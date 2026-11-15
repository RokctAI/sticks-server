import { describe, expect, it } from "vitest";
import { startBootScheduler } from "./boot-pass.js";
import { endOfDayHookFromEnv, notConnectedEndOfDayDeps } from "./end-of-day-wiring.js";
import type { EndOfDayDeps } from "./end-of-day.js";

/** Deps that succeed and record each call, so the day and the chats can be checked. */
function recordingDeps() {
  const calls: string[] = [];
  const deps: EndOfDayDeps = {
    activeChats: async (day) => {
      calls.push(`chats:${day}`);
      return [{ id: "chat-1" }];
    },
    summarise: async () => "facts",
    remember: async () => {},
    clearWorkingContext: async () => {},
  };
  return { deps, calls };
}

describe("end of day from the environment (brief task 18)", () => {
  it("no STICKS_END_OF_DAY means no daily job", () => {
    expect(endOfDayHookFromEnv({}, recordingDeps().deps)).toBeUndefined();
    expect(endOfDayHookFromEnv({ STICKS_END_OF_DAY: "   " }, recordingDeps().deps)).toBeUndefined();
  });

  it("the next instant is the tenant's local end of day, with the zone offset", () => {
    const hook = endOfDayHookFromEnv(
      { STICKS_END_OF_DAY: "18:00", STICKS_TZ_OFFSET_MINUTES: "120" },
      recordingDeps().deps,
    );
    expect(hook?.nextAt(new Date("2026-11-15T10:00:00Z")).toISOString()).toBe("2026-11-15T16:00:00.000Z");
  });

  it("a run is for the day that ended at its instant, in the tenant's zone", async () => {
    const { deps, calls } = recordingDeps();
    const hook = endOfDayHookFromEnv({ STICKS_END_OF_DAY: "18:00", STICKS_TZ_OFFSET_MINUTES: "120" }, deps);
    await hook?.run(new Date("2026-11-15T16:00:00Z"));
    expect(calls).toEqual(["chats:2026-11-15"]);
  });

  it("a zone offset that is not a whole number of minutes is refused at start", () => {
    expect(() => endOfDayHookFromEnv({ STICKS_END_OF_DAY: "18:00", STICKS_TZ_OFFSET_MINUTES: "1.5" }, recordingDeps().deps)).toThrow(
      "whole number",
    );
  });

  it("a malformed end of day is refused at start", () => {
    expect(() => endOfDayHookFromEnv({ STICKS_END_OF_DAY: "6pm" }, recordingDeps().deps)).toThrow("HH:MM");
  });

  it("the not-connected adapters fail with a clear message, not silently", async () => {
    await expect(notConnectedEndOfDayDeps().activeChats("2026-11-15")).rejects.toThrow("not connected yet");
    await expect(notConnectedEndOfDayDeps().remember({ chatId: "c", day: "d", facts: "f" })).rejects.toThrow(
      "not connected yet",
    );
  });
});

describe("end of day in the boot scheduler's one timer", () => {
  it("a due end of day runs once at the first pass, and the scheduler stops cleanly", async () => {
    const runs: Date[] = [];
    let first = true;
    const hook = {
      // The first instant is already past (a restart after the end of day); the next is a day later.
      nextAt: (now: Date) => {
        if (first) {
          first = false;
          return new Date(now.getTime() - 1_000);
        }
        return new Date(now.getTime() + 24 * 60 * 60_000);
      },
      run: async (endAt: Date) => {
        runs.push(endAt);
      },
    };
    const emptyPrisma = {
      run: { findMany: async () => [], findFirst: async () => null },
      routine: { findMany: async () => [], findFirst: async () => null },
    };
    const jobs = { enqueue: async () => {} };
    const scheduler = startBootScheduler({
      prisma: emptyPrisma as never,
      jobs: jobs as never,
      endOfDay: hook,
      now: () => new Date("2026-11-15T10:00:00Z"),
    });
    await scheduler.ready;
    expect(runs).toHaveLength(1);
    scheduler.stop();
  });
});
