// The sandbox helper's rules (spec 4.6, 8.1; brief task 15), kept apart from the process so they can be
// tested directly. Nothing here reads the helper's own environment.
import { isAbsolute, join, relative, resolve, sep } from "node:path";

/** Commands see these variables and no others. Never the helper's or the engine's environment. */
export const SANDBOX_PATH = "/usr/local/bin:/usr/bin:/bin";
export const SANDBOX_LANG = "C.UTF-8";

/** The only environment a sandboxed command gets: PATH, HOME (its Stick's folder) and LANG. */
export function minimalEnv(home: string): Record<string, string> {
  return { PATH: SANDBOX_PATH, HOME: home, LANG: SANDBOX_LANG };
}

const STICK_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** A Stick's folder, under the root: /data/home/sticks/<stick id>. Refuses any id that is not a plain name. */
export function stickHome(root: string, stickId: string): string {
  if (!STICK_ID.test(stickId)) throw new Error("bad stick id");
  return join(root, stickId);
}

/**
 * A path inside a Stick's folder. Refuses absolute paths and any path that climbs out of the folder
 * (`..`). Symlinks are checked by the caller with realpath where the file exists.
 */
export function insideHome(home: string, requested: string): string {
  if (typeof requested !== "string" || requested === "" || isAbsolute(requested)) {
    throw new Error("path must be relative to the Stick's folder");
  }
  const target = resolve(home, requested);
  const rel = relative(home, target);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel) || rel.split(sep).includes("..")) {
    throw new Error("path leaves the Stick's folder");
  }
  return target;
}

/** Output a command may return: the first `limit` bytes, and whether more was cut. */
export function capOutput(text: string, limit = 256 * 1024): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, "utf8") <= limit) return { text, truncated: false };
  return { text: Buffer.from(text, "utf8").subarray(0, limit).toString("utf8"), truncated: true };
}

/** Hard limits for one command. Per-process: a wall clock and an output cap. The cgroup caps need delegation. */
export const COMMAND_LIMITS = {
  timeoutMs: 60_000,
  maxTimeoutMs: 10 * 60_000,
  outputBytes: 256 * 1024,
  fileBytes: 1024 * 1024,
} as const;
