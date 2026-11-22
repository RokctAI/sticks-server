import { describe, expect, it } from "vitest";
import { exportOrg, importOrg, insertOrder, selfOrder, type ForeignKey } from "./org-move.js";

type Row = Record<string, unknown>;
const FKS = [
  { child: "member", child_cols: ["organizationId"], parent: "organization", parent_cols: ["id"] },
  { child: "member", child_cols: ["userId"], parent: "user", parent_cols: ["id"] },
  { child: "thread", child_cols: ["organizationId"], parent: "organization", parent_cols: ["id"] },
  { child: "events", child_cols: ["threadId"], parent: "thread", parent_cols: ["id"] },
  { child: "events", child_cols: ["parentId"], parent: "events", parent_cols: ["id"] },
  { child: "session", child_cols: ["userId"], parent: "user", parent_cols: ["id"] },
];

/** A tiny in-memory database that answers only the statements org-move sends. */
function fakeDb(tables: Record<string, Row[]>, fks: unknown[] = FKS) {
  return async (sql: string, p: unknown[] = []): Promise<unknown[]> => {
    if (sql.includes("pg_constraint")) return fks;
    if (sql.includes("set_config") || sql.includes("information_schema")) return [];
    const t = /(?:FROM|INTO) "([^"]+)"/.exec(sql)![1]!;
    tables[t] ??= [];
    if (sql.startsWith("SELECT") && sql.includes("WHERE id = $1")) return tables[t]!.filter((r) => r.id === p[0]);
    if (sql.startsWith("SELECT")) {
      const cols = /WHERE \(([^)]*)\)/.exec(sql)![1]!.split(",").map((c) => c.replace(/"/g, ""));
      const want = new Set<string>();
      for (let i = 0; i < p.length; i += cols.length) want.add(JSON.stringify(p.slice(i, i + cols.length)));
      return tables[t]!.filter((r) => want.has(JSON.stringify(cols.map((c) => r[c]))));
    }
    const cols = /\(([^)]*)\) VALUES/.exec(sql)![1]!.split(",").map((c) => c.replace(/"/g, ""));
    const row = Object.fromEntries(cols.map((c, i) => [c, p[i]]));
    if (tables[t]!.some((r) => r.id === row.id)) return [];
    tables[t]!.push(row);
    return [1];
  };
}

function sharedDocker(): Record<string, Row[]> {
  return {
    organization: [{ id: "A" }, { id: "B" }],
    user: [{ id: "u1" }, { id: "u2" }],
    member: [{ id: "m1", organizationId: "A", userId: "u1" }, { id: "m2", organizationId: "B", userId: "u2" }],
    thread: [{ id: "t1", organizationId: "A" }, { id: "t2", organizationId: "B" }],
    events: [{ id: "e2", threadId: "t1", parentId: "e1" }, { id: "e1", threadId: "t1", parentId: null }, { id: "e3", threadId: "t2", parentId: null }],
    session: [{ id: "s1", userId: "u1" }],
  };
}

describe("org move", () => {
  it("exports one tenant and none of the other tenant's rows", async () => {
    const out = await exportOrg(fakeDb(sharedDocker()), "A");
    expect(out.tables.organization).toEqual([{ id: "A" }]);
    expect(out.tables.user).toEqual([{ id: "u1" }]);
    expect(out.tables.thread!.map((r) => r.id)).toEqual(["t1"]);
    expect(out.tables.events!.map((r) => r.id)).toEqual(["e1", "e2"]);
    expect(JSON.stringify(out)).not.toMatch(/"B"|u2|t2|e3/);
    // Sessions hang off the user, not the org, so they are not walked down into.
    expect(out.tables.session).toBeUndefined();
  });

  it("refuses an export that would reach a second organization", async () => {
    // A user linked to both A and B, and a (hypothetical) column on organization that points down at the user.
    const tables: Record<string, Row[]> = {
      organization: [{ id: "A", ownerId: "u1" }, { id: "B", ownerId: "u1" }],
      user: [{ id: "u1" }],
    };
    const fks = [{ child: "organization", child_cols: ["ownerId"], parent: "user", parent_cols: ["id"] }];
    await expect(exportOrg(fakeDb(tables, fks), "A")).rejects.toThrow(/exactly one/);
  });

  it("imports into an empty database, and a second import changes nothing", async () => {
    const data = await exportOrg(fakeDb(sharedDocker()), "A");
    const target: Record<string, Row[]> = {};
    const first = await importOrg(fakeDb(target), data);
    expect(first.events).toBe(2);
    const again = await importOrg(fakeDb(target), data);
    expect(Object.values(again).every((n) => n === 0)).toBe(true);
    expect(target.events!.map((r) => r.id)).toEqual(["e1", "e2"]);
  });

  it("orders parents first and refuses a real cycle", () => {
    const fk = (child: string, parent: string): ForeignKey => ({ child, parent, childCols: ["x"], parentCols: ["id"] });
    expect(insertOrder(["c", "b", "a"], [fk("b", "a"), fk("c", "b")])).toEqual(["a", "b", "c"]);
    expect(() => insertOrder(["a", "b"], [fk("a", "b"), fk("b", "a")])).toThrow(/cycle/);
    expect(selfOrder([{ id: 2, x: 1 }, { id: 1, x: null }], [fk("t", "t")]).map((r) => r.id)).toEqual([1, 2]);
  });
});
