import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sessionCookieHeader } from "../../../packages/testkit/src/index.ts";
import { type DisposablePostgres, startPostgres } from "../../../packages/testkit/src/cli/postgres.ts";
import type { AppHandles } from "../../api/src/app.js";
import { startEngine } from "./engine.js";

const ORIGIN = "http://127.0.0.1:5173";

describe("sticks engine root (one process, shared Postgres, scripted model)", () => {
  let pg: DisposablePostgres;
  let secrets: string;
  let dataDir: string;
  let handles: AppHandles;

  beforeAll(async () => {
    pg = await startPostgres();
    // The base URL has no password: the password comes from the secret file, as in production.
    const uri = new URL(pg.getConnectionUri());
    const password = uri.password;
    uri.password = "";
    secrets = await mkdtemp(join(tmpdir(), "sticks-engine-secrets-"));
    await writeFile(join(secrets, "db_password"), decodeURIComponent(password));
    await writeFile(join(secrets, "content_key"), randomBytes(32).toString("base64"));
    dataDir = await mkdtemp(join(tmpdir(), "sticks-engine-data-"));
    await mkdir(join(dataDir, "home"), { recursive: true });
    handles = await startEngine({
      env: { STICKS_DATABASE_URL: uri.toString() },
      secretsDir: secrets,
      overrides: {
        dataDir,
        sandboxProvider: "fake",
        agentRuntime: "scripted",
        signupsEnabled: "true",
        webOrigin: ORIGIN,
        authUrl: ORIGIN,
      },
    });
  }, 600_000);

  afterAll(async () => {
    await handles?.stop();
    await pg?.stop();
    await rm(secrets, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  });

  it("keeps every procedure the app calls routed (none answers 404)", async () => {
    // The list the Sticks app calls (checked against upstream's contract by the sync robot before).
    const text = await readFile(new URL("../../../sticks-contracts/used-procedures.txt", import.meta.url), "utf8");
    const procedures = text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));
    expect(procedures.length).toBeGreaterThan(100);
    const missing: string[] = [];
    for (const procedure of procedures) {
      const response = await handles.app.request(`/rpc/${procedure}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: {} }),
      });
      if (response.status === 404) missing.push(procedure);
    }
    expect(missing).toEqual([]);
  }, 120_000);

  it("answers the health check", async () => {
    const response = await handles.app.request("/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it("sends one message and sees one run complete", async () => {
    const signup = await handles.app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({
        email: `engine-${Date.now()}@sticks.test`,
        password: "test-password-123",
        name: "Engine tester",
      }),
    });
    expect(signup.status).toBeLessThan(400);
    const cookie = sessionCookieHeader(signup);
    const rpc = (procedure: string, json: unknown) =>
      handles.app.request(`/rpc/${procedure}`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie, origin: ORIGIN },
        body: JSON.stringify({ json }),
      });

    const created = await rpc("bots/create", { name: "Sticks test" });
    expect(created.status).toBe(200);
    const botId = ((await created.json()) as { json: { id: string } }).json.id;

    const sent = await rpc("threads/send", { botId, text: "Hello from the test" });
    expect(sent.status).toBeLessThan(400);

    // Poll the database for the run (no timer in the product; the test waits briefly).
    const deadline = Date.now() + 120_000;
    let statuses: string[] = [];
    while (Date.now() < deadline) {
      const runs = await handles.prisma.run.findMany({ where: { botId }, select: { status: true } });
      statuses = runs.map((run) => run.status);
      if (statuses.includes("completed")) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    expect(statuses).toEqual(["completed"]);
  }, 300_000);

  it("messaging/status answers none: no messaging app is connected or offered (spec 11.2)", async () => {
    const signup = await handles.app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({
        email: `messaging-${Date.now()}@sticks.test`,
        password: "test-password-123",
        name: "Messaging tester",
      }),
    });
    const cookie = sessionCookieHeader(signup);
    const response = await handles.app.request("/rpc/messaging/status", {
      method: "POST",
      headers: { "content-type": "application/json", cookie, origin: ORIGIN },
      body: JSON.stringify({ json: {} }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { json: { enabled: boolean; providers: string[] } };
    expect(body.json.enabled).toBe(false);
    expect(body.json.providers).toEqual([]);
  }, 120_000);

  it("refuses organizations/create and spaces/create with a clear error (spec 5.2)", async () => {
    const signup = await handles.app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({
        email: `refuse-${Date.now()}@sticks.test`,
        password: "test-password-123",
        name: "Refusal tester",
      }),
    });
    const cookie = sessionCookieHeader(signup);
    for (const procedure of ["organizations/create", "spaces/create"]) {
      const response = await handles.app.request(`/rpc/${procedure}`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie, origin: ORIGIN },
        body: JSON.stringify({ json: { name: "Another" } }),
      });
      const body = (await response.json()) as { json?: { code?: string; message?: string } };
      expect(body.json?.code, procedure).toBe("FORBIDDEN");
      expect(body.json?.message, procedure).toContain("is not available");
    }
  }, 120_000);
});
