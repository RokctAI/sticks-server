// The engine's process entry: one Node process, one HTTP listener, no worker process (spec 4.2).
import { loadEnv } from "../../api/src/env.js";
import { startEngine } from "./engine.js";
import { serveFetch } from "./serve.js";

// startEngine sets the variables loadEnv requires (DATABASE_URL, ENCRYPTION_KEY), so it runs first.
const handles = await startEngine();
const env = loadEnv(process.env);
const server = serveFetch(handles.app, env.port, env.apiHost);
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
