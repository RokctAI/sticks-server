// Working hours and "off duty" for a Stick (Ray 11-09: "working hours", "off duty when told not to work",
// resting states). Each Stick may have weekly working hours in a time zone, and may be told to go off duty, either
// until a time or until told to come back. Off duty or outside its hours, a Stick's routines skip their occurrence
// (upstream routine gate, patch 0006) and keep-going does not push it on. A person writing to the Stick still gets
// an answer: the owner talking to it is never blocked, only work the Stick would start by itself.
// The owner tells the Stick in chat; the Stick calls the built-in "duty" plugin; the app reads the state to show
// the Stick resting.
import type { SqlQuery } from "./plugin-draft-store.js";

export const DUTY_TABLE_SQL = `CREATE TABLE IF NOT EXISTS sticks_duty (
  bot_id text PRIMARY KEY,
  hours jsonb,
  off_until timestamptz,
  off_reason text,
  updated_at timestamptz NOT NULL DEFAULT now()
)`;

export const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export type Day = (typeof DAYS)[number];
/** Weekly hours: per day a list of [start, end) in "HH:MM" local time; a day not listed is a rest day. */
export type Hours = { tz: string; days: Partial<Record<Day, Array<[string, string]>>> };
export type Duty = { hours: Hours | null; offUntil: Date | null; offReason: string | null };
export type DutyState = { on_duty: boolean; state: "working" | "off_duty" | "resting"; reason: string | null; until: string | null };

export class DutyError extends Error {}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$|^24:00$/;

/** Checks and normalises hours sent by the app or the Stick. Throws DutyError on anything malformed. */
export function parseHours(input: unknown): Hours {
  const h = input as { tz?: unknown; days?: unknown };
  if (!h || typeof h.tz !== "string" || !h.tz) throw new DutyError("hours.tz must be a time zone such as Africa/Johannesburg");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: h.tz });
  } catch {
    throw new DutyError("hours.tz is not a known time zone");
  }
  if (!h.days || typeof h.days !== "object") throw new DutyError("hours.days must map days to time ranges");
  const days: Hours["days"] = {};
  for (const [day, ranges] of Object.entries(h.days as Record<string, unknown>)) {
    if (!(DAYS as readonly string[]).includes(day)) throw new DutyError(`unknown day ${day}`);
    if (!Array.isArray(ranges)) throw new DutyError(`hours for ${day} must be a list of [start, end]`);
    days[day as Day] = ranges.map((r) => {
      if (!Array.isArray(r) || r.length !== 2 || !HHMM.test(String(r[0])) || !HHMM.test(String(r[1])) || String(r[0]) >= String(r[1]))
        throw new DutyError(`each range for ${day} must be ["HH:MM","HH:MM"] with start before end`);
      return [String(r[0]), String(r[1])] as [string, string];
    });
  }
  return { tz: h.tz, days };
}

/** The day and "HH:MM" of `at` in a time zone. */
function localDayTime(at: Date, tz: string): { day: Day; hhmm: string } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  return { day: String(parts.weekday).toLowerCase().slice(0, 3) as Day, hhmm: `${parts.hour}:${parts.minute}` };
}

export function withinHours(hours: Hours, at: Date): boolean {
  const { day, hhmm } = localDayTime(at, hours.tz);
  return (hours.days[day] ?? []).some(([start, end]) => hhmm >= start && hhmm < end);
}

/** Pure; tested. Off duty wins over hours; no hours set means always working. */
export function dutyState(duty: Duty, at: Date): DutyState {
  if (duty.offUntil && duty.offUntil.getTime() > at.getTime()) {
    const forever = !Number.isFinite(duty.offUntil.getTime()) || duty.offUntil.getUTCFullYear() >= 9999;
    return { on_duty: false, state: "off_duty", reason: duty.offReason, until: forever ? null : duty.offUntil.toISOString() };
  }
  if (duty.hours && !withinHours(duty.hours, at)) return { on_duty: false, state: "resting", reason: "outside working hours", until: null };
  return { on_duty: true, state: "working", reason: null, until: null };
}

