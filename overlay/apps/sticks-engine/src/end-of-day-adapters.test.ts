import { describe, expect, it } from "vitest";
import {
  activeChatsWhere,
  compactThroughEnd,
  dayBoundsUtc,
  endOfDayDeps,
  notConnectedEngram,
  type ThreadCursor,
} from "./end-of-day-adapters.js";

/** A thread held in memory; `compact` moves its cursor like upstream's compactHistory does. */
function fakeThread(start: ThreadCursor, step = 50) {
  const thread = { ...start };
  let compactCalls = 0;
  return {
    thread,
    get compactCalls() {
      return compactCalls;
    },
    compact: async () => {
      compactCalls++;
      const from = thread.historyCompactedUpToSeq ?? -1;
      const to = Math.min(thread.nextMessageSeq - 1, from + step);
      if (to > from) {
        thread.historyCompactedUpToSeq = to;
        thread.historyCompactionSummary = `summary through ${to}`;
      }
    },
    readThread: async () => ({ ...thread }),
  };
}

describe("end-of-day day bounds (brief task 18)", () => {
  it("the local day in a zone at UTC+2 starts and ends two hours before midnight UTC", () => {
    const { start, end } = dayBoundsUtc("2026-11-15", 120);
    expect(start.toISOString()).toBe("2026-11-14T22:00:00.000Z");
    expect(end.toISOString()).toBe("2026-11-15T22:00:00.000Z");
  });

  it("a day that is not YYYY-MM-DD is refused", () => {
    expect(() => dayBoundsUtc("15/11/2026", 0)).toThrow("YYYY-MM-DD");
  });
});

describe("compactThroughEnd: upstream's summariser moves the cursor to the end", () => {
  it("compacts in rounds until the cursor reaches the last message, then returns the summary", async () => {
    const fake = fakeThread({ nextMessageSeq: 120, historyCompactedUpToSeq: null, historyCompactionSummary: null }, 50);
    const summary = await compactThroughEnd(fake.compact, fake.readThread, "t1");
    expect(fake.thread.historyCompactedUpToSeq).toBe(119);
    expect(summary).toBe("summary through 119");
    expect(fake.compactCalls).toBe(3);
  });

  it("a thread already compacted to its last message is not summarised again", async () => {
    const fake = fakeThread({ nextMessageSeq: 10, historyCompactedUpToSeq: 9, historyCompactionSummary: "done" });
    const summary = await compactThroughEnd(fake.compact, fake.readThread, "t1");
    expect(summary).toBe("done");
    expect(fake.compactCalls).toBe(0);
  });

  it("a round that makes no progress stops the loop (the summariser refused)", async () => {
    const fake = fakeThread({ nextMessageSeq: 10, historyCompactedUpToSeq: null, historyCompactionSummary: null }, 0);
    await compactThroughEnd(fake.compact, fake.readThread, "t1");
    expect(fake.compactCalls).toBe(1);
  });

  it("the number of rounds is bounded", async () => {
    const fake = fakeThread({ nextMessageSeq: 10_000, historyCompactedUpToSeq: null, historyCompactionSummary: null }, 1);
    await compactThroughEnd(fake.compact, fake.readThread, "t1", 5);
    expect(fake.compactCalls).toBe(5);
  });
});

describe("the Engram write and the assembled deps (brief task 18)", () => {
  it("the not-connected Engram transport refuses every write with a clear message", async () => {
    await expect(notConnectedEngram().remember({ chatId: "c", day: "d", facts: "f" })).rejects.toThrow(
      "not connected yet",
    );
  });

  it("remember forwards the facts for the chat and day, and clear is a no-op", async () => {
    const written: { chatId: string; day: string; facts: string }[] = [];
    const fake = fakeThread({ nextMessageSeq: 3, historyCompactedUpToSeq: null, historyCompactionSummary: null }, 50);
    const deps = endOfDayDeps({
      activeChats: async () => [{ id: "t1" }],
      compact: fake.compact,
      readThread: fake.readThread,
      engram: {
        remember: async (input) => {
          written.push(input);
        },
      },
    });
    const facts = await deps.summarise("t1", "2026-11-15");
    await deps.remember({ chatId: "t1", day: "2026-11-15", facts });
    await deps.clearWorkingContext("t1");
    expect(written).toEqual([{ chatId: "t1", day: "2026-11-15", facts: "summary through 2" }]);
  });
});

describe("activeChatsWhere: the query's day bounds", () => {
  it("asks for bot threads with a message inside the local day, in UTC bounds", () => {
    expect(activeChatsWhere("2026-11-15", 120)).toEqual({
      botId: { not: null },
      messages: {
        some: {
          createdAt: { gte: new Date("2026-11-14T22:00:00.000Z"), lt: new Date("2026-11-15T22:00:00.000Z") },
        },
      },
    });
  });
});
