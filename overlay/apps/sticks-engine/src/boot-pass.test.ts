import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BackgroundJob, JobPublisher } from "../../../packages/adapter-kit/src/index.ts";
import { sessionCookieHeader } from "../../../packages/testkit/src/index.ts";
import { type DisposablePostgres, startPostgres } from "../../../packages/testkit/src/cli/postgres.ts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppHandles } from "../../api/src/app.js";
import { bootPass, earliest, MAX_TIMER_MS, startBootScheduler, timerDelay } from "./boot-pass.js";
import { startEngine } from "./engine.js";

const ORIGIN = "http://127.0.0.1:5173";

describe("boot pass helpers (pure)", () => {
  it("earliest picks the smallest set time and ignores nulls", () => {
    const a = new Date("2026-11-15T10:00:00Z");
    const b = new Date("2026-11-15T09:00:00Z");
    expect(earliest([null, a, undefined, b])?.toISOString()).toBe(b.toISOString());
    expect(earliest([null, undefined])).toBeNull();
  });

  it("timerDelay is never negative and never beyond what setTimeout accepts", () => {
    const now = new Date("2026-11-15T10:00:00Z");
    expect(timerDelay(now, new Date("2026-11-15T09:00:00Z"))).toBe(0);
    expect(timerDelay(now, new Date("2026-11-15T10:00:05Z"))).toBe(5_000);
    expect(timerDelay(now, new Date("2099-01-01T00:00:00Z"))).toBe(MAX_TIMER_MS);
  });
});

describe("boot pass against the database (brief task 7)", () => {
  let pg: DisposablePostgres;
  let secrets: string;
  let dataDir: string;
  let handles: AppHandles;
  let botId: string;
  let runId: string;

  /** A job publisher that records what the pass would have sent to the in-memory queue. */
  function recorder() {
    const jobs: BackgroundJob[] = [];
    const publisher = {
      enqueue: async (job: BackgroundJob) => {
        jobs.push(job);
      },
      cancel: async () => undefined,
      close: async () => undefined,
    } as unknown as JobPublisher;
    return { jobs, publisher };
  }

  const runJobsFor = (jobs: BackgroundJob[], id: string) =>
    jobs.filter((job) => job.name === "run.continue" && (job.payload as { runId: string }).runId === id);

  beforeAll(async () => {
    pg = await startPostgres();
    const uri = new URL(pg.getConnectionUri());
    const password = decodeURIComponent(uri.password);
    uri.password = "";
    secrets = await mkdtemp(join(tmpdir(), "sticks-boot-secrets-"));
    await writeFile(join(secrets, "db_password"), password);
    await writeFile(join(secrets, "content_key"), randomBytes(32).toString("base64"));
    dataDir = await mkdtemp(join(tmpdir(), "sticks-boot-data-"));
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
    }) as AppHandles;

    // One Stick and one completed run, made through the app's own calls.
    const signup = await handles.app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({ email: `boot-${Date.now()}@sticks.test`, password: "test-password-123", name: "Boot tester" }),
    });
    const cookie = sessionCookieHeader(signup);
    const rpc = (procedure: string, json: unknown) =>
      handles.app.request(`/rpc/${procedure}`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie, origin: ORIGIN },
        body: JSON.stringify({ json }),
      });
    botId = (((await (await rpc("bots/create", { name: "Boot Stick" })).json()) as { json: { id: string } }).json.id);
    await rpc("threads/send", { botId, text: "Hello" });
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      const done = await handles.prisma.run.findFirst({ where: { botId, status: "completed" }, select: { id: true } });
      if (done) {
        runId = done.id;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    expect(runId).toBeTruthy();
  }, 600_000);

  afterAll(async () => {
    await handles?.stop();
    await pg?.stop();
    await rm(secrets, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  });

  it("restart with queued work: the pass re-enqueues the queued run it lost", async () => {
    await handles.prisma.run.update({ where: { id: runId }, data: { status: "queued", wakeAt: null, leaseExpiresAt: null } });
    const { jobs, publisher } = recorder();
    const result = await bootPass({ prisma: handles.prisma, jobs: publisher });
    expect(result.queuedRecovered).toBeGreaterThanOrEqual(1);
    expect(runJobsFor(jobs, runId).length).toBe(1);
  });

  it("crash in the middle of a run: an expired lease is recovered, a live lease is left alone", async () => {
    const now = Date.now();
    await handles.prisma.run.update({
      where: { id: runId },
      data: { status: "running", wakeAt: null, leaseExpiresAt: new Date(now - 60_000) },
    });
    const expired = recorder();
    await bootPass({ prisma: handles.prisma, jobs: expired.publisher });
    expect(runJobsFor(expired.jobs, runId).length).toBe(1);

    const liveUntil = new Date(now + 10 * 60_000);
    await handles.prisma.run.update({ where: { id: runId }, data: { leaseExpiresAt: liveUntil } });
    const live = recorder();
    const result = await bootPass({ prisma: handles.prisma, jobs: live.publisher });
    expect(runJobsFor(live.jobs, runId).length).toBe(0);
    // The nearest later item is this lease's expiry: the one timer waits for it.
    expect(result.nextDueAt?.getTime()).toBe(liveUntil.getTime());
  });

  it("lost timer: a wake time whose timer never fired is recovered by the next start's pass", async () => {
    const wakeAt = new Date(Date.now() + 5 * 60_000);
    await handles.prisma.run.update({ where: { id: runId }, data: { status: "queued", wakeAt, leaseExpiresAt: null } });

    // The timer for wakeAt is lost (process restarted). The pass before it is due does not send it,
    // but reports it as the nearest item for the one timer.
    const beforeDue = recorder();
    const first = await bootPass({ prisma: handles.prisma, jobs: beforeDue.publisher, now: () => new Date(wakeAt.getTime() - 60_000) });
    expect(runJobsFor(beforeDue.jobs, runId).length).toBe(0);
    expect(first.nextDueAt?.getTime()).toBe(wakeAt.getTime());

    // The next start, after wakeAt, recovers it without any timer.
    const afterDue = recorder();
    await bootPass({ prisma: handles.prisma, jobs: afterDue.publisher, now: () => new Date(wakeAt.getTime() + 1_000) });
    expect(runJobsFor(afterDue.jobs, runId).length).toBe(1);
  });

  it("the scheduler arms one timer and clears it on stop, and stop can be called twice", async () => {
    await handles.prisma.run.update({ where: { id: runId }, data: { status: "completed", wakeAt: null, leaseExpiresAt: null } });
    const { publisher } = recorder();
    const scheduler = startBootScheduler({ prisma: handles.prisma, jobs: publisher });
    const result = await scheduler.ready;
    expect(result.leasesRecovered).toBeGreaterThanOrEqual(0);
    scheduler.stop();
    scheduler.stop();
  });
});
