import { describe, expect, it } from "vitest";
import { seal, setUpStickAccount, stickToken, unseal } from "./stick-pulsar-accounts.js";

function db() {
  const rows = new Map<string, { sealed: string }>();
  return async (sql: string, p: unknown[]) => {
    if (sql.startsWith("CREATE")) return [];
    if (sql.startsWith("INSERT")) { rows.set(p[0] as string, { sealed: p[2] as string }); return []; }
    const r = rows.get(p[0] as string); return r ? [r] : [];
  };
}

describe("stick pulsar accounts", () => {
  it("seals so the stored value is not the token", () => {
    const s = seal("stk_abc", "secret");
    expect(s).not.toContain("stk_abc");
    expect(unseal(s, "secret")).toBe("stk_abc");
    expect(() => unseal(s, "other")).toThrow();
  });
  it("creates the account and keeps the Stick's token; rotates when it exists", async () => {
    const q = db();
    const calls: string[] = [];
    const fetcher = async (url: string) => {
      calls.push(url.split(".").pop()!);
      if (url.endsWith("create_account")) return new Response("{}", { status: 409 });
      return new Response(JSON.stringify({ message: { user: "lebo@sticks.local", token: "stk_new" } }), { status: 200 });
    };
    const r = await setUpStickAccount(q, fetcher, "http://p", "adm", "secret", { stickId: "lebo", displayName: "Lebo", role: "Sales User" });
    expect(r.user).toBe("lebo@sticks.local");
    expect(calls).toEqual(["create_account", "rotate_token"]);
    expect(await stickToken(q, "lebo", "secret")).toBe("stk_new");
    expect(r.rotated).toBe(true);
    expect(r.note).toMatch(/not changed/);
    // A changed engine secret means the token can't be opened: no account, not an error.
    expect(await stickToken(q, "lebo", "different")).toBeUndefined();
  });
  it("refuses when Pulsar says the caller is not an admin", async () => {
    const fetcher = async () => new Response("{}", { status: 403 });
    await expect(setUpStickAccount(db(), fetcher, "http://p", "x", "s", { stickId: "lebo", displayName: "Lebo", role: "R" })).rejects.toThrow(/admin/);
  });
});
