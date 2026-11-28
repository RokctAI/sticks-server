// The lead Stick's morning brief (owner's ruling of 27 Nov: "the highest role is the one that need to be
// proactive ... not every time a user will create a secretary"). The lead Stick is the top of the team: the
// Stick that reports to the owner. Reporting lines are not in the engine yet (docs/reporting-lines-and-templates.md),
// so until they are, every Stick reports to the owner and the lead is the one created first in its tenant's space (owner's ruling:
// "first created leads"). When reporting lines land, leadSticks() narrows to Sticks with no manager.
//
// The brief is an ordinary upstream routine on the lead Stick: weekday mornings, in the tenant's zone, posting to
// the owner. Its prompt tells the Stick to stay short, to ask before anything leaves (Sticks ask, never take),
// and to take money totals from Pulsar, never to work them out. The routine gate (duty.ts) still skips it when the
// Stick is off duty. Nothing here polls: it runs with the 15-minute defaults pass in engine.ts, after the boot pass.

import { randomUUID } from "node:crypto";

import { nextCronDate } from "../../../packages/core/src/routines/schedule.ts";
import type { SqlQuery } from "./plugin-draft-store.js";

/** The routine's name; also how we find it again, so the owner may rename it to stop us re-adding it. */
export const BRIEF_NAME = "Morning brief";
/** Weekdays, 07:30 local. */
export const BRIEF_CRON = "30 7 * * 1-5";
export const BRIEF_PROMPT = [
  "Morning brief for the owner. Look at what changed since the last brief: the team board, your inbox and the",
  "team's asks, and any connected email and calendar. Write one short message with three parts, leaving out a part",
  "that has nothing: Needs you today (each item one line; when you can do it, draft it and raise an ask so the owner",
  "only taps yes), Calendar (today's meetings and any clash, with a proposed fix), Money (totals only from Pulsar,",
  "never worked out yourself). End with one line on what you will keep watching. If nothing needs the owner, say so",
  "in one line. Never send, pay, sign or delete anything from this brief: ask first.",
].join(" ");

/** IANA zone for the tenant: STICKS_TIMEZONE when set, else a fixed zone from the whole-hour offset. Pure; tested. */
export function tenantTimezone(env: NodeJS.ProcessEnv, offsetMinutes: number): string {
  const named = env.STICKS_TIMEZONE?.trim();
  if (named) return named;
  if (offsetMinutes === 0 || offsetMinutes % 60 !== 0) return "UTC";
  const h = offsetMinutes / 60;
  // Etc/GMT zones have the sign inverted: UTC+2 is Etc/GMT-2.
  return `Etc/GMT${h > 0 ? "-" : "+"}${Math.abs(h)}`;
}

/**
 * The lead Stick of each space: the active Stick created first there. The engine serves many tenants in one
 * process (tenants.ts: one organization and default space per tenant), so the lead is picked per space.
 */
export async function leadSticks(query: SqlQuery): Promise<Array<{ id: string; spaceId: string; userId: string }>> {
  return (await query(
    `SELECT DISTINCT ON ("spaceId") id, "spaceId", "userId" FROM bots WHERE "archivedAt" IS NULL ORDER BY "spaceId", "createdAt" ASC, id ASC`,
    [],
  )) as Array<{ id: string; spaceId: string; userId: string }>;
}

/**
 * Gives each space's lead Stick its morning brief once. Returns how many routines were added. A Stick that already has a
 * routine of that name (active or paused by the owner) is left alone, so turning it off sticks.
 */
export async function ensureMorningBrief(
  query: SqlQuery,
  timezone: string,
  wake: (routineId: string, at: Date) => Promise<unknown>,
  now: Date = new Date(),
): Promise<number> {
  let added = 0;
  for (const lead of await leadSticks(query)) {
    const existing = (await query(`SELECT id FROM routines WHERE "botId" = $1 AND name = $2 LIMIT 1`, [lead.id, BRIEF_NAME])) as unknown[];
    if (existing.length) continue;
    const next = nextCronDate(BRIEF_CRON, now, timezone);
    const id = randomUUID();
    await query(
      `INSERT INTO routines (id, "spaceId", "botId", "userId", name, prompt, crons, timezone, active, notify, "nextRunAt", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, true, $9, $10, $10)`,
      [id, lead.spaceId, lead.id, lead.userId, BRIEF_NAME, BRIEF_PROMPT, [BRIEF_CRON], timezone, next, now],
    );
    // Same as upstream's routine create: queue its first wake-up, so it runs without waiting for a restart.
    await wake(id, next);
    added++;
  }
  return added;
}

/** The inbox watch's name; found again by name, like the brief. */
export const INBOX_WATCH_NAME = "Inbox watch";
/**
 * Checked every 15 minutes by upstream's watch checker, without a model: the Stick only runs when a new unread
 * email arrives (tracked by message id), so a quiet inbox costs nothing.
 */
export const INBOX_WATCH = {
  kind: "tool",
  tool: "GMAIL_FETCH_EMAILS",
  args: { query: "in:inbox is:unread newer_than:2d", max_results: 20 },
  track: ["messageId"],
  everyMinutes: 15,
  loud: false,
} as const;
export const INBOX_WATCH_PROMPT = [
  "New email arrived in the owner's inbox. For each new message decide one of four, and stay silent unless it is",
  "the last two: ignore (newsletters, receipts, anything that needs nothing); keep for the morning brief; tell the",
  "owner now (one short message, only when it cannot wait for the brief, such as something due today or a clash);",
  "or offer to do it (draft the reply, form or booking, then raise an ask so the owner only taps yes). Hand work that",
  "belongs to a teammate to that Stick. Never send, pay, sign or delete without the owner's yes.",
].join(" ");

/**
 * Gives each space's lead Stick its inbox watch once the owner (the Stick's user) has connected Gmail there.
 * Returns how many were added. The tenant's zone is engine-wide for now (STICKS_TIMEZONE), shared by all tenants.
 * Like the brief, a routine of that name that already exists (even paused) is left alone.
 */
export async function ensureInboxWatch(
  query: SqlQuery,
  timezone: string,
  wake: (routineId: string, at: Date) => Promise<unknown>,
  now: Date = new Date(),
): Promise<number> {
  let added = 0;
  for (const lead of await leadSticks(query)) {
    // Connections are per user: the watch's tool call runs as the routine's user, so that user must hold Gmail.
    const gmail = (await query(
      `SELECT id FROM connections WHERE "spaceId" = $1 AND "userId" = $2 AND provider = 'gmail' AND status = 'connected' LIMIT 1`,
      [lead.spaceId, lead.userId],
    )) as unknown[];
    if (!gmail.length) continue;
    const existing = (await query(`SELECT id FROM routines WHERE "botId" = $1 AND name = $2 LIMIT 1`, [lead.id, INBOX_WATCH_NAME])) as unknown[];
    if (existing.length) continue;
    const id = randomUUID();
    // Upstream's first watch check comes right away; that reading is the baseline, so old mail does not wake it.
    const first = new Date(now.getTime() + 2_000);
    await query(
      `INSERT INTO routines (id, "spaceId", "botId", "userId", name, prompt, crons, timezone, active, notify, watch, "nextRunAt", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, false, $9::jsonb, $10, $11, $11)`,
      [id, lead.spaceId, lead.id, lead.userId, INBOX_WATCH_NAME, INBOX_WATCH_PROMPT, [], timezone, JSON.stringify(INBOX_WATCH), first, now],
    );
    await wake(id, first);
    added++;
  }
  return added;
}
