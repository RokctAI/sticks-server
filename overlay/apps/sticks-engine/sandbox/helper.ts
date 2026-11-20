// The sandbox helper (spec 4.6, 8.1; brief task 15). A small process that runs as user `sticks`. The
// engine sends it commands and file operations over a unix socket; it runs them inside a Stick's own
// folder, /data/home/sticks/<stick id>, with a minimal environment.
//
// Protocol: one JSON request per line, one JSON reply per line, matched by `id`.
// Upstream's 0.9.0 fixes this keeps: it never loads code from a Stick's home (it has no import or require
// of anything there), and it never passes on a control token (commands get only policy.minimalEnv).
import { spawn, type ChildProcess } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, readFile, realpath, stat, unlink } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { dirname, join, sep } from "node:path";
import { COMMAND_LIMITS, capOutput, insideHome, minimalEnv, stickHome } from "./policy.js";

export type SandboxRequest =
  | { id: string; op: "exec"; stickId: string; command: string; timeoutMs?: number }
  | { id: string; op: "read"; stickId: string; path: string }
  | { id: string; op: "write"; stickId: string; path: string; content: string }
  /** Binary-safe: the file's bytes, base64 encoded. */
  | { id: string; op: "readBytes"; stickId: string; path: string }
  | { id: string; op: "writeBytes"; stickId: string; path: string; base64: string }
  | { id: string; op: "list"; stickId: string; path?: string };

export type SandboxReply = { id: string; ok: true; result: unknown } | { id: string; ok: false; error: string };

export type CommandResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  /** True when the time limit ended the command. Its output is what was read by then. */
  timedOut: boolean;
};

const MAX_COMMAND_CHARS = 10_000;
/** After a kill, the reply goes out after this long even if a background job still holds the pipes. */
export const KILL_GRACE_MS = 200;

function killGroup(child: ChildProcess): void {
  try {
    if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

/**
 * Runs one shell command in the Stick's folder with the minimal environment, under a wall-clock limit.
 * On timeout the command's process group is killed, and the reply goes out after KILL_GRACE_MS without
 * waiting for the pipes to close: a `setsid` background job leaves its own session and keeps them open.
 */
function runCommand(home: string, command: string, timeoutMs: number) {
  return new Promise<CommandResult>((resolve, reject) => {
    // detached: the shell leads its own process group, so a timeout can kill every process it started.
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
    child.stdout?.on("data", collect(out));
    child.stderr?.on("data", collect(err));

    let settled = false;
    let timedOut = false;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const stdout = capOutput(Buffer.concat(out).toString("utf8"));
      const stderr = capOutput(Buffer.concat(err).toString("utf8"));
      resolve({
        code,
        stdout: stdout.text,
        stderr: stderr.text,
        truncated: stdout.truncated || stderr.truncated,
        timedOut,
      });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child);
      setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(null);
      }, KILL_GRACE_MS);
    }, timeoutMs);

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => finish(code));
  });
}

/** True when a real (symlink-free) path lies inside the real home folder. */
function isInside(realHome: string, real: string): boolean {
  return real === realHome || real.startsWith(realHome + sep);
}

/** True when `path` (which exists) resolves inside `home`, after symlinks. */
async function resolvesInside(home: string, path: string): Promise<boolean> {
  const realHome = await realpath(home);
  const real = await realpath(path);
  return isInside(realHome, real);
}

/**
 * The deepest ancestor of `path` that exists (possibly `path` itself). Every folder between it and
 * `path` is still to be created, so only this one can already point somewhere else.
 */
async function deepestExisting(path: string): Promise<string> {
  let current = path;
  for (;;) {
    try {
      await lstat(current);
      return current;
    } catch {
      const parent = dirname(current);
      if (parent === current) return current;
      current = parent;
    }
  }
}

