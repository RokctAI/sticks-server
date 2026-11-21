// The engine's call hub (voice calls plan: softphone with no PBX). The engine is the only SIP endpoint; this
// tracks each call and decides who is on our side of it: a Stick (the call loop) or a person in the app or the
// launcher dialer (audio relayed over WebRTC, Opus). It sends the call events the dialer and the app listen to.
// The SIP line and the WebRTC relay plug in through `CallLine` and `notify`; both are faked in tests.
import { randomUUID } from "node:crypto";
import { RING_SECONDS, whoAnswers, type AnswerPlan } from "./call-rules.js";

export type CallState = "ringing" | "answered" | "ended" | "failed";
export type CallEvent = { callId: string; state: CallState; direction: "in" | "out"; number: string; by?: string; reason?: string };

export type Call = {
  id: string;
  direction: "in" | "out";
  number: string;
  state: CallState;
  /** Who holds our side: "app" (a person) or a Stick id. */
  holder: string | null;
  muted: boolean;
  held: boolean;
};

export interface CallLine {
  dial(number: string): Promise<{ lineCallId: string }>;
  answer(lineCallId: string): Promise<void>;
  hangup(lineCallId: string): Promise<void>;
}

export type HubDeps = {
  line: CallLine;
  notify: (e: CallEvent) => void;
  /** Starts the Stick call loop on this call. */
  startStick: (callId: string, stickId: string) => void;
  /** Sends the incoming-call push to the tenant's app. */
  pushApp: (e: CallEvent) => Promise<void>;
  /** Records a voicemail and posts its transcript to the chat. */
  voicemail: (callId: string) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
};

export class CallHub {
  readonly calls = new Map<string, Call & { lineCallId: string }>();
  constructor(private readonly d: HubDeps) {}

  private emit(c: Call, extra: Partial<CallEvent> = {}) {
    this.d.notify({ callId: c.id, state: c.state, direction: c.direction, number: c.number, ...(c.holder ? { by: c.holder } : {}), ...extra });
  }

  /** telephony.dial from the launcher dialer or the app: a person calls out; audio relays to them. */
  async dial(number: string): Promise<Call> {
    const { lineCallId } = await this.d.line.dial(number);
    const c = { id: randomUUID(), lineCallId, direction: "out" as const, number, state: "ringing" as CallState, holder: "app", muted: false, held: false };
    this.calls.set(c.id, c);
    this.emit(c);
    return c;
  }

  /** The far end answered an outgoing call. */
  farAnswered(callId: string) {
    const c = this.calls.get(callId);
    if (!c || c.state !== "ringing") return;
    c.state = "answered";
    this.emit(c);
  }

  /** An incoming call on the tenant's line. */
  async incoming(lineCallId: string, number: string, sticksAnswer: boolean, callSticks: string[]): Promise<AnswerPlan> {
    const c = { id: randomUUID(), lineCallId, direction: "in" as const, number, state: "ringing" as CallState, holder: null as string | null, muted: false, held: false };
    this.calls.set(c.id, c);
    const plan = whoAnswers(sticksAnswer, callSticks);
    if (plan.kind === "stick") {
      await this.takeBy(c, plan.stickId);
      return plan;
    }
    this.emit(c);
    await this.d.pushApp({ callId: c.id, state: "ringing", direction: "in", number });
    (this.d.setTimer ?? setTimeout)(() => void this.ringTimeout(c.id, plan), RING_SECONDS * 1000);
    return plan;
  }

  private async takeBy(c: Call & { lineCallId: string }, holder: string) {
    await this.d.line.answer(c.lineCallId);
    c.state = "answered";
    c.holder = holder;
    this.emit(c);
    if (holder !== "app") this.d.startStick(c.id, holder);
  }

  /** The person tapped answer in the app. */
  async appAnswer(callId: string): Promise<boolean> {
    const c = this.calls.get(callId);
    if (!c || c.state !== "ringing" || c.direction !== "in") return false;
    await this.takeBy(c, "app");
    return true;
  }

  /** The person declined, or nobody answered in time: a Stick takes it, or voicemail. */
  async ringTimeout(callId: string, plan: AnswerPlan, declined = false) {
    const c = this.calls.get(callId);
    if (!c || c.state !== "ringing") return;
    if (plan.kind === "ring_app" && plan.fallback.kind === "stick") await this.takeBy(c, plan.fallback.stickId);
    else {
      await this.d.line.answer(c.lineCallId);
      c.state = "answered";
      c.holder = "voicemail";
      this.emit(c, { reason: declined ? "declined" : "no answer" });
      this.d.voicemail(c.id);
    }
  }

  /** A Stick puts the caller through to the owner (fake transfer to a person): ring the app. */
  async toOwner(callId: string): Promise<void> {
    const c = this.calls.get(callId);
    if (!c || c.state !== "answered") return;
    c.holder = "app";
    await this.d.pushApp({ callId: c.id, state: "answered", direction: c.direction, number: c.number, by: "app" });
    this.emit(c);
  }

  async hangup(callId: string, reason = "hung up"): Promise<void> {
    const c = this.calls.get(callId);
    if (!c || c.state === "ended" || c.state === "failed") return;
    await this.d.line.hangup(c.lineCallId).catch(() => undefined);
    c.state = "ended";
    this.emit(c, { reason });
  }

  setMute(callId: string, on: boolean) {
    const c = this.calls.get(callId);
    if (c) c.muted = on;
  }

  setHold(callId: string, on: boolean) {
    const c = this.calls.get(callId);
    if (c) c.held = on;
  }
}
