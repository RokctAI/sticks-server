// Hub feature switches (Ray 11-22 "Yes"): the hub resolves switches per plan with per-tenant overrides and sends
// them on get_subscription_status (agent#687). Pulsar keeps the latest and posts them here whenever they change
// (core#1630). If none ever arrived, everything is on, so older tenants keep working. Callers: Pulsar posts;
// the Sticks app and engine checks read GET /internal/features.
import type { SqlQuery } from "./plugin-draft-store.js";

export const FEATURE_KEYS = ["plugin_building", "unsupported_service_plugins", "voice_calls", "hands_on"] as const;
export type FeatureKey = (typeof FEATURE_KEYS)[number];
export type Features = Record<FeatureKey, boolean>;
// Ray 11-28: a Stick never creates a plugin itself; people send a service request instead. Both plugin switches
// start OFF (the code stays). The hub can still turn them on. Everything else is on until the hub says otherwise.
export const ALL_ON: Features = { plugin_building: false, unsupported_service_plugins: false, voice_calls: true, hands_on: true };

export const FEATURES_TABLE_SQL = `CREATE TABLE IF NOT EXISTS sticks_features (
  id smallint PRIMARY KEY CHECK (id = 1),
  features jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
)`;

/** Keeps known boolean keys; a missing key keeps its current value. Unknown keys are ignored. */
export function mergeFeatures(current: Features, incoming: unknown): Features {
  const out = { ...current };
  if (incoming && typeof incoming === "object") {
    for (const k of FEATURE_KEYS) {
      const v = (incoming as Record<string, unknown>)[k];
      if (typeof v === "boolean") out[k] = v;
    }
  }
  return out;
}

export async function readFeatures(query: SqlQuery): Promise<Features> {
  const rows = (await query(`SELECT features FROM sticks_features WHERE id = 1`, [])) as Array<{ features: unknown }>;
  return mergeFeatures(ALL_ON, rows[0]?.features);
}

export async function saveFeatures(query: SqlQuery, incoming: unknown): Promise<Features> {
  const next = mergeFeatures(await readFeatures(query), incoming);
  await query(
    `INSERT INTO sticks_features (id, features) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET features = EXCLUDED.features, updated_at = now()`,
    [JSON.stringify(next)],
  );
  return next;
}
