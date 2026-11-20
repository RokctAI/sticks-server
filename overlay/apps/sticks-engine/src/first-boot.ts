// First boot (spec 7.1 step 3; brief task 10). Replaces scripts/setup_tenant.py and
// scripts/apply_stick_defaults.py inside the engine:
// - the tenant's one organization and one default space, named after the company (STICKS_COMPANY_NAME);
// - every active Stick carries the marked default block from templates/stick-defaults.md.
// The block is kept here as a string so it survives the esbuild bundle; a test checks it matches the template.
import { randomUUID } from "node:crypto";
import type { SqlQuery } from "./plugin-draft-store.js";

export const START = "<!-- sticks-defaults:start -->";
export const END = "<!-- sticks-defaults:end -->";
/** The text of templates/stick-defaults.md (trimmed). */
export const DEFAULT_BLOCK = "<!-- sticks-defaults:start -->\nTeam board: this workspace has a shared board that your team and the owner can see. Use it for your work. When you are given or take on a task, check board_tickets first, then ticket_create one if none exists. Keep it current with ticket_update (todo, doing, review, blocked, done) and post progress and results with ticket_comment. Move it to review when you finish, and to blocked with the reason when you are stuck. The board is the team's record; the scratchpad is only your private notes.\nWorking through a list: when given a list or a batch of items, work through all of it in this turn without stopping to ask between batches. Save results as you go (a file, or ticket comments). Ask only when you are blocked by something only the owner can decide, or the action cannot be undone. If the job is too big for one turn, keep a scratchpad item and schedule_create a one-shot follow-up for the next batch instead of waiting to be told to continue. When it is all done, send one short summary.\nFiles: when you make a file the owner should get, attach it to your reply with attach_file. Never only write its path in a message. You may also mention the file name.\n<!-- sticks-defaults:end -->";
/** Upstream's space name limit. */
export const SPACE_NAME_MAX = 60;
/** Upstream's instructions limit; a Stick whose instructions would exceed it is left alone. */
export const MAX_INSTRUCTIONS = 20000;

/** Same rule as scripts/stick_defaults.py apply_block: add or replace our block, idempotent. */
export function applyBlock(instructions: string, block: string = DEFAULT_BLOCK): string {
  const b = block.trim();
  const a = instructions.indexOf(START);
  const e = instructions.indexOf(END);
  if (a !== -1 && e > a) return instructions.slice(0, a) + b + instructions.slice(e + END.length);
  let text = instructions;
  if (a !== -1 || e !== -1) text = text.split(START).join("").split(END).join("");
  const base = text.trimEnd();
  return base ? `${base}\n\n${b}\n` : `${b}\n`;
}

/** Same rule as scripts/setup_tenant.py space_name. */
export function spaceName(company: string): string {
  const name = company.trim().replace(/\s+/g, " ").slice(0, SPACE_NAME_MAX).trim();
  return name || "Workspace";
}

export function slugOf(company: string): string {
  return company.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "tenant";
}

/** Creates the one organization and default space if missing; renames the default space to match the company. */
export async function ensureTenantSpace(query: SqlQuery, company: string, now: Date = new Date()): Promise<{ orgId: string; spaceId: string; created: boolean }> {
  const name = spaceName(company);
  const orgs = (await query(`SELECT id FROM organization ORDER BY "createdAt" ASC LIMIT 1`, [])) as Array<{ id: string }>;
  let orgId = orgs[0]?.id;
  let created = false;
  if (!orgId) {
    orgId = randomUUID();
    await query(`INSERT INTO organization (id, name, slug, "createdAt") VALUES ($1, $2, $3, $4)`, [orgId, name, slugOf(company), now]);
    created = true;
  }
  const spaces = (await query(
    `SELECT id, name FROM spaces WHERE "organizationId" = $1 AND "deletingAt" IS NULL ORDER BY "isDefault" DESC, "createdAt" ASC LIMIT 1`,
    [orgId],
  )) as Array<{ id: string; name: string }>;
  let spaceId = spaces[0]?.id;
  if (!spaceId) {
    spaceId = randomUUID();
    await query(`INSERT INTO spaces (id, "organizationId", name, "isDefault", "createdAt") VALUES ($1, $2, $3, true, $4)`, [spaceId, orgId, name, now]);
    created = true;
  } else if (spaces[0]!.name !== name) {
    await query(`UPDATE spaces SET name = $2 WHERE id = $1`, [spaceId, name]);
  }
  return { orgId, spaceId, created };
}

/**
 * Puts the default block into every active Stick whose instructions lack it or carry an old copy.
 * The update only lands if the instructions are unchanged since they were read, so a concurrent edit wins.
 * Returns how many Sticks changed.
 */
export async function applyStickDefaults(query: SqlQuery, block: string = DEFAULT_BLOCK): Promise<number> {
  const bots = (await query(`SELECT id, instructions FROM bots WHERE "archivedAt" IS NULL`, [])) as Array<{ id: string; instructions: string }>;
  let changed = 0;
  for (const bot of bots) {
    const current = bot.instructions ?? "";
    const next = applyBlock(current, block).trim();
    if (next === current.trim() || next.length > MAX_INSTRUCTIONS) continue;
    const rows = (await query(
      `UPDATE bots SET instructions = $2, "updatedAt" = now() WHERE id = $1 AND instructions = $3 RETURNING id`,
      [bot.id, next, current],
    )) as unknown[];
    changed += rows.length;
  }
  return changed;
}
