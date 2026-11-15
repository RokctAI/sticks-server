// Verifies the engine token Pulsar signs for a user (spec 7.2, 5.3; brief task 9).
//
// The token is core's signed envelope (RokctAI/core, pulsar/pulsar/envelope.py, protocol v1):
//   { v, sender: {kind, id}, ts, nonce, body, sig }
//   signed string: v|kind|sender.id|ts|nonce|sha256(canonical JSON of body), ed25519, base64.
//   ts within 5 minutes of the receiver's clock; a nonce is accepted once per sender in 10 minutes.
// The body is { tenant, user, role, exp } with exp in epoch seconds (five minutes after issue).
//
// Settled here: the envelope rules above, the body checks, the role mapping for the three roles
// whose upstream role is clear. NOT settled, so NOT decided here (see docs/pulsar-engine-interface.md):
// the sender.kind and sender.id Pulsar puts in the token (the caller passes them in), the header the
// engine token travels in, and the role for Sticks Guest.
import { createHash, createPublicKey, verify as cryptoVerify, sign as cryptoSign, createPrivateKey } from "node:crypto";

export const ENVELOPE_VERSION = 1;
export const MAX_SKEW_SECONDS = 300;
export const NONCE_WINDOW_SECONDS = 600;

/** The fixed prefix of an ed25519 SubjectPublicKeyInfo; the raw 32-byte key follows it. */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

export type TokenErrorCode =
  | "malformed"
  | "bad_signature"
  | "stale"
  | "replay"
  | "wrong_tenant"
  | "expired"
  | "unknown_role";

export class PulsarTokenError extends Error {
  constructor(readonly code: TokenErrorCode, message = "") {
    super(message ? `${code}: ${message}` : code);
  }
}

export type TokenEnvelope = {
  v: number;
  sender: { kind: string; id: string };
  ts: string;
  nonce: string;
  body: unknown;
  sig: string;
};

export type TokenBody = { tenant: string; user: string; role: string; exp: number };

/**
 * Sticks roles to upstream's. Owner and Member are clear. Admin maps to upstream's organization admin
 * (the space itself has only owner and member), which is a proposal, not settled by the spec.
 * Guest has no mapping: a token that carries it is refused until the owner decides (BLOCKED, see the PR).
 */
export const STICKS_ROLE_MAP: Readonly<Record<string, "owner" | "admin" | "member">> = {
  "Sticks Owner": "owner",
  "Sticks Admin": "admin",
  "Sticks Member": "member",
};

/** The sender kind Pulsar signs with for a tenant's engine (settled 11-15, docs/pulsar-engine-interface.md). */
export const SETTLED_SENDER_KIND = "site";

/** The expected sender for this tenant: kind "site", id the tenant's site host name (STICKS_TENANT_SITE). */
export function senderFromTenantSite(siteHost: string): { kind: string; id: string } {
  const id = siteHost.trim();
  if (!id) throw new PulsarTokenError("malformed", "STICKS_TENANT_SITE is empty");
  return { kind: SETTLED_SENDER_KIND, id };
}

/**
 * Reads the engine token from an Authorization header: `Bearer <base64url of the JSON envelope>`
 * (settled 11-15). Returns the parsed envelope; verifyPulsarToken checks it.
 */
export function envelopeFromAuthorization(header: string | undefined): unknown {
  const token = /^Bearer ([A-Za-z0-9_-]+)$/.exec(header ?? "")?.[1];
  if (!token) throw new PulsarTokenError("malformed", "Authorization is not Bearer <base64url>");
  try {
    // base64url mapped to base64 by hand: the Node types upstream compiles against do not list "base64url".
    const standard = token.replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(Buffer.from(standard, "base64").toString("utf8")) as unknown;
  } catch {
    throw new PulsarTokenError("malformed", "token is not base64url JSON");
  }
}

/** Canonical JSON: keys sorted at every level, no spaces, UTF-8 (matches core's _canonical). */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

/** The exact string core signs. */
export function signingString(
  v: number,
  kind: string,
  senderId: string,
  ts: string,
  nonce: string,
  body: unknown,
): Buffer {
  const digest = createHash("sha256").update(canonicalJson(body), "utf8").digest("hex");
  return Buffer.from(`${v}|${kind}|${senderId}|${ts}|${nonce}|${digest}`, "utf8");
}

/** An ed25519 public key from a raw 32-byte key in base64 (what core's generate_keypair writes). */
export function publicKeyFromRawBase64(rawBase64: string) {
  const raw = Buffer.from(rawBase64.trim(), "base64");
  if (raw.length !== 32) throw new PulsarTokenError("malformed", "public key is not 32 bytes");
  return createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: "der", type: "spki" });
}

