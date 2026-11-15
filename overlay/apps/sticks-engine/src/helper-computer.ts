// The in-container computer provider (spec 4.6, 11.1 "Docker computers"; brief task 16). It is built from the
// desktop provider, but every command goes to the sandbox helper (task 15) over the helper's unix socket. The
// helper runs it as user `sticks`, inside the Stick's own folder, with its minimal environment. No Docker
// socket and no supervisor are involved. It reports graphical: false (inherited).
import { createConnection } from "node:net";
import { DesktopSandboxProvider } from "../../../packages/adapters/src/desktop-sandbox.ts";
import type {
  AdapterContext,
  CommandRequest,
  ComputerRef,
  ProcessEvent,
} from "../../../packages/adapter-kit/src/index.ts";
import type { CommandResult, SandboxRequest } from "../sandbox/helper.js";

/** A request without its id: the client adds one. Distributes over the union. */
type Body<T> = T extends { id: string } ? Omit<T, "id"> : never;
export type SandboxBody = Body<SandboxRequest>;

let counter = 0;

/** Sends one request to the helper and resolves with its result. Rejects on an error reply or a timeout. */
export function sendToHelper(socketPath: string, body: SandboxBody, timeoutMs = 130_000): Promise<unknown> {
  const id = `${Date.now()}-${++counter}`;
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("the sandbox helper did not answer in time"));
    }, timeoutMs);
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify({ ...body, id })}\n`));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timer);
      socket.end();
      let reply: { id: string; ok: boolean; result?: unknown; error?: string };
      try {
        reply = JSON.parse(buffer.slice(0, newline)) as typeof reply;
      } catch {
        reject(new Error("the sandbox helper sent a reply that is not JSON"));
        return;
      }
      if (reply.id !== id) {
        reject(new Error("the sandbox helper's reply does not match the request"));
        return;
      }
      if (!reply.ok) {
        reject(new Error(reply.error ?? "the sandbox helper refused the request"));
        return;
      }
      resolve(reply.result);
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

/** POSIX single-quote form of one argument: safe for `sh -c`, whatever the argument holds. */
export function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

export class HelperComputerProvider extends DesktopSandboxProvider {
  constructor(
    private readonly socketPath: string,
    opts: { root?: string; hostRoots?: string[]; maxFileBytes?: number } = {},
  ) {
    super(opts);
  }

  override async *execute(
    computer: ComputerRef,
    request: CommandRequest,
    context: AdapterContext,
  ): AsyncIterable<ProcessEvent> {
    if (context.signal.aborted) {
      yield { type: "stderr", data: "command cancelled\n" };
      yield { type: "exit", code: 1 };
      return;
    }
    // The helper runs a command from the Stick's own folder; it takes no working directory.
    if (request.cwd && request.cwd !== "." && request.cwd !== "./") {
      yield { type: "stderr", data: "cwd is not supported by the sandbox helper; commands run from the computer's home\n" };
      yield { type: "exit", code: 1 };
      return;
    }
    if (request.argv.some((arg) => arg.includes("\0"))) {
      yield { type: "stderr", data: "command rejected\n" };
      yield { type: "exit", code: 1 };
      return;
    }
    const command = request.argv.length ? request.argv.map(shellQuote).join(" ") : "echo ready";
    let result: CommandResult;
    try {
      result = (await sendToHelper(this.socketPath, {
        op: "exec",
        stickId: computer.botId,
        command,
        timeoutMs: request.timeoutMs,
      })) as CommandResult;
    } catch (error) {
      yield { type: "stderr", data: `${error instanceof Error ? error.message : String(error)}\n` };
      yield { type: "exit", code: 1 };
      return;
    }
    if (result.stdout) yield { type: "stdout", data: result.stdout };
    if (result.stderr) yield { type: "stderr", data: result.stderr };
    if (result.timedOut) yield { type: "stderr", data: "command timed out\n" };
    yield { type: "exit", code: result.code ?? 1 };
  }
}