/** "Until told otherwise" is stored as this date. */
export const UNTIL_TOLD = new Date("9999-12-31T00:00:00Z");

export class DutyStore {
  constructor(private readonly query: SqlQuery) {}
  async ensure(): Promise<void> {
    await this.query(DUTY_TABLE_SQL, []);
  }
  async get(botId: string): Promise<Duty> {
    const rows = (await this.query(`SELECT hours, off_until, off_reason FROM sticks_duty WHERE bot_id = $1`, [botId])) as Array<{
      hours: Hours | null;
      off_until: Date | string | null;
      off_reason: string | null;
    }>;
    const r = rows[0];
    if (!r) return { hours: null, offUntil: null, offReason: null };
    return { hours: r.hours, offUntil: r.off_until ? new Date(r.off_until) : null, offReason: r.off_reason };
  }
  async setHours(botId: string, hours: Hours | null): Promise<void> {
    await this.query(
      `INSERT INTO sticks_duty (bot_id, hours) VALUES ($1, $2::jsonb) ON CONFLICT (bot_id) DO UPDATE SET hours = EXCLUDED.hours, updated_at = now()`,
      [botId, hours ? JSON.stringify(hours) : null],
    );
  }
  async setOff(botId: string, until: Date | null, reason: string | null): Promise<void> {
    await this.query(
      `INSERT INTO sticks_duty (bot_id, off_until, off_reason) VALUES ($1, $2, $3)
       ON CONFLICT (bot_id) DO UPDATE SET off_until = EXCLUDED.off_until, off_reason = EXCLUDED.off_reason, updated_at = now()`,
      [botId, until, reason],
    );
  }
}

/** Applies one change from the app or the plugin: {hours} | {hours:null} | {off:{until?, reason?}} | {on:true}. */
export async function applyDutyChange(store: DutyStore, botId: string, body: unknown, now: Date): Promise<DutyState> {
  const b = (body ?? {}) as { hours?: unknown; off?: { until?: unknown; reason?: unknown }; on?: unknown };
  if ("hours" in b) await store.setHours(botId, b.hours === null ? null : parseHours(b.hours));
  if (b.off !== undefined) {
    let until = UNTIL_TOLD;
    if (b.off.until !== undefined && b.off.until !== null) {
      const d = new Date(String(b.off.until));
      if (!Number.isFinite(d.getTime()) || d.getTime() <= now.getTime()) throw new DutyError("off.until must be a time in the future");
      until = d;
    }
    const reason = typeof b.off.reason === "string" ? b.off.reason.slice(0, 200) : null;
    await store.setOff(botId, until, reason);
  }
  if (b.on === true) await store.setOff(botId, null, null);
  return dutyState(await store.get(botId), now);
}

export function dutyPluginDocument(engineUrl: string): unknown {
  const stick = { stick_id: { type: "string", description: "This Stick's id" }, thread_id: { type: "string", description: "The chat, if the id is not known" } };
  return {
    openapi: "3.0.3",
    info: { title: "Duty", version: "1.0.0" },
    servers: [{ url: engineUrl }],
    paths: {
      "/internal/duty": {
        post: {
          operationId: "set_duty",
          summary:
            "Go off duty when the owner says to stop working (optionally until a time), come back on duty when told, or set weekly working hours. Off duty or outside hours you start no work by yourself; you still answer people.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    ...stick,
                    off: { type: "object", properties: { until: { type: "string", format: "date-time" }, reason: { type: "string" } } },
                    on: { type: "boolean" },
                    hours: {
                      type: "object",
                      properties: { tz: { type: "string" }, days: { type: "object", additionalProperties: { type: "array", items: { type: "array", items: { type: "string" } } } } },
                    },
                  },
                },
              },
            },
          },
          responses: { "200": { description: "The Stick's duty state" } },
        },
      },
    },
  };
}
