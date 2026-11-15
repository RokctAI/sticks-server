import { describe, expect, it } from "vitest";
import { dayEndingAt, nextEndOfDayAt, runEndOfDay, type EndOfDayDeps } from "./end-of-day.js";

/** A fake of every dependency; each call is recorded so the order can be checked. */
function fakeDeps(overrides: Partial<EndOfDayDeps> = {}) {
  const calls: string[] = [];
  const deps: EndOfDayDeps = {
    activeChats: async () => [{ id: "chat-1" }, { id: "chat-2" }],
    summarise: async (chatId) => {
      calls.push(`summarise:${chatId}`);
      return `facts for ${chatId}`;
    },
    remember: async ({ chatId }) => {
      calls.push(`remember:${chatId}`);
    },
    clearWorkingContext: async (chatId) => {
      calls.push(`clear:${chatId}`);
    },
    ...overrides,
  };
  return { deps, calls };
}

describe("end of day: the next wake time (spec 7.6, no timer of its own)", () => {
  it("the next 18:00 in a zone at UTC+2, after a time before it", () => {
    const now = new Date("2026-11-15T10:00:00Z"); // 12:00 local
    expect(nextEndOfDayAt(now, "18:00", 120).toISOString()).toBe("2026-11-15T16:00:00.000Z");
  });

  it("after today's end of day has passed, the next one is tomorrow", () => {
    const now = new Date("2026-11-15T17:00:00Z"); // 19:00 local
    expect(nextEndOfDayAt(now, "18:00", 120).toISOString()).toBe("2026-11-16T16:00:00.000Z");
  });

  it("exactly at the end of day, the next one is tomorrow (strictly after now)", () => {
    const now = new Date("2026-11-15T16:00:00Z"); // 18:00 local
    expect(nextEndOfDayAt(now, "18:00", 120).toISOString()).toBe("2026-11-16T16:00:00.000Z");
  });

  it("a negative offset (west of UTC) works", () => {
    const now = new Date("2026-11-15T12:00:00Z"); // 07:00 local at UTC-5
    expect(nextEndOfDayAt(now, "23:30", -300).toISOString()).toBe("2026-11-16T04:30:00.000Z");
  });

  it("a malformed time is refused", () => {
    expect(() => nextEndOfDayAt(new Date(), "6pm", 0)).toThrow("HH:MM");
    expect(() => nextEndOfDayAt(new Date(), "24:00", 0)).toThrow("HH:MM");
  });

  it("the day that ends at an instant is the local date", () => {
    expect(dayEndingAt(new Date("2026-11-15T22:30:00Z"), 120)).toBe("2026-11-16");
    expect(dayEndingAt(new Date("2026-11-15T22:30:00Z"), -120)).toBe("2026-11-15");
  });
});

describe("end of day: one run (brief task 18)", () => {
  it("each active chat is summarised, remembered, then cleared, in that order", async () => {
    const { deps, calls } = fakeDeps();
    const result = await runEndOfDay("2026-11-15", deps);
    expect(calls).toEqual([
      "summarise:chat-1",
      "remember:chat-1",
      "clear:chat-1",
      "summarise:chat-2",
      "remember:chat-2",
      "clear:chat-2",
    ]);
    expect(result).toEqual({ day: "2026-11-15", remembered: ["chat-1", "chat-2"], failed: [] });
  });

  it("the facts written to memory are the summary, for that chat and day", async () => {
    const seen: { chatId: string; day: string; facts: string }[] = [];
    const { deps } = fakeDeps({
      activeChats: async () => [{ id: "chat-9" }],
      remember: async (input) => {
        seen.push(input);
      },
    });
    await runEndOfDay("2026-11-15", deps);
    expect(seen).toEqual([{ chatId: "chat-9", day: "2026-11-15", facts: "facts for chat-9" }]);
  });

  it("a failed memory write keeps the chat's working context (not cleared), and the other chats still run", async () => {
    const { deps, calls } = fakeDeps({
      remember: async ({ chatId }) => {
        calls.push(`remember:${chatId}`);
        if (chatId === "chat-1") throw new Error("engram down");
      },
    });
    const result = await runEndOfDay("2026-11-15", deps);
    expect(calls).not.toContain("clear:chat-1");
    expect(calls).toContain("clear:chat-2");
    expect(result.failed).toEqual([{ chatId: "chat-1", step: "remember", message: "engram down" }]);
    expect(result.remembered).toEqual(["chat-2"]);
  });

  it("a failed summary writes nothing and clears nothing for that chat", async () => {
    const { deps, calls } = fakeDeps({
      summarise: async (chatId) => {
        calls.push(`summarise:${chatId}`);
        if (chatId === "chat-1") throw new Error("gateway 402");
        return "ok";
      },
    });
    const result = await runEndOfDay("2026-11-15", deps);
    expect(calls.filter((c) => c.endsWith("chat-1"))).toEqual(["summarise:chat-1"]);
    expect(result.failed).toEqual([{ chatId: "chat-1", step: "summarise", message: "gateway 402" }]);
  });

  it("a failed clear is reported as a clear step failure; the memory write stands", async () => {
    const { deps } = fakeDeps({
      clearWorkingContext: async (chatId) => {
        if (chatId === "chat-2") throw new Error("database busy");
      },
    });
    const result = await runEndOfDay("2026-11-15", deps);
    expect(result.remembered).toEqual(["chat-1", "chat-2"]);
    expect(result.failed).toEqual([{ chatId: "chat-2", step: "clear", message: "database busy" }]);
  });

  it("no active chats means nothing to do", async () => {
    const { deps, calls } = fakeDeps({ activeChats: async () => [] });
    const result = await runEndOfDay("2026-11-15", deps);
    expect(calls).toEqual([]);
    expect(result).toEqual({ day: "2026-11-15", remembered: [], failed: [] });
  });
});
