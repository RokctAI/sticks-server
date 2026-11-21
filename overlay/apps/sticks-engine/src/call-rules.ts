// Call rules for Stick phone calls (approved plan /sticks/voice-calls-plan.md, Ray 11-21). Pure decisions, no I/O:
// who a Stick may call, the do-not-call flow, the objective card, who answers an incoming call, and transfers.
import { dialDecision, type DialDecision, type PhoneLine } from "./outbound-call-gate.js";

/** Pulsar's answer to telephony.may_call: the number belongs to a CRM, invoice or quote contact, or not. */
export type CalleeLookup =
  | { found: false }
  | { found: true; contact: string; source: "crm" | "invoice" | "quote"; doNotCall: boolean; humansOnly: boolean; pendingDoNotCall: boolean };

/** The approved objective card. A call is an outward action: the owner approves this before dialling. */
export type CallObjective = {
  number: string;
  contact: string;
  objective: string;
  mayAgree: string[];
  mustNotShare: string[];
  giveUpAfter: string;
  approvedBy: string | null;
};

export function objectiveProblems(o: Partial<CallObjective>): string[] {
  const p: string[] = [];
  if (!o.number?.trim()) p.push("number is required");
  if (!o.contact?.trim()) p.push("contact is required");
  if (!o.objective?.trim()) p.push("objective is required");
  if (!o.giveUpAfter?.trim()) p.push("say when to give up");
  return p;
}

/** Whether a Stick may dial now: the line (dialDecision), the callee rules, and the owner's approval. */
export function mayStickDial(line: PhoneLine | null, callee: CalleeLookup, objective: CallObjective, now: Date): DialDecision {
  const l = dialDecision(line, now);
  if (!l.allowed) return l;
  if (!callee.found) return { allowed: false, reason: "not a CRM, invoice or quote contact" };
  if (callee.doNotCall) return { allowed: false, reason: "contact is marked do not call" };
  if (callee.pendingDoNotCall) return { allowed: false, reason: "contact asked not to be called; waiting for the owner" };
  if (callee.humansOnly) return { allowed: false, reason: "contact asked to speak to a person; suggest the owner calls" };
  const problems = objectiveProblems(objective);
  if (problems.length) return { allowed: false, reason: problems.join("; ") };
  if (!objective.approvedBy) return { allowed: false, reason: "objective not approved by the owner" };
  return { allowed: true };
}

/**
 * What happens when the person says "don't call me again". The Stick always asks why first (reason required).
 * A Stick never calls them again. A company contact gets an owner follow-up task; "not a bot" marks humans only.
 * Only a person (owner or tenant admin) sets the final do-not-call flag.
 */
export type DoNotCallOutcome = { recordReason: string; markPending: true; humansOnly: boolean; ownerTask: string | null };

export function onDoNotCall(contact: { name: string; isCompany: boolean }, reason: string | undefined): DoNotCallOutcome | { askWhy: true } {
  const r = reason?.trim();
  if (!r) return { askWhy: true };
  const notBot = /\b(bots?|robots?|machines?|ai|artificial|real person|humans?)\b/i.test(r);
  return {
    recordReason: r,
    markPending: true,
    humansOnly: notBot,
    ownerTask: contact.isCompany ? `${contact.name} asked not to be called again (${r}). Please call them yourself.` : null,
  };
}

export function mayClearDoNotCall(actor: { kind: "stick" | "owner" | "admin" }): boolean {
  return actor.kind !== "stick";
}

/** Who answers an incoming call. */
export type AnswerPlan = { kind: "stick"; stickId: string } | { kind: "ring_app"; fallback: { kind: "stick"; stickId: string } | { kind: "voicemail" } };
export const RING_SECONDS = 20;

export function whoAnswers(sticksAnswer: boolean, callSticks: string[]): AnswerPlan {
  const first = callSticks[0];
  if (sticksAnswer && first) return { kind: "stick", stickId: first };
  return { kind: "ring_app", fallback: first ? { kind: "stick", stickId: first } : { kind: "voicemail" } };
}

/** Fake transfer: the call stays on its line; another Stick (role allows calls) takes over. */
export const MAX_TRANSFERS = 3;

export function mayTransfer(call: { transfers: number; currentStick: string }, target: string, callSticks: string[]): DialDecision {
  if (target === call.currentStick) return { allowed: false, reason: "already on this Stick" };
  if (!callSticks.includes(target)) return { allowed: false, reason: "that Stick's role does not take calls" };
  if (call.transfers >= MAX_TRANSFERS) return { allowed: false, reason: `at most ${MAX_TRANSFERS} transfers per call` };
  return { allowed: true };
}

/** The opening line: name, role, company. Not "I am an AI" unless asked; never claims to be human. */
export function openingLine(stick: { name: string; role: string; company: string }, contact?: string): string {
  return `${contact ? `Hello ${contact}, ` : "Hello, "}this is ${stick.name}, ${stick.role} at ${stick.company}.`;
}

export const ARE_YOU_A_BOT_ANSWER = "Yes, I'm an AI assistant working for the business. I can carry on, or ask a person to call you back.";
