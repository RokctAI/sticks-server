// The sandbox helper's process entry (run as user `sticks`; brief task 15). Reads two paths from its own
// environment and passes nothing on: commands get only policy.minimalEnv.
import { startHelper } from "./helper.js";

const root = process.env.SANDBOX_HOME_ROOT ?? "/data/home/sticks";
const socketPath = process.env.SANDBOX_SOCKET ?? "/run/sticks/sandbox.sock";

const server = await startHelper({ root, socketPath });
console.log(JSON.stringify({ msg: "sandbox helper listening", socket: socketPath, root }));

const stop = () => server.close(() => process.exit(0));
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
