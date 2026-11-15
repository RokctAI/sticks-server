// Model and speech calls go through the model gateway (spec 4.4, 8.3; brief task 13). The engine holds
// no provider key: it sends its gateway key where the provider's own key would go, under the
// gateway's path for that provider. The contract is in docs/gateway-protocol.md.
import { readSecret, SECRETS_DIR } from "./config.js";

/** Auth header per provider. Only providers whose header is settled are listed (see the doc). */
export const PROVIDER_AUTH: Readonly<Record<string, "x-api-key" | "bearer">> = {
  anthropic: "x-api-key",
  openai: "bearer",
};

/**
 * Environment variables that carry a provider's own key. The engine refuses to start if any is set to
 * a non-empty value (startEngine), so a provider key cannot reach a tenant through its environment.
 */
export const PROVIDER_KEY_ENV_NAMES: readonly string[] = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "GOOGLE_API_KEY",
  "GEMINI_API_KEY",
  "MISTRAL_API_KEY",
  "GROQ_API_KEY",
  "DEEPSEEK_API_KEY",
  "XAI_API_KEY",
  "ELEVENLABS_API_KEY",
  "DEEPGRAM_API_KEY",
  "ASSEMBLYAI_API_KEY",
  "OPENAI_COMPATIBLE_API_KEY",
];

const PROVIDER_ID = /^[a-z][a-z0-9-]*$/;

/** The base URL for one provider: `${gateway}/<provider>`, with no trailing slash. */
export function gatewayUrlFor(gatewayUrl: string, provider: string): string {
  if (!PROVIDER_ID.test(provider)) throw new Error(`not a provider id: ${provider}`);
  const base = gatewayUrl.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//.test(base)) throw new Error("STICKS_GATEWAY_URL must be an http(s) URL");
  return `${base}/${provider}`;
}

/** The auth headers for one provider, carrying the gateway key in the provider's own header. */
export function gatewayHeaders(provider: string, gatewayKey: string): Record<string, string> {
  const style = Object.prototype.hasOwnProperty.call(PROVIDER_AUTH, provider) ? PROVIDER_AUTH[provider] : undefined;
  if (!style) throw new Error(`no auth header is settled for provider ${provider}`);
  if (!gatewayKey) throw new Error("the gateway key is empty");
  return style === "x-api-key" ? { "x-api-key": gatewayKey } : { authorization: `Bearer ${gatewayKey}` };
}

/** The gateway key, from /run/secrets/gateway_key (or a folder given for tests). */
export function readGatewayKey(secretsDir: string = SECRETS_DIR): string {
  return readSecret("gateway_key", secretsDir);
}

/** The provider key variables that are set (non-empty) in this environment. Empty values do not count. */
export function providerKeysInEnv(env: NodeJS.ProcessEnv): string[] {
  return PROVIDER_KEY_ENV_NAMES.filter((name) => (env[name] ?? "").trim() !== "");
}
