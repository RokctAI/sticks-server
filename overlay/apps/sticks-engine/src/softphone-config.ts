// The SIP domain the softphone registers with (outbound calls to clients; see the telephony todo item).
// It is configuration, not code: the default is the current host, and the environment changes it, so a domain
// change is a config change. Only the host name is taken here; the softphone builds its own SIP URIs from it.

/** The host the softphone registers with when no environment value is set. */
export const DEFAULT_SIP_DOMAIN = "voip.rokct.ai";

export type SoftphoneConfig = { domain: string };

const HOST = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i;

/**
 * Reads STICKS_SIP_DOMAIN. Unset or empty means the default. A value that is not a bare host name (a scheme,
 * a port, a path or spaces) is refused at start, so a bad setting cannot reach a call.
 */
export function softphoneConfigFromEnv(env: NodeJS.ProcessEnv): SoftphoneConfig {
  const raw = (env.STICKS_SIP_DOMAIN ?? "").trim();
  if (!raw) return { domain: DEFAULT_SIP_DOMAIN };
  const domain = raw.toLowerCase();
  if (!HOST.test(domain)) {
    throw new Error(`STICKS_SIP_DOMAIN must be a bare host name (no scheme, port or path), got ${raw}`);
  }
  return { domain };
}
