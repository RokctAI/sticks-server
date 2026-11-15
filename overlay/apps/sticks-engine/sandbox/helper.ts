// The sandbox helper (spec 4.6, 8.1; brief task 15). A small process that runs as user `sticks`. The
// engine sends it commands and file operations over a unix socket; it runs them inside a Stick's own
// folder, /data/home/sticks/<stick id>, with a minimal environment.
//
// Protocol: one JSON request per line, one JSON reply per line, matched by `id`.
// Upstream's 0.9.0 fixes this keeps: it never loads code from a Stick's home (it has no import or require
// of anything there), and it never passes on a control token (commands get only policy.minimalEnv).
import { spawn } from "node:child_process";
import { chmod, mkdir, readdir, readFile, realpath, stat, unlink, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { dirname, sep } from "node:path";
import { COMMAND_LIMITS, capOutput, insideHome, minimalEnv, stickHome } from "./policy.js";

export type SandboxRequest =
  | { id: string; op: "exec"; stickId: string; command: string; timeoutMs?: number }
  | { id: string; op: "read"; stickId: string; path: string }
  | { id: string; op: "write"; stickId: string; path: string; content: string }
  | { id: string; op: "list"; stickId: string; path?: string };

export type SandboxReply = { id: string; ok: true; result: unknown } | { id: string; ok: false; error: string };

const MAX_COMMAND_CHARS = 10_000;

/** Runs one shell command in the Stick's folder with the minimal environment, under a wall-clock limit. */
function runCommand(home: string, command: string, timeoutMs: number) {
  return new Promise<{ code: number | null; stdout: string; stderr: string; truncated: boolean }>((resolve, reject) => {
    // detached: the shell becomes the leader of its own process group, so a timeout can kill every
    // process the command started (a `sleep` inside the shell holds the output pipe open otherwise).
    const child = spawn("/bin/sh", ["-c", command], {
      cwd: home,
      env: minimalEnv(home),
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let total = 0;
    const collect = (into: Buffer[]) => (chunk: Buffer) => {
      total += chunk.length;
      if (total <= COMMAND_LIMITS.outputBytes * 2) into.push(chunk);
    };
    child.stdout.on("data", collect(out));
    child.stderr.on("data", collect(err));
    const timer = setTimeout(() => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const stdout = capOutput(Buffer.concat(out).toString("utf8"));
      const stderr = capOutput(Buffer.concat(err).toString("utf8"));
      resolve({ code, stdout: stdout.text, stderr: stderr.text, truncated: stdout.truncated || stderr.truncated });
    });
  });
}

/** True when `path` (which exists) resolves inside `home`, after symlinks. */
async function resolvesInside(home: string, path: string): Promise<boolean> {
  const realHome = await realpath(home);
  const real = await realpath(path);
  return real === realHome || real.startsWith(realHome + sep);
}

/** Runs one request. Every failure becomes an error reply; nothing is thrown to the socket. */
export async function handleRequest(root: string, request: SandboxRequest): Promise<SandboxReply> {
  try {
    const home = stickHome(root, request.stickId);
    await mkdir(home, { recursive: true });
    switch (request.op) {
      case "exec": {
        if (typeof request.command !== "string" || request.command.length === 0 || request.command.length > MAX_COMMAND_CHARS) {
          throw new Error("bad command");
        }
        const requested = request.timeoutMs ?? COMMAND_LIMITS.timeoutMs;
        const timeoutMs = Math.min(Math.max(requested, 1), COMMAND_LIMITS.maxTimeoutMs);
        return { id: request.id, ok: true, result: await runCommand(home, request.command, timeoutMs) };
      }
      case "read": {
        const target = insideHome(home, request.path);
        const info = await stat(target);
        if (!info.isFile()) throw new Error("not a file");
        if (info.size > COMMAND_LIMITS.fileBytes) throw new Error("file is too large to read in one go");
        if (!(await resolvesInside(home, target))) throw new Error("path leaves the Stick's folder");
        return { id: request.id, ok: true, result: { content: await readFile(target, "utf8") } };
      }
      case "write": {
        const target = insideHome(home, request.path);
        if (Buffer.byteLength(request.content, "utf8") > COMMAND_LIMITS.fileBytes) throw new Error("content is too large");
        await mkdir(dirname(target), { recursive: true });
        if (!(await resolvesInside(home, dirname(target)))) throw new Error("path leaves the Stick's folder");
        await writeFile(target, request.content, "utf8");
        return { id: request.id, ok: true, result: { bytes: Buffer.byteLength(request.content, "utf8") } };
      }
      case "list": {
        const target = request.path ? insideHome(home, request.path) : home;
        const entries = await readdir(target, { withFileTypes: true });
        return {
          id: request.id,
          ok: true,
          result: { entries: entries.map((entry) => ({ name: entry.name, dir: entry.isDirectory() })) },
        };
      }
      default:
        throw new Error("unknown operation");
    }
  } catch (error) {
    return { id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

const MAX_LINE_BYTES = 2 * 1024 * 1024;

function serveConnection(root: string, socket: Socket) {
  let pending = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    pending += chunk;
    if (pending.length > MAX_LINE_BYTES) {
      socket.destroy();
      return;
    }
    let newline = pending.indexOf("\n");
    while (newline >= 0) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      newline = pending.indexOf("\n");
      void (async () => {
        let reply: SandboxReply;
        try {
          const request = JSON.parse(line) as SandboxRequest;
          reply = await handleRequest(root, request);
        } catch {
          reply = { id: "", ok: false, error: "malformed request" };
        }
        if (!socket.destroyed) socket.write(`${JSON.stringify(reply)}\n`);
      })();
    }
  });
  socket.on("error", () => socket.destroy());
}

/**
 * Listens on a unix socket. The socket file is 0600, so only the helper's own user can open it; the
 * runner makes the engine's user the owner or puts both in one group (spec 8.1, see the PR).
 */
export async function startHelper(options: { root: string; socketPath: string }): Promise<Server> {
  await mkdir(dirname(options.socketPath), { recursive: true });
  await unlink(options.socketPath).catch(() => undefined);
  const server = createServer((socket) => serveConnection(options.root, socket));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.socketPath, () => resolve());
  });
  await chmod(options.socketPath, 0o600);
  return server;
}
