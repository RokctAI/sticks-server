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
 * Any environment variable named like a provider key (`*_API_KEY`). The engine refuses to start if one
 * is set to a non-empty value (startEngine), so a provider key cannot reach a tenant through its
 * environment. The rule is the name pattern, not a fixed list, so a new provider is covered too.
 */
export const PROVIDER_KEY_ENV_PATTERN = /_API_KEY$/;

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

/** The provider key variables (any `*_API_KEY`) set to a non-empty value. Empty values do not count. */
export function providerKeysInEnv(env: NodeJS.ProcessEnv): string[] {
  return Object.keys(env)
    .filter((name) => PROVIDER_KEY_ENV_PATTERN.test(name) && (env[name] ?? "").trim() !== "")
    .sort();
}

/**
 * A catalogue entry pointed at the gateway: its base URL becomes `${gateway}/<its provider>`. Every other
 * field is kept as it is. Works on any model shape with `provider` and `baseUrl` (pi-ai's Model type).
 */
export function throughGateway<T extends { provider: string; baseUrl: string }>(model: T, gatewayUrl: string): T {
  return { ...model, baseUrl: gatewayUrlFor(gatewayUrl, model.provider) };
}
