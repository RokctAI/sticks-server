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
import { endOfDayHookFromEnv, engineEndOfDayDeps, tzOffsetFromEnv } from "./end-of-day-wiring.js";
import { providerKeysInEnv } from "./gateway.js";
import { bearerMatches, engineSecretFrom, IdleTracker, pushIdle, readIdleInputs } from "./idle.js";

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

  // Recover what a restart lost, before anything serves (spec 7.6, brief task 7). The one timer for
  // the nearest due item is held by the scheduler; stop() clears it before upstream shuts down.
  // The end-of-day job (brief task 18) is held in the scheduler's one timer when STICKS_END_OF_DAY is set.
  // The chat listing and cursor reads are real; the summariser (upstream's compactHistory needs the agent
  // runtime) and the Engram write (Pulsar side) are not connected yet, so a day fails with a clear error
  // (logged by onError) and the next day still runs.
  const offset = tzOffsetFromEnv(env);
  const scheduler = startBootScheduler({
    prisma: handles.prisma,
    jobs: handles.jobs,
    endOfDay: endOfDayHookFromEnv(
      env,
      engineEndOfDayDeps({
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

  // Idle and next wake (spec 7.6, brief task 8). GET /internal/idle needs the per-tenant engine secret.
  // Open streams and live scripts are not counted yet (no hook in upstream), so the tenant is never
  // reported idle through them: see idle.ts and the PR.
  const idle = new IdleTracker();
  const untracked = () => undefined;
  handles.app.get("/internal/idle", async (c) => {
    const secret = engineSecretFrom(dir);
    if (!secret) return c.json({ error: "engine secret not provisioned" }, 503);
    if (!bearerMatches(c.req.header("authorization"), secret)) return c.json({ error: "unauthorized" }, 401);
    const now = new Date();
    const inputs = await readIdleInputs(handles.prisma, now, untracked, untracked);
    return c.json(idle.update(inputs, now).snapshot);
  });
  // The first evaluation at start: the engine is starting, so the state is new. Later changes are pushed
  // when the engine learns of them (see the PR).
  {
    const secret = engineSecretFrom(dir);
    const now = new Date();
    const inputs = await readIdleInputs(handles.prisma, now, untracked, untracked);
    const { snapshot, changed } = idle.update(inputs, now);
    if (changed) void pushIdle(env.STICKS_IDLE_PUSH_URL, snapshot, secret);
  }

  const stopUpstream = handles.stop;
  return {
    ...handles,
    stop: async () => {
      scheduler.stop();
      await stopUpstream();
    },
  };
}
