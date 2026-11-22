// Many tenants in one engine (Ray 11-22: "A shared docker means all tenants will use that same rakazo that is
// inside their docker"). Each tenant is its own upstream organization with its own default space; upstream's
// per-space row-level security and membership keep tenants apart. A tenant is found at sign-in from the Pulsar
// site that signed the token. Callers: Pulsar's first start registers its tenant (POST /internal/tenants, engine
// secret); the front door looks the signer up on every sign-in. The tenant given by STICKS_TENANT (the one
// engine-per-tenant setup) is registered at boot, so existing dockers keep working unchanged.
import { randomUUID } from "node:crypto";
import type { SqlQuery } from "./plugin-draft-store.js";
import { slugOf, spaceName } from "./first-boot.js";

export const TENANTS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS sticks_tenants (
  tenant text PRIMARY KEY,
  site text NOT NULL UNIQUE,
  org_id text NOT NULL UNIQUE,
  space_id text NOT NULL,
  public_key text NOT NULL,
  legacy boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
)`;

export type Tenant = { tenant: string; site: string; orgId: string; spaceId: string; publicKey: string; legacy: boolean };

export class TenantError extends Error {}

/** Every registered tenant by signing site, kept in memory so a refused sign-in never touches the database.
 *  One engine process per docker (spec 4.2), so this process sees every registration. */
const bySite = new Map<string, Tenant>();
const remember = (t: Tenant) => {
  for (const [site, known] of bySite) if (known.tenant === t.tenant) bySite.delete(site);
  bySite.set(t.site, t);
  return t;
};

/** Fills the in-memory list from the database; called once at start. */
export async function loadTenants(query: SqlQuery): Promise<number> {
  await query(TENANTS_TABLE_SQL, []);
  const rows = (await query(`SELECT * FROM sticks_tenants`, [])) as Array<Record<string, unknown>>;
  bySite.clear();
  for (const r of rows) remember(toTenant(r));
  return bySite.size;
}

/** The tenant whose Pulsar site signed a token, from memory only. */
export function knownTenant(site: string): Tenant | undefined {
  return bySite.get(site);
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function toTenant(r: Record<string, unknown>): Tenant {
  return {
    tenant: r.tenant as string, site: r.site as string, orgId: r.org_id as string, spaceId: r.space_id as string,
    publicKey: r.public_key as string, legacy: r.legacy as boolean,
  };
}

/** The user id inside the engine. Two tenants can both have "Administrator", so ids carry the tenant;
 *  the original single tenant keeps plain ids so its existing users, chats and Sticks stay theirs. */
export function engineUserId(t: Pick<Tenant, "tenant" | "legacy">, pulsarUser: string): string {
  return t.legacy ? pulsarUser : `${t.tenant}/${pulsarUser}`;
}

async function newOrg(query: SqlQuery, company: string, now: Date): Promise<{ orgId: string; spaceId: string }> {
  const orgId = randomUUID();
  const spaceId = randomUUID();
  await query(`INSERT INTO organization (id, name, slug, "createdAt") VALUES ($1, $2, $3, $4)`, [orgId, spaceName(company), `${slugOf(company)}-${orgId.slice(0, 8)}`, now]);
  await query(`INSERT INTO spaces (id, "organizationId", name, "isDefault", "createdAt") VALUES ($1, $2, $3, true, $4)`, [spaceId, orgId, spaceName(company), now]);
  return { orgId, spaceId };
}

/**
 * Adds a tenant, or returns it when it is already there (same site). A tenant name or site already used by a
 * different tenant is refused, so one tenant can never take over another's organization.
 */
export async function registerTenant(
  query: SqlQuery,
  input: { tenant: unknown; site: unknown; company: unknown; publicKey: unknown },
  now: Date = new Date(),
): Promise<Tenant> {
  const { tenant, site, company, publicKey } = input;
  if (typeof tenant !== "string" || !NAME.test(tenant)) throw new TenantError("tenant is invalid");
  if (typeof site !== "string" || !NAME.test(site)) throw new TenantError("site is invalid");
  if (typeof company !== "string" || !company.trim()) throw new TenantError("company is required");
  if (typeof publicKey !== "string" || !/^[A-Za-z0-9+/=_-]{40,64}$/.test(publicKey)) throw new TenantError("public key is invalid");
  await query(TENANTS_TABLE_SQL, []);
  const existing = (await query(`SELECT * FROM sticks_tenants WHERE tenant = $1 OR site = $2`, [tenant, site])) as Array<Record<string, unknown>>;
  if (existing.length > 1 || (existing[0] && (existing[0].tenant !== tenant || existing[0].site !== site))) {
    throw new TenantError("tenant or site already belongs to another tenant");
  }
  if (existing[0]) {
    await query(`UPDATE sticks_tenants SET public_key = $2 WHERE tenant = $1`, [tenant, publicKey]);
    return remember({ ...toTenant(existing[0]), publicKey });
  }
  const { orgId, spaceId } = await newOrg(query, company, now);
  await query(
    `INSERT INTO sticks_tenants (tenant, site, org_id, space_id, public_key) VALUES ($1,$2,$3,$4,$5)`,
    [tenant, site, orgId, spaceId, publicKey],
  );
  return remember({ tenant, site, orgId, spaceId, publicKey, legacy: false });
}

/** The one-tenant setup (STICKS_TENANT): registers it on its existing first organization, plain user ids. */
export async function registerLegacyTenant(query: SqlQuery, tenant: string, site: string, orgId: string, spaceId: string, publicKey: string): Promise<void> {
  await query(TENANTS_TABLE_SQL, []);
  await query(
    `INSERT INTO sticks_tenants (tenant, site, org_id, space_id, public_key, legacy) VALUES ($1,$2,$3,$4,$5,true)
     ON CONFLICT (tenant) DO UPDATE SET site = EXCLUDED.site, public_key = EXCLUDED.public_key`,
    [tenant, site, orgId, spaceId, publicKey],
  );
  await loadTenants(query);
}

/** The tenant whose Pulsar site signed a token, or undefined. */
export async function tenantBySite(query: SqlQuery, site: string): Promise<Tenant | undefined> {
  await query(TENANTS_TABLE_SQL, []);
  const rows = (await query(`SELECT * FROM sticks_tenants WHERE site = $1`, [site])) as Array<Record<string, unknown>>;
  return rows[0] ? toTenant(rows[0]) : undefined;
}
