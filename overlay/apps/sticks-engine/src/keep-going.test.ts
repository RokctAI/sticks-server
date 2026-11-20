// Every case from tests/test_sync.py KeepGoingTests, ported unchanged.
import { describe, expect, it } from "vitest";
import {
  continueText, decide, DEFAULT_POLICY, KeepGoingStore, NEW_STATE, onRunFinished, signatureOf,
  type Policy, type Snapshot, type StickState,
} from "./keep-going.js";

const snap = (kw: Partial<Snapshot> = {}): Snapshot => ({
  runStatus: "completed", runEndedAt: 100, lastMessageText: "Done with batch 1.", lastMessageFromOwner: false, lastMessageAt: 100,
  pendingTickets: [{ id: "T1", title: "Process the list", status: "doing" }], openScratchpad: [], blockedTickets: [], spendToday: 0, ...kw,
});
const pol: Policy = { ...DEFAULT_POLICY, enabled: true, maxSpendPerDay: 100 };
const st = (kw: Partial<StickState> = {}): StickState => ({ ...NEW_STATE, ...kw });
const dec = (s = snap(), p = pol, state = st(), now = 1000) => decide(s, p, state, now, "2026-11-09");

describe("keep-going decide (ported from scripts/keep_going.py)", () => {
  it("is on by default and can be switched off", () => {
    expect(DEFAULT_POLICY.enabled).toBe(true);
    expect(dec(snap(), DEFAULT_POLICY).send).toBe(true);
    expect(dec(snap(), { ...DEFAULT_POLICY, enabled: false }).send).toBe(false);
  });

  it("continues with an open ticket", () => expect(dec().send).toBe(true));

  it("counts the scratchpad, which can be turned off", () => {
    const s = snap({ pendingTickets: [], openScratchpad: [{ id: "S1", title: "list" }] });
    expect(dec(s).send).toBe(true);
    expect(dec(s, { ...DEFAULT_POLICY, maxSpendPerDay: 1, includeScratchpad: false }).send).toBe(false);
  });

  it("stops with no pending work", () => expect(dec(snap({ pendingTickets: [] })).send).toBe(false));

  it("is blocked by a paused run or a question", () => {
    expect(dec(snap({ runStatus: "waiting_input" })).send).toBe(false);
    expect(dec(snap({ runStatus: "waiting_takeover" })).send).toBe(false);
    expect(dec(snap({ lastMessageText: "Which list should I use?" })).send).toBe(false);
    expect(dec(snap({ lastMessageText: "Let me know when to go on." })).send).toBe(false);
    expect(dec(snap({ lastMessageText: "Saved 40 of 591. Next batch." })).send).toBe(true);
  });

  it("stops on failed, cancelled, running, or the owner speaking last", () => {
    expect(dec(snap({ runStatus: "failed" })).send).toBe(false);
    expect(dec(snap({ runStatus: "cancelled" })).send).toBe(false);
    expect(dec(snap({ runStatus: "running" })).send).toBe(false);
    expect(dec(snap({ lastMessageFromOwner: true, lastMessageAt: 101 })).send).toBe(false);
  });

  it("applies the caps", () => {
    const sig = signatureOf(snap(), pol);
    expect(dec(snap(), pol, st({ day: "2026-11-09", continuesToday: 20 })).reason).toContain("daily");
    expect(dec(snap(), pol, st({ lastContinueAt: 990 })).reason).toContain("too soon");
    expect(dec(snap({ spendToday: 100 })).reason).toContain("spend");
    expect(dec(snap({ spendToday: 5 }), DEFAULT_POLICY).reason).toContain("spend");
    expect(dec(snap(), { ...DEFAULT_POLICY, maxSpendPerDay: 0 }).reason).toContain("spend");
    expect(dec(snap(), pol, st({ lastSignature: sig, triesOnSignature: 3 })).reason).toContain("stalled");
    expect(dec(snap(), pol, st({ lastSignature: "old", triesOnSignature: 3 })).send).toBe(true);
  });

  it("resets the label when the open work changed", () => {
    const s = snap();
    expect(continueText(s, st({ lastSignature: signatureOf(s, pol), triesOnSignature: 2 }), pol)).toContain("auto-continue 3/3");
    expect(continueText(s, st({ lastSignature: "old", triesOnSignature: 2 }), pol)).toContain("auto-continue 1/3");
  });

  it("checks a done claim against the board", () => {
    expect(continueText(snap({ lastMessageText: "All done!" }), st(), pol)).toContain("You said this is done, but these are still open: Process the list");
  });

  it("wakes once, then waits out the gap, and saves the counters", async () => {
    const rows = new Map<string, { enabled: boolean; state: StickState }>();
    const query = async (sql: string, v: unknown[] = []) => {
      if (sql.startsWith("SELECT")) return rows.has(v[0] as string) ? [rows.get(v[0] as string)] : [];
      if (sql.includes("state")) rows.set(v[0] as string, { enabled: true, state: JSON.parse(v[1] as string) });
      return [];
    };
    const store = new KeepGoingStore(query);
    const woke: string[] = [];
    const wake = async (_b: string, text: string) => void woke.push(text);
    const settings = { enabled: true, maxNoProgress: 3, maxPerDay: 20, gapSeconds: 60 };
    const t0 = new Date("2026-11-09T10:00:00Z");
    expect((await onRunFinished(store, "b1", snap(), settings, wake, t0)).send).toBe(true);
    expect(woke[0]).toContain("auto-continue 1/3");
    expect((await onRunFinished(store, "b1", snap(), settings, wake, new Date(t0.getTime() + 10_000))).outcome).toBe("waiting");
    expect(woke).toHaveLength(1);
  });
});
