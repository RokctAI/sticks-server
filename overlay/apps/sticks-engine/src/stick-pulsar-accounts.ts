// Stick Pulsar accounts (Ray 11-22: "in sticks a bot has account similar to human"; core#1627). When a tenant
// admin sets up a Stick's Pulsar account, the engine asks Pulsar (api.sticks.create_account, System Manager only,
// using the admin's own Pulsar token for that one call) and keeps the Stick's token. /run/secrets is read-only at
// run time, so the token is stored in our table encrypted with a key derived from the engine secret (AES-256-GCM).
// Caller: the proxy in engine.ts (/internal/pulsar/:area/:op) reads it; the admin screen in the Sticks app calls
// POST /internal/sticks/:stick/pulsar-account.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { SqlQuery } from "./plugin-draft-store.js";

export const STICK_TOKENS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS sticks_pulsar_tokens (
  stick_id text PRIMARY KEY,
  pulsar_user text NOT NULL,
  sealed text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
)`;

export class StickAccountError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 502) {
    super(message);
  }
}

export const validStickId = (s: unknown): s is string => typeof s === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(s);

const keyFrom = (engineSecret: string) => createHash("sha256").update(`sticks-pulsar-tokens:${engineSecret}`).digest();

export function seal(token: string, engineSecret: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", keyFrom(engineSecret), iv);
  const body = Buffer.concat([c.update(token, "utf8"), c.final()]);
  return [iv, c.getAuthTag(), body].map((b) => b.toString("base64")).join(".");
}

export function unseal(sealed: string, engineSecret: string): string {
  const [iv, tag, body] = sealed.split(".").map((p) => Buffer.from(p, "base64"));
  const d = createDecipheriv("aes-256-gcm", keyFrom(engineSecret), iv!);
  d.setAuthTag(tag!);
  return Buffer.concat([d.update(body!), d.final()]).toString("utf8");
}

export async function saveStickToken(query: SqlQuery, stickId: string, pulsarUser: string, token: string, engineSecret: string): Promise<void> {
  await query(STICK_TOKENS_TABLE_SQL, []);
  await query(
    `INSERT INTO sticks_pulsar_tokens (stick_id, pulsar_user, sealed) VALUES ($1,$2,$3)
     ON CONFLICT (stick_id) DO UPDATE SET pulsar_user = EXCLUDED.pulsar_user, sealed = EXCLUDED.sealed, updated_at = now()`,
    [stickId, pulsarUser, seal(token, engineSecret)],
  );
}

/** The Stick's Pulsar token, or undefined when it has no account yet. */
export async function stickToken(query: SqlQuery, stickId: string, engineSecret: string): Promise<string | undefined> {
  await query(STICK_TOKENS_TABLE_SQL, []);
  const rows = (await query(`SELECT sealed FROM sticks_pulsar_tokens WHERE stick_id = $1`, [stickId])) as Array<{ sealed: string }>;
  return rows[0] ? unseal(rows[0].sealed, engineSecret) : undefined;
}

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/** Creates (or, when it exists, rotates) the Stick's Pulsar user with the admin's token and keeps the Stick's token. */
export async function setUpStickAccount(
  query: SqlQuery, fetcher: Fetch, pulsarUrl: string, adminToken: string, engineSecret: string,
  input: { stickId: unknown; displayName: unknown; role: unknown; directors?: unknown },
): Promise<{ user: string }> {
  const { stickId, displayName, role, directors } = input;
  if (!validStickId(stickId)) throw new StickAccountError("stick id is invalid", 400);
  if (typeof displayName !== "string" || !displayName.trim()) throw new StickAccountError("displayName is required", 400);
  if (typeof role !== "string" || !role.trim()) throw new StickAccountError("role is required", 400);
  if (directors !== undefined && !(Array.isArray(directors) && directors.every((d) => typeof d === "string"))) throw new StickAccountError("directors must be a list of users", 400);
  const call = (method: string, args: Record<string, unknown>) =>
    fetcher(`${pulsarUrl}/api/method/api.sticks.${method}`, {
      method: "POST",
      headers: { authorization: `token ${adminToken}`, "content-type": "application/json" },
      body: JSON.stringify(args),
    });
  let res = await call("create_account", { stick_id: stickId, display_name: displayName, role, directors: directors ?? [] });
  if (res.status === 409) res = await call("rotate_token", { stick_id: stickId });
  if (res.status === 401 || res.status === 403) throw new StickAccountError("only a tenant admin can set up a Stick's Pulsar account", 403);
  if (!res.ok) throw new StickAccountError("Pulsar could not set up the account", 502);
  const out = (await res.json().catch(() => ({}))) as { message?: { user?: string; token?: string }; user?: string; token?: string };
  const msg = out.message ?? out;
  if (!msg.user || !msg.token) throw new StickAccountError("Pulsar did not return the account", 502);
  await saveStickToken(query, stickId, msg.user, msg.token, engineSecret);
  return { user: msg.user };
}
