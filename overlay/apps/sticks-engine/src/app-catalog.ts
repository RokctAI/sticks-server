// Curated app catalog (Ray 11-28): apps from integrations.sh that people may connect. Hidden by default. The hub
// decides which entries are listed AND have every need satisfied, and Pulsar pushes only those here. The catalog
// carries NO secrets: only plain display fields, and anything else (keys, tokens, secrets) is dropped on the way in.
// Callers: Pulsar posts POST /internal/catalog with the engine secret; signed-in people read GET /internal/catalog.
import type { SqlQuery } from "./plugin-draft-store.js";

export interface CatalogEntry {
  id: string;
  name: string;
  summary: string;
  logo?: string;
  /** Plain-words list of what the app can read or change, shown before connecting. */
  can: string[];
}

export const CATALOG_TABLE_SQL = `CREATE TABLE IF NOT EXISTS sticks_app_catalog (
  id smallint PRIMARY KEY CHECK (id = 1),
  entries jsonb NOT NULL,
  version text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now()
)`;

const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const short = (v: unknown, max: number): string | undefined => (typeof v === "string" && v.trim() && v.length <= max ? v.trim() : undefined);

/** Whitelist: only known display fields survive; an entry without a valid id, name or summary is skipped. */
export function cleanEntries(incoming: unknown): CatalogEntry[] {
  if (!Array.isArray(incoming)) return [];
  const seen = new Set<string>();
  const out: CatalogEntry[] = [];
  for (const raw of incoming) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const id = typeof r.id === "string" && ID.test(r.id) ? r.id : undefined;
    const name = short(r.name, 80);
    const summary = short(r.summary, 300);
    if (!id || !name || !summary || seen.has(id)) continue;
    seen.add(id);
    const logo = typeof r.logo === "string" && /^https:\/\/[^\s]{1,300}$/.test(r.logo) ? r.logo : undefined;
    const can = Array.isArray(r.can) ? r.can.map((x) => short(x, 160)).filter((x): x is string => !!x).slice(0, 12) : [];
    out.push({ id, name, summary, ...(logo ? { logo } : {}), can });
  }
  return out;
}

/** Nothing is shown until the hub has pushed a list. */
export async function readCatalog(query: SqlQuery): Promise<{ entries: CatalogEntry[]; version: string }> {
  const rows = (await query(`SELECT entries, version FROM sticks_app_catalog WHERE id = 1`, [])) as Array<{ entries: unknown; version: string }>;
  return { entries: cleanEntries(rows[0]?.entries), version: rows[0]?.version ?? "" };
}

/** The pushed list replaces the stored one (the hub sends the full available list each time). */
export async function saveCatalog(query: SqlQuery, incoming: unknown): Promise<{ entries: CatalogEntry[]; version: string }> {
  const body = (incoming && typeof incoming === "object" ? incoming : {}) as Record<string, unknown>;
  const entries = cleanEntries(body.entries);
  const version = short(body.version, 64) ?? "";
  await query(
    `INSERT INTO sticks_app_catalog (id, entries, version) VALUES (1, $1, $2) ON CONFLICT (id) DO UPDATE SET entries = EXCLUDED.entries, version = EXCLUDED.version, updated_at = now()`,
    [JSON.stringify(entries), version],
  );
  return { entries, version };
}
