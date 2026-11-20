// Settings from Pulsar (spec 5.1 "Sticks Settings", 5.3 row 4; brief task 11).
// Pulsar pushes them to POST /internal/settings (engine secret), and the engine pulls them at boot from
// STICKS_SETTINGS_URL. Hub limits (`hub_settings.limits`) always win over the tenant's own values.
// The current settings live in the engine's own table `sticks_settings` (one row), so a restart keeps them.
import type { SqlQuery } from "./plugin-draft-store.js";

export type ApprovalsPolicy = "ask_writes" | "ask_all" | "never";

export type KeepGoingDefaults = { enabled: boolean; maxNoProgress: number; maxPerDay: number; gapSeconds: number };

export type SticksSettings = {
  defaultModel: string | null;
  approvals: ApprovalsPolicy;
  sleepDelaySeconds: number;
  browserAllowed: boolean;
  homeQuotaMb: number;
  keepGoing: KeepGoingDefaults;
};

/** Upper bounds the hub sets for every tenant. Any field may be missing. */
export type HubLimits = Partial<{
  sleepDelaySeconds: number;
  homeQuotaMb: number;
  browserAllowed: boolean;
  keepGoingMaxPerDay: number;
}>;

export const DEFAULT_SETTINGS: SticksSettings = {
  defaultModel: null,
  approvals: "ask_writes",
  sleepDelaySeconds: 600,
  browserAllowed: false,
  homeQuotaMb: 1024,
  // Spec 7.5 defaults: 3 tries without progress, 20 a day, 60 s gap.
  keepGoing: { enabled: true, maxNoProgress: 3, maxPerDay: 20, gapSeconds: 60 },
};

