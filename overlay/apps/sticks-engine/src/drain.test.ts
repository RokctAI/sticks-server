import { describe, expect, it } from "vitest";
import { DrainState, refusedWhileDraining } from "./drain.js";

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
