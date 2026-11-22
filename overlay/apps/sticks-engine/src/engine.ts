// The composition root: upstream's API and worker in one Node process (spec 4.2, 11.1).
// Upstream's createApp is used as is; the overrides below are the Sticks wiring.
import { fileURLToPath } from "node:url";
import { InMemoryRealtimeFanout } from "../../../packages/adapters/src/index.ts";
import { createApp, type AppHandles } from "../../api/src/app.js";
import { deployMigrations } from "../../../packages/db/src/index.ts";
import { createServiceLogger, SERVICE_NAMES } from "../../../packages/logging/src/index.ts";
import { databaseUrlWithPassword, readSecret, SECRETS_DIR } from "./config.js";
import { startBootScheduler } from "./boot-pass.js";
import { helperSandboxFromEnv } from "./helper-computer.js";
import { activeChatsWhere } from "./end-of-day-adapters.js";
import { ensurePluginDraftTable } from "./plugin-draft-store.js";
import { GUEST_TABLE_SQL } from "./pulsar-session.js";
import { applyStickDefaults, ensureTenantSpace } from "./first-boot.js";
import { loadTenants, registerLegacyTenant, registerTenant, TenantConflictError, TenantError } from "./tenants.js";
import { pullSettings, SettingsError, SettingsStore } from "./settings.js";
import { callHub, OnboardingError, onboardingEnabled, onboardingPluginDocument, readOnboardingToken, saveOnboardingToken, type OnboardingTool } from "./hub-onboarding.js";
import { sqlDraftRepository } from "./plugin-draft-store.js";
import { seedBuiltinPlugin } from "./plugin-seed.js";
import { GITHUB_PLUGIN_DOCUMENT, GITHUB_PLUGIN_NAME } from "./github-plugin-document.js";
import { resumeAfterRenewal, settleLeftovers, socketTransport } from "./pulsar-credits.js";
import { socketEngram } from "./end-of-day-adapters.js";
import { ensureOnboardingStick } from "./onboarding-stick.js";
import { isGuestSession, sessionTokenFrom } from "./pulsar-session.js";
import { endOfDayHookFromEnv, engineEndOfDayDeps, tzOffsetFromEnv } from "./end-of-day-wiring.js";
import { providerKeysInEnv } from "./gateway.js";
import { bearerMatches, engineSecretFrom, IdleTracker, pushIdle, readIdleInputs } from "./idle.js";
import { liveScripts, openStreams } from "./activity.js";
import { pulsarRequest, PulsarProxyError, seedPulsarPlugins } from "./pulsar-plugins.js";
import { forwardVoice, voiceProxyToken } from "./voice-proxy.js";
import { readGatewayKey } from "./gateway.js";
import { addReaction, listReactions, ReactionError, reactionsPluginDocument } from "./reactions.js";
import { saveStickToken, setUpStickAccount, StickAccountError, stickToken, STICK_TOKENS_TABLE_SQL, validStickId } from "./stick-pulsar-accounts.js";
import { DrainState } from "./drain.js";
import { applyDutyChange, DutyError, dutyPluginDocument, dutyState, DutyStore } from "./duty.js";
import { routineGates } from "../../../packages/adapters/src/run-routines.ts";
import { runFinishedHooks } from "../../../packages/db/src/events.ts";
import { runAsSystem } from "../../../packages/db/src/row-security.ts";
import { runContinueJob } from "../../../packages/adapter-kit/src/index.ts";
import { KeepGoingStore } from "./keep-going.js";
import { completeGoal, GoalError, GOALS_TABLE_SQL, goalPluginDocument, keepGoingAfterRun, readGoal, setGoal, type SnapshotReader } from "./keep-going-wiring.js";
import { FEATURES_TABLE_SQL, readFeatures, saveFeatures } from "./features.js";
import { answerRecordRequest, createRecordRequest, getRecordRequest, listRecordRequests, recordConfirmPluginDocument, RecordRequestError } from "./record-requests.js";

const DB_PACKAGE_DIR = fileURLToPath(new URL("../../../packages/db", import.meta.url));

export type EngineStartOptions = {
  /** Environment to read settings from. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Folder holding db_password and content_key. Defaults to /run/secrets. */
  secretsDir?: string;
  /** Extra createApp overrides (tests use these for the sandbox, runtime and sign-up). */
  overrides?: Record<string, unknown>;
};

/**
 * Starts the engine: reads the two secrets, runs upstream's migrations as the tenant's login, then
 * calls createApp with the Sticks settings. Returns upstream's handles; stop() closes everything.
 *
 * Roles stay with the platform: this boot runs only the schema migrations, as the tenant's login.
 * The in-memory job driver needs no queue schema, so the queue step is skipped too.
 */