export const SETTINGS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS sticks_settings (
  id smallint PRIMARY KEY CHECK (id = 1),
  body jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
)`;

export class SettingsError extends Error {}

const POLICIES: ApprovalsPolicy[] = ["ask_writes", "ask_all", "never"];

function int(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new SettingsError(`${name} must be a whole number from ${min} to ${max}`);
  }
  return value;
}

function bool(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new SettingsError(`${name} must be true or false`);
  return value;
}

/**
 * Checks Pulsar's payload: `{ settings: {...}, hub_settings?: { limits?: {...} } }` with snake_case keys
 * (Pulsar is Python). Missing fields keep their current value; unknown fields are refused.
 */
export function parseSettings(payload: unknown, current: SticksSettings = DEFAULT_SETTINGS): { settings: SticksSettings; limits: HubLimits } {
  if (!payload || typeof payload !== "object") throw new SettingsError("body must be an object");
  const { settings = {}, hub_settings: hub = {} } = payload as { settings?: Record<string, unknown>; hub_settings?: { limits?: Record<string, unknown> } };
  const known = ["default_model", "approvals", "sleep_delay_seconds", "browser_allowed", "home_quota_mb", "keep_going"];
  for (const key of Object.keys(settings)) if (!known.includes(key)) throw new SettingsError(`unknown setting ${key}`);
  const s: SticksSettings = structuredClone(current);
  if ("default_model" in settings) {
    const v = settings.default_model;
    if (v !== null && (typeof v !== "string" || !v.trim() || v.length > 200)) throw new SettingsError("default_model must be a model id or null");
    s.defaultModel = v === null ? null : (v as string).trim();
  }
  if ("approvals" in settings) {
    if (!POLICIES.includes(settings.approvals as ApprovalsPolicy)) throw new SettingsError(`approvals must be one of ${POLICIES.join(", ")}`);
    s.approvals = settings.approvals as ApprovalsPolicy;
  }
  if ("sleep_delay_seconds" in settings) s.sleepDelaySeconds = int(settings.sleep_delay_seconds, "sleep_delay_seconds", 60, 86_400);
  if ("browser_allowed" in settings) s.browserAllowed = bool(settings.browser_allowed, "browser_allowed");
  if ("home_quota_mb" in settings) s.homeQuotaMb = int(settings.home_quota_mb, "home_quota_mb", 64, 1_048_576);
  if ("keep_going" in settings) {
    const k = settings.keep_going as Record<string, unknown>;
    if (!k || typeof k !== "object") throw new SettingsError("keep_going must be an object");
    if ("enabled" in k) s.keepGoing.enabled = bool(k.enabled, "keep_going.enabled");
    if ("max_no_progress" in k) s.keepGoing.maxNoProgress = int(k.max_no_progress, "keep_going.max_no_progress", 1, 100);
    if ("max_per_day" in k) s.keepGoing.maxPerDay = int(k.max_per_day, "keep_going.max_per_day", 0, 1000);
    if ("gap_seconds" in k) s.keepGoing.gapSeconds = int(k.gap_seconds, "keep_going.gap_seconds", 10, 86_400);
  }
  const raw = hub.limits ?? {};
  const limits: HubLimits = {};
  if ("sleep_delay_seconds" in raw) limits.sleepDelaySeconds = int(raw.sleep_delay_seconds, "limits.sleep_delay_seconds", 60, 86_400);
  if ("home_quota_mb" in raw) limits.homeQuotaMb = int(raw.home_quota_mb, "limits.home_quota_mb", 64, 1_048_576);
  if ("browser_allowed" in raw) limits.browserAllowed = bool(raw.browser_allowed, "limits.browser_allowed");
  if ("keep_going_max_per_day" in raw) limits.keepGoingMaxPerDay = int(raw.keep_going_max_per_day, "limits.keep_going_max_per_day", 0, 1000);
  return { settings: s, limits };
}

/** Hub limits win: each limited value is capped, and a hub "no browser" turns the browser off. */
export function applyLimits(s: SticksSettings, limits: HubLimits): SticksSettings {
  const out = structuredClone(s);
  if (limits.sleepDelaySeconds !== undefined) out.sleepDelaySeconds = Math.min(out.sleepDelaySeconds, limits.sleepDelaySeconds);
  if (limits.homeQuotaMb !== undefined) out.homeQuotaMb = Math.min(out.homeQuotaMb, limits.homeQuotaMb);
  if (limits.browserAllowed === false) out.browserAllowed = false;
  if (limits.keepGoingMaxPerDay !== undefined) out.keepGoing.maxPerDay = Math.min(out.keepGoing.maxPerDay, limits.keepGoingMaxPerDay);
  return out;
}

/** The settings store: read once at boot, then kept in memory and written through on every change. */
export class SettingsStore {
  private current: SticksSettings = structuredClone(DEFAULT_SETTINGS);
  constructor(private readonly query: SqlQuery) {}

  async load(): Promise<SticksSettings> {
    await this.query(SETTINGS_TABLE_SQL, []);
    const rows = (await this.query(`SELECT body FROM sticks_settings WHERE id = 1`, [])) as Array<{ body: SticksSettings }>;
    if (rows[0]) this.current = { ...structuredClone(DEFAULT_SETTINGS), ...rows[0].body };
    return this.get();
  }

  get(): SticksSettings {
    return structuredClone(this.current);
  }

  /** Validates, applies hub limits, stores. Throws SettingsError on a bad payload (nothing changes). */
  async update(payload: unknown): Promise<SticksSettings> {
    const { settings, limits } = parseSettings(payload, this.current);
    const next = applyLimits(settings, limits);
    await this.query(
      `INSERT INTO sticks_settings (id, body, updated_at) VALUES (1, $1::jsonb, now())
       ON CONFLICT (id) DO UPDATE SET body = EXCLUDED.body, updated_at = now()`,
      [JSON.stringify(next)],
    );
    this.current = next;
    return this.get();
  }
}

/** Pulls the settings from Pulsar at boot. A failure keeps the stored settings (logged by the caller). */
export async function pullSettings(url: string, secret: string, fetchImpl: typeof fetch = fetch): Promise<unknown> {
  const res = await fetchImpl(url, { headers: { authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`settings pull answered HTTP ${res.status}`);
  return res.json();
}
