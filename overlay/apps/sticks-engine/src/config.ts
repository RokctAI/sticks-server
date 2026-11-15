// Settings for the one-process engine (spec 4.2, 4.3, 8.2, 8.3).
// Secrets come only from files under /run/secrets/; nothing secret is read from the environment.
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const SECRETS_DIR = "/run/secrets";

/** Reads one secret file, trimmed. The error names the file, never its value. */
export function readSecret(name: string, dir: string = SECRETS_DIR): string {
  let raw: string;
  try {
    raw = readFileSync(join(dir, name), "utf8");
  } catch {
    throw new Error(`secret ${name} is missing from ${dir}`);
  }
  const value = raw.trim();
  if (!value) throw new Error(`secret ${name} is empty`);
  return value;
}

/**
 * The tenant's database URL: the base (login, host, database, no password) from the environment,
 * with the password from /run/secrets/db_password. A base that already carries a password, or
 * that asks for another schema, is refused (spec 4.3: the engine keeps the default public schema).
 */
export function databaseUrlWithPassword(base: string, password: string): string {
  const url = new URL(base);
  if (url.password) throw new Error("STICKS_DATABASE_URL must not contain a password");
  if (!url.username) throw new Error("STICKS_DATABASE_URL needs the tenant login");
  if (url.searchParams.has("schema") || url.searchParams.has("search_path")) {
    throw new Error("the engine keeps the default public schema; remove schema and search_path");
  }
  url.password = password;
  return url.toString();
}