/** Refuses a write whose existing ancestors point outside the home, checked before anything is created. */
async function assertAncestorsInside(home: string, folder: string): Promise<void> {
  const existing = await deepestExisting(folder);
  const realHome = await realpath(home);
  const real = await realpath(existing);
  if (!isInside(realHome, real)) throw new Error("path leaves the Stick's folder");
}

/** Runs one request. Every failure becomes an error reply; nothing is thrown to the socket. */
/** Reads a file inside the Stick's folder, with the limits and checks every read uses. */
async function readInside(home: string, requested: string): Promise<Buffer> {
  const target = insideHome(home, requested);
  const info = await stat(target);
  if (!info.isFile()) throw new Error("not a file");
  if (info.size > COMMAND_LIMITS.fileBytes) throw new Error("file is too large to read in one go");
  if (!(await resolvesInside(home, target))) throw new Error("path leaves the Stick's folder");
  return readFile(target);
}

/** Writes a file inside the Stick's folder. Refuses symlinks and any path that leaves the folder. */
async function writeInside(home: string, requested: string, data: Buffer): Promise<void> {
  const target = insideHome(home, requested);
  if (data.byteLength > COMMAND_LIMITS.fileBytes) throw new Error("content is too large");
  // Before anything is created: the nearest existing folder must resolve inside the home.
  await assertAncestorsInside(home, dirname(target));
  await mkdir(dirname(target), { recursive: true });
  // The target itself must not be a symlink. O_NOFOLLOW makes the open fail on one, race-free.
  const existingTarget = await lstat(target).catch(() => null);
  if (existingTarget?.isSymbolicLink()) throw new Error("refuses to write through a symlink");
  const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW;
  const handle = await open(target, flags, 0o600).catch((error: NodeJS.ErrnoException) => {
    throw new Error(error.code === "ELOOP" ? "refuses to write through a symlink" : error.message);
  });
  try {
    await handle.writeFile(data);
  } finally {
    await handle.close();
  }
}

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
        const bytes = await readInside(home, request.path);
        return { id: request.id, ok: true, result: { content: bytes.toString("utf8") } };
      }
      case "readBytes": {
        const bytes = await readInside(home, request.path);
        return { id: request.id, ok: true, result: { base64: bytes.toString("base64") } };
      }
      case "write": {
        await writeInside(home, request.path, Buffer.from(request.content, "utf8"));
        return { id: request.id, ok: true, result: { bytes: Buffer.byteLength(request.content, "utf8") } };
      }
      case "writeBytes": {
        const data = Buffer.from(request.base64, "base64");
        await writeInside(home, request.path, data);
        return { id: request.id, ok: true, result: { bytes: data.byteLength } };
      }
      case "list": {
        const target = request.path ? insideHome(home, request.path) : home;
        if (!(await resolvesInside(home, target))) throw new Error("path leaves the Stick's folder");
        const entries = await readdir(target, { withFileTypes: true });
        const listed = await Promise.all(
          entries.map(async (entry) => {
            // lstat: a link is reported as a link, not as the size of what it points at.
            const info = await lstat(join(target, entry.name)).catch(() => null);
            return { name: entry.name, dir: entry.isDirectory(), size: info?.isFile() ? info.size : 0 };
          }),
        );
        return { id: request.id, ok: true, result: { entries: listed } };
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
 * Listens on a unix socket. Owner only: the socket is created with umask 0177, so it is 0600 from the
 * start, and chmod 0600 is applied after. Only the helper's own user can open it; the runner makes the
 * engine's user the owner (spec 8.1).
 */
export async function startHelper(options: { root: string; socketPath: string }): Promise<Server> {
  await mkdir(dirname(options.socketPath), { recursive: true });
  await unlink(options.socketPath).catch(() => undefined);
  const server = createServer((socket) => serveConnection(options.root, socket));
  const previousUmask = process.umask(0o177);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.socketPath, () => resolve());
    });
  } finally {
    process.umask(previousUmask);
  }
  await chmod(options.socketPath, 0o600);
  return server;
}
