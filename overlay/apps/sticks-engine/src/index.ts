// The engine's process entry: one Node process, one HTTP listener, no worker process (spec 4.2).
import { loadEnv } from "../../api/src/env.js";
import { startEngine } from "./engine.js";
import { serveFetch } from "./serve.js";
import { readSecret, SECRETS_DIR } from "./config.js";
import { pulsarFront } from "./pulsar-front.js";
import { publicKeyFromRawBase64, senderFromTenantSite } from "./pulsar-token.js";

// startEngine sets the variables loadEnv requires (DATABASE_URL, ENCRYPTION_KEY), so it runs first.
const handles = await startEngine();
const env = loadEnv(process.env);
// Sign-in is by Pulsar token only (brief task 9): the front door closes upstream's other sign-in routes.
const tenant = process.env.STICKS_TENANT?.trim();
if (!tenant) throw new Error("STICKS_TENANT is required");
const secretsDir = process.env.STICKS_SECRETS_DIR ?? SECRETS_DIR;
const front = pulsarFront(handles.app, {
  query: (sql, values = []) => handles.prisma.$queryRawUnsafe<unknown[]>(sql, ...values),
  authSecret: env.authSecret,
  publicKey: () => {
    try {
      return publicKeyFromRawBase64(readSecret("pulsar_public_key", secretsDir));
    } catch {
      return undefined;
    }
  },
  sender: senderFromTenantSite(process.env.STICKS_TENANT_SITE ?? ""),
  tenant,
});
const server = serveFetch(front, env.port, env.apiHost);
console.log(JSON.stringify({ msg: "sticks engine listening", port: env.port, host: env.apiHost }));

let stopping = false;
async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  // Stop taking new requests, then let upstream finish or hand back its work and close connections.
  server.close();
  await handles.stop();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
