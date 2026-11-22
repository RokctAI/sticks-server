import { describe, expect, it } from "vitest";
import { DrainState, drainingOrgs, refusedWhileDraining, SiteDrainState } from "./drain.js";

describe("drain", () => {
  it("refuses writes but keeps reads and internal routes open", () => {
    expect(refusedWhileDraining(true, "POST", "/api/rpc/chat.send")).toBe(true);
    expect(refusedWhileDraining(true, "GET", "/api/rpc/thread.list")).toBe(false);
    expect(refusedWhileDraining(true, "POST", "/internal/resume")).toBe(false);
    expect(refusedWhileDraining(false, "POST", "/api/rpc/chat.send")).toBe(false);
  });
  it("survives a restart through the database", async () => {
    let row: unknown;
    const q = async (sql: string, p: unknown[] = []): Promise<unknown[]> => {
      if (sql.startsWith("INSERT")) row = { draining: p[0] };
      if (sql.startsWith("SELECT")) return row ? [row] : [];
      return [];
    };
    await new DrainState(q).set(true);
    expect(await new DrainState(q).load()).toBe(true);
  });
});

describe("drain one tenant", () => {
  it("keeps the draining organizations in memory and in the table, and survives a restart", async () => {
    const table = new Map<string, string>();
    const query = async (sql: string, p: unknown[] = []): Promise<unknown[]> => {
      if (sql.startsWith("INSERT")) table.set(p[0] as string, p[1] as string);
      if (sql.startsWith("DELETE")) table.delete(p[0] as string);
      if (sql.startsWith("SELECT")) return [...table.values()].map((org_id) => ({ org_id }));
      return [];
    };
    const d = new SiteDrainState(query);
    await d.set("a.example", "org-A", true);
    expect([...drainingOrgs]).toEqual(["org-A"]);
    drainingOrgs.clear();
    expect(await new SiteDrainState(query).load()).toBe(1);
    expect(drainingOrgs.has("org-A")).toBe(true);
    await d.set("a.example", "org-A", false);
    expect(drainingOrgs.size).toBe(0);
    expect(table.size).toBe(0);
  });
});
