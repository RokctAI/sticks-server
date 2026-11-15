import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { databaseUrlWithPassword, readSecret } from "./config.js";

describe("secrets from files", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "sticks-secrets-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reads a secret file and trims the trailing newline", async () => {
    await writeFile(join(dir, "db_password"), "s3cret-value\n");
    expect(readSecret("db_password", dir)).toBe("s3cret-value");
  });

  it("refuses a missing secret and names the file, not a value", () => {
    expect(() => readSecret("content_key", dir)).toThrow("secret content_key is missing");
  });

  it("refuses an empty secret", async () => {
    await writeFile(join(dir, "content_key"), "  \n");
    expect(() => readSecret("content_key", dir)).toThrow("secret content_key is empty");
  });
});

describe("database URL", () => {
  it("adds the password from the secret and keeps login, host and database", () => {
    const url = databaseUrlWithPassword("postgresql://t_8f3k@db.internal:5432/t_8f3k", "p@ss/word");
    const parsed = new URL(url);
    expect(parsed.username).toBe("t_8f3k");
    expect(decodeURIComponent(parsed.password)).toBe("p@ss/word");
    expect(parsed.host).toBe("db.internal:5432");
    expect(parsed.pathname).toBe("/t_8f3k");
  });

  it("refuses a base URL that already carries a password", () => {
    expect(() => databaseUrlWithPassword("postgresql://u:pw@h/db", "x")).toThrow(
      "must not contain a password",
    );
  });

  it("refuses a base URL with no login", () => {
    expect(() => databaseUrlWithPassword("postgresql://h/db", "x")).toThrow("needs the tenant login");
  });

  it("refuses another schema (the engine keeps public)", () => {
    expect(() =>
      databaseUrlWithPassword("postgresql://u@h/db?schema=pulsar", "x"),
    ).toThrow("default public schema");
    expect(() =>
      databaseUrlWithPassword("postgresql://u@h/db?search_path=pulsar", "x"),
    ).toThrow("default public schema");
  });
});

describe("the root never creates roles or grants membership (spec 8.2 items 1-3)", () => {
  it("does not call the runtime-role or job-queue provisioning, nor mention the shared role", async () => {
    const source = await readFile(new URL("./engine.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/provisionRuntimeRole|migrateJobQueue|rakazo_app|CREATE ROLE|GRANT/i);
    expect(source).toContain("deployMigrations");
  });
});