/** A signing key from a raw 32-byte private key in base64. Used by the fake Pulsar in tests. */
export function privateKeyFromRawBase64(rawBase64: string) {
  const raw = Buffer.from(rawBase64.trim(), "base64");
  if (raw.length !== 32) throw new Error("private key is not 32 bytes");
  return createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, raw]), format: "der", type: "pkcs8" });
}

/** Remembers (sender, nonce) pairs for the replay window. Same rule as core's NonceCache. */
export class NonceCache {
  private seen = new Map<string, number>();

  checkAndAdd(senderId: string, nonce: string, nowSeconds: number): boolean {
    const cutoff = nowSeconds - NONCE_WINDOW_SECONDS;
    for (const [key, at] of this.seen) if (at < cutoff) this.seen.delete(key);
    const key = `${senderId}\u0000${nonce}`;
    if (this.seen.has(key)) return false;
    this.seen.set(key, nowSeconds);
    return true;
  }
}

function epochSeconds(ts: string): number {
  const ms = Date.parse(ts);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(ts) || Number.isNaN(ms)) {
    throw new PulsarTokenError("malformed", "ts is not an ISO time in UTC");
  }
  return ms / 1000;
}

/**
 * Verifies a token and returns its body. Throws PulsarTokenError with a machine code.
 *
 * Order matters and mirrors core: shape, signature, skew, replay, then the body checks (tenant, expiry,
 * role). The sender kind and id must be the ones the caller expects; the spec does not fix them yet.
 */
export function verifyPulsarToken(
  envelope: unknown,
  options: {
    publicKey: ReturnType<typeof publicKeyFromRawBase64>;
    expectedSender: { kind: string; id: string };
    tenant: string;
    nowSeconds: number;
    nonces?: NonceCache;
  },
): { user: string; role: "owner" | "admin" | "member"; tenant: string; exp: number } {
  const env = envelope as Partial<TokenEnvelope> | null;
  if (!env || typeof env !== "object") throw new PulsarTokenError("malformed", "not an object");
  const { v, sender, ts, nonce, body, sig } = env;
  if (v !== ENVELOPE_VERSION) throw new PulsarTokenError("malformed", `unsupported version ${String(v)}`);
  if (!sender || typeof sender.kind !== "string" || typeof sender.id !== "string") {
    throw new PulsarTokenError("malformed", "sender");
  }
  if (typeof ts !== "string" || typeof nonce !== "string" || typeof sig !== "string") {
    throw new PulsarTokenError("malformed", "ts, nonce or sig");
  }
  if (sender.kind !== options.expectedSender.kind || sender.id !== options.expectedSender.id) {
    throw new PulsarTokenError("bad_signature", "sender is not the expected Pulsar");
  }

  const signature = Buffer.from(sig, "base64");
  const message = signingString(v, sender.kind, sender.id, ts, nonce, body);
  if (!cryptoVerify(null, message, options.publicKey, signature)) {
    throw new PulsarTokenError("bad_signature");
  }

  const issued = epochSeconds(ts);
  if (Math.abs(options.nowSeconds - issued) > MAX_SKEW_SECONDS) throw new PulsarTokenError("stale");
  if (options.nonces && !options.nonces.checkAndAdd(sender.id, nonce, options.nowSeconds)) {
    throw new PulsarTokenError("replay");
  }

  const token = body as Partial<TokenBody> | null;
  if (!token || typeof token !== "object" || typeof token.tenant !== "string" ||
      typeof token.user !== "string" || typeof token.role !== "string" || typeof token.exp !== "number") {
    throw new PulsarTokenError("malformed", "body must be {tenant, user, role, exp}");
  }
  if (token.tenant !== options.tenant) throw new PulsarTokenError("wrong_tenant");
  if (token.exp <= options.nowSeconds) throw new PulsarTokenError("expired");
  const role = Object.prototype.hasOwnProperty.call(STICKS_ROLE_MAP, token.role)
    ? STICKS_ROLE_MAP[token.role]
    : undefined;
  if (!role) throw new PulsarTokenError("unknown_role", token.role);
  return { user: token.user, role, tenant: token.tenant, exp: token.exp };
}

/** Signs a body the way core's sign() does. For the fake Pulsar in tests; the engine never signs. */
export function signEnvelope(
  body: TokenBody,
  options: { privateKey: ReturnType<typeof privateKeyFromRawBase64>; sender: { kind: string; id: string }; nowSeconds: number; nonce: string },
): TokenEnvelope {
  const ts = new Date(options.nowSeconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const message = signingString(ENVELOPE_VERSION, options.sender.kind, options.sender.id, ts, options.nonce, body);
  const sig = cryptoSign(null, message, options.privateKey).toString("base64");
  return { v: ENVELOPE_VERSION, sender: options.sender, ts, nonce: options.nonce, body, sig };
}
