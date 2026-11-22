// sticks-org CLI (Ray 11-22 "Go"): moves one tenant's Rakazo rows between dockers. Run inside the tenant
// service, no engine needed, with the same STICKS_DATABASE_URL (no password) and /run/secrets/db_password the
// engine uses:
//   node sticks-org.mjs export <organizationId> <file.json>
//   node sticks-org.mjs export --only-org <file.json>   (the database holds one tenant: export that one)
//   node sticks-org.mjs import <file.json>        (running it twice changes nothing)
// Exit 0 on success, 1 on failure (the reason on stderr, never a secret). Encrypted content and stored secrets
// stay encrypted with the source docker's content key, so the target docker must run with that same
// content_key secret (copied by the move runner) or it cannot read them. Caller: control's move runner.
import { readFileSync, writeFileSync } from "node:fs";
import { createPool } from "../../../packages/db/src/client.ts";
import { databaseUrlWithPassword, readSecret, SECRETS_DIR } from "./config.js";
import { exportOrg, importOrg } from "./org-move.js";

async function main(argv: string[]): Promise<number> {
  const [cmd, a, b] = argv;
  const base = process.env.STICKS_DATABASE_URL?.trim();
  if (!base) throw new Error("STICKS_DATABASE_URL is required");
  const dir = process.env.STICKS_SECRETS_DIR ?? SECRETS_DIR;
  const pool = createPool(databaseUrlWithPassword(base, readSecret("db_password", dir)), { poolMax: 1 });
  const client = await pool.connect();
  const query = async (text: string, values: unknown[] = []) => (await client.query(text, values)).rows as unknown[];
  try {
    if (cmd === "export" && a && b) {
      let org = a;
      if (a === "--only-org") {
        const orgs = (await query(`SELECT id FROM organization`)) as Array<{ id: string }>;
        if (orgs.length !== 1) throw new Error(`--only-org needs exactly one organization; found ${orgs.length}`);
        org = orgs[0]!.id;
      }
      const data = await exportOrg(query, org);
      writeFileSync(b, JSON.stringify(data), { mode: 0o600 });
      console.log(JSON.stringify({ exported: Object.fromEntries(Object.entries(data.tables).map(([t, r]) => [t, r.length])) }));
      return 0;
    }
    if (cmd === "import" && a) {
      await query("BEGIN");
      try {
        const counts = await importOrg(query, JSON.parse(readFileSync(a, "utf8")));
        await query("COMMIT");
        console.log(JSON.stringify({ imported: counts }));
        return 0;
      } catch (error) {
        await query("ROLLBACK");
        throw error;
      }
    }
    console.error("usage: sticks-org export <organizationId> <file.json> | import <file.json>");
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