export async function startEngine(options: EngineStartOptions = {}): Promise<AppHandles> {
  const env = options.env ?? process.env;
  // STICKS_SECRETS_DIR lets a measurement run point at a temp folder; the product uses /run/secrets.
  const dir = options.secretsDir ?? env.STICKS_SECRETS_DIR ?? SECRETS_DIR;
  const base = env.STICKS_DATABASE_URL?.trim();
  if (!base) throw new Error("STICKS_DATABASE_URL is required");
  // Provider keys reach the engine only through the gateway (brief task 13): refuse to start if one is set.
  const providerKeys = providerKeysInEnv(env);
  if (providerKeys.length > 0) {
    throw new Error(`provider keys must not be in the engine's environment: ${providerKeys.join(", ")}`);
  }

  const databaseUrl = databaseUrlWithPassword(base, readSecret("db_password", dir));
  const contentKey = readSecret("content_key", dir);

  // Upstream's content keys and secret store read ENCRYPTION_KEY from the process environment.
  // It is set in memory here, never written to the volume or the database.
  process.env.ENCRYPTION_KEY = contentKey;
  // loadEnv requires DATABASE_URL to be present. The real URL (with the password) is passed as an
  // override below, so the password itself never enters the environment.
  process.env.DATABASE_URL = base;
  // Idle pool clients close after 30 s, so a quiet tenant holds fewer connections (spec 4.3).
  // Read by the 0001 patch in apps/api/src/app.ts.
  process.env.DB_POOL_IDLE_MS = "30000";

  await deployMigrations({ migrationUrl: databaseUrl, dbPackageDir: DB_PACKAGE_DIR });

  const logger = createServiceLogger({ service: SERVICE_NAMES.api });
  const handles = await createApp({
    databaseUrl,
    encryptionKey: contentKey,
    // Events go to this process only: no Postgres LISTEN connection (spec 4.3, 11.1).
    realtime: new InMemoryRealtimeFanout(),
    // The memory job driver is the supported single-process mode (spec 11.1).
    wakeupDriver: "memory",
    ticketBoardEnabled: true,
    logger,
    // Commands and files for computers go to the sandbox helper when STICKS_COMPUTER=helper (brief task 16).
    sandbox: helperSandboxFromEnv(env),
    ...options.overrides,
  });

  // The engine's own plugin draft table (brief task 21): created if missing, on every start.
  await ensurePluginDraftTable(async (sql, values = []) => handles.prisma.$queryRawUnsafe<unknown[]>(sql, ...values));
  // The built-in GitHub plugin (brief task 22): stored as approved if missing; never overwrites a stored one.
  await seedBuiltinPlugin(sqlDraftRepository(async (q, v = []) => handles.prisma.$queryRawUnsafe<unknown[]>(q, ...v)), GITHUB_PLUGIN_NAME, GITHUB_PLUGIN_DOCUMENT);
  // Guest sign-ins are recorded here (brief task 9): the front door lets them only read.
  await handles.prisma.$queryRawUnsafe(GUEST_TABLE_SQL);

  // First boot (brief task 10): the tenant's one organization and space, named after the company, and the
  // default block in every active Stick. The block is re-applied every 15 minutes, so a new Stick or one
  // whose block was edited away gets it back (scripts/apply_stick_defaults.py ran nightly before).
  const sql = async (text: string, values: unknown[] = []) => handles.prisma.$queryRawUnsafe<unknown[]>(text, ...values);
  const company = env.STICKS_COMPANY_NAME?.trim();
  await loadTenants(sql);
  if (company) {
    const first = await ensureTenantSpace(sql, company);
    // The one-tenant setup becomes the first entry of the tenant list (tenants.ts), keeping its plain user ids.
    const tenant = env.STICKS_TENANT?.trim();
    const site = env.STICKS_TENANT_SITE?.trim();
    let key: string | undefined;
    try {
      key = readSecret("pulsar_public_key", dir);
    } catch {
      key = undefined;
    }
    if (tenant && site && key) await registerLegacyTenant(sql, tenant, site, first.orgId, first.spaceId, key);
  }
  const applyDefaults = () =>
    applyStickDefaults(sql).catch((error) => logger.error("stick defaults failed", error));
  await applyDefaults();
  const defaultsTimer = setInterval(() => void applyDefaults(), 15 * 60_000);
  defaultsTimer.unref();

  // Recover what a restart lost, before anything serves (spec 7.6, brief task 7). The one timer for
  // the nearest due item is held by the scheduler; stop() clears it before upstream shuts down.
  // The end-of-day job (brief task 18) is held in the scheduler's one timer when STICKS_END_OF_DAY is set.
  // The chat listing and cursor reads are real; the summariser (upstream's compactHistory needs the agent
  // runtime) and the Engram write (Pulsar side) are not connected yet, so a day fails with a clear error
  // (logged by onError) and the next day still runs.
  const offset = tzOffsetFromEnv(env);
  // The Pulsar unix socket (credits, Engram) and the per-tenant engine secret.
  const pulsarSocket = env.STICKS_PULSAR_SOCKET?.trim();
  const creditsSecret = engineSecretFrom(dir);
  const scheduler = startBootScheduler({
    prisma: handles.prisma,
    jobs: handles.jobs,
    endOfDay: endOfDayHookFromEnv(
      env,
      engineEndOfDayDeps({
        ...(pulsarSocket && creditsSecret ? { engram: socketEngram(pulsarSocket, creditsSecret, env.STICKS_TENANT?.trim() ?? "") } : {}),
        activeChats: (day) =>
          handles.prisma.thread.findMany({ where: activeChatsWhere(day, offset), select: { id: true }, take: 500 }),
        readThread: (threadId) =>
          handles.prisma.thread.findUniqueOrThrow({
            where: { id: threadId },
            select: { nextMessageSeq: true, historyCompactedUpToSeq: true, historyCompactionSummary: true },
          }),
      }),
    ),
    onError: (error) => logger.error("boot scheduler error (boot pass or end of day)", error),
  });
  await scheduler.ready;

  // Settings from Pulsar (brief task 11): stored settings first, then a pull from STICKS_SETTINGS_URL when set.
  // A failed pull keeps the stored settings. Pulsar also pushes changes to POST /internal/settings.
  const settings = new SettingsStore(sql);
  await settings.load();
  const settingsUrl = env.STICKS_SETTINGS_URL?.trim();
  if (settingsUrl) {
    const secret = engineSecretFrom(dir);
    if (secret) {
      await pullSettings(settingsUrl, secret)
        .then((payload) => settings.update(payload))
        .catch((error) => logger.error("settings pull failed; keeping the stored settings", error));
    }
  }
  handles.app.post("/internal/settings", async (c) => {
    const secret = engineSecretFrom(dir);
    if (!secret) return c.json({ error: "engine secret not provisioned" }, 503);
    if (!bearerMatches(c.req.header("authorization"), secret)) return c.json({ error: "unauthorized" }, 401);
    try {
      return c.json(await settings.update(await c.req.json()));
    } catch (error) {
      if (error instanceof SettingsError || error instanceof SyntaxError) return c.json({ error: error.message }, 400);
      throw error;
    }
  });

  // Credits (brief task 12): settle runs a crash left unsettled. Runs reserve and settle through pulsar-credits.ts.
  if (pulsarSocket && creditsSecret) {
    await settleLeftovers(socketTransport(pulsarSocket, creditsSecret), sql)
      .then((n) => n && console.log(JSON.stringify({ msg: "settled runs left unsettled", count: n })))
      .catch((error) => logger.error("credits boot settle failed; will retry next boot", error));
  }

  // Credits renewed (a new cycle, a new day for a Stick's daily cap, or a top-up): Pulsar posts
  // {scope: "cycle" | "day" | "all"} with the engine secret, and every Stick stopped for credits carries on.
  // Waking a Stick needs the run hooks (with the v0.13.0 repin); until then it fails and the record stays.
  handles.app.post("/internal/credits/renewed", async (c) => {
    const secret = engineSecretFrom(dir);
    if (!secret) return c.json({ error: "engine secret not provisioned" }, 503);
    if (!bearerMatches(c.req.header("authorization"), secret)) return c.json({ error: "unauthorized" }, 401);
    const body = (await c.req.json().catch(() => ({}))) as { scope?: string };
    const scope = body.scope === "day" || body.scope === "all" ? body.scope : "cycle";
    const woken = await resumeAfterRenewal(sql, scope, async () => {
      throw new Error("waking a Stick needs the run hooks (v0.13.0 repin)");
    });
    return c.json({ woken });
  });

  // Hub onboarding (control#204): only when STICKS_HUB_ONBOARDING=1. The chat page hands over the tenant's
  // onboarding token once (signed-in, not a guest); the plugin's three tools call the proxy routes, which add
  // the token. Callers must be signed in (any member) or hold the engine secret.
  const onboarding = onboardingEnabled(env);
  if (onboarding) {
    const signedIn = async (headers: Headers) => {
      const raw = sessionTokenFrom(headers);
      if (!raw) return false;
      const rows = (await sql(`SELECT 1 FROM session WHERE token = $1 AND "expiresAt" > $2 LIMIT 1`, [raw, new Date()])) as unknown[];
      return rows.length > 0 && !(await isGuestSession(sql, raw));
    };
    await seedBuiltinPlugin(sqlDraftRepository(sql), "hub-onboarding", onboardingPluginDocument(onboarding.engineUrl));
    const fail = (c: { json: (b: unknown, s: number) => Response }, error: unknown) => {
      if (error instanceof OnboardingError) return c.json({ error: error.message }, error.status);
      if (error instanceof SyntaxError) return c.json({ error: "body must be JSON" }, 400);
      throw error;
    };
    handles.app.post("/internal/onboarding/token", async (c) => {
      if (!(await signedIn(c.req.raw.headers))) return c.json({ error: "sign in first" }, 401);
      try {
        const body = (await c.req.json()) as { onboarding_token?: unknown };
        await saveOnboardingToken(sql, body?.onboarding_token);
        // The Onboarding Stick is made here, not at boot: a Stick needs an owner, and at boot nobody has signed in.
        const raw = sessionTokenFrom(c.req.raw.headers);
        const owner = (await sql(`SELECT "userId" FROM session WHERE token = $1 LIMIT 1`, [raw])) as Array<{ userId: string }>;
        const stickId = owner[0] ? await ensureOnboardingStick(sql, owner[0].userId) : undefined;
        return c.json({ ok: true, stickId: stickId ?? null });
      } catch (error) {
        return fail(c as never, error);
      }
    });
    for (const tool of ["state", "save-answer", "finish"] as OnboardingTool[]) {
      handles.app.post(`/internal/onboarding/${tool}`, async (c) => {
        const secret = engineSecretFrom(dir);
        const bySecret = secret !== undefined && bearerMatches(c.req.header("authorization"), secret);
        if (!bySecret && !(await signedIn(c.req.raw.headers))) return c.json({ error: "unauthorized" }, 401);
        const token = await readOnboardingToken(sql);
        if (!token) return c.json({ error: "onboarding has not started: no onboarding token yet" }, 409);
        try {
          const text = await c.req.text();
          return c.json({ result: await callHub(onboarding.hubUrl, token, tool, text ? JSON.parse(text) : {}) });
        } catch (error) {
          return fail(c as never, error);
        }
      });
    }
  }

  // Hub feature switches (Ray 11-22). Pulsar posts the hub's resolved switches with the engine secret whenever they
  // change (core#1630); signed-in people and the engine read them. Everything is on until the hub says otherwise.
  await sql(FEATURES_TABLE_SQL, []);
  handles.app.post("/internal/features", async (c) => {
    const secret = engineSecretFrom(dir);
    if (secret === undefined || !bearerMatches(c.req.header("authorization"), secret)) return c.json({ error: "unauthorized" }, 401);
    return c.json({ features: await saveFeatures(sql, await c.req.json().catch(() => ({}))) });
  });
  handles.app.get("/internal/features", async (c) => {
    const secret = engineSecretFrom(dir);
    const bySecret = secret !== undefined && bearerMatches(c.req.header("authorization"), secret);
    const raw = sessionTokenFrom(c.req.raw.headers);
    const signed = raw ? ((await sql(`SELECT 1 FROM session WHERE token = $1 AND "expiresAt" > $2 LIMIT 1`, [raw, new Date()])) as unknown[]).length > 0 && !(await isGuestSession(sql, raw)) : false;
    if (!bySecret && !signed) return c.json({ error: "unauthorized" }, 401);
    return c.json({ features: await readFeatures(sql) });
  });

  // Many tenants in one engine (Ray 11-22). Pulsar's first start registers its tenant with the engine secret:
  // {tenant, site, company, public_key}. Create-only: repeating it with the same key is harmless; another tenant's name or site is refused (400) and a different key for an existing tenant is refused (409).
  handles.app.post("/internal/tenants", async (c) => {
    const s = engineSecretFrom(dir);
    if (s === undefined || !bearerMatches(c.req.header("authorization"), s)) return c.json({ error: "unauthorized" }, 401);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    try {
      const t = await registerTenant(sql, { tenant: body.tenant, site: body.site, company: body.company, publicKey: body.public_key });
      return c.json({ tenant: t.tenant, organization: t.orgId });
    } catch (error) {
      if (error instanceof TenantConflictError) return c.json({ error: error.message }, 409);
      if (error instanceof TenantError) return c.json({ error: error.message }, 400);
      throw error;
    }
  });

  // Drain and resume for docker moves (Ray 11-22 "Go"; caller: control's move_runner). Both need the engine secret.
  // Drain answers with the current idle snapshot; the runner polls GET /internal/idle until idle before freezing.
  {
    const drain = new DrainState(sql);
    await drain.load();
    const bySecret = (h: string | undefined) => {
      const s = engineSecretFrom(dir);
      return s !== undefined && bearerMatches(h, s);
    };
    handles.app.post("/internal/drain", async (c) => {
      if (!bySecret(c.req.header("authorization"))) return c.json({ error: "unauthorized" }, 401);
      await drain.set(true);
      const inputs = await readIdleInputs(handles.prisma, new Date(), () => openStreams.value, () => liveScripts.value);
      return c.json({ draining: true, active_runs: inputs.activeRuns });
    });
    handles.app.post("/internal/resume", async (c) => {
      if (!bySecret(c.req.header("authorization"))) return c.json({ error: "unauthorized" }, 401);
      await drain.set(false);
      return c.json({ draining: false });
    });
  }

  // Working hours and off duty (Ray 11-09; duty.ts). Routines skip occurrences while a Stick is off duty or
  // outside its hours (upstream routine gate, patch 0006). The Stick sets it through the built-in "duty" plugin;
  // the app reads GET /internal/duty?stick=ID to show it resting. A signed-in caller must belong to the Stick's
  // organization, so one tenant can never read or change another tenant's Stick.
  {
    const duty = new DutyStore(sql);
    await duty.ensure();
    routineGates.push(async (routine, at) => dutyState(await duty.get(routine.botId), at).on_duty);
    const botOf = async (stick: unknown, thread: unknown): Promise<{ id: string; org: string } | undefined> => {
      const rows = (typeof stick === "string" && stick
        ? await sql(`SELECT b.id, s."organizationId" AS org FROM bots b JOIN spaces s ON s.id = b."spaceId" WHERE b.id = $1`, [stick])
        : typeof thread === "string" && thread
          ? await sql(`SELECT b.id, s."organizationId" AS org FROM threads t JOIN bots b ON b.id = t."botId" JOIN spaces s ON s.id = b."spaceId" WHERE t.id = $1`, [thread])
          : []) as Array<{ id: string; org: string }>;
      return rows[0];
    };
    const mayAct = async (c: { req: { header: (n: string) => string | undefined; raw: Request } }, org: string) => {
      const secret = engineSecretFrom(dir);
      if (secret !== undefined && bearerMatches(c.req.header("authorization"), secret)) return true;
      const raw = sessionTokenFrom(c.req.raw.headers);
      if (!raw) return false;
      const rows = (await sql(
        `SELECT 1 FROM session se JOIN member m ON m."userId" = se."userId" WHERE se.token = $1 AND se."expiresAt" > $2 AND m."organizationId" = $3 LIMIT 1`,
        [raw, new Date(), org],
      )) as unknown[];
      return rows.length > 0;
    };
    const dutyUrl = env.STICKS_ENGINE_URL?.trim().replace(/\/+$/, "");
    if (dutyUrl && /^https:\/\//.test(dutyUrl)) await seedBuiltinPlugin(sqlDraftRepository(sql), "duty", dutyPluginDocument(dutyUrl));
    handles.app.get("/internal/duty", async (c) => {
      const bot = await botOf(c.req.query("stick"), c.req.query("thread"));
      if (!bot) return c.json({ error: "unknown Stick" }, 404);
      if (!(await mayAct(c, bot.org))) return c.json({ error: "unauthorized" }, 401);
      const d = await duty.get(bot.id);
      return c.json({ stick: bot.id, hours: d.hours, ...dutyState(d, new Date()) });
    });
    handles.app.post("/internal/duty", async (c) => {
      const body = (await c.req.json().catch(() => ({}))) as { stick_id?: unknown; thread_id?: unknown };
      const bot = await botOf(body.stick_id, body.thread_id);
      if (!bot) return c.json({ error: "unknown Stick" }, 404);
      if (!(await mayAct(c, bot.org))) return c.json({ error: "unauthorized" }, 401);
      try {
        return c.json({ stick: bot.id, ...(await applyDutyChange(duty, bot.id, body, new Date())) });
      } catch (error) {
        if (error instanceof DutyError) return c.json({ error: error.message }, 400);
        throw error;
      }
    });

    // Keep-going and the goal loop (Ray 11-11; keep-going-wiring.ts). Upstream tells us each finalized run
    // (patch 0006); a Stick with open tickets, scratchpad items or an unfinished goal is asked to continue,
    // within keep-going's caps and only while on duty.
    const kgStore = new KeepGoingStore(sql);
    await kgStore.ensure();
    await sql(GOALS_TABLE_SQL);
    const sys = <T>(fn: () => Promise<T>) => runAsSystem("sticks keep-going", fn);
    const read: SnapshotReader = {
      run: (id) => sys(() => handles.prisma.run.findUnique({ where: { id }, select: { status: true, completedAt: true, userId: true } })),
      lastMessage: (threadId) =>
        sys(() => handles.prisma.message.findFirst({ where: { threadId }, orderBy: { seq: "desc" }, select: { role: true, blocks: true, createdAt: true } })),
      tickets: (botId) =>
        sys(() => handles.prisma.ticket.findMany({ where: { assigneeBotId: botId, status: { in: ["todo", "doing", "blocked"] } }, select: { id: true, title: true, status: true }, take: 50 })),
      scratchpad: (botId) =>
        sys(() => handles.prisma.scratchpadItem.findMany({ where: { botId, status: "open" }, select: { id: true, title: true, status: true }, take: 50 })),
    };
    const queueFollowUp = async (e: { spaceId: string; botId: string; threadId: string }, userId: string, prompt: string, delaySeconds: number) => {
      const fire = async () => {
        const runId = await sys(() =>
          handles.prisma.$transaction(async (tx) => {
            const task = await tx.task.create({ data: { spaceId: e.spaceId, botId: e.botId, threadId: e.threadId, userId, prompt, status: "queued" } });
            const run = await tx.run.create({
              data: { spaceId: e.spaceId, botId: e.botId, threadId: e.threadId, taskId: task.id, userId, status: "queued", trigger: "follow_up" },
            });
            return run.id;
          }),
        );
        await handles.jobs.enqueue(runContinueJob(runId));
      };
      const timer = setTimeout(() => void fire().catch((error) => logger.error("keep-going follow-up failed", error)), Math.max(0, delaySeconds) * 1000);
      timer.unref();
    };
    runFinishedHooks.push((e) =>
      keepGoingAfterRun(
        {
          store: kgStore,
          query: sql,
          read,
          settings: () => settings.get().keepGoing,
          onDuty: async (botId, at) => dutyState(await duty.get(botId), at).on_duty,
          queueFollowUp,
        },
        e,
      ).then((outcome) => console.log(JSON.stringify({ msg: "keep-going", bot: e.botId, run: e.runId, outcome }))),
    );
    const goalUrl = env.STICKS_ENGINE_URL?.trim().replace(/\/+$/, "");
    if (goalUrl && /^https:\/\//.test(goalUrl)) await seedBuiltinPlugin(sqlDraftRepository(sql), "goal", goalPluginDocument(goalUrl));
    handles.app.get("/internal/goal", async (c) => {
      const bot = await botOf(undefined, c.req.query("thread"));
      if (!bot) return c.json({ error: "unknown chat" }, 404);
      if (!(await mayAct(c, bot.org))) return c.json({ error: "unauthorized" }, 401);
      return c.json({ goal: (await readGoal(sql, String(c.req.query("thread")))) ?? null });
    });
    handles.app.post("/internal/goal", async (c) => {
      const body = (await c.req.json().catch(() => ({}))) as { thread_id?: unknown; goal?: unknown };
      const bot = await botOf(undefined, body.thread_id);
      if (!bot) return c.json({ error: "unknown chat" }, 404);
      if (!(await mayAct(c, bot.org))) return c.json({ error: "unauthorized" }, 401);
      try {
        return c.json(await setGoal(sql, String(body.thread_id), body.goal));
      } catch (error) {
        if (error instanceof GoalError) return c.json({ error: error.message }, 400);
        throw error;
      }
    });
    handles.app.post("/internal/goal/done", async (c) => {
      const body = (await c.req.json().catch(() => ({}))) as { thread_id?: unknown; note?: unknown };
      const bot = await botOf(undefined, body.thread_id);
      if (!bot) return c.json({ error: "unknown chat" }, 404);
      if (!(await mayAct(c, bot.org))) return c.json({ error: "unauthorized" }, 401);
      return c.json({ done: await completeGoal(sql, String(body.thread_id), body.note) });
    });
  }

  // Stick reactions (Ray 11-21). A Stick reacts through the built-in "reactions" plugin (needs STICKS_ENGINE_URL
  // https); the app reads GET /internal/reactions?thread=ID[&since=ISO] and buzzes on a new one while the chat is open.
  {
    const allowed = async (c: { req: { header: (n: string) => string | undefined; raw: Request } }) => {
      const secret = engineSecretFrom(dir);
      if (secret !== undefined && bearerMatches(c.req.header("authorization"), secret)) return true;
      const raw = sessionTokenFrom(c.req.raw.headers);
      if (!raw) return false;
      const rows = (await sql(`SELECT 1 FROM session WHERE token = $1 AND "expiresAt" > $2 LIMIT 1`, [raw, new Date()])) as unknown[];
      return rows.length > 0;
    };
    const engineUrl = env.STICKS_ENGINE_URL?.trim().replace(/\/+$/, "");
    if (engineUrl && /^https:\/\//.test(engineUrl)) await seedBuiltinPlugin(sqlDraftRepository(sql), "reactions", reactionsPluginDocument(engineUrl));
    handles.app.post("/internal/reactions", async (c) => {
      if (!(await allowed(c))) return c.json({ error: "unauthorized" }, 401);
      const body = (await c.req.json().catch(() => ({}))) as { message_id?: unknown; emoji?: unknown };
      try {
        return c.json({ reaction: await addReaction(sql, body.message_id, body.emoji) });
      } catch (error) {
        if (error instanceof ReactionError) return c.json({ error: error.message }, error.status);
        throw error;
      }
    });
    handles.app.get("/internal/reactions", async (c) => {
      if (!(await allowed(c))) return c.json({ error: "unauthorized" }, 401);
      const thread = c.req.query("thread");
      if (!thread) return c.json({ error: "thread is required" }, 400);
      return c.json({ reactions: await listReactions(sql, thread, c.req.query("since") || undefined) });
    });

    // Record cards (Ray 11-21). The Stick asks with the engine secret (built-in "record-confirm" plugin); the app
    // lists GET /internal/record-requests?thread=ID[&since=ISO] and answers POST /internal/record-requests/answer
    // {requestId, decision} as the signed-in person. Answering twice is a no-op.
    if (engineUrl && /^https:\/\//.test(engineUrl)) await seedBuiltinPlugin(sqlDraftRepository(sql), "record-confirm", recordConfirmPluginDocument(engineUrl));
    const sessionUser = async (c: { req: { raw: Request } }) => {
      const raw = sessionTokenFrom(c.req.raw.headers);
      if (!raw) return undefined;
      const rows = (await sql(`SELECT "userId" FROM session WHERE token = $1 AND "expiresAt" > $2 LIMIT 1`, [raw, new Date()])) as Array<{ userId: string }>;
      if (!rows[0] || (await isGuestSession(sql, raw))) return undefined;
      return rows[0].userId;
    };
    // Record content (customer names, totals) is for the engine secret or a non-guest member, never a guest.
    const recordReader = async (c: { req: { header: (n: string) => string | undefined; raw: Request } }) => {
      const secret = engineSecretFrom(dir);
      if (secret !== undefined && bearerMatches(c.req.header("authorization"), secret)) return true;
      return (await sessionUser(c)) !== undefined;
    };
    const recordError = (error: unknown) => {
      if (error instanceof RecordRequestError) return { body: { error: error.message }, status: error.status };
      throw error;
    };
    handles.app.post("/internal/record-requests/answer", async (c) => {
      const user = await sessionUser(c);
      if (!user) return c.json({ error: "unauthorized" }, 401);
      const body = (await c.req.json().catch(() => ({}))) as { requestId?: unknown; decision?: unknown };
      try {
        return c.json({ ok: true, request: await answerRecordRequest(sql, body.requestId, body.decision, user) });
      } catch (error) {
        const e = recordError(error);
        return c.json(e.body, e.status);
      }
    });
    handles.app.post("/internal/record-requests", async (c) => {
      const secret = engineSecretFrom(dir);
      if (secret === undefined || !bearerMatches(c.req.header("authorization"), secret)) return c.json({ error: "unauthorized" }, 401);
      try {
        return c.json({ request: await createRecordRequest(sql, (await c.req.json().catch(() => ({}))) as Record<string, unknown>) });
      } catch (error) {
        const e = recordError(error);
        return c.json(e.body, e.status);
      }
    });
    handles.app.get("/internal/record-requests/:requestId", async (c) => {
      if (!(await recordReader(c))) return c.json({ error: "unauthorized" }, 401);
      try {
        return c.json({ request: await getRecordRequest(sql, c.req.param("requestId")) });
      } catch (error) {
        const e = recordError(error);
        return c.json(e.body, e.status);
      }
    });
    handles.app.get("/internal/record-requests", async (c) => {
      if (!(await recordReader(c))) return c.json({ error: "unauthorized" }, 401);
      const thread = c.req.query("thread");
      if (!thread) return c.json({ error: "thread is required" }, 400);
      const since = c.req.query("since");
      if (since && Number.isNaN(Date.parse(since))) return c.json({ error: "since must be a date" }, 400);
      return c.json({ requests: await listRecordRequests(sql, thread, c.req.query("since") || undefined) });
    });
  }

  // Speech for voice chat in the app (voice calls plan, piece 1). GET /internal/voice/setup (signed in) returns the
  // base URL and proxy token to save as the Space's OpenAI-compatible voice server; /internal/voice/v1/* forwards
  // to the gateway with the gateway key and charges credits. Needs STICKS_ENGINE_URL https and STICKS_GATEWAY_URL.
  {
    const engineUrl = env.STICKS_ENGINE_URL?.trim().replace(/\/+$/, "");
    const gatewayUrl = env.STICKS_GATEWAY_URL?.trim();
    const secret = engineSecretFrom(dir);
    if (engineUrl && /^https:\/\//.test(engineUrl) && gatewayUrl && secret) {
      handles.app.get("/internal/voice/setup", async (c) => {
        const raw = sessionTokenFrom(c.req.raw.headers);
        const ok = raw ? ((await sql(`SELECT 1 FROM session WHERE token = $1 AND "expiresAt" > $2 LIMIT 1`, [raw, new Date()])) as unknown[]).length > 0 : false;
        if (!ok) return c.json({ error: "unauthorized" }, 401);
        return c.json({ baseUrl: `${engineUrl}/internal/voice/v1`, apiKey: voiceProxyToken(secret) });
      });
      handles.app.all("/internal/voice/v1/*", async (c) => {
        const path = new URL(c.req.url).pathname.replace(/^\/internal\/voice\/v1\//, "");
        return forwardVoice(
          { gatewayUrl, gatewayKey: readGatewayKey(dir), engineSecret: secret, credits: pulsarSocket ? socketTransport(pulsarSocket, secret) : undefined },
          path,
          c.req.raw,
        );
      });
    }
  }

  // Pulsar plugins (Ray 11-21): one plugin per Pulsar area, seeded as drafts for the admin to approve. The proxy
  // calls Pulsar's /api/resource at STICKS_PULSAR_URL (in the same container) Ray 11-22: each Stick is its own
  // Pulsar user with its own role, so the call uses that Stick's token (pulsar_token_<stick>), never a shared
  // account. The person who asked or approved goes along as X-Requested-By for Pulsar's record trail.
  {
    const engineUrl = env.STICKS_ENGINE_URL?.trim().replace(/\/+$/, "");
    const pulsarUrl = env.STICKS_PULSAR_URL?.trim().replace(/\/+$/, "");
    const secret = engineSecretFrom(dir);
    if (engineUrl && /^https:\/\//.test(engineUrl) && pulsarUrl && secret) {
      await seedPulsarPlugins(sqlDraftRepository(sql), engineUrl);
      await sql(STICK_TOKENS_TABLE_SQL, []);
      // Stick account setup (core#1627): a signed-in tenant admin sends their own Pulsar token once in
      // X-Pulsar-Token; Pulsar refuses anyone without System Manager. Body {displayName, role, directors?}.
      // Hand-off from Pulsar's first start (Ray 11-22 "Agreed"): Pulsar creates the Stick's account itself and posts
      // its token here once with the engine secret. Body {user, token}.
      handles.app.post("/internal/sticks/:stick/pulsar-token", async (c) => {
        if (!bearerMatches(c.req.header("authorization"), secret)) return c.json({ error: "unauthorized" }, 401);
        const stickId = c.req.param("stick");
        const body = (await c.req.json().catch(() => ({}))) as { user?: unknown; token?: unknown };
        if (!validStickId(stickId) || typeof body.user !== "string" || !body.user || typeof body.token !== "string" || !body.token) {
          return c.json({ error: "stick, user and token are required" }, 400);
        }
        await saveStickToken(sql, stickId, body.user, body.token, secret);
        return c.json({ ok: true });
      });
      handles.app.post("/internal/sticks/:stick/pulsar-account", async (c) => {
        const raw = sessionTokenFrom(c.req.raw.headers);
        const signed = raw ? ((await sql(`SELECT 1 FROM session WHERE token = $1 AND "expiresAt" > $2 LIMIT 1`, [raw, new Date()])) as unknown[]).length > 0 && !(await isGuestSession(sql, raw)) : false;
        const adminToken = c.req.header("x-pulsar-token");
        if (!signed || !adminToken) return c.json({ error: "unauthorized" }, 401);
        const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
        try {
          return c.json(await setUpStickAccount(sql, fetch, pulsarUrl, adminToken, secret, { stickId: c.req.param("stick"), displayName: body.displayName, role: body.role, directors: body.directors }));
        } catch (error) {
          if (error instanceof StickAccountError) return c.json({ error: error.message }, error.status);
          throw error;
        }
      });
      handles.app.all("/internal/pulsar/:area/:op", async (c) => {
        // Only Stick runs call this (engine secret). A person's session is refused: the Stick and requester headers
        // would be forgeable, and any member could write to Pulsar as any Stick account.
        if (!bearerMatches(c.req.header("authorization"), secret)) return c.json({ error: "unauthorized" }, 401);
        try {
          const body = c.req.method === "GET" ? {} : ((await c.req.json().catch(() => ({}))) as Record<string, unknown>);
          const r = pulsarRequest(c.req.param("area"), c.req.param("op"), new URL(c.req.url).searchParams, body);
          const stick = c.req.header("x-sticks-stick") ?? "";
          if (!/^[A-Za-z0-9_-]{1,64}$/.test(stick)) return c.json({ error: "which Stick is calling is required" }, 400);
          const requestedBy = c.req.header("x-sticks-requested-by");
          // The Stick's token is kept (sealed) by the account setup below; a file secret still works for images
          // that ship one.
          let token = await stickToken(sql, stick, secret);
          if (!token) {
            try {
              token = readSecret(`pulsar_token_${stick}`, dir);
            } catch {
              return c.json({ error: "This Stick has no Pulsar account yet" }, 503);
            }
          }
          const res = await fetch(`${pulsarUrl}${r.path}`, {
            method: r.method,
            headers: {
              authorization: `token ${token}`,
              ...(requestedBy ? { "x-requested-by": requestedBy.slice(0, 140) } : {}),
              ...(r.body !== undefined ? { "content-type": "application/json" } : {}),
            },
            ...(r.body !== undefined ? { body: JSON.stringify(r.body) } : {}),
          });
          return new Response(await res.text(), { status: res.status, headers: { "content-type": "application/json" } });
        } catch (error) {
          if (error instanceof PulsarProxyError) return c.json({ error: error.message }, error.status);
          throw error;
        }
      });
    }
  }

  // Idle and next wake (spec 7.6, brief task 8). GET /internal/idle needs the per-tenant engine secret.
  // Open streams are counted at the front door and running sandbox commands in the helper client (activity.ts).
  // Every change to either re-checks idle and pushes a change to Pulsar at once; nothing polls.
  const idle = new IdleTracker();
  const streams = () => openStreams.value;
  const scripts = () => liveScripts.value;
  handles.app.get("/internal/idle", async (c) => {
    const secret = engineSecretFrom(dir);
    if (!secret) return c.json({ error: "engine secret not provisioned" }, 503);
    if (!bearerMatches(c.req.header("authorization"), secret)) return c.json({ error: "unauthorized" }, 401);
    const now = new Date();
    const inputs = await readIdleInputs(handles.prisma, now, streams, scripts);
    return c.json(idle.update(inputs, now).snapshot);
  });
  let checking = false;
  let again = false;
  const recheck = async (): Promise<void> => {
    if (checking) {
      again = true;
      return;
    }
    checking = true;
    try {
      do {
        again = false;
        const now = new Date();
        const inputs = await readIdleInputs(handles.prisma, now, streams, scripts);
        const { snapshot, changed } = idle.update(inputs, now);
        if (changed) void pushIdle(env.STICKS_IDLE_PUSH_URL, snapshot, engineSecretFrom(dir));
      } while (again);
    } catch (error) {
      logger.error("idle re-check failed", error);
    } finally {
      checking = false;
    }
  };
  const offStreams = openStreams.onChange(() => void recheck());
  const offScripts = liveScripts.onChange(() => void recheck());
  // The first evaluation at start: the engine is starting, so the state is new.
  await recheck();

  const stopUpstream = handles.stop;
  return {
    ...handles,
    stop: async () => {
      scheduler.stop();
      clearInterval(defaultsTimer);
      offStreams();
      offScripts();
      await stopUpstream();
    },
  };
}
