// Keep-going inside the engine (brief task 14, spec 7.5). `decide` is ported unchanged from
// scripts/keep_going.py: when a run ends and the Stick still has open work, ask it to continue, unless it is
// off, blocked, waiting for the owner, or past a cap. Outcomes: continue, complete, blocked, waiting,
// working, capped, off. Counters and the per-Stick switch live in our own table sticks_keep_going.
import { createHash } from "node:crypto";
import type { SqlQuery } from "./plugin-draft-store.js";

export const PENDING_TICKET_STATUSES = new Set(["todo", "doing"]);
export const PAUSED_RUN_STATUSES = new Set(["waiting_input", "waiting_takeover"]);
export const WORKING_RUN_STATUSES = new Set(["queued", "leased", "running"]);
export const MARKER = "[auto-continue";
const BLOCKER_PHRASES = [
  "let me know", "please confirm", "please advise", "waiting for your", "waiting on you",
  "need your", "your call", "which one would you", "do you want me to", "should i ",
  "shall i ", "can you confirm", "need you to",
];

export type Policy = {
  enabled: boolean;
  maxTriesWithoutProgress: number;
  maxPerDay: number;
  minGapSeconds: number;
  /** US dollars per Stick per day; 0 = no spend allowed. In the engine, Pulsar's Stick daily cap also applies. */
  maxSpendPerDay: number;
  includeScratchpad: boolean;
};
export const DEFAULT_POLICY: Policy = { enabled: true, maxTriesWithoutProgress: 3, maxPerDay: 20, minGapSeconds: 60, maxSpendPerDay: 5, includeScratchpad: true };

export type StickState = { day: string; continuesToday: number; lastContinueAt: number; lastSignature: string; triesOnSignature: number };
export const NEW_STATE: StickState = { day: "", continuesToday: 0, lastContinueAt: 0, lastSignature: "", triesOnSignature: 0 };

export type Item = { id: string; title: string; status?: string };
export type Snapshot = {
  runStatus: string;
  runEndedAt: number;
  lastMessageText: string;
  lastMessageFromOwner: boolean;
  lastMessageAt: number;
  pendingTickets: Item[];
  openScratchpad: Item[];
  blockedTickets: Item[];
  spendToday: number;
};
export type Outcome = "continue" | "complete" | "blocked" | "waiting" | "working" | "capped" | "off";
export type Decision = { send: boolean; reason: string; signature: string; outcome: Outcome };

const d = (send: boolean, reason: string, outcome: Outcome, signature = ""): Decision => ({ send, reason, signature, outcome });

