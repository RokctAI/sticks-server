// Stick reactions (Ray, 11-21): a Stick can react to a message with one emoji, and the app shows it under the
// message (and buzzes when it arrives while the chat is open). Upstream has no reactions, so this is our own
// table, keyed on upstream's events.id (a chat message is an event).
import type { SqlQuery } from "./plugin-draft-store.js";

export const REACTIONS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS sticks_reactions (
  event_id text NOT NULL,
  emoji text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, emoji)
)`;

export class ReactionError extends Error {
  constructor(message: string, readonly status: 400 | 404) {
    super(message);
  }
}

/** One emoji: 1 to 4 grapheme-ish code points, pictographic, no letters or digits. */
export function validEmoji(emoji: unknown): emoji is string {
  if (typeof emoji !== "string") return false;
  const cps = [...emoji];
  return cps.length >= 1 && cps.length <= 8 && /\p{Extended_Pictographic}/u.test(emoji) && !/[\p{L}\p{N}\s]/u.test(emoji.replace(/[\u{1F3FB}-\u{1F3FF}]/gu, ""));
}

export type Reaction = { messageId: string; threadId: string; emoji: string; by: "stick"; at: string };

/** Adds the Stick's reaction. Same emoji twice is one reaction. Returns the reaction as the app receives it. */
export async function addReaction(query: SqlQuery, messageId: unknown, emoji: unknown): Promise<Reaction> {
  if (typeof messageId !== "string" || !messageId) throw new ReactionError("message_id is required", 400);
  if (!validEmoji(emoji)) throw new ReactionError("emoji must be one emoji", 400);
  const ev = (await query(`SELECT "threadId" FROM events WHERE id = $1`, [messageId])) as Array<{ threadId: string }>;
  if (!ev[0]) throw new ReactionError("no such message", 404);
  await query(REACTIONS_TABLE_SQL, []);
  const rows = (await query(
    `INSERT INTO sticks_reactions (event_id, emoji) VALUES ($1, $2) ON CONFLICT (event_id, emoji) DO UPDATE SET emoji = EXCLUDED.emoji RETURNING created_at`,
    [messageId, emoji],
  )) as Array<{ created_at: Date | string }>;
  return { messageId, threadId: ev[0].threadId, emoji, by: "stick", at: new Date(rows[0]!.created_at).toISOString() };
}

/** Every Stick reaction in a thread, oldest first. `since` (ISO time) returns only newer ones, for polling. */
export async function listReactions(query: SqlQuery, threadId: string, since?: string): Promise<Reaction[]> {
  await query(REACTIONS_TABLE_SQL, []);
  const rows = (await query(
    `SELECT r.event_id, r.emoji, r.created_at FROM sticks_reactions r JOIN events e ON e.id = r.event_id
     WHERE e."threadId" = $1 AND ($2::timestamptz IS NULL OR r.created_at > $2::timestamptz) ORDER BY r.created_at`,
    [threadId, since ?? null],
  )) as Array<{ event_id: string; emoji: string; created_at: Date | string }>;
  return rows.map((r) => ({ messageId: r.event_id, threadId, emoji: r.emoji, by: "stick" as const, at: new Date(r.created_at).toISOString() }));
}

/** The built-in plugin that gives every Stick the react tool. */
export function reactionsPluginDocument(engineUrl: string): unknown {
  return {
    openapi: "3.0.3",
    info: { title: "Reactions", version: "1.0.0" },
    servers: [{ url: engineUrl }],
    paths: {
      "/internal/reactions": {
        post: {
          operationId: "react_to_message",
          summary: "React to one of the owner's messages with a single emoji, instead of or as well as replying",
          requestBody: {
            required: true,
            content: { "application/json": { schema: { type: "object", required: ["message_id", "emoji"], properties: { message_id: { type: "string" }, emoji: { type: "string" } } } } },
          },
          responses: { "200": { description: "The reaction" } },
        },
      },
    },
  };
}
