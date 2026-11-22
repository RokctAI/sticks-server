// Move one tenant's Rakazo data between dockers (Ray 11-22 "Go"). In a shared docker every tenant lives in one
// Rakazo database, separated by organization. Export walks the foreign keys down from the tenant's organization
// row (everything that belongs to it), then adds the rows those point up to (for example the user a member is),
// without walking down from them, so no other tenant's rows come along. Import inserts parents before children
// with ON CONFLICT DO NOTHING, so running it twice changes nothing. The schema is read from the database at run
// time, so an upstream upgrade needs no change here. Caller: control's move_runner through the sticks-org CLI.
import type { SqlQuery } from "./plugin-draft-store.js";

export type ForeignKey = { child: string; childCols: string[]; parent: string; parentCols: string[] };
export type OrgExport = { version: 1; org: string; tables: Record<string, Array<Record<string, unknown>>>; order: string[] };

const q = (name: string) => `"${name.replace(/"/g, '""')}"`;
const key = (row: Record<string, unknown>, cols: string[]) => JSON.stringify(cols.map((c) => row[c]));

export async function readForeignKeys(query: SqlQuery): Promise<ForeignKey[]> {
  const rows = (await query(
    `SELECT c.relname AS child, p.relname AS parent,
            (SELECT array_agg(a.attname::text ORDER BY k.n) FROM unnest(con.conkey) WITH ORDINALITY k(attnum, n)
               JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum) AS child_cols,
            (SELECT array_agg(a.attname::text ORDER BY k.n) FROM unnest(con.confkey) WITH ORDINALITY k(attnum, n)
               JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum) AS parent_cols
     FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid JOIN pg_class p ON p.oid = con.confrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE con.contype = 'f' AND n.nspname = 'public'`,
    [],
  )) as Array<{ child: string; parent: string; child_cols: string[]; parent_cols: string[] }>;
  return rows.map((r) => ({ child: r.child, parent: r.parent, childCols: r.child_cols, parentCols: r.parent_cols }));
}

/** Parents before children. A table pointing at itself is fine; a real cycle between tables throws. */
export function insertOrder(tables: string[], fks: ForeignKey[]): string[] {
  const set = new Set(tables);
  const deps = new Map(tables.map((t) => [t, new Set(fks.filter((f) => f.child === t && f.parent !== t && set.has(f.parent)).map((f) => f.parent))]));
  const out: string[] = [];
  while (out.length < tables.length) {
    const ready = tables.filter((t) => !out.includes(t) && [...deps.get(t)!].every((d) => out.includes(d))).sort();
    if (ready.length === 0) throw new Error(`foreign key cycle between: ${tables.filter((t) => !out.includes(t)).join(", ")}`);
    out.push(...ready);
  }
  return out;
}

/** Rows of one table in a self-referencing table, parents first (rows whose parent is not in the set go first). */
export function selfOrder(rows: Array<Record<string, unknown>>, self: ForeignKey[]): Array<Record<string, unknown>> {
  if (self.length === 0) return rows;
  const out: Array<Record<string, unknown>> = [];
  const placed = new Set<string>();
  let rest = rows;
  while (rest.length) {
    const ready = rest.filter((r) =>
      self.every((f) => {
        if (f.childCols.some((c) => r[c] === null || r[c] === undefined)) return true;
        const k = key(r, f.childCols);
        return placed.has(`${f.parentCols.join(",")}|${k}`) || !rows.some((x) => key(x, f.parentCols) === k);
      }),
    );
    if (ready.length === 0) return [...out, ...rest];
    for (const r of ready) for (const f of self) placed.add(`${f.parentCols.join(",")}|${key(r, f.parentCols)}`);
    out.push(...ready);
    rest = rest.filter((r) => !ready.includes(r));
  }
  return out;
}

async function selectWhere(query: SqlQuery, table: string, cols: string[], values: unknown[][]): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  for (let i = 0; i < values.length; i += 500) {
    const params: unknown[] = [];
    const tuples = values
      .slice(i, i + 500)
      .map((v) => `(${v.map((x) => (params.push(x), `$${params.length}`)).join(",")})`)
      .join(",");
    out.push(...((await query(`SELECT * FROM ${q(table)} WHERE (${cols.map(q).join(",")}) IN (${tuples})`, params)) as Array<Record<string, unknown>>));
  }
  return out;
}

