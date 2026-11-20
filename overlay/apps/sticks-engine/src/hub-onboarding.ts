// Hub onboarding (control#204, engine side). The hub's onboarding bot runs inside the new tenant's engine
// with three tools: onboarding state, save answer, finish. The hub answers them through Pulsar's one
// gateway method with an onboarding token that provision_new_tenant made. The token is the tenant's, not
// a user's: the Next.js chat page hands it to the engine once, the engine stores it, and the engine's own
// proxy adds it to every call. The model never sees the token.
//
// Turned on by STICKS_HUB_ONBOARDING=1 with STICKS_HUB_URL. The built-in plugin "hub-onboarding" points at
// the engine's proxy routes below, so the plugin itself carries no credential.
import type { SqlQuery } from "./plugin-draft-store.js";

export const ONBOARDING_TABLE_SQL = `CREATE TABLE IF NOT EXISTS sticks_onboarding (
  id smallint PRIMARY KEY CHECK (id = 1),
  token text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
)`;

export const HUB_METHOD_PATH = "/api/v1/method/rokct.platform.api";

/** The three tools, each mapped to the hub command it calls. */
export const ONBOARDING_COMMANDS = {
  state: "control:onboarding_state",
  "save-answer": "control:onboarding_save_answer",
  finish: "control:onboarding_finish",
} as const;
export type OnboardingTool = keyof typeof ONBOARDING_COMMANDS;

export class OnboardingError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Plugins must name an https server, so the plugin points at the engine's public https address. */
export function onboardingEnabled(env: Record<string, string | undefined>): { hubUrl: string; engineUrl: string } | undefined {
  if (env.STICKS_HUB_ONBOARDING?.trim() !== "1") return undefined;
  const hubUrl = env.STICKS_HUB_URL?.trim().replace(/\/+$/, "");
  if (!hubUrl || !/^https?:\/\//.test(hubUrl)) throw new Error("STICKS_HUB_ONBOARDING=1 needs STICKS_HUB_URL (http or https)");
  const engineUrl = env.STICKS_ENGINE_URL?.trim().replace(/\/+$/, "");
  if (!engineUrl || !/^https:\/\//.test(engineUrl)) throw new Error("STICKS_HUB_ONBOARDING=1 needs STICKS_ENGINE_URL (the engine's public https address)");
  return { hubUrl, engineUrl };
}

export async function saveOnboardingToken(query: SqlQuery, token: unknown): Promise<void> {
  if (typeof token !== "string" || !token.trim() || token.length > 512) throw new OnboardingError("onboarding_token must be a string", 400);
  await query(ONBOARDING_TABLE_SQL, []);
  await query(
    `INSERT INTO sticks_onboarding (id, token, updated_at) VALUES (1, $1, now())
     ON CONFLICT (id) DO UPDATE SET token = EXCLUDED.token, updated_at = now()`,
    [token.trim()],
  );
}

export async function readOnboardingToken(query: SqlQuery): Promise<string | undefined> {
  await query(ONBOARDING_TABLE_SQL, []);
  const rows = (await query(`SELECT token FROM sticks_onboarding WHERE id = 1`, [])) as Array<{ token: string }>;
  return rows[0]?.token;
}

/**
 * Calls the hub for one tool. The model's arguments go in the payload; a session_token key from the model
 * is dropped, and the stored token is added. The hub wraps replies as {message: ...}; that is unwrapped.
 * A refused token (403) and a validation error (417) come back as OnboardingError with a plain message.
 */
export async function callHub(
  hubUrl: string,
  token: string,
  tool: OnboardingTool,
  args: unknown,
  fetchImpl: typeof fetch = fetch,
): Promise<unknown> {
  const payload: Record<string, unknown> = args && typeof args === "object" && !Array.isArray(args) ? { ...(args as Record<string, unknown>) } : {};
  delete payload.session_token;
  payload.session_token = token;
  const res = await fetchImpl(`${hubUrl}${HUB_METHOD_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cmd: ONBOARDING_COMMANDS[tool], payload }),
    signal: AbortSignal.timeout(20_000),
  });
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
  if (res.status === 403) throw new OnboardingError("the hub refused the onboarding token", 403);
  if (res.status === 417) throw new OnboardingError(hubMessage(body) ?? "the hub refused the answer", 422);
  if (!res.ok) throw new OnboardingError(`the hub answered HTTP ${res.status}`, 502);
  return body && typeof body === "object" && "message" in body ? (body as { message: unknown }).message : body;
}

function hubMessage(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const b = body as Record<string, unknown>;
  for (const key of ["exception", "message", "_server_messages"]) if (typeof b[key] === "string") return (b[key] as string).slice(0, 500);
  return undefined;
}

/** The built-in plugin's description. Its server is the engine itself; the proxy adds the token. */
export function onboardingPluginDocument(engineUrl: string): unknown {
  const op = (operationId: string, summary: string, schema: unknown) => ({
    post: {
      operationId,
      summary,
      requestBody: { required: true, content: { "application/json": { schema } } },
      responses: { "200": { description: "The hub's answer" } },
    },
  });
  return {
    openapi: "3.0.3",
    info: { title: "Hub onboarding", version: "1.0.0" },
    servers: [{ url: engineUrl }],
    paths: {
      "/internal/onboarding/state": op("onboarding_state", "Which questions are answered, the next question, what is unlocked, and whether the site is building", { type: "object", properties: {} }),
      "/internal/onboarding/save-answer": op("onboarding_save_answer", "Save the tenant's answer to one question, in their own words", {
        type: "object",
        required: ["key", "answer"],
        properties: { key: { type: "string" }, answer: { type: "string" } },
      }),
      "/internal/onboarding/finish": op("onboarding_finish", "Finish onboarding. Only when the tenant says they are done", { type: "object", properties: {} }),
    },
  };
}
