// Holds the end-of-day job in the boot scheduler's one timer (spec 7.6; brief task 18). The schedule comes
// from the environment: STICKS_END_OF_DAY ("HH:MM", the tenant's local time) and STICKS_TZ_OFFSET_MINUTES
// (the zone's offset from UTC, east positive, default 0). Unset STICKS_END_OF_DAY means no daily job.
import { dayEndingAt, nextEndOfDayAt, runEndOfDay, type EndOfDayDeps, type EndOfDayResult } from "./end-of-day.js";
import { endOfDayDeps, notConnectedEngram, type ThreadCursor } from "./end-of-day-adapters.js";

/** The zone offset from the environment (STICKS_TZ_OFFSET_MINUTES), validated. Default 0. */
export function tzOffsetFromEnv(env: NodeJS.ProcessEnv): number {
  const offsetText = (env.STICKS_TZ_OFFSET_MINUTES ?? "0").trim();
  const offset = Number(offsetText);
  if (!/^-?\d+$/.test(offsetText) || !Number.isInteger(offset) || Math.abs(offset) > 14 * 60) {
    throw new Error(`STICKS_TZ_OFFSET_MINUTES must be a whole number of minutes within 14 hours, got ${offsetText}`);
  }
  return offset;
}

/**
 * The engine's end-of-day deps. The chat listing and cursor reads come from the engine (its typed Prisma
 * client). The summariser needs upstream's compaction runtime, which the engine does not expose yet, so it
 * fails with a clear message; the Engram write is not connected (Pulsar side).
 */
export function engineEndOfDayDeps(options: {
  activeChats: (day: string) => Promise<{ id: string }[]>;
  readThread: (threadId: string) => Promise<ThreadCursor>;
}): EndOfDayDeps {
  return endOfDayDeps({
    activeChats: options.activeChats,
    compact: async () => {
      throw new Error(
        "end of day: upstream's summariser (compactHistory) needs the agent runtime, which the engine does not expose yet",
      );
    },
    readThread: options.readThread,
    engram: notConnectedEngram(),
  });
}

/** What the boot scheduler needs: the next end of day after a time, and a run for the day that ended at `endAt`. */
export type EndOfDayHook = {
  nextAt(now: Date): Date;
  run(endAt: Date): Promise<void>;
};

/**
 * The hook for the boot scheduler, or undefined when no end of day is configured.
 * `onResult` receives each day's per-chat outcome (remembered and failed chats).
 */
export function endOfDayHookFromEnv(
  env: NodeJS.ProcessEnv,
  deps: EndOfDayDeps,
  onResult?: (result: EndOfDayResult) => void,
): EndOfDayHook | undefined {
  const endOfDay = (env.STICKS_END_OF_DAY ?? "").trim();
  if (!endOfDay) return undefined;
  const offset = tzOffsetFromEnv(env);
  // Validates the time once, now, so a bad value stops startup rather than failing each day.
  nextEndOfDayAt(new Date(0), endOfDay, offset);
  return {
    nextAt: (now) => nextEndOfDayAt(now, endOfDay, offset),
    run: async (endAt) => {
      const result = await runEndOfDay(dayEndingAt(endAt, offset), deps);
      onResult?.(result);
    },
  };
}

/** Deps for the adapters that are not connected yet. Each one throws, so a day that runs without them fails loudly. */
export function notConnectedEndOfDayDeps(): EndOfDayDeps {
  const fail = (name: string): never => {
    throw new Error(`end of day: ${name} is not connected yet (see docs/pulsar-engine-interface.md section 5)`);
  };
  return {
    activeChats: async () => fail("active chat listing"),
    summarise: async () => fail("history summary through the gateway"),
    remember: async () => fail("Engram write through Pulsar"),
    clearWorkingContext: async () => fail("working context clear"),
  };
}
