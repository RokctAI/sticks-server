// The composition root: upstream's API and worker in one Node process (spec 4.2, 11.1).
// Upstream's createApp is used as is; the overrides below are the Sticks wiring.
import { fileURLToPath } from "node:url";
import { InMemoryRealtimeFanout } from "../../../packages/adapters/src/index.ts";
import { createApp, type AppHandles } from "../../api/src/app.js";
import { deployMigrations } from "../../../packages/db/src/index.ts";
import { createServiceLogger, SERVICE_NAMES } from "../../../packages/logging/src/index.ts";
import { databaseUrlWithPassword, readSecret, SECRETS_DIR } from "./config.js";

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

  return createApp({
    databaseUrl,
    encryptionKey: contentKey,
    // Events go to this process only: no Postgres LISTEN connection (spec 4.3, 11.1).
    realtime: new InMemoryRealtimeFanout(),
    // The memory job driver is the supported single-process mode (spec 11.1).
    wakeupDriver: "memory",
    ticketBoardEnabled: true,
    logger: createServiceLogger({ service: SERVICE_NAMES.api }),
    ...options.overrides,
  });
}
