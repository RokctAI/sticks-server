import { createHmac, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { pulsarFront, SIGN_IN_PATH } from "./pulsar-front.js";
import { isClosedAuthPath, placeholderEmail, sessionTokenFrom, signSessionToken } from "./pulsar-session.js";
import { privateKeyFromRawBase64, publicKeyFromRawBase64, signEnvelope, type TokenBody } from "./pulsar-token.js";
import type { NodeEnv } from "./serve.js";

const TENANT = "t_1";
const SENDER = { kind: "site", id: "acme.example" };
const NOW = new Date("2026-11-20T10:00:00Z");
const SECRET = "test-auth-secret-with-enough-length";

const pair = generateKeyPairSync("ed25519");
const privateRaw = (pair.privateKey.export({ format: "der", type: "pkcs8" }) as Buffer).subarray(-32).toString("base64");
const publicRaw = (pair.publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(-32).toString("base64");

function bearerFor(role: string, nonce: string): string {
  const body: TokenBody = { tenant: TENANT, user: "u-1", role, exp: NOW.getTime() / 1000 + 300 };
  const envelope = signEnvelope(body, {
    privateKey: privateKeyFromRawBase64(privateRaw),
    sender: SENDER,
    nowSeconds: NOW.getTime() / 1000,
    nonce,
  });
  const b64 = Buffer.from(JSON.stringify(envelope), "utf8").toString("base64");
  return `Bearer ${b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
}

/** A fake database: records each statement and answers the few reads the session layer makes. */
function fakeDb(opts: { org?: string; space?: string; guestTokens?: string[] } = {}) {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const query = async (sql: string, values: unknown[] = []) => {
    calls.push({ sql, values });
    if (sql.includes("FROM organization")) return opts.org ? [{ id: opts.org }] : [];
    if (sql.includes("FROM spaces")) return opts.space ? [{ id: opts.space }] : [];
    if (sql.includes("JOIN sticks_guest")) return (opts.guestTokens ?? []).includes(values[0] as string) ? [{}] : [];
    return [];
  };
  return { calls, query };
}

const inner = { fetch: async () => new Response("upstream") };
const env = {} as NodeEnv;
const front = (db: ReturnType<typeof fakeDb>, key = publicRaw) =>
  pulsarFront(inner, {
    query: db.query,
    authSecret: SECRET,
    publicKey: () => (key ? publicKeyFromRawBase64(key) : undefined),
    sender: SENDER,
    tenant: TENANT,
    now: () => NOW,
  });
const post = (path: string, headers: Record<string, string> = {}) =>
  new Request(`http://engine${path}`, { method: "POST", headers });

describe("Pulsar sign-in (brief task 9 session layer)", () => {
  it("a valid token opens a session: user, membership with the mapped role, and a signed bearer", async () => {
    const db = fakeDb({ org: "org-1", space: "space-1" });
    const res = await front(db).fetch(post(SIGN_IN_PATH, { authorization: bearerFor("Sticks Admin", "n1") }), env);
    expect(res.status).toBe(200);
    const { token, expiresAt } = (await res.json()) as { token: string; expiresAt: string };
    const [raw, sig] = token.split(".");
    expect(sig).toBe(createHmac("sha256", SECRET).update(raw!).digest("base64"));
    expect(expiresAt).toBe("2026-11-20T22:00:00.000Z");
    const sqls = db.calls.map((c) => c.sql);
    expect(sqls.some((s) => s.includes('INSERT INTO "user"'))).toBe(true);
    expect(db.calls.find((c) => c.sql.includes("INSERT INTO member"))?.values).toContain("admin");
    expect(db.calls.find((c) => c.sql.includes("INSERT INTO space_members"))?.values).toContain("space-1");
    expect(db.calls.find((c) => c.sql.includes("INSERT INTO session"))?.values).toContain(raw);
    expect(sqls.some((s) => s.includes("DELETE FROM sticks_guest"))).toBe(true);
  });

  it("a guest token records the guest flag", async () => {
    const db = fakeDb({ org: "org-1" });
    const res = await front(db).fetch(post(SIGN_IN_PATH, { authorization: bearerFor("Sticks Guest", "n2") }), env);
    expect(res.status).toBe(200);
    expect(db.calls.some((c) => c.sql.includes("INSERT INTO sticks_guest"))).toBe(true);
  });

  it("a bad token, a replay and a missing key are refused without touching the database", async () => {
    const db = fakeDb();
    const app = front(db);
    expect((await app.fetch(post(SIGN_IN_PATH, { authorization: "Bearer nope" }), env)).status).toBe(401);
    const once = bearerFor("Sticks Member", "n3");
    expect((await app.fetch(post(SIGN_IN_PATH, { authorization: once }), env)).status).toBe(200);
    const calls = db.calls.length;
    const replay = await app.fetch(post(SIGN_IN_PATH, { authorization: once }), env);
    expect(replay.status).toBe(401);
    expect(await replay.json()).toEqual({ error: "replay" });
    expect(db.calls.length).toBe(calls);
    expect((await front(db, "").fetch(post(SIGN_IN_PATH, { authorization: once }), env)).status).toBe(503);
  });

  it("other sign-in routes are closed; reading the session and signing out stay open", async () => {
    for (const path of ["/api/auth/sign-in/email", "/api/auth/sign-up/email", "/api/auth/email-otp/send-verification-otp",
      "/api/auth/passkey/generate-authenticate-options", "/api/auth/sign-in/social", "/api/auth/callback/oidc"]) {
      expect(isClosedAuthPath(path)).toBe(true);
      expect((await front(fakeDb()).fetch(post(path), env)).status).toBe(404);
    }
    for (const path of ["/api/auth/get-session", "/api/auth/sign-out", "/api/auth/capabilities"]) {
      expect(isClosedAuthPath(path)).toBe(false);
    }
    expect(isClosedAuthPath("/rpc/chat.send")).toBe(false);
  });

  it("a guest session may read but not write; other sessions pass through", async () => {
    const db = fakeDb({ guestTokens: ["guesttok"] });
    const app = front(db);
    const guest = { authorization: `Bearer ${signSessionToken("guesttok", SECRET)}` };
    expect((await app.fetch(post("/rpc/chat.send", guest), env)).status).toBe(403);
    expect(await (await app.fetch(new Request("http://engine/rpc/x", { headers: guest }), env)).text()).toBe("upstream");
    const member = { authorization: `Bearer ${signSessionToken("membertok", SECRET)}` };
    expect(await (await app.fetch(post("/rpc/chat.send", member), env)).text()).toBe("upstream");
  });

  it("reads the session token from the bearer or the cookie", () => {
    expect(sessionTokenFrom(new Headers({ authorization: "Bearer abc.sig" }))).toBe("abc");
    expect(sessionTokenFrom(new Headers({ cookie: "x=1; better-auth.session_token=def.s%3D" }))).toBe("def");
    expect(sessionTokenFrom(new Headers({ cookie: "__Secure-better-auth.session_token=ghi.s" }))).toBe("ghi");
    expect(sessionTokenFrom(new Headers())).toBeUndefined();
  });

  it("the placeholder email can never receive mail", () => {
    expect(placeholderEmail("U 1", "T_1")).toBe("u-1@t_1.sticks.invalid");
  });
});