/** Upstream's row-level security limits a session to one space unless the system bypass is set (its own rule). */
async function systemSession(query: SqlQuery): Promise<void> {
  await query(`SELECT set_config('app.rls_bypass', 'on', false)`, []);
}

export async function exportOrg(query: SqlQuery, orgId: string, orgTable = "organization"): Promise<OrgExport> {
  await systemSession(query);
  const fks = await readForeignKeys(query);
  const rows = new Map<string, Map<string, Record<string, unknown>>>();
  const add = (t: string, list: Array<Record<string, unknown>>) => {
    const m = rows.get(t) ?? new Map<string, Record<string, unknown>>();
    let added = 0;
    for (const r of list) {
      const k = JSON.stringify(r);
      if (!m.has(k)) {
        m.set(k, r);
        added++;
      }
    }
    rows.set(t, m);
    return added;
  };
  const root = (await query(`SELECT * FROM ${q(orgTable)} WHERE id = $1`, [orgId])) as Array<Record<string, unknown>>;
  if (!root[0]) throw new Error(`no organization ${orgId}`);
  add(orgTable, root);
  // Down: children of anything exported, until nothing new.
  for (let changed = true; changed; ) {
    changed = false;
    for (const f of fks) {
      const parents = [...(rows.get(f.parent)?.values() ?? [])];
      const found = await selectWhere(query, f.child, f.childCols, parents.map((p) => f.parentCols.map((c) => p[c])));
      if (add(f.child, found) > 0) changed = true;
    }
  }
  // Up: rows the exported rows point to that are not exported yet. Nothing is walked down from these.
  for (let changed = true; changed; ) {
    changed = false;
    for (const f of fks) {
      const have = new Set([...(rows.get(f.parent)?.values() ?? [])].map((r) => key(r, f.parentCols)));
      const missing = new Map<string, unknown[]>();
      for (const r of rows.get(f.child)?.values() ?? []) {
        if (f.childCols.some((c) => r[c] === null || r[c] === undefined)) continue;
        const k = key(r, f.childCols);
        if (!have.has(k)) missing.set(k, f.childCols.map((c) => r[c]));
      }
      if (add(f.parent, await selectWhere(query, f.parent, f.parentCols, [...missing.values()])) > 0) changed = true;
    }
  }
  const tables: Record<string, Array<Record<string, unknown>>> = {};
  for (const [t, m] of rows) {
    if (!m.size) continue;
    const list = [...m.values()].map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, toFile(v)])));
    tables[t] = selfOrder(list, fks.filter((f) => f.child === t && f.parent === t));
  }
  return { version: 1, org: orgId, tables, order: insertOrder(Object.keys(tables), fks) };
}

/** Bytes survive the JSON file as {"$bytea": base64}. */
export function toFile(v: unknown): unknown {
  if (v instanceof Uint8Array) return { $bytea: Buffer.from(v).toString("base64") };
  return v;
}

async function columnTypes(query: SqlQuery, table: string): Promise<Map<string, string>> {
  const rows = (await query(
    `SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`,
    [table],
  )) as Array<{ column_name: string; data_type: string }>;
  return new Map(rows.map((r) => [r.column_name, r.data_type]));
}

/** json/jsonb go as JSON text; bytes back to a Buffer; arrays and plain values as they are. */
export function param(v: unknown, type: string | undefined): unknown {
  if (v !== null && typeof v === "object" && "$bytea" in (v as object)) return Buffer.from((v as { $bytea: string }).$bytea, "base64");
  if (type === "json" || type === "jsonb") return v === null ? null : JSON.stringify(v);
  return v;
}

/** Inserts parents first; rows already there are skipped. Returns how many rows were new per table. */
export async function importOrg(query: SqlQuery, data: OrgExport): Promise<Record<string, number>> {
  if (data.version !== 1) throw new Error("unknown export version");
  await systemSession(query);
  const counts: Record<string, number> = {};
  for (const t of data.order) {
    const types = await columnTypes(query, t);
    let n = 0;
    for (const row of data.tables[t] ?? []) {
      const cols = Object.keys(row);
      const res = (await query(
        `INSERT INTO ${q(t)} (${cols.map(q).join(",")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(",")}) ON CONFLICT DO NOTHING RETURNING 1`,
        cols.map((c) => param(row[c], types.get(c))),
      )) as unknown[];
      n += res.length;
    }
    counts[t] = n;
  }
  return counts;
}
