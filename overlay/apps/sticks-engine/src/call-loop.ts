// The Stick call loop (voice calls plan, piece 2). Media-agnostic: a CallMedia gives finished utterances from
// the other side (speech to text already done) and plays text (text to speech inside). The SIP/RTP leg that
// implements CallMedia is the next PR. The loop: opening line, then for each utterance ask the Stick, speak its
// reply, until the Stick ends the call, the person hangs up, silence or turn limits, or credits run out.
import { ARE_YOU_A_BOT_ANSWER, MAX_TRANSFERS, onDoNotCall, openingLine } from "./call-rules.js";
import { CreditsRefused } from "./pulsar-credits.js";

export interface CallMedia {
  /** Next finished utterance, or null when the line is silent for `timeoutMs`, or "hangup". */
  listen(timeoutMs: number): Promise<string | null | "hangup">;
  say(text: string): Promise<void>;
  hangup(): Promise<void>;
}

export type Speaker = { id: string; name: string; role: string; company: string };

/** What the Stick decides each turn. */
export type StickTurn =
  | { kind: "say"; text: string }
  | { kind: "end"; text: string; outcome: "met" | "refused" | "gave_up" }
  | { kind: "transfer"; to: Speaker; text: string; summary: string }
  | { kind: "do_not_call"; reason?: string; text: string };

export type TurnInput = { stick: Speaker; objective: string; transcript: Line[]; handover?: string };
export type Line = { who: string; text: string; at: number };

export type CallResult = {
  outcome: "met" | "refused" | "gave_up" | "hangup" | "silence" | "turn_limit" | "credits" | "do_not_call";
  transcript: Line[];
  transfers: number;
  doNotCall?: ReturnType<typeof onDoNotCall>;
  creditsReason?: string;
};

export const LIMITS = { silenceMs: 15_000, silencePrompts: 2, maxTurns: 40 };

const BOT_QUESTION = /\b(are|is) (you|this|it) (a |an )?(bot|robot|machine|ai|computer|real person|human)\b/i;

export async function runCall(opts: {
  media: CallMedia;
  stick: Speaker;
  contact?: string;
  objective: string;
  isCompany: boolean;
  callSticks: string[];
  turn: (input: TurnInput) => Promise<StickTurn>;
  now?: () => number;
}): Promise<CallResult> {
  const now = opts.now ?? Date.now;
  const transcript: Line[] = [];
  let stick = opts.stick;
  let handover: string | undefined;
  let transfers = 0;
  let silences = 0;
  const say = async (text: string) => {
    transcript.push({ who: stick.name, text, at: now() });
    await opts.media.say(text);
  };
  const end = async (r: Omit<CallResult, "transcript" | "transfers">): Promise<CallResult> => {
    await opts.media.hangup();
    return { ...r, transcript, transfers };
  };

  await say(openingLine(stick, opts.contact));
  for (let turns = 0; turns < LIMITS.maxTurns; turns++) {
    const heard = await opts.media.listen(LIMITS.silenceMs);
    if (heard === "hangup") return { outcome: "hangup", transcript, transfers };
    if (heard === null) {
      if (++silences > LIMITS.silencePrompts) return end({ outcome: "silence" });
      await say("Are you still there?");
      continue;
    }
    silences = 0;
    transcript.push({ who: opts.contact ?? "caller", text: heard, at: now() });
    // Truthful about being an AI when asked, whatever the model would say.
    if (BOT_QUESTION.test(heard)) {
      await say(ARE_YOU_A_BOT_ANSWER);
      continue;
    }
    let t: StickTurn;
    try {
      t = await opts.turn({ stick, objective: opts.objective, transcript, ...(handover ? { handover } : {}) });
    } catch (e) {
      if (e instanceof CreditsRefused) {
        await say("I'm sorry, I have to end the call now. Someone will get back to you.");
        return end({ outcome: "credits", creditsReason: e.reason });
      }
      throw e;
    }
    if (t.kind === "say") await say(t.text);
    else if (t.kind === "end") {
      await say(t.text);
      return end({ outcome: t.outcome });
    } else if (t.kind === "do_not_call") {
      const d = onDoNotCall({ name: opts.contact ?? "caller", isCompany: opts.isCompany }, t.reason);
      if ("askWhy" in d) {
        await say(t.text || "Of course. May I ask why, so we get it right?");
        continue;
      }
      await say(t.text);
      return end({ outcome: "do_not_call", doNotCall: d });
    } else {
      if (transfers >= MAX_TRANSFERS || !opts.callSticks.includes(t.to.id) || t.to.id === stick.id) {
        await say("Let me help you with that myself.");
        continue;
      }
      await say(t.text);
      transfers++;
      handover = t.summary;
      stick = t.to;
      await say(openingLine(stick));
    }
  }
  await say("Thank you for your time. Goodbye.");
  return end({ outcome: "turn_limit" });
}
