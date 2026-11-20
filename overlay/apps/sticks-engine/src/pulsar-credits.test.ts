import { describe, expect, it } from "vitest";
import { CreditsRefused, microsOf, RunCredits, settleLeftovers, type CreditsTransport } from "./pulsar-credits.js";

type Row = { run_id: string; block_micros: number; used_micros: number; usage: unknown; settled_at: Date | null };

function fakeDb() {
  const rows = new Map<string, Row>();
  const query = async (sql: string, v: unknown[] = []) => {
    if (sql.startsWith("INSERT")) rows.has(v[0] as string) || rows.set(v[0] as string, { run_id: v[0] as string, block_micros: v[1] as number, used_micros: 0, usage: null, settled_at: null });
    else if (sql.includes("SET used_micros")) Object.assign(rows.get(v[0] as string)!, { used_micros: v[1], usage: JSON.parse(v[2] as string) });
    else if (sql.includes("SET block_micros")) rows.get(v[0] as string)!.block_micros += v[1] as number;
    else if (sql.includes("SET settled_at")) rows.get(v[0] as string)!.settled_at = new Date();
    else if (sql.startsWith("SELECT")) return [...rows.values()].filter((r) => !r.settled_at);
    return [];
  };
  return { rows, query };
}

function fakePulsar(opts: { reserve?: number | string; extend?: number | string } = {}) {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const settled = new Set<string>();
  const t: CreditsTransport = {
    call: async (path, body) => {
      calls.push([path, body]);
      if (path === "/credits/reserve") return typeof opts.reserve === "string" ? { ok: false, reason: opts.reserve } : { ok: true, block_micros: opts.reserve ?? 100_000 };
      if (path === "/credits/extend") return typeof opts.extend === "string" ? { ok: false, reason: opts.extend } : { ok: true, block_micros: opts.extend ?? 100_000 };
      settled.add(body.run as string);
      return { ok: true };
    },
  };
  return { t, calls, settled };
}

const run = { runId: "r1", stickId: "s1", userId: "u1" };

describe("credits from Pulsar (brief task 12)", () => {
  it("does not start a run Pulsar refuses, and says why", async () => {
    const p = fakePulsar({ reserve: "no credits left" });
    await expect(RunCredits.start(p.t, fakeDb().query, run)).rejects.toThrow(new CreditsRefused("no credits left"));
  });

  it("spends in memory and extends below 20 percent", async () => {
    const p = fakePulsar();
    const rc = await RunCredits.start(p.t, fakeDb().query, run);
    await rc.beforeCall({ maxCostUsd: 0.05 }); // 50,000 of 100,000
    expect(p.calls.filter(([c]) => c === "/credits/extend")).toHaveLength(0);
    await rc.beforeCall({ maxCostUsd: 0.04 }); // would leave 10 percent: extend first
    expect(p.calls.filter(([c]) => c === "/credits/extend")).toHaveLength(1);
  });

  it("throws credits exhausted when the extend is refused and the block is spent", async () => {
    const p = fakePulsar({ extend: "limit reached" });
    const rc = await RunCredits.start(p.t, fakeDb().query, run);
    await expect(rc.beforeCall({ maxCostUsd: 0.09 })).rejects.toThrow(CreditsRefused);
  });

  it("settles a crashed run at boot, and a double settle is harmless", async () => {
    const p = fakePulsar();
    const db = fakeDb();
    const rc = await RunCredits.start(p.t, db.query, run);
    await rc.beforeCall({ maxCostUsd: 0.01 });
    await rc.afterCall("x", { inputTokens: 10, costUsd: 0.004 });
    // Crash: settle never called. Next boot:
    expect(await settleLeftovers(p.t, db.query)).toBe(1);
    expect(p.calls.at(-1)).toEqual(["/credits/settle", { run: "r1", used_micros: 4000, usage: { inputTokens: 10, costUsd: 0.004 } }]);
    expect(await settleLeftovers(p.t, db.query)).toBe(0);
    await rc.settle();
    await rc.settle();
    expect(p.calls.filter(([c]) => c === "/credits/settle")).toHaveLength(2); // boot once, run end once; Pulsar dedupes on run id
  });

  it("counts an unknown cost as one credit", () => {
    expect(microsOf(undefined)).toBe(10_000);
    expect(microsOf(0.0000011)).toBe(2);
  });
});
