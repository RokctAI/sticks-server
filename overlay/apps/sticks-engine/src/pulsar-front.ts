// The engine's front door (brief task 9 session layer). It sits in front of upstream's app:
// - POST /internal/pulsar/sign-in turns a verified Pulsar token into a session;
// - every other upstream sign-in route (password, emailed code, passkey, SSO, sign-up) answers 404;
// - a guest session may only read.
import { envelopeFromAuthorization, NonceCache, PulsarTokenError, verifyPulsarToken } from "./pulsar-token.js";
import type { SqlQuery } from "./plugin-draft-store.js";
import { guestMayDo, isClosedAuthPath, isGuestSession, openPulsarSession, sessionTokenFrom } from "./pulsar-session.js";
import type { FetchApp, NodeEnv } from "./serve.js";
import { countStream } from "./activity.js";
import { engineUserId, knownTenant } from "./tenants.js";
import { publicKeyFromRawBase64 } from "./pulsar-token.js";

import { drainFlag, refusedWhileDraining } from "./drain.js";

export const SIGN_IN_PATH = "/internal/pulsar/sign-in";

export type FrontDeps = {
  query: SqlQuery;
  authSecret: string;
  /** Read per request so a rotated key needs no restart; undefined when not provisioned. */
  publicKey: () => ReturnType<typeof publicKeyFromRawBase64> | undefined;
  sender: { kind: string; id: string };
  tenant: string;
  nonces?: NonceCache;
  now?: () => Date;
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export function pulsarFront(inner: FetchApp, deps: FrontDeps): FetchApp {
  const nonces = deps.nonces ?? new NonceCache();
  const now = deps.now ?? (() => new Date());
  return {
    fetch: async (request: Request, env: NodeEnv) => {
      const url = new URL(request.url);
      if (url.pathname === SIGN_IN_PATH) {
        if (request.method !== "POST") return json(405, { error: "method not allowed" });
        const at = now();
        let verified;
        let registered: ReturnType<typeof knownTenant>;
        try {
          const envelope = envelopeFromAuthorization(request.headers.get("authorization") ?? undefined);
          // Many tenants (tenants.ts): the signing site names the tenant; its own key must verify the token.
          const site = (envelope as { sender?: { id?: unknown } })?.sender?.id;
          registered = typeof site === "string" ? knownTenant(site) : undefined;
          const key = registered ? publicKeyFromRawBase64(registered.publicKey) : deps.publicKey();
          if (!key) return json(401, { error: "unauthorized" });
          verified = verifyPulsarToken(envelope, {
            publicKey: key,
            expectedSender: registered ? { kind: deps.sender.kind, id: registered.site } : deps.sender,
            tenant: registered ? registered.tenant : deps.tenant,
            nowSeconds: Math.floor(at.getTime() / 1000),
            nonces,
          });
        } catch (error) {
          if (error instanceof PulsarTokenError) return json(401, { error: error.code });
          return json(401, { error: "malformed" });
        }
        // User ids inside the engine carry the tenant ("acme/Administrator"), so a Pulsar user name with a slash could
        // land on another tenant's user id. Refused for every tenant.
        if (verified.user.includes("/")) return json(401, { error: "unauthorized" });
        const session = await openPulsarSession(
          deps.query, verified, deps.authSecret, at,
          registered ? { orgId: registered.orgId, spaceId: registered.spaceId, userId: engineUserId(registered, verified.user) } : undefined,
        );
        return json(200, { token: session.bearer, expiresAt: session.expiresAt.toISOString() });
      }
      if (isClosedAuthPath(url.pathname)) return json(404, { error: "not found" });
      // During a docker move nothing new starts; the app retries after resume (drain.ts).
      if (refusedWhileDraining(drainFlag.draining, request.method, url.pathname)) return json(503, { error: "moving", retry: true });
      if (!guestMayDo(request.method)) {
        const raw = sessionTokenFrom(request.headers);
        if (raw && (await isGuestSession(deps.query, raw, now()))) return json(403, { error: "guests may only read" });
      }
      return countStream(await inner.fetch(request, env));
    },
  };
}
