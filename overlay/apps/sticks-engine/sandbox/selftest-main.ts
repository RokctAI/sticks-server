// `sandbox-selftest` (brief task 15): run as user `sticks`. Exits 1 if any target is reachable, 0 if none is.
// It only checks. The runner installs the firewall rules (spec 8.1).
import { runSelftest, selftestTargets } from "./selftest.js";

const postgresHost = process.env.STICKS_POSTGRES_HOST ?? "127.0.0.1";
const postgresPort = Number(process.env.STICKS_POSTGRES_PORT ?? 5432);
const targets = selftestTargets({ postgresHost, postgresPort });

const result = await runSelftest(targets);
for (const target of result.reached) {
  console.error(`REACHABLE: ${target.label} (${target.host}:${target.port})`);
}
console.log(JSON.stringify({ checked: targets.length, reached: result.reached.length }));
process.exit(result.exitCode);
