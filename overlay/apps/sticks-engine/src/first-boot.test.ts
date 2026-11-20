import { describe, expect, it } from "vitest";
import { applyBlock, applyStickDefaults, DEFAULT_BLOCK, END, ensureTenantSpace, spaceName, START } from "./first-boot.js";

describe("first boot (brief task 10)", () => {
  it("applyBlock adds, replaces and repairs the block like scripts/stick_defaults.py", () => {
    const block = `${START}\nnew\n${END}`;
    expect(applyBlock("", block)).toBe(`${block}\n`);
    expect(applyBlock("mine\n", block)).toBe(`mine\n\n${block}\n`);
    expect(applyBlock(`mine\n\n${START}\nold\n${END}\nafter`, block)).toBe(`mine\n\n${block}\nafter`);
    expect(applyBlock(`mine ${START} half`, block)).toBe(`mine  half\n\n${block}\n`);
    expect(applyBlock(applyBlock("x", block), block)).toBe(applyBlock("x", block));
  });

  it("spaceName trims, collapses spaces and keeps 60 characters", () => {
    expect(spaceName("  Acme   Water  ")).toBe("Acme Water");
    expect(spaceName("x".repeat(80))).toHaveLength(60);
    expect(spaceName("   ")).toBe("Workspace");
  });

  it("creates the organization and space once, then only renames", async () => {
    const calls: string[] = [];
    let org: string | undefined;
    let space: { id: string; name: string } | undefined;
    const query = async (sql: string, values: unknown[] = []) => {
      calls.push(sql);
      if (sql.startsWith("SELECT id FROM organization")) return org ? [{ id: org }] : [];
      if (sql.startsWith("SELECT id, name FROM spaces")) return space ? [space] : [];
      if (sql.startsWith("INSERT INTO organization")) org = values[0] as string;
      if (sql.startsWith("INSERT INTO spaces")) space = { id: values[0] as string, name: values[2] as string };
      if (sql.startsWith("UPDATE spaces")) space = { id: values[0] as string, name: values[1] as string };
      return [];
    };
    const first = await ensureTenantSpace(query, "Acme");
    expect(first.created).toBe(true);
    const second = await ensureTenantSpace(query, "Acme");
    expect(second).toEqual({ orgId: first.orgId, spaceId: first.spaceId, created: false });
    expect(calls.filter((s) => s.startsWith("INSERT")).length).toBe(2);
    await ensureTenantSpace(query, "Acme Two");
    expect(space?.name).toBe("Acme Two");
  });

  it("applies the block to Sticks that lack it, skips ones that have it, and loses to a concurrent edit", async () => {
    const block = `${START}\nb\n${END}`;
    const bots = [
      { id: "a", instructions: "" },
      { id: "b", instructions: `${block}` },
      { id: "c", instructions: "edited meanwhile" },
    ];
    const updates: unknown[][] = [];
    const query = async (sql: string, values: unknown[] = []) => {
      if (sql.startsWith("SELECT")) return bots;
      updates.push(values);
      return values[0] === "c" ? [] : [{ id: values[0] }];
    };
    expect(await applyStickDefaults(query, block)).toBe(1);
    expect(updates.map((v) => v[0])).toEqual(["a", "c"]);
  });
});
