import { describe, expect, it } from "vitest";
import { KeepGoingStore } from "./keep-going.js";
import { blocksText, keepGoingAfterRun, type KeepGoingDeps, type SnapshotReader } from "./keep-going-wiring.js";

const E = { runId: "r1", outcome: "completed", spaceId: "s1", threadId: "t1", botId: "b1" };
const NOW = new Date("2026-11-23T08:00:00Z");
const SETTINGS = { enabled: true, maxNoProgress: 3, maxPerDay: 20, gapSeconds: 60 };

function db(goal?: { goal: string; done: boolean }) {
  const kg = new Map<string, unknown>();
  return async (sql: string, p: unknown[] = []): Promise<unknown[]> => {
    if (sql.includes("FROM sticks_goals")) return goal ? [{ goal: goal.goal, done_at: goal.done ? NOW : null, done_note: null }] : [];
    if (sql.includes("FROM sticks_keep_going")) return kg.has(p[0] as string) ? [kg.get(p[0] as string)] : [];
    if (sql.startsWith("INSERT INTO sticks_keep_going")) kg.set(p[0] as string, { enabled: true, state: JSON.parse(p[1] as string) });
    return [];
  };
}

function reader(over: Partial<SnapshotReader> = {}): SnapshotReader {
  return {
    run: async () => ({ status: "completed", completedAt: new Date(NOW.getTime() - 120_000), userId: "u1" }),
    lastMessage: async () => ({ role: "bot", blocks: [{ kind: "text", text: "Done the first part." }], createdAt: new Date(NOW.getTime() - 120_000) }),
    tickets: async () => [],
    scratchpad: async () => [],
    ...over,
  };
}

function deps(query: ReturnType<typeof db>, read: SnapshotReader, onDuty = true) {
  const queued: Array<{ prompt: string; delay: number }> = [];
  const d: KeepGoingDeps = {
    store: new KeepGoingStore(query),
    query,
    read,
    settings: () => SETTINGS,
    onDuty: async () => onDuty,
    queueFollowUp: async (_e, _u, prompt, delay) => void queued.push({ prompt, delay }),
    now: () => NOW,
  };
  return { d, queued };
}

describe("keep-going after a run (wired through the run-finished hook)", () => {
  it("an unfinished goal keeps the Stick going: one follow-up queued, mentioning the goal", async () => {
    const { d, queued } = deps(db({ goal: "invoice every open job", done: false }), reader());
    expect(await keepGoingAfterRun(d, E)).toBe("continue");
    expect(queued).toHaveLength(1);
    expect(queued[0]!.prompt).toContain("invoice every open job");
    expect(queued[0]!.delay).toBe(60);
  });
  it("a finished goal and no open work: complete, nothing queued", async () => {
    const { d, queued } = deps(db({ goal: "x", done: true }), reader());
    expect(await keepGoingAfterRun(d, E)).toBe("complete");
    expect(queued).toHaveLength(0);
  });
  it("open tickets keep it going; a question to the owner stops it", async () => {
    const tickets = async () => [{ id: "k1", title: "Send quote", status: "todo" }];
    expect(await keepGoingAfterRun(deps(db(), reader({ tickets })).d, E)).toBe("continue");
    const asks = reader({ tickets, lastMessage: async () => ({ role: "bot", blocks: [{ kind: "text", text: "Should I send it now?" }], createdAt: NOW }) });
    expect(await keepGoingAfterRun(deps(db(), asks).d, E)).toBe("blocked");
  });
  it("off duty or outside hours: not pushed on", async () => {
    const { d, queued } = deps(db({ goal: "x", done: false }), reader(), false);
    expect(await keepGoingAfterRun(d, E)).toBe("resting");
    expect(queued).toHaveLength(0);
  });
  it("only completed runs count", async () => {
    expect(await keepGoingAfterRun(deps(db({ goal: "x", done: false }), reader()).d, { ...E, outcome: "failed" })).toBe("not completed");
  });
  it("reads only text blocks", () => {
    expect(blocksText([{ kind: "text", text: "a" }, { kind: "image" }, { kind: "text", text: "b" }])).toBe("a\nb");
  });
});
