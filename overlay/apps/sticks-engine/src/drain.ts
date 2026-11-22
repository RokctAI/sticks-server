// Drain and resume for docker moves (Ray 11-22 "Go"). Before the move runner freezes a site it calls
// POST /internal/drain: the front door then refuses new work (any write that is not an /internal route) with 503
// {error:"moving", retry:true}, so the app retries after the move instead of starting a run that would be cut.
// The runner polls GET /internal/idle until idle, then freezes. POST /internal/resume (after the switch, or on
// rollback) lets work in again. The flag also lives in the database, so a restart on the new docker keeps
// refusing until resume is called. Caller: control's move_runner (Paramount thread).
import type { SqlQuery } from "./plugin-draft-store.js";

export const DRAIN_TABLE_SQL = `CREATE TABLE IF NOT EXISTS sticks_drain (
  id smallint PRIMARY KEY CHECK (id = 1),
  draining boolean NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
)`;

/** The process-wide flag the front door reads. */
export const drainFlag = { draining: false };

export class DrainState {
  get draining(): boolean {
    return drainFlag.draining;
  }
  constructor(private readonly query: SqlQuery) {}
  async load(): Promise<boolean> {
    await this.query(DRAIN_TABLE_SQL, []);
    const rows = (await this.query(`SELECT draining FROM sticks_drain WHERE id = 1`, [])) as Array<{ draining: boolean }>;
    drainFlag.draining = rows[0]?.draining ?? false;
    return drainFlag.draining;
  }
  async set(draining: boolean): Promise<void> {
    await this.query(DRAIN_TABLE_SQL, []);
    await this.query(
      `INSERT INTO sticks_drain (id, draining) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET draining = EXCLUDED.draining, updated_at = now()`,
      [draining],
    );
    drainFlag.draining = draining;
  }
}

/** While draining, refuse anything that could start work: writes outside /internal. Reads and /internal stay open. */
export function refusedWhileDraining(draining: boolean, method: string, pathname: string): boolean {
  if (!draining) return false;
  if (pathname.startsWith("/internal/")) return false;
  return !(method === "GET" || method === "HEAD" || method === "OPTIONS");
}

// Per tenant (many tenants in one engine, tenants.ts): drain {site} blocks only that tenant's writes, so the other
// tenants on a shared docker keep working while one is moved. Kept in memory (by organization id, which is what a
// session carries) and in the database so a restart keeps refusing until resume.
export const DRAIN_SITES_TABLE_SQL = `CREATE TABLE IF NOT EXISTS sticks_drain_sites (
  site text PRIMARY KEY,
  org_id text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
)`;

/** Organization ids of tenants being moved. The front door reads it. */
export const drainingOrgs = new Set<string>();

export class SiteDrainState {
  constructor(private readonly query: SqlQuery) {}
  async load(): Promise<number> {
    await this.query(DRAIN_SITES_TABLE_SQL, []);
    const rows = (await this.query(`SELECT org_id FROM sticks_drain_sites`, [])) as Array<{ org_id: string }>;
    drainingOrgs.clear();
    for (const r of rows) drainingOrgs.add(r.org_id);
    return drainingOrgs.size;
  }
  async set(site: string, orgId: string, draining: boolean): Promise<void> {
    await this.query(DRAIN_SITES_TABLE_SQL, []);
    if (draining) {
      await this.query(
        `INSERT INTO sticks_drain_sites (site, org_id) VALUES ($1, $2) ON CONFLICT (site) DO UPDATE SET org_id = EXCLUDED.org_id, updated_at = now()`,
        [site, orgId],
      );
      drainingOrgs.add(orgId);
    } else {
      await this.query(`DELETE FROM sticks_drain_sites WHERE site = $1`, [site]);
      drainingOrgs.delete(orgId);
    }
  }
}

/** The organization a signed-in request belongs to, only looked up while some tenant is draining. */
export async function sessionOrg(query: SqlQuery, rawToken: string): Promise<string | undefined> {
  const rows = (await query(
    `SELECT s."activeOrganizationId" AS org, m."organizationId" AS member_org
       FROM session s LEFT JOIN member m ON m."userId" = s."userId"
      WHERE s.token = $1 LIMIT 1`,
    [rawToken],
  )) as Array<{ org: string | null; member_org: string | null }>;
  return rows[0]?.org ?? rows[0]?.member_org ?? undefined;
}
