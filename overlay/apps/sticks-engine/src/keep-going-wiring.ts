// Keep-going and the goal loop, wired to the engine (Ray 11-11: "completion loop … Kilo's /goal system"; brief
// task 14). keep-going.ts decided what to do but nothing called it. Now upstream tells us when a run is finalized
// (patch 0006, runFinishedHooks); this reads what the Stick still has open (its tickets, its scratchpad, and the
// chat's goal if one is set), asks keep-going.ts, and when the answer is "continue" queues one follow-up run with
// the continue text, the same way upstream queues a group handoff (a task and a queued run, then run.continue).
// It respects working hours and off duty (duty.ts): a resting Stick is not pushed on.
// The goal: a person (or the Stick) sets a goal on a chat through the built-in "goal" plugin. Until the Stick
// marks it done, the goal counts as open work, so the Stick keeps going toward it within keep-going's caps.
import type { SqlQuery } from "./plugin-draft-store.js";
import { onRunFinished, type KeepGoingStore, type Item, type Snapshot } from "./keep-going.js";

export const GOALS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS sticks_goals (
  thread_id text PRIMARY KEY,
  goal text NOT NULL,
  done_at timestamptz,
  done_note text,
  updated_at timestamptz NOT NULL DEFAULT now()
)`;

export type RunFinished = { runId: string; outcome: string; spaceId: string; threadId: string; botId: string };

export class GoalError extends Error {}

export async function setGoal(query: SqlQuery, threadId: string, goal: unknown): Promise<{ goal: string }> {
  if (typeof goal !== "string" || !goal.trim()) throw new GoalError("goal must be a non-empty text");
  const text = goal.trim().slice(0, 1000);
  await query(
    `INSERT INTO sticks_goals (thread_id, goal) VALUES ($1, $2)
     ON CONFLICT (thread_id) DO UPDATE SET goal = EXCLUDED.goal, done_at = NULL, done_note = NULL, updated_at = now()`,
    [threadId, text],
  );
  return { goal: text };
}

export async function completeGoal(query: SqlQuery, threadId: string, note: unknown): Promise<boolean> {
  const rows = (await query(
    `UPDATE sticks_goals SET done_at = now(), done_note = $2, updated_at = now() WHERE thread_id = $1 AND done_at IS NULL RETURNING 1`,
    [threadId, typeof note === "string" ? note.slice(0, 1000) : null],
  )) as unknown[];
  return rows.length > 0;
}

export async function readGoal(query: SqlQuery, threadId: string): Promise<{ goal: string; done: boolean; note: string | null } | undefined> {
  const rows = (await query(`SELECT goal, done_at, done_note FROM sticks_goals WHERE thread_id = $1`, [threadId])) as Array<{
    goal: string;
    done_at: unknown;
    done_note: string | null;
  }>;
  return rows[0] ? { goal: rows[0].goal, done: rows[0].done_at != null, note: rows[0].done_note } : undefined;
}

/** Text of a message's blocks (upstream's MessageBlock list); non-text blocks are left out. */
export function blocksText(blocks: unknown): string {
  if (!Array.isArray(blocks)) return "";
  return blocks
    .filter((b): b is { kind: string; text: string } => !!b && (b as { kind?: unknown }).kind === "text" && typeof (b as { text?: unknown }).text === "string")
    .map((b) => b.text)
    .join("\n");
}

/** What the snapshot needs, read through upstream's Prisma client (which decrypts message content). */
export type SnapshotReader = {
  run(runId: string): Promise<{ status: string; completedAt: Date | null; userId: string } | null>;
  lastMessage(threadId: string): Promise<{ role: string; blocks: unknown; createdAt: Date } | null>;
  tickets(botId: string): Promise<Array<{ id: string; title: string; status: string }>>;
  scratchpad(botId: string): Promise<Array<{ id: string; title: string; status: string }>>;
};

export async function snapshotFor(read: SnapshotReader, query: SqlQuery, e: RunFinished): Promise<{ snap: Snapshot; userId: string } | null> {
  const run = await read.run(e.runId);
  if (!run) return null;
  const [last, tickets, pad, goal] = await Promise.all([read.lastMessage(e.threadId), read.tickets(e.botId), read.scratchpad(e.botId), readGoal(query, e.threadId)]);
  const pending: Item[] = tickets.filter((t) => t.status === "todo" || t.status === "doing").map((t) => ({ id: t.id, title: t.title, status: t.status }));
  if (goal && !goal.done) pending.unshift({ id: "goal", title: `Goal: ${goal.goal} (when it is done, mark it done with the goal plugin)`, status: "doing" });
  const ended = (run.completedAt ?? new Date()).getTime() / 1000;
  return {
    userId: run.userId,
    snap: {
      runStatus: run.status,
      runEndedAt: ended,
      lastMessageText: last && last.role === "bot" ? blocksText(last.blocks) : "",
      lastMessageFromOwner: last?.role === "user",
      lastMessageAt: last ? last.createdAt.getTime() / 1000 : 0,
      pendingTickets: pending,
      openScratchpad: pad.filter((p) => p.status === "open").map((p) => ({ id: p.id, title: p.title })),
      blockedTickets: tickets.filter((t) => t.status === "blocked").map((t) => ({ id: t.id, title: t.title, status: t.status })),
      spendToday: 0,
    },
  };
}

export type KeepGoingDeps = {
  store: KeepGoingStore;
  query: SqlQuery;
  read: SnapshotReader;
  settings: () => { enabled: boolean; maxNoProgress: number; maxPerDay: number; gapSeconds: number };
  onDuty: (botId: string, at: Date) => Promise<boolean>;
  /** Queues one follow-up run for the Stick with this prompt, after the delay. */
  queueFollowUp: (e: RunFinished, userId: string, prompt: string, delaySeconds: number) => Promise<void>;
  now?: () => Date;
};

/** The run-finished hook. Returns the outcome, for logs and tests. */
export async function keepGoingAfterRun(deps: KeepGoingDeps, e: RunFinished): Promise<string> {
  const now = deps.now?.() ?? new Date();
  if (e.outcome !== "completed") return "not completed";
  if (!(await deps.onDuty(e.botId, now))) return "resting";
  const got = await snapshotFor(deps.read, deps.query, e);
  if (!got) return "no run";
  const decision = await onRunFinished(
    deps.store,
    e.botId,
    got.snap,
    deps.settings(),
    (_bot, text, delay) => deps.queueFollowUp(e, got.userId, text, delay),
    now,
  );
  return decision.outcome;
}

export function goalPluginDocument(engineUrl: string): unknown {
  const body = (props: Record<string, unknown>, required: string[]) => ({
    required: true,
    content: { "application/json": { schema: { type: "object", required, properties: props } } },
  });
  return {
    openapi: "3.0.3",
    info: { title: "Goal", version: "1.0.0" },
    servers: [{ url: engineUrl }],
    paths: {
      "/internal/goal": {
        post: {
          operationId: "set_goal",
          summary: "Set the goal for this chat when the owner gives you one to finish. You keep working toward it until you mark it done.",
          requestBody: body({ thread_id: { type: "string" }, goal: { type: "string" } }, ["thread_id", "goal"]),
          responses: { "200": { description: "The goal" } },
        },
      },
      "/internal/goal/done": {
        post: {
          operationId: "complete_goal",
          summary: "Mark this chat's goal done, only when it really is done, with a short note of what shows it.",
          requestBody: body({ thread_id: { type: "string" }, note: { type: "string" } }, ["thread_id", "note"]),
          responses: { "200": { description: "Done" } },
        },
      },
    },
  };
}
