import { describe, expect, it } from "vitest";
import type { SqlQuery } from "./plugin-draft-store.js";
import { exportEngineRows } from "./engine-rows.js";
import { seal, unseal } from "./stick-pulsar-accounts.js";

const SECRET = "engine-secret-of-the-source-docker";
const MOVE_KEY = "one-off-move-key-with-at-least-32-chars";

type Row = Record<string, unknown> & { org: string };

/** Answers only what exportEngineRows sends: the table check and one SELECT per table, scoped by the org parameter
 *  (the fake mimics the SQL scoping by org; the real SQL against a real database is not tested here). */
function fakeDb(tables: Record<string, Row[]>): SqlQuery {
  return async (sql, p = []) => {
    if (sql.includes("to_regclass")) return [{ ok: p[0] as string in tables }];
    const t = /FROM (\w+) WHERE/.exec(sql)![1]!;
    return (tables[t] ?? []).filter((r) => r.org === p[0]).map(({ org: _org, ...rest }) => rest);
  };
}

const twoOrgs = (): Record<string, Row[]> => ({
  sticks_tenants: [
    { org: "A", tenant: "acme", site: "acme.shared", org_id: "A" },
    { org: "B", tenant: "beta", site: "beta.shared", org_id: "B" },
  ],
  sticks_pulsar_tokens: [
    { org: "A", stick_id: "a1", pulsar_user: "a1@sticks.local", sealed: seal("stk_plain_A", SECRET) },
    { org: "B", stick_id: "b1", pulsar_user: "b1@sticks.local", sealed: seal("stk_plain_B", SECRET) },
  ],
  sticks_guest: [{ org: "A", user_id: "acme/g" }, { org: "B", user_id: "beta/g" }],
});

describe("engine rows for one tenant", () => {
  it("holds none of the other tenant's rows or tokens, and no plain token", async () => {
    const out = await exportEngineRows(fakeDb(twoOrgs()), "A", { engineSecret: SECRET, moveKey: MOVE_KEY });
    expect(out.rows.sticks_tenants!.map((r) => r.tenant)).toEqual(["acme"]);
    expect(out.rows.sticks_pulsar_tokens!.map((r) => r.stick_id)).toEqual(["a1"]);
    expect(out.rows.sticks_guest!.map((r) => r.user_id)).toEqual(["acme/g"]);
    const text = JSON.stringify(out);
    expect(text).not.toMatch(/beta|b1|stk_plain_B/);
    expect(text).not.toContain("stk_plain_A");
    // The token is sealed under the move key, not the source engine secret, and opens to the original.
    const sealed = String(out.rows.sticks_pulsar_tokens![0]!.sealed);
    expect(unseal(sealed, MOVE_KEY)).toBe("stk_plain_A");
    expect(() => unseal(sealed, SECRET)).toThrow();
  });

  it("without a move key the tokens are left out and counted", async () => {
    const out = await exportEngineRows(fakeDb(twoOrgs()), "A", { engineSecret: SECRET });
    expect(out.rows.sticks_pulsar_tokens).toEqual([]);
    expect(out.skippedTokens).toBe(1);
    expect(JSON.stringify(out)).not.toMatch(/stk_plain/);
  });
});
