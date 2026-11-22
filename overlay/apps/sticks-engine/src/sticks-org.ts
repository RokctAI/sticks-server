// sticks-org CLI (Ray 11-22 "Go"): moves one tenant's Rakazo rows between dockers. Run inside the tenant
// service, no engine needed, with the same STICKS_DATABASE_URL (no password) and /run/secrets/db_password the
// engine uses:
//   node sticks-org.mjs export <organizationId> <file.json>
//   node sticks-org.mjs export --site <site> <file.json>   (the tenant whose Pulsar site this is; shared dockers)
//   node sticks-org.mjs export --only-org <file.json>   (the database holds one tenant: export that one)
//   node sticks-org.mjs import <file.json>        (running it twice changes nothing)
// Option --move-key <file> on both export and import: a one-off random key file the move runner makes and gives to
// both sides. With it the tenant's Stick Pulsar tokens move too (engine-rows.ts); without it they are skipped and
// must be rotated after the move. The engine's own rows for the tenant always move (engine-rows.ts).
// With --move-key the tenant's space keys are also re-wrapped from this docker's content_key to the target's
// (content-rewrap.ts), so message content stays readable on a docker with another content_key. Stored connection
// secrets (upstream's secret store) are NOT re-encrypted yet: on a docker with another content_key they must be
// entered again. Exit 0 on success, 1 on failure (the reason on stderr, never a secret). Caller: control's move runner.
import { readFileSync, writeFileSync } from "node:fs";
import { createPool } from "../../../packages/db/src/client.ts";
import { databaseUrlWithPassword, readSecret, SECRETS_DIR } from "./config.js";
import { exportOrg, importOrg } from "./org-move.js";
import { exportEngineRows, importEngineRows, type EngineRows } from "./engine-rows.js";
import { TENANTS_TABLE_SQL } from "./tenants.js";
import { STICK_TOKENS_TABLE_SQL } from "./stick-pulsar-accounts.js";
import { KEEP_GOING_TABLE_SQL } from "./keep-going.js";
import { CREDIT_PAUSED_TABLE_SQL } from "./pulsar-credits.js";
import { RECORD_REQUESTS_TABLE_SQL } from "./record-requests.js";
import { GUEST_TABLE_SQL } from "./pulsar-session.js";

const ENGINE_TABLES: Record<string, string> = {
  sticks_tenants: TENANTS_TABLE_SQL,
  sticks_pulsar_tokens: STICK_TOKENS_TABLE_SQL,
  sticks_keep_going: KEEP_GOING_TABLE_SQL,
  sticks_credit_paused: CREDIT_PAUSED_TABLE_SQL,
  sticks_record_requests: RECORD_REQUESTS_TABLE_SQL,
  sticks_guest: GUEST_TABLE_SQL,
};

/** Takes `--move-key <file>` out of the arguments. */
function moveKeyFrom(argv: string[]): { rest: string[]; moveKey?: string } {
  const i = argv.indexOf("--move-key");
  if (i < 0) return { rest: argv };
  const file = argv[i + 1];
  if (!file) throw new Error("--move-key needs a file");
  const moveKey = readFileSync(file, "utf8").trim();
  if (moveKey.length < 32) throw new Error("the move key file must hold at least 32 characters");
  return { rest: [...argv.slice(0, i), ...argv.slice(i + 2)], moveKey };
}

function contentKey(dir: string): string | undefined {
  try {
    return readSecret("content_key", dir);
  } catch {
    return undefined;
  }
}

function engineSecret(dir: string): string | undefined {
  try {
    return readSecret("engine_secret", dir);
  } catch {
    return undefined;
  }
}

async function main(args: string[]): Promise<number> {
  const { rest: argv, moveKey } = moveKeyFrom(args);
  const [cmd, a, b, c] = argv;
  const base = process.env.STICKS_DATABASE_URL?.trim();
  if (!base) throw new Error("STICKS_DATABASE_URL is required");
  const dir = process.env.STICKS_SECRETS_DIR ?? SECRETS_DIR;
  const pool = createPool(databaseUrlWithPassword(base, readSecret("db_password", dir)), { poolMax: 1 });
  const client = await pool.connect();
  const query = async (text: string, values: unknown[] = []) => (await client.query(text, values)).rows as unknown[];
  const exportTo = async (org: string, file: string): Promise<number> => {
    const data = await exportOrg(query, org);
    const engine = await exportEngineRows(query, org, { engineSecret: engineSecret(dir), moveKey, contentKey: contentKey(dir) });
    writeFileSync(file, JSON.stringify({ ...data, engine: engine.rows }), { mode: 0o600 });
    console.log(JSON.stringify({
      exported: Object.fromEntries(Object.entries(data.tables).map(([t, r]) => [t, r.length])),
      engine: Object.fromEntries(Object.entries(engine.rows).map(([t, r]) => [t, r.length])),
      skipped_stick_tokens: engine.skippedTokens,
      space_keys_rewrapped: engine.spaceKeysRewrapped,
    }));
    return 0;
  };
  try {
    if (cmd === "export" && a === "--site" && b && c) {
      await query(TENANTS_TABLE_SQL);
      const rows = (await query(`SELECT org_id FROM sticks_tenants WHERE site = $1`, [b])) as Array<{ org_id: string }>;
      if (!rows[0]) throw new Error("no tenant with that site in this engine");
      return await exportTo(rows[0].org_id, c);
    }
    if (cmd === "export" && a && b) {
      let org = a;
      if (a === "--only-org") {
        const orgs = (await query(`SELECT id FROM organization`)) as Array<{ id: string }>;
        if (orgs.length !== 1) throw new Error(`--only-org needs exactly one organization; found ${orgs.length}`);
        org = orgs[0]!.id;
      }
      return await exportTo(org, b);
    }
    if (cmd === "import" && a) {
      await query("BEGIN");
      try {
        const data = JSON.parse(readFileSync(a, "utf8")) as Parameters<typeof importOrg>[1] & { engine?: EngineRows };
        const counts = await importOrg(query, data);
        const engine = await importEngineRows(query, data.engine, { engineSecret: engineSecret(dir), moveKey, contentKey: contentKey(dir) }, ENGINE_TABLES);
        await query("COMMIT");
        console.log(JSON.stringify({ imported: counts, engine }));
        return 0;
      } catch (error) {
        await query("ROLLBACK");
        throw error;
      }
    }
    console.error("usage: sticks-org export <organizationId>|--site <site>|--only-org <file.json> | import <file.json> [--move-key <file>]");
    return 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : "failed");
    process.exit(1);
  },
);
