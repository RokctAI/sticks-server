// Whether a bot may place an outbound call (the telephony todo item). A bot dials only from a phone line the
// tenant has: a Telephony Subscription that is Active, has a phone number (did_number), a SIP username and a
// password, and is not past its cancellation date. The balance is not checked here: it is shown to the human
// tenant user in the app, not read by the bot.

/** The Telephony Subscription fields the gate reads. Names follow the doctype's field names, in camelCase. */
export type PhoneLine = {
  status: string;
  didNumber: string | null;
  sipUsername: string | null;
  sipPassword: string | null;
  cancellationDate: Date | null;
};

export type DialDecision = { allowed: true } | { allowed: false; reason: string };

/** The statuses a Telephony Subscription can have (its `status` select). Only Active may dial. */
export const DIALLING_STATUS = "Active";

export function dialDecision(line: PhoneLine | null | undefined, now: Date): DialDecision {
  if (!line) return { allowed: false, reason: "no telephony subscription for this tenant" };
  if (line.status !== DIALLING_STATUS) return { allowed: false, reason: `subscription is ${line.status}` };
  if (!line.didNumber?.trim()) return { allowed: false, reason: "no phone number allocated" };
  if (!line.sipUsername?.trim()) return { allowed: false, reason: "no SIP username on the subscription" };
  if (!line.sipPassword?.trim()) return { allowed: false, reason: "no SIP password on the subscription" };
  if (line.cancellationDate && line.cancellationDate.getTime() <= now.getTime()) {
    return { allowed: false, reason: "subscription is past its cancellation date" };
  }
  return { allowed: true };
}
