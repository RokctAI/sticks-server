import { mkdtemp, readFile, readdir, rm, symlink, writeFile, mkdir, stat } from "node:fs/promises";
import { createServer as createTcpServer, type AddressInfo } from "node:net";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withRunBrowser, browserProfileDir } from "./browser.js";
import { handleRequest, startHelper } from "./helper.js";
import { COMMAND_LIMITS, capOutput, insideHome, minimalEnv, stickHome } from "./policy.js";
import { probe, runSelftest, selftestTargets } from "./selftest.js";

const POSIX = process.platform !== "win32";

describe("sandbox policy (brief task 15)", () => {
  it("a command gets only PATH, HOME and LANG", () => {
    expect(Object.keys(minimalEnv("/data/home/sticks/abc")).sort()).toEqual(["HOME", "LANG", "PATH"]);
  });

  it("a Stick's folder is under the root, and an id that is not a plain name is refused", () => {
    expect(stickHome("/data/home/sticks", "stick_01-a")).toBe("/data/home/sticks/stick_01-a");
    expect(() => stickHome("/data/home/sticks", "../other")).toThrow("bad stick id");
    expect(() => stickHome("/data/home/sticks", "a/b")).toThrow("bad stick id");
  });

  it("a path must be relative and must not leave the Stick's folder", () => {
    expect(insideHome("/h", "notes/a.txt")).toBe("/h/notes/a.txt");
    expect(() => insideHome("/h", "/etc/passwd")).toThrow("relative");
    expect(() => insideHome("/h", "../x")).toThrow("leaves");
    expect(() => insideHome("/h", "a/../../x")).toThrow("leaves");
    expect(() => insideHome("/h", "")).toThrow("relative");
  });

  it("output is capped and says so", () => {
    const big = "x".repeat(COMMAND_LIMITS.outputBytes + 10);
    const capped = capOutput(big);
    expect(capped.truncated).toBe(true);
    expect(Buffer.byteLength(capped.text, "utf8")).toBe(COMMAND_LIMITS.outputBytes);
    expect(capOutput("small").truncated).toBe(false);
  });

  it("the helper never loads code from a Stick's home (no import or require of anything)", async () => {
    const source = await readFile(new URL("./helper.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/\bimport\s*\(|\brequire\s*\(/);
  });
});

describe.skipIf(!POSIX)("commands and files, run in a Stick's folder (POSIX)", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "sticks-sandbox-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    delete process.env.ENCRYPTION_KEY;
  });

  it("a sandboxed command cannot see the engine's ENCRYPTION_KEY or any other variable", async () => {
    process.env.ENCRYPTION_KEY = "engine-secret-value-that-must-not-leak";
    process.env.STICKS_TEST_TOKEN = "control-token-value";
    const reply = await handleRequest(root, { id: "1", op: "exec", stickId: "s1", command: "env" });
    expect(reply.ok).toBe(true);
    const out = (reply as { result: { stdout: string } }).result.stdout;
    expect(out).not.toContain("ENCRYPTION_KEY");
    expect(out).not.toContain("engine-secret-value");
    expect(out).not.toContain("STICKS_TEST_TOKEN");
    expect(out).not.toContain("control-token-value");
    expect(out).toContain(`HOME=${stickHome(root, "s1")}`);
  });

  it("a command runs in the Stick's own folder", async () => {
    const reply = await handleRequest(root, { id: "2", op: "exec", stickId: "s2", command: "pwd" });
    expect((reply as { result: { stdout: string } }).result.stdout.trim()).toBe(stickHome(root, "s2"));
  });

  it("a command that runs past its time limit is killed", async () => {
    const started = Date.now();
    const reply = await handleRequest(root, { id: "3", op: "exec", stickId: "s3", command: "sleep 30", timeoutMs: 300 });
    expect(Date.now() - started).toBeLessThan(10_000);
    const result = (reply as { result: { code: number | null } }).result;
    expect(result.code).not.toBe(0);
  });

  it("files read, write and list inside the folder; a write outside is refused", async () => {
    const write = await handleRequest(root, { id: "4", op: "write", stickId: "s4", path: "notes/a.txt", content: "hello" });
    expect(write.ok).toBe(true);
    const read = await handleRequest(root, { id: "5", op: "read", stickId: "s4", path: "notes/a.txt" });
    expect((read as { result: { content: string } }).result.content).toBe("hello");
    const list = await handleRequest(root, { id: "6", op: "list", stickId: "s4", path: "notes" });
    expect((list as { result: { entries: { name: string }[] } }).result.entries.map((e) => e.name)).toEqual(["a.txt"]);
    const escape = await handleRequest(root, { id: "7", op: "write", stickId: "s4", path: "../../evil.txt", content: "x" });
    expect(escape.ok).toBe(false);
  });

  it("a symlink inside the folder that points outside it is refused on read", async () => {
    const outside = await mkdtemp(join(tmpdir(), "sticks-outside-"));
    try {
      await writeFile(join(outside, "secret.txt"), "not yours");
      const home = stickHome(root, "s5");
      await mkdir(home, { recursive: true });
      await symlink(join(outside, "secret.txt"), join(home, "link.txt"));
      const reply = await handleRequest(root, { id: "8", op: "read", stickId: "s5", path: "link.txt" });
      expect(reply.ok).toBe(false);
      expect((reply as { error: string }).error).toContain("leaves");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("a bad stick id gets an error reply, not a crash", async () => {
    const reply = await handleRequest(root, { id: "9", op: "exec", stickId: "../x", command: "echo hi" });
    expect(reply.ok).toBe(false);
  });

  it("the socket is 0600 and answers one JSON line per request", async () => {
    const socketPath = join(root, "run", "helper.sock");
    const server = await startHelper({ root: join(root, "home"), socketPath });
    try {
      const info = await stat(socketPath);
      expect(info.mode & 0o777).toBe(0o600);
      const reply = await new Promise<string>((resolve, reject) => {
        const client = createConnection(socketPath);
        let text = "";
        client.on("data", (chunk) => {
          text += chunk.toString();
          if (text.includes("\n")) {
            client.end();
            resolve(text.split("\n")[0] ?? "");
          }
        });
        client.on("error", reject);
        client.write(`${JSON.stringify({ id: "a", op: "list", stickId: "s6" })}\n`);
      });
      expect(JSON.parse(reply)).toMatchObject({ id: "a", ok: true });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("the browser for one run (brief task 15)", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "sticks-browser-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("does not start when browser use is off", async () => {
    let launched = 0;
    const result = await withRunBrowser({
      root,
      stickId: "b1",
      browserAllowed: false,
      launch: async () => {
        launched += 1;
        return { close: async () => undefined };
      },
      work: async () => "done",
    });
    expect(result).toBe("done");
    expect(launched).toBe(0);
  });

  it("starts with the Stick's own profile folder and stops when the run ends, even if the run fails", async () => {
    const seen: string[] = [];
    let closed = 0;
    await expect(
      withRunBrowser({
        root,
        stickId: "b2",
        browserAllowed: true,
        launch: async (profile) => {
          seen.push(profile);
          return {
            close: async () => {
              closed += 1;
            },
          };
        },
        work: async () => {
          throw new Error("the run failed");
        },
      }),
    ).rejects.toThrow("the run failed");
    expect(seen).toEqual([browserProfileDir(root, "b2")]);
    expect(seen[0]?.endsWith(".browser")).toBe(true);
    expect(closed).toBe(1);
  });
});

describe.skipIf(!POSIX)("review defects in #35 (POSIX)", () => {
  let root: string;
  let outside: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "sticks-review-"));
    outside = await mkdtemp(join(tmpdir(), "sticks-review-outside-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it("(a) write refuses a symlink target and leaves the file it points to untouched", async () => {
    await writeFile(join(outside, "target.txt"), "original");
    const home = stickHome(root, "d1");
    await mkdir(home, { recursive: true });
    await symlink(join(outside, "target.txt"), join(home, "link.txt"));
    const reply = await handleRequest(root, { id: "a1", op: "write", stickId: "d1", path: "link.txt", content: "pwned" });
    expect(reply.ok).toBe(false);
    expect((reply as { error: string }).error).toContain("symlink");
    expect(await readFile(join(outside, "target.txt"), "utf8")).toBe("original");
  });

  it("(b) list refuses a folder that is a symlink to outside the home", async () => {
    const home = stickHome(root, "d2");
    await mkdir(home, { recursive: true });
    await symlink(outside, join(home, "dirlink"));
    const reply = await handleRequest(root, { id: "b1", op: "list", stickId: "d2", path: "dirlink" });
    expect(reply.ok).toBe(false);
    expect((reply as { error: string }).error).toContain("leaves");
  });

  it("(c) write checks the nearest existing folder before creating anything under it", async () => {
    const home = stickHome(root, "d3");
    await mkdir(home, { recursive: true });
    await symlink(outside, join(home, "linkdir"));
    const reply = await handleRequest(root, { id: "c1", op: "write", stickId: "d3", path: "linkdir/sub/x.txt", content: "x" });
    expect(reply.ok).toBe(false);
    expect(await readdir(outside)).toEqual([]);
  });

  it("(d) a timed-out command answers after the grace period, with timedOut set, even when a setsid job holds the pipes", async () => {
    const started = Date.now();
    const reply = await handleRequest(root, {
      id: "d1",
      op: "exec",
      stickId: "d4",
      command: "setsid sleep 6 & echo started",
      timeoutMs: 300,
    });
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(reply.ok).toBe(true);
    expect((reply as { result: { timedOut: boolean } }).result.timedOut).toBe(true);
  });
});

describe("the self-test (brief task 15)", () => {
  it("names the addresses it must not reach, including the private ranges and metadata", () => {
    const labels = selftestTargets({ postgresHost: "10.9.9.9", postgresPort: 5432, ownAddress: "10.1.1.1" }).map(
      (t) => t.label,
    );
    expect(labels).toEqual(expect.arrayContaining(["loopback", "the Postgres address", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"]));
    expect(labels.some((label) => label.includes("169.254.169.254"))).toBe(true);
  });

  it("exits 1 if any connection succeeds, 0 if none does", async () => {
    const targets = selftestTargets({ postgresHost: "10.9.9.9", postgresPort: 5432, ownAddress: "10.1.1.1" });
    const none = await runSelftest(targets, async () => false);
    expect(none.exitCode).toBe(0);
    const one = await runSelftest(targets, async (target) => target.label === "loopback");
    expect(one.exitCode).toBe(1);
    expect(one.reached.map((t) => t.label)).toEqual(["loopback"]);
  });

  it("a real probe reports an open port as reachable and a closed one as not", async () => {
    const server = createTcpServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const { port } = server.address() as AddressInfo;
    try {
      expect(await probe({ label: "open", host: "127.0.0.1", port })).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    expect(await probe({ label: "closed", host: "127.0.0.1", port })).toBe(false);
  });
});

describe("hidden files (Ray, 2026-11-28)", () => {
  it("blocks dot-files and dot-folders, allows a short read-only list", async () => {
    const { hiddenStatus, assertNotHidden, commandTouchesSecrets, safeHiddenRead } = await import("./policy.js");
    expect(hiddenStatus("notes/a.txt")).toBe("visible");
    expect(hiddenStatus(".env")).toBe("blocked");
    expect(hiddenStatus("app/.git/config")).toBe("blocked");
    expect(hiddenStatus(".ssh/id_rsa")).toBe("blocked");
    expect(hiddenStatus(".gitignore")).toBe("allowed");
    expect(hiddenStatus("app/.gitignore")).toBe("allowed");
    expect(hiddenStatus(".git/.gitignore")).toBe("blocked");
    expect(() => assertNotHidden(".gitignore", "write")).toThrow("read-only");
    expect(() => assertNotHidden(".env", "read")).toThrow("hidden");
    expect(commandTouchesSecrets("cat .env")).toBe(true);
    expect(commandTouchesSecrets("cp -r ~/.ssh out")).toBe(true);
    expect(commandTouchesSecrets("cat .env.example")).toBe(false);
    expect(commandTouchesSecrets("ls notes")).toBe(false);
    const read = safeHiddenRead(".gitignore", Buffer.from("node_modules​\n"));
    expect(read).toContain("<untrusted_file name=\".gitignore\">");
    expect(read).not.toContain("​");
    expect(() => safeHiddenRead(".gitignore", Buffer.alloc(70 * 1024))).toThrow("too large");
  });

  it("list hides dot entries and read refuses them", async () => {
    if (!POSIX) return;
    const root = await mkdtemp(join(tmpdir(), "sticks-hidden-"));
    const home = join(root, "s1");
    await mkdir(home, { recursive: true });
    await writeFile(join(home, ".env"), "SECRET=1");
    await writeFile(join(home, ".gitignore"), "dist");
    await writeFile(join(home, "a.txt"), "hi");
    const listed = await handleRequest(root, { id: "1", op: "list", stickId: "s1" } as never);
    const names = (listed as { result: { entries: { name: string }[] } }).result.entries.map((e) => e.name).sort();
    expect(names).toEqual([".gitignore", "a.txt"]);
    const env = await handleRequest(root, { id: "2", op: "read", stickId: "s1", path: ".env" } as never);
    expect(env.ok).toBe(false);
    const exec = await handleRequest(root, { id: "3", op: "exec", stickId: "s1", command: "cat .env" } as never);
    expect(exec.ok).toBe(false);
    await rm(root, { recursive: true, force: true });
  });
});