export function looksBlocked(text: string): boolean {
  const t = (text ?? "").trim();
  if (!t) return false;
  const tail = t.slice(-400).replace(/[\s"'”’)\]*_~`>.!]+$/u, "");
  if (tail.endsWith("?")) return true;
  const low = t.slice(-400).toLowerCase();
  return BLOCKER_PHRASES.some((p) => low.includes(p));
}

export function claimsDone(text: string): boolean {
  return /\b(all done|finished|completed?|done)\b/i.test((text ?? "").slice(-400));
}

export function signatureOf(snap: Snapshot, policy: Policy): string {
  const parts = snap.pendingTickets.map((t) => `t:${t.id}:${t.status ?? ""}`).sort();
  if (policy.includeScratchpad) parts.push(...snap.openScratchpad.map((s) => `s:${s.id}`).sort());
  return createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 12);
}

export function decide(snap: Snapshot, policy: Policy, state: StickState, now: number, today: string): Decision {
  if (!policy.enabled) return d(false, "off for this Stick", "off");
  if (WORKING_RUN_STATUSES.has(snap.runStatus)) return d(false, "a run is still working", "working");
  if (PAUSED_RUN_STATUSES.has(snap.runStatus)) return d(false, `blocked: run is ${snap.runStatus} (waiting for the owner)`, "blocked");
  if (snap.runStatus !== "completed") {
    return d(false, `run ended as ${snap.runStatus}; not continuing`, snap.runStatus === "none" ? "waiting" : "capped");
  }
  if (snap.lastMessageFromOwner && snap.lastMessageAt >= snap.runEndedAt) {
    return d(false, "the owner wrote after the run ended; their message comes first", "waiting");
  }
  const pending = snap.pendingTickets.length > 0 || (policy.includeScratchpad && snap.openScratchpad.length > 0);
  if (!pending) {
    if (snap.blockedTickets.length) return d(false, `blocked: ${snap.blockedTickets.slice(0, 3).map((t) => t.title ?? "").join("; ")}`, "blocked");
    return d(false, "complete: no open tickets or scratchpad items", "complete");
  }
  if (looksBlocked(snap.lastMessageText)) {
    const tail = snap.lastMessageText.split(/\s+/).filter(Boolean).join(" ").slice(-160);
    return d(false, `blocked: last message asks the owner: ${tail}`, "blocked");
  }
  const sig = signatureOf(snap, policy);
  const countToday = state.day === today ? state.continuesToday : 0;
  if (countToday >= policy.maxPerDay) return d(false, `daily cap reached (${policy.maxPerDay})`, "capped", sig);
  if (now - state.lastContinueAt < policy.minGapSeconds) return d(false, "too soon after the last continue", "waiting", sig);
  if (snap.spendToday >= policy.maxSpendPerDay) return d(false, "spend cap reached for today", "capped", sig);
  const tries = state.lastSignature === sig ? state.triesOnSignature : 0;
  if (tries >= policy.maxTriesWithoutProgress) return d(false, `stalled: ${tries} continues without the open work changing`, "capped", sig);
  return d(true, "open work and not blocked", "continue", sig);
}

export function applyDecision(state: StickState, decision: Decision, now: number, today: string): StickState {
  const s = { ...state };
  if (s.day !== today) Object.assign(s, { day: today, continuesToday: 0 });
  s.continuesToday += 1;
  s.lastContinueAt = now;
  s.triesOnSignature = s.lastSignature === decision.signature ? s.triesOnSignature + 1 : 1;
  s.lastSignature = decision.signature;
  return s;
}

export function continueText(snap: Snapshot, state: StickState, policy: Policy): string {
  const same = state.lastSignature === signatureOf(snap, policy);
  const n = same ? state.triesOnSignature + 1 : 1;
  const next = snap.pendingTickets[0]?.title ?? snap.openScratchpad[0]?.title ?? "your open work";
  if (claimsDone(snap.lastMessageText)) {
    const open = (snap.pendingTickets.length ? snap.pendingTickets : snap.openScratchpad).slice(0, 3).map((t) => t.title).join("; ");
    return `${MARKER} ${n}/${policy.maxTriesWithoutProgress}] You said this is done, but these are still open: ${open}. Finish them, or set each one to done, or to blocked with the reason.`;
  }
  return (
    `${MARKER} ${n}/${policy.maxTriesWithoutProgress}] Continue with your open work, next: ${next}. ` +
    "Keep going without waiting for me. If you are blocked on something only I can decide, set that ticket to blocked and say exactly what you need."
  );
}

export const KEEP_GOING_TABLE_SQL = `CREATE TABLE IF NOT EXISTS sticks_keep_going (
  bot_id text PRIMARY KEY,
  enabled boolean NOT NULL DEFAULT true,
  state jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_outcome text,
  updated_at timestamptz NOT NULL DEFAULT now()
)`;

/** The per-Stick switch (on by default) and counters. */
export class KeepGoingStore {
  constructor(private readonly query: SqlQuery) {}

  async ensure(): Promise<void> {
    await this.query(KEEP_GOING_TABLE_SQL, []);
  }

  async get(botId: string): Promise<{ enabled: boolean; state: StickState }> {
    const rows = (await this.query(`SELECT enabled, state FROM sticks_keep_going WHERE bot_id = $1`, [botId])) as Array<{ enabled: boolean; state: Partial<StickState> }>;
    return { enabled: rows[0]?.enabled ?? true, state: { ...NEW_STATE, ...(rows[0]?.state ?? {}) } };
  }

  async save(botId: string, state: StickState, outcome: Outcome): Promise<void> {
    await this.query(
      `INSERT INTO sticks_keep_going (bot_id, state, last_outcome) VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (bot_id) DO UPDATE SET state = EXCLUDED.state, last_outcome = EXCLUDED.last_outcome, updated_at = now()`,
      [botId, JSON.stringify(state), outcome],
    );
  }

  async setEnabled(botId: string, enabled: boolean): Promise<void> {
    await this.query(
      `INSERT INTO sticks_keep_going (bot_id, enabled) VALUES ($1, $2) ON CONFLICT (bot_id) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()`,
      [botId, enabled],
    );
  }
}

/** Policy from the tenant settings (task 11) and the Stick's switch. */
export function policyFrom(settings: { enabled: boolean; maxNoProgress: number; maxPerDay: number; gapSeconds: number }, stickEnabled: boolean): Policy {
  return {
    ...DEFAULT_POLICY,
    enabled: settings.enabled && stickEnabled,
    maxTriesWithoutProgress: settings.maxNoProgress,
    maxPerDay: settings.maxPerDay,
    minGapSeconds: settings.gapSeconds,
    // The engine's spend cap is Pulsar's Stick daily cap (a refused reserve gives "capped"), so no dollar cap here.
    maxSpendPerDay: Number.POSITIVE_INFINITY,
  };
}

/**
 * Handles one finished run (act on `completed` only). Returns the decision; when it says continue, `wake`
 * is called after the gap with the continue text, and the counters are saved.
 */
export async function onRunFinished(
  store: KeepGoingStore,
  botId: string,
  snap: Snapshot,
  settings: { enabled: boolean; maxNoProgress: number; maxPerDay: number; gapSeconds: number },
  wake: (botId: string, text: string, delaySeconds: number) => Promise<void>,
  now: Date = new Date(),
): Promise<Decision> {
  const { enabled, state } = await store.get(botId);
  const policy = policyFrom(settings, enabled);
  const today = now.toISOString().slice(0, 10);
  const seconds = now.getTime() / 1000;
  const decision = decide(snap, policy, state, seconds, today);
  if (!decision.send) {
    await store.save(botId, state, decision.outcome);
    return decision;
  }
  const text = continueText(snap, state, policy);
  await wake(botId, text, policy.minGapSeconds);
  await store.save(botId, applyDecision(state, decision, seconds, today), decision.outcome);
  return decision;
}
