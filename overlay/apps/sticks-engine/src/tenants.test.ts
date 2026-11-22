import { describe, expect, it } from "vitest";
import { engineUserId, knownTenant, registerLegacyTenant, registerTenant, tenantBySite } from "./tenants.js";

const KEY_A = "A".repeat(43) + "=";
const KEY_B = "B".repeat(43) + "=";

function db() {
  const t = { orgs: [] as Record<string, unknown>[], spaces: [] as Record<string, unknown>[], tenants: [] as Record<string, unknown>[] };
  const q = async (sql: string, p: unknown[] = []): Promise<unknown[]> => {
    if (sql.startsWith("CREATE")) return [];
    if (sql.startsWith("INSERT INTO organization")) return void t.orgs.push({ id: p[0], slug: p[2] }), [];
    if (sql.startsWith("INSERT INTO spaces")) return void t.spaces.push({ id: p[0], org: p[1] }), [];
    if (sql.startsWith("INSERT INTO sticks_tenants")) {
      const legacy = sql.includes("true");
      const i = t.tenants.findIndex((r) => r.tenant === p[0]);
      const row = { tenant: p[0], site: p[1], org_id: p[2], space_id: p[3], public_key: p[4], legacy };
      if (i >= 0) t.tenants[i] = { ...t.tenants[i], site: p[1], public_key: p[4] };
      else t.tenants.push(row);
      return [];
    }
    if (sql.startsWith("UPDATE sticks_tenants")) return void (t.tenants.find((r) => r.tenant === p[0])!.public_key = p[1]), [];
    if (sql.includes("WHERE tenant = $1 OR site = $2")) return t.tenants.filter((r) => r.tenant === p[0] || r.site === p[1]);
    if (sql.includes("WHERE site = $1")) return t.tenants.filter((r) => r.site === p[0]);
    if (sql === "SELECT * FROM sticks_tenants") return t.tenants;
    throw new Error(`unexpected: ${sql}`);
  };
  return { q, t };
}

describe("many tenants in one engine", () => {
  it("gives each tenant its own organization and space, found by its signing site", async () => {
    const { q, t } = db();
    const a = await registerTenant(q, { tenant: "acme", site: "acme.rokct.ai", company: "Acme", publicKey: KEY_A });
    const b = await registerTenant(q, { tenant: "beta", site: "beta.rokct.ai", company: "Beta", publicKey: KEY_B });
    expect(a.orgId).not.toBe(b.orgId);
    expect(a.spaceId).not.toBe(b.spaceId);
    expect(t.orgs).toHaveLength(2);
    expect((await tenantBySite(q, "beta.rokct.ai"))!.publicKey).toBe(KEY_B);
    expect(await tenantBySite(q, "nobody.rokct.ai")).toBeUndefined();
    // Sign-in reads from memory, so a token from an unknown site costs no database call.
    expect(knownTenant("acme.rokct.ai")!.orgId).toBe(a.orgId);
    expect(knownTenant("nobody.rokct.ai")).toBeUndefined();
  });

  it("registering again is harmless; another tenant's name or site is refused", async () => {
    const { q, t } = db();
    const a = await registerTenant(q, { tenant: "acme", site: "acme.rokct.ai", company: "Acme", publicKey: KEY_A });
    const again = await registerTenant(q, { tenant: "acme", site: "acme.rokct.ai", company: "Acme", publicKey: KEY_B });
    expect(again.orgId).toBe(a.orgId);
    expect(t.orgs).toHaveLength(1);
    await expect(registerTenant(q, { tenant: "evil", site: "acme.rokct.ai", company: "E", publicKey: KEY_A })).rejects.toThrow(/another tenant/);
    await expect(registerTenant(q, { tenant: "acme", site: "evil.rokct.ai", company: "E", publicKey: KEY_A })).rejects.toThrow(/another tenant/);
  });

  it("user ids carry the tenant, except the original one-tenant setup", async () => {
    const { q } = db();
    await registerLegacyTenant(q, "old", "old.rokct.ai", "org0", "space0", KEY_A);
    const old = (await tenantBySite(q, "old.rokct.ai"))!;
    const fresh = await registerTenant(q, { tenant: "acme", site: "acme.rokct.ai", company: "Acme", publicKey: KEY_B });
    expect(engineUserId(old, "Administrator")).toBe("Administrator");
    expect(engineUserId(fresh, "Administrator")).toBe("acme/Administrator");
  });

  it("refuses bad input", async () => {
    const { q } = db();
    await expect(registerTenant(q, { tenant: "a b", site: "x", company: "C", publicKey: KEY_A })).rejects.toThrow();
    await expect(registerTenant(q, { tenant: "a", site: "x", company: "C", publicKey: "short" })).rejects.toThrow();
  });
});
