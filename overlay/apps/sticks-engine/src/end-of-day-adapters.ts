// The end-of-day job's real steps (brief task 18), built on what the engine already has:
//   - activeChatsForDay: the bot chats with a message on the day (the tenant's zone).
//   - compactThroughEnd: moves the history-compaction cursor to the end of the thread using upstream's own
//     summariser (compactHistory, which reaches the model through the gateway). The summary stays on the
//     thread; the messages stay readable; the working window stops including the compacted messages.
//   - engramRemember: writes the facts to Engram through a transport. The Pulsar side is not built, so the
//     transport is injected; the engine's default throws "not connected".
// Upstream's own clear (events.ts) deletes messages, so it is NOT used here.
import { request } from "node:http";
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

/**
 * Engram write over the Pulsar unix socket (STICKS_PULSAR_SOCKET) with the engine secret:
 * POST /engram/remember {tenant, chat, day, facts}. Any answer other than {ok: true} is a failure, so the chat's
 * working context is kept and the write is tried again next time.
 */
export function socketEngram(
  socketPath: string,
  secret: string,
  tenant: string,
  post: (socketPath: string, path: string, secret: string, body: unknown) => Promise<{ ok?: boolean; reason?: string }> = pulsarPost,
): EngramTransport {
  return {
    remember: async ({ chatId, day, facts }) => {
      const r = await post(socketPath, "/engram/remember", secret, { tenant, chat: chatId, day, facts });
      if (r.ok !== true) throw new Error(`end of day: Engram refused the write: ${r.reason ?? "no reason"}`);
    },
  };
}

/** One JSON POST to Pulsar over its unix socket. */
export function pulsarPost(socketPath: string, path: string, secret: string, body: unknown, timeoutMs = 20_000): Promise<{ ok?: boolean; reason?: string }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = request(
      { socketPath, path, method: "POST", timeout: timeoutMs, headers: { "content-type": "application/json", authorization: `Bearer ${secret}`, "content-length": Buffer.byteLength(payload) } },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (text += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(text) as { ok?: boolean; reason?: string });
          } catch {
            reject(new Error(`pulsar answered HTTP ${res.statusCode} without JSON`));
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("pulsar call timed out")));
    req.on("error", reject);
    req.end(payload);
  });
}

/**
 * The where clause of the active-chat query: bot threads with at least one message inside the local day.
 * The engine runs it with its own typed client (a structural Prisma type does not match the real client).
 */
export function activeChatsWhere(
  day: string,
  offsetMinutes: number,
): { botId: { not: null }; messages: { some: { createdAt: { gte: Date; lt: Date } } } } {
  const { start, end } = dayBoundsUtc(day, offsetMinutes);
  return {
    botId: { not: null },
    messages: { some: { createdAt: { gte: start, lt: end } } },
  };
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
