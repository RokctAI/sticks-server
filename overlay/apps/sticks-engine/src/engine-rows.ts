// The engine's own rows for one tenant, carried with a docker move (sticks-org export/import; Paramount thread).
// The upstream rows move through org-move.ts by foreign key; the engine's sticks_* tables have no foreign keys, so
// each is picked here by the tenant's organization: its sticks_tenants row, its Sticks' Pulsar tokens, keep-going
// switches and credit pauses (by bot), its record cards (by thread) and its guest marks (by user).
// Stick Pulsar tokens are sealed with the docker's engine secret, which differs per docker. Export opens them and
// seals them again with a one-off move key (a file the move runner makes and gives to both sides, then deletes);
// import opens them with that key and seals them with the target engine secret, so no token needs rotating.
// Without a move key the tokens are left out (counted as skipped) and must be rotated after the move.
import { seal, unseal } from "./stick-pulsar-accounts.js";
import type { SqlQuery } from "./plugin-draft-store.js";

export type EngineRows = Record<string, Array<Record<string, unknown>>>;

const BOTS = `SELECT b.id FROM bots b JOIN spaces s ON s.id = b."spaceId" WHERE s."organizationId" = $1`;
const THREADS = `SELECT t.id FROM threads t JOIN spaces s ON s.id = t."spaceId" WHERE s."organizationId" = $1`;
const USERS = `SELECT "userId" FROM member WHERE "organizationId" = $1`;

/** Table, key columns, and the rows of one organization. Tables that do not exist yet are skipped. */
export const PICKS: Array<{ table: string; keys: string[]; where: string }> = [
  { table: "sticks_tenants", keys: ["tenant"], where: `org_id = $1` },
  { table: "sticks_pulsar_tokens", keys: ["stick_id"], where: `stick_id IN (${BOTS})` },
  { table: "sticks_keep_going", keys: ["bot_id"], where: `bot_id IN (${BOTS})` },
  { table: "sticks_credit_paused", keys: ["bot_id"], where: `bot_id IN (${BOTS})` },
  { table: "sticks_record_requests", keys: ["request_id"], where: `thread_id IN (${THREADS})` },
  { table: "sticks_guest", keys: ["user_id"], where: `user_id IN (${USERS})` },
];

async function tableExists(query: SqlQuery, table: string): Promise<boolean> {
  const rows = (await query(`SELECT to_regclass($1) IS NOT NULL AS ok`, [table])) as Array<{ ok: boolean }>;
  return rows[0]?.ok === true;
}

export async function exportEngineRows(
  query: SqlQuery,
  orgId: string,
  keys: { engineSecret?: string; moveKey?: string },
): Promise<{ rows: EngineRows; skippedTokens: number }> {
  const rows: EngineRows = {};
  let skippedTokens = 0;
  for (const p of PICKS) {
    if (!(await tableExists(query, p.table))) continue;
    let list = (await query(`SELECT * FROM ${p.table} WHERE ${p.where}`, [orgId])) as Array<Record<string, unknown>>;
    if (p.table === "sticks_pulsar_tokens") {
      const { engineSecret, moveKey } = keys;
      if (!engineSecret || !moveKey) {
        skippedTokens = list.length;
        list = [];
      } else {
        list = list.map((r) => ({ ...r, sealed: seal(unseal(String(r.sealed), engineSecret), moveKey) }));
      }
    }
    for (const r of list) for (const [k, v] of Object.entries(r)) if (v instanceof Date) r[k] = v.toISOString();
    rows[p.table] = list;
  }
  return { rows, skippedTokens };
}

/** Adds the rows; rows already there are left alone, so running it twice changes nothing. */
export async function importEngineRows(
  query: SqlQuery,
  rows: EngineRows | undefined,
  keys: { engineSecret?: string; moveKey?: string },
  ensureTables: Record<string, string>,
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const p of PICKS) {
    const list = rows?.[p.table];
    if (!list?.length) continue;
    const ddl = ensureTables[p.table];
    if (ddl) await query(ddl, []);
    const { engineSecret, moveKey } = keys;
    if (p.table === "sticks_pulsar_tokens" && (!engineSecret || !moveKey))
      throw new Error("the file carries Stick tokens: import needs the same move key and this docker's engine secret");
    let added = 0;
    for (const raw of list) {
      const r = p.table === "sticks_pulsar_tokens" ? { ...raw, sealed: seal(unseal(String(raw.sealed), moveKey!), engineSecret!) } : raw;
      const cols = Object.keys(r);
      const values = cols.map((c) => (r[c] !== null && typeof r[c] === "object" ? JSON.stringify(r[c]) : r[c]));
      const res = (await query(
        `INSERT INTO ${p.table} (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")})
         ON CONFLICT (${p.keys.map((k) => `"${k}"`).join(", ")}) DO NOTHING RETURNING 1`,
        values,
      )) as unknown[];
      added += res.length;
    }
    counts[p.table] = added;
  }
  return counts;
}
