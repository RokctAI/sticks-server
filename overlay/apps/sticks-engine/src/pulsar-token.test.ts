import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  NonceCache,
  PulsarTokenError,
  publicKeyFromRawBase64,
  privateKeyFromRawBase64,
  signEnvelope,
  STICKS_ROLE_MAP,
  verifyPulsarToken,
  type TokenBody,
} from "./pulsar-token.js";

const TENANT = "t_8f3k0001";
const SENDER = { kind: "pulsar", id: "pulsar-test" };
const NOW = Math.floor(Date.parse("2026-11-15T10:00:00Z") / 1000);

/** A fresh ed25519 pair as raw base64, the way core's generate_keypair writes them. */
function keypair() {
  const pair = generateKeyPairSync("ed25519");
  const privateDer = pair.privateKey.export({ format: "der", type: "pkcs8" }) as Buffer;
  const publicDer = pair.publicKey.export({ format: "der", type: "spki" }) as Buffer;
  return {
    privateRaw: privateDer.subarray(-32).toString("base64"),
    publicRaw: publicDer.subarray(-32).toString("base64"),
  };
}

const signer = keypair();
const body = (overrides: Partial<TokenBody> = {}): TokenBody => ({
  tenant: TENANT,
  user: "user-42",
  role: "Sticks Member",
  exp: NOW + 300,
  ...overrides,
});
const sign = (b: TokenBody, at = NOW, nonce = "n-1", key = signer.privateRaw) =>
  signEnvelope(b, {
    privateKey: privateKeyFromRawBase64(key),
    sender: SENDER,
    nowSeconds: at,
    nonce,
  });
const verifyOpts = (overrides: Partial<Parameters<typeof verifyPulsarToken>[1]> = {}) => ({
  publicKey: publicKeyFromRawBase64(signer.publicRaw),
  expectedSender: SENDER,
  tenant: TENANT,
  nowSeconds: NOW,
  ...overrides,
});

describe("core's envelope rules, in TypeScript", () => {
  it("canonical JSON sorts keys at every level, with no spaces (matches core's _canonical)", () => {
    expect(canonicalJson({ b: 1, a: { d: 1, c: [2, { z: 0, y: 1 }] } })).toBe(
      '{"a":{"c":[2,{"y":1,"z":0}],"d":1},"b":1}',
    );
  });

  it("the role map has the three roles the spec names with a clear upstream role; Guest is not mapped", () => {
    expect(STICKS_ROLE_MAP).toEqual({ "Sticks Owner": "owner", "Sticks Admin": "admin", "Sticks Member": "member" });
    expect(STICKS_ROLE_MAP["Sticks Guest"]).toBeUndefined();
  });
});

describe("verifyPulsarToken (brief task 9)", () => {
  it("a valid token returns the user, the mapped role and the tenant", () => {
    const result = verifyPulsarToken(sign(body()), verifyOpts());
    expect(result).toEqual({ user: "user-42", role: "member", tenant: TENANT, exp: NOW + 300 });
  });

  it("an expired token (exp in the past, fresh signature) is refused", () => {
    const expired = sign(body({ exp: NOW - 1 }));
    expect(() => verifyPulsarToken(expired, verifyOpts())).toThrow(PulsarTokenError);
    try {
      verifyPulsarToken(expired, verifyOpts());
    } catch (error) {
      expect((error as PulsarTokenError).code).toBe("expired");
    }
  });

  it("a token signed with another key is refused as a bad signature", () => {
    const other = keypair();
    const forged = sign(body(), NOW, "n-2", other.privateRaw);
    try {
      verifyPulsarToken(forged, verifyOpts());
      throw new Error("should have been refused");
    } catch (error) {
      expect((error as PulsarTokenError).code).toBe("bad_signature");
    }
  });

  it("a token for another tenant is refused", () => {
    try {
      verifyPulsarToken(sign(body({ tenant: "t_other" })), verifyOpts());
      throw new Error("should have been refused");
    } catch (error) {
      expect((error as PulsarTokenError).code).toBe("wrong_tenant");
    }
  });

  it("an unknown role is refused (Guest is unmapped until the owner decides)", () => {
    for (const role of ["Sticks Guest", "Sticks Wizard"]) {
      try {
        verifyPulsarToken(sign(body({ role })), verifyOpts());
        throw new Error("should have been refused");
      } catch (error) {
        expect((error as PulsarTokenError).code).toBe("unknown_role");
      }
    }
  });

  it("a tampered body fails the signature", () => {
    const token = sign(body());
    const tampered = { ...token, body: { ...(token.body as TokenBody), role: "Sticks Owner" } };
    try {
      verifyPulsarToken(tampered, verifyOpts());
      throw new Error("should have been refused");
    } catch (error) {
      expect((error as PulsarTokenError).code).toBe("bad_signature");
    }
  });

  it("a token issued more than five minutes ago is stale, even if its exp is still ahead", () => {
    const old = sign(body({ exp: NOW + 600 }), NOW - 400);
    try {
      verifyPulsarToken(old, verifyOpts());
      throw new Error("should have been refused");
    } catch (error) {
      expect((error as PulsarTokenError).code).toBe("stale");
    }
  });

  it("the same nonce from the same sender is a replay", () => {
    const nonces = new NonceCache();
    const first = sign(body(), NOW, "same-nonce");
    verifyPulsarToken(first, verifyOpts({ nonces }));
    try {
      verifyPulsarToken(first, verifyOpts({ nonces }));
      throw new Error("should have been refused");
    } catch (error) {
      expect((error as PulsarTokenError).code).toBe("replay");
    }
  });

  it("a sender other than the expected Pulsar is refused", () => {
    const token = sign(body());
    try {
      verifyPulsarToken({ ...token, sender: { kind: "hub", id: "hub-1" } }, verifyOpts());
      throw new Error("should have been refused");
    } catch (error) {
      expect((error as PulsarTokenError).code).toBe("bad_signature");
    }
  });

  it("a body without the four fields is malformed", () => {
    const token = sign({ tenant: TENANT, user: "u", role: "Sticks Owner" } as unknown as TokenBody);
    try {
      verifyPulsarToken(token, verifyOpts());
      throw new Error("should have been refused");
    } catch (error) {
      expect((error as PulsarTokenError).code).toBe("malformed");
    }
  });
});
