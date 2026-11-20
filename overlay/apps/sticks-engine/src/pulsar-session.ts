// Sign-in by Pulsar token (spec 5.3 row 1, 7.2; brief task 9 session layer, settled 11-20).
// A verified token becomes an ordinary upstream session row, so every upstream route keeps reading the
// session the way it always has. The user row is keyed by the Pulsar user id. Password, emailed code,
// passkey and SSO routes are closed by the outer router below; the Pulsar route is the only way in.
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import type { SqlQuery } from "./plugin-draft-store.js";

/** A session lasts 12 hours; a fresh Pulsar token signs in again (settled 11-20). */
export const SESSION_SECONDS = 12 * 60 * 60;
/** Users signed in with the Sticks Guest role: read-only (no tools, no runs, no memory writes). */
export const GUEST_TABLE_SQL = `CREATE TABLE IF NOT EXISTS sticks_guest (
  user_id text PRIMARY KEY,
  updated_at timestamptz NOT NULL DEFAULT now()
)`;

export type VerifiedToken = { user: string; role: "owner" | "admin" | "member"; tenant: string; guest: boolean };

/** The email upstream's user row requires. The .invalid domain can never receive mail. */
export function placeholderEmail(user: string, tenant: string): string {
  const safe = (s: string) => s.toLowerCase().replace(/[^a-z0-9._-]/g, "-");
  return `${safe(user)}@${safe(tenant)}.sticks.invalid`;
}

/**
 * The bearer value upstream's signed-bearer plugin accepts: the session token, a dot, and the
 * HMAC-SHA256 of the token under the auth secret in standard base64 (the signed-cookie form).
 */
export function signSessionToken(token: string, secret: string): string {
  return `${token}.${createHmac("sha256", secret).update(token).digest("base64")}`;
}

/** The raw session token from an Authorization header or the session cookie, or undefined. */
export function sessionTokenFrom(headers: Headers): string | undefined {
  const auth = headers.get("authorization");
  let value: string | undefined;
  if (auth && auth.slice(0, 7).toLowerCase() === "bearer ") value = auth.slice(7).trim();
  if (!value) {
    const cookie = headers.get("cookie") ?? "";
    const match = /(?:^|;\s*)(?:__Secure-)?better-auth\.session_token=([^;]+)/.exec(cookie);
    value = match?.[1];
  }
  if (!value) return undefined;
  try {
    value = decodeURIComponent(value);
  } catch {
    return undefined;
  }
  const token = value.split(".")[0];
  return token || undefined;
}

/**
 * Creates or updates the user, puts them in the tenant's one organization and default space with the
 * mapped role (when first boot has created them), records the guest flag, and opens a session.
 * Returns the signed bearer value and the expiry.
 */
export async function openPulsarSession(
  query: SqlQuery,
  token: VerifiedToken,
  secret: string,
  now: Date = new Date(),
): Promise<{ bearer: string; expiresAt: Date; userId: string }> {
  const userId = token.user;
  await query(
    `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, true, $4, $4)
     ON CONFLICT (id) DO UPDATE SET "updatedAt" = EXCLUDED."updatedAt"`,
    [userId, userId, placeholderEmail(token.user, token.tenant), now],
  );

  const orgs = (await query(`SELECT id FROM organization ORDER BY "createdAt" ASC LIMIT 1`, [])) as Array<{ id: string }>;
  const orgId = orgs[0]?.id;
  if (orgId) {
    await query(
      `INSERT INTO member (id, "organizationId", "userId", role, "createdAt") VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT ("organizationId", "userId") DO UPDATE SET role = EXCLUDED.role`,
      [randomUUID(), orgId, userId, token.role, now],
    );
    const spaces = (await query(
      `SELECT id FROM spaces WHERE "organizationId" = $1 AND "deletingAt" IS NULL ORDER BY "isDefault" DESC, "createdAt" ASC LIMIT 1`,
      [orgId],
    )) as Array<{ id: string }>;
    const spaceId = spaces[0]?.id;
    if (spaceId) {
      await query(
        `INSERT INTO space_members (id, "spaceId", "organizationId", "userId", role, "createdAt") VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT ("spaceId", "userId") DO UPDATE SET role = EXCLUDED.role`,
        [randomUUID(), spaceId, orgId, userId, token.role, now],
      );
    }
  }

  if (token.guest) {
    await query(`INSERT INTO sticks_guest (user_id) VALUES ($1) ON CONFLICT (user_id) DO UPDATE SET updated_at = now()`, [userId]);
  } else {
    await query(`DELETE FROM sticks_guest WHERE user_id = $1`, [userId]);
  }

  const raw = randomBytes(24).toString("hex");
  const expiresAt = new Date(now.getTime() + SESSION_SECONDS * 1000);
  await query(
    `INSERT INTO session (id, token, "userId", "expiresAt", "createdAt", "updatedAt", "activeOrganizationId")
     VALUES ($1, $2, $3, $4, $5, $5, $6)`,
    [randomUUID(), raw, userId, expiresAt, now, orgId ?? null],
  );
  return { bearer: signSessionToken(raw, secret), expiresAt, userId };
}

/** Whether the session behind this token belongs to a guest. Unknown or expired sessions are not guests. */
export async function isGuestSession(query: SqlQuery, rawToken: string, now: Date = new Date()): Promise<boolean> {
  const rows = (await query(
    `SELECT 1 FROM session s JOIN sticks_guest g ON g.user_id = s."userId" WHERE s.token = $1 AND s."expiresAt" > $2 LIMIT 1`,
    [rawToken, now],
  )) as unknown[];
  return rows.length > 0;
}

/** Upstream auth paths that stay open: reading and ending the current session, and the capability probe. */
const OPEN_AUTH_PATHS = new Set(["/api/auth/get-session", "/api/auth/sign-out", "/api/auth/capabilities"]);

/** Every other auth route (password, emailed code, passkey, SSO, sign-up, reset) is closed. */
export function isClosedAuthPath(pathname: string): boolean {
  return pathname.startsWith("/api/auth/") && !OPEN_AUTH_PATHS.has(pathname);
}

/** A guest may only read. */
export function guestMayDo(method: string): boolean {
  return method === "GET" || method === "HEAD" || method === "OPTIONS";
}
