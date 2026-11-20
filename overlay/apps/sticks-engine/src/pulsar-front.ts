// The engine's front door (brief task 9 session layer). It sits in front of upstream's app:
// - POST /internal/pulsar/sign-in turns a verified Pulsar token into a session;
// - every other upstream sign-in route (password, emailed code, passkey, SSO, sign-up) answers 404;
// - a guest session may only read.
import { envelopeFromAuthorization, NonceCache, PulsarTokenError, verifyPulsarToken } from "./pulsar-token.js";
import type { publicKeyFromRawBase64 } from "./pulsar-token.js";
import type { SqlQuery } from "./plugin-draft-store.js";
import { guestMayDo, isClosedAuthPath, isGuestSession, openPulsarSession, sessionTokenFrom } from "./pulsar-session.js";
import type { FetchApp, NodeEnv } from "./serve.js";
import { countStream } from "./activity.js";

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
        const key = deps.publicKey();
        if (!key) return json(503, { error: "pulsar public key not provisioned" });
        const at = now();
        let verified;
        try {
          verified = verifyPulsarToken(envelopeFromAuthorization(request.headers.get("authorization") ?? undefined), {
            publicKey: key,
            expectedSender: deps.sender,
            tenant: deps.tenant,
            nowSeconds: Math.floor(at.getTime() / 1000),
            nonces,
          });
        } catch (error) {
          if (error instanceof PulsarTokenError) return json(401, { error: error.code });
          return json(401, { error: "malformed" });
        }
        const session = await openPulsarSession(deps.query, verified, deps.authSecret, at);
        return json(200, { token: session.bearer, expiresAt: session.expiresAt.toISOString() });
      }
      if (isClosedAuthPath(url.pathname)) return json(404, { error: "not found" });
      if (!guestMayDo(request.method)) {
        const raw = sessionTokenFrom(request.headers);
        if (raw && (await isGuestSession(deps.query, raw, now()))) return json(403, { error: "guests may only read" });
      }
      return countStream(await inner.fetch(request, env));
    },
  };
}
