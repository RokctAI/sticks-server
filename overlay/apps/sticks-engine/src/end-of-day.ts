// End-of-day memory (spec 7.6 and the owner's ruling of 14 Nov; brief task 18). Once a day per tenant:
//   1. each chat active that day is summarised with the engine's own history-summary code (through the gateway);
//   2. the lasting facts are written to Engram through the memory adapter (Pulsar side is not built: a fake here);
//   3. that chat's working context is cleared, only after step 2 succeeded, so nothing is lost on failure.
// The job has no timer of its own: its time is the tenant's next_wake_at (spec 7.6). Nothing here polls.

export type EndOfDayChat = { id: string };

export type EndOfDayDeps = {
  /** Chats with activity on the given day (YYYY-MM-DD in the tenant's zone). */
  activeChats(day: string): Promise<readonly EndOfDayChat[]>;
  /** The engine's history-summary code, through the gateway. Returns the chat's summary text. */
  summarise(chatId: string, day: string): Promise<string>;
  /** Writes the lasting facts to Engram via Pulsar. Rejects on failure. */
  remember(input: { chatId: string; day: string; facts: string }): Promise<void>;
  /** Clears the chat's working context so the next day starts small. The messages stay readable. */
  clearWorkingContext(chatId: string): Promise<void>;
};

export type EndOfDayResult = {
  day: string;
  remembered: string[];
  failed: { chatId: string; step: "summarise" | "remember" | "clear"; message: string }[];
};

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * The next instant at which the tenant's end of day falls, strictly after `now`.
 * `endOfDay` is local time "HH:MM"; `offsetMinutes` is the tenant zone's offset from UTC (east positive).
 */
export function nextEndOfDayAt(now: Date, endOfDay: string, offsetMinutes: number): Date {
  const match = HHMM.exec(endOfDay);
  if (!match) throw new Error(`end of day must be HH:MM, got ${endOfDay}`);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const localNow = new Date(now.getTime() + offsetMinutes * 60_000);
  const candidateLocal = Date.UTC(
    localNow.getUTCFullYear(),
    localNow.getUTCMonth(),
    localNow.getUTCDate(),
    hour,
    minute,
  );
  let candidate = candidateLocal - offsetMinutes * 60_000;
  if (candidate <= now.getTime()) candidate += 24 * 60 * 60_000;
  return new Date(candidate);
}

/** The day (YYYY-MM-DD in the tenant's zone) that ends at the given instant. */
export function dayEndingAt(at: Date, offsetMinutes: number): string {
  const local = new Date(at.getTime() + offsetMinutes * 60_000);
  return local.toISOString().slice(0, 10);
}

/**
 * Runs the end-of-day step for one day. A chat whose remember step fails keeps its working context, so
 * the next run retries it. Per-chat failures are reported; they do not stop the other chats.
 */
export async function runEndOfDay(day: string, deps: EndOfDayDeps): Promise<EndOfDayResult> {
  const result: EndOfDayResult = { day, remembered: [], failed: [] };
  const chats = await deps.activeChats(day);
  for (const chat of chats) {
    let facts: string;
    try {
      facts = await deps.summarise(chat.id, day);
    } catch (error) {
      result.failed.push({ chatId: chat.id, step: "summarise", message: messageOf(error) });
      continue;
    }
    try {
      await deps.remember({ chatId: chat.id, day, facts });
    } catch (error) {
      result.failed.push({ chatId: chat.id, step: "remember", message: messageOf(error) });
      continue;
    }
    result.remembered.push(chat.id);
    try {
      await deps.clearWorkingContext(chat.id);
    } catch (error) {
      result.failed.push({ chatId: chat.id, step: "clear", message: messageOf(error) });
    }
  }
  return result;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
