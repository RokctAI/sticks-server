// The end-of-day job's real steps (brief task 18), built on what the engine already has:
//   - activeChatsForDay: the bot chats with a message on the day (the tenant's zone).
//   - compactThroughEnd: moves the history-compaction cursor to the end of the thread using upstream's own
//     summariser (compactHistory, which reaches the model through the gateway). The summary stays on the
//     thread; the messages stay readable; the working window stops including the compacted messages.
//   - engramRemember: writes the facts to Engram through a transport. The Pulsar side is not built, so the
//     transport is injected; the engine's default throws "not connected".
// Upstream's own clear (events.ts) deletes messages, so it is NOT used here.
import type { EndOfDayDeps } from "./end-of-day.js";

/** The UTC instants where the local day `day` (YYYY-MM-DD in a zone at `offsetMinutes` from UTC) starts and ends. */
export function dayBoundsUtc(day: string, offsetMinutes: number): { start: Date; end: Date } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) throw new Error(`day must be YYYY-MM-DD, got ${day}`);
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const date = Number(match[3]);
  const start = Date.UTC(year, month, date) - offsetMinutes * 60_000;
  return { start: new Date(start), end: new Date(start + 24 * 60 * 60_000) };
}

/** The thread fields the compaction loop reads. */
export type ThreadCursor = {
  nextMessageSeq: number;
  historyCompactedUpToSeq: number | null;
  historyCompactionSummary: string | null;
};

/**
 * Runs upstream's summariser until the cursor reaches the last message, or stops when a round makes no
 * progress (the summariser refused, or a summary is too large). Returns the thread's summary text.
 * `compact` is upstream's compactHistory bound to the engine's deps; `readThread` reads the thread's fields.
 */
export async function compactThroughEnd(
  compact: (threadId: string) => Promise<void>,
  readThread: (threadId: string) => Promise<ThreadCursor>,
  threadId: string,
  maxRounds = 20,
): Promise<string> {
  for (let round = 0; round < maxRounds; round++) {
    const before = await readThread(threadId);
    const lastSeq = before.nextMessageSeq - 1;
    if (lastSeq < 0 || (before.historyCompactedUpToSeq ?? -1) >= lastSeq) break;
    await compact(threadId);
    const after = await readThread(threadId);
    if ((after.historyCompactedUpToSeq ?? -1) === (before.historyCompactedUpToSeq ?? -1)) break;
  }
  return (await readThread(threadId)).historyCompactionSummary ?? "";
}

/** Engram write through Pulsar. The transport is injected; Pulsar's endpoint is a core-side build. */
export type EngramTransport = {
  remember(input: { chatId: string; day: string; facts: string }): Promise<void>;
};

/** A transport that refuses every write until Pulsar's Engram endpoint is connected. */
export function notConnectedEngram(): EngramTransport {
  return {
    remember: async () => {
      throw new Error("end of day: Engram write through Pulsar is not connected yet");
    },
  };
}

/** The chats with at least one message on the day. Bot chats only (a thread with a bot). */
export async function activeChatsForDay(
  prisma: {
    thread: {
      findMany(args: {
        where: unknown;
        select: { id: true };
        take: number;
      }): Promise<{ id: string }[]>;
    };
  },
  day: string,
  offsetMinutes: number,
): Promise<{ id: string }[]> {
  const { start, end } = dayBoundsUtc(day, offsetMinutes);
  return prisma.thread.findMany({
    where: {
      botId: { not: null },
      messages: { some: { createdAt: { gte: start, lt: end } } },
    },
    select: { id: true },
    take: 500,
  });
}

/** Builds the EndOfDayDeps from the pieces above. `compact` and `readThread` come from the engine. */
export function endOfDayDeps(options: {
  activeChats: (day: string) => Promise<{ id: string }[]>;
  compact: (threadId: string) => Promise<void>;
  readThread: (threadId: string) => Promise<ThreadCursor>;
  engram: EngramTransport;
}): EndOfDayDeps {
  return {
    activeChats: options.activeChats,
    summarise: (chatId) => compactThroughEnd(options.compact, options.readThread, chatId),
    remember: (input) => options.engram.remember(input),
    // The cursor already moved in summarise, so the working window excludes the day's messages. Nothing
    // is deleted, so there is nothing to clear here; kept as a step so the order stays visible.
    clearWorkingContext: async () => {},
  };
}
