import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type DisposablePostgres, startPostgres } from "../../../packages/testkit/src/cli/postgres.ts";
import type { AppHandles } from "../../api/src/app.js";
import { bearerMatches, idleSnapshot, IdleTracker, isIdle, pushIdle } from "./idle.js";
import { startEngine } from "./engine.js";

const NOW = new Date("2026-11-15T10:00:00Z");
const quiet = { activeRuns: 0, openStreams: 0, liveScripts: 0, nextWakeAt: null };
// A fixture, not a credential. Kept apart from the header prefix so the header is built, not written out.
const FIXTURE_ENGINE_SECRET = "engine-secret-for-tests-" + "0001";

describe("the sleep rule (spec 7.6, pure)", () => {
  it("idle needs no active runs, no open streams and no live script", () => {
    expect(isIdle(quiet)).toBe(true);
    expect(isIdle({ ...quiet, activeRuns: 1 })).toBe(false);
    expect(isIdle({ ...quiet, openStreams: 1 })).toBe(false);
    expect(isIdle({ ...quiet, liveScripts: 1 })).toBe(false);
  });

  it("a stream or script that is not tracked yet keeps the tenant awake", () => {
    expect(isIdle({ ...quiet, openStreams: undefined })).toBe(false);
    expect(isIdle({ ...quiet, liveScripts: undefined })).toBe(false);
  });

  it("since is kept while the state holds, and reset when it changes", () => {
    const first = idleSnapshot(undefined, quiet, NOW);
    expect(first).toEqual({ idle: true, since: NOW.toISOString(), next_wake_at: null });
    const later = new Date(NOW.getTime() + 60_000);
    expect(idleSnapshot({ idle: true, since: first.since }, quiet, later).since).toBe(NOW.toISOString());
    expect(idleSnapshot({ idle: true, since: first.since }, { ...quiet, activeRuns: 1 }, later).since).toBe(
      later.toISOString(),
    );
  });

  it("next_wake_at is the nearest wake time, as an ISO string", () => {
    const wake = new Date("2026-11-15T11:00:00Z");
    expect(idleSnapshot(undefined, { ...quiet, nextWakeAt: wake }, NOW).next_wake_at).toBe(wake.toISOString());
  });

  it("the tracker reports a change only when idle or next wake changes", () => {
    const tracker = new IdleTracker();
    expect(tracker.update(quiet, NOW).changed).toBe(true);
    expect(tracker.update(quiet, new Date(NOW.getTime() + 1_000)).changed).toBe(false);
    expect(tracker.update({ ...quiet, activeRuns: 1 }, NOW).changed).toBe(true);
  });
});

describe("the bearer secret and the push (pure)", () => {
  it("a bearer header matches only the exact secret", () => {
    expect(bearerMatches("Bearer s3cret-value", "s3cret-value")).toBe(true);
    expect(bearerMatches("Bearer s3cret-valuE", "s3cret-value")).toBe(false);
    expect(bearerMatches("Basic s3cret-value", "s3cret-value")).toBe(false);
    expect(bearerMatches(undefined, "s3cret-value")).toBe(false);
    expect(bearerMatches("Bearer x", undefined)).toBe(false);
  });

  it("a push posts the snapshot with the secret, and a failed push is reported, not thrown", async () => {
    const seen: { url: string; body: string; auth: string | null }[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      seen.push({
        url,
        body: String(init.body),
        auth: new Headers(init.headers).get("authorization"),
      });
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;
    const snapshot = { idle: true, since: NOW.toISOString(), next_wake_at: null };
    expect(await pushIdle("https://idle.example/hook", snapshot, "tok", fake)).toBe(true);
    expect(seen[0]).toEqual({
      url: "https://idle.example/hook",
      body: JSON.stringify(snapshot),
      auth: "Bearer tok",
    });
    expect(await pushIdle(undefined, snapshot, "tok", fake)).toBe(false);
    const broken = (async () => {
      throw new Error("down");
    }) as unknown as typeof fetch;
    expect(await pushIdle("https://idle.example/hook", snapshot, "tok", broken)).toBe(false);
  });
});

describe("GET /internal/idle against the database (brief task 8)", () => {
  let pg: DisposablePostgres;
  let secrets: string;
  let dataDir: string;
  let handles: AppHandles;

  beforeAll(async () => {
    pg = await startPostgres();
    const uri = new URL(pg.getConnectionUri());
    const password = decodeURIComponent(uri.password);
    uri.password = "";
    secrets = await mkdtemp(join(tmpdir(), "sticks-idle-secrets-"));
    await writeFile(join(secrets, "db_password"), password);
    await writeFile(join(secrets, "content_key"), randomBytes(32).toString("base64"));
    await writeFile(join(secrets, "engine_secret"), FIXTURE_ENGINE_SECRET);
    dataDir = await mkdtemp(join(tmpdir(), "sticks-idle-data-"));
    handles = (await startEngine({
      env: { STICKS_DATABASE_URL: uri.toString() },
      secretsDir: secrets,
      overrides: {
        dataDir,
        sandboxProvider: "fake",
        agentRuntime: "scripted",
        signupsEnabled: "true",
        webOrigin: "http://127.0.0.1:5173",
        authUrl: "http://127.0.0.1:5173",
      },
    })) as AppHandles;
  }, 600_000);

  afterAll(async () => {
    await handles?.stop();
    await pg?.stop();
    await rm(secrets, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  });

  it("refuses a call without the engine secret", async () => {
    const response = await handles.app.request("/internal/idle");
    expect(response.status).toBe(401);
  });

  it("answers the snapshot to the engine secret, with the three keys", async () => {
    const response = await handles.app.request("/internal/idle", {
      headers: { authorization: `Bearer ${FIXTURE_ENGINE_SECRET}` },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { idle: boolean; since: string; next_wake_at: string | null };
    expect(typeof body.idle).toBe("boolean");
    expect(Date.parse(body.since)).not.toBeNaN();
    expect(body.next_wake_at === null || Date.parse(body.next_wake_at) > 0).toBe(true);
  });
});
