import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AdapterContext, CommandRequest, ComputerRef, ProcessEvent } from "../../../packages/adapter-kit/src/index.ts";
import { HelperComputerProvider, shellQuote } from "./helper-computer.js";
import { startHelper } from "../sandbox/helper.js";

let root: string;
let server: Server;
let socketPath: string;
let provider: HelperComputerProvider;

const computer = { id: "desktop-stick-1", botId: "stick-1", kind: "desktop", providerRef: "", fresh: false } as ComputerRef;
const context = { signal: new AbortController().signal, runId: "run-1" } as unknown as AdapterContext;

async function run(request: CommandRequest): Promise<ProcessEvent[]> {
  const events: ProcessEvent[] = [];
  for await (const event of provider.execute(computer, request, context)) events.push(event);
  return events;
}

const stdoutOf = (events: ProcessEvent[]) =>
  events.flatMap((event) => (event.type === "stdout" ? [event.data] : [])).join("");
const exitOf = (events: ProcessEvent[]) => events.find((event) => event.type === "exit");

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "sticks-helper-computer-"));
  socketPath = join(root, "sandbox.sock");
  server = await startHelper({ root: join(root, "home"), socketPath });
  provider = new HelperComputerProvider(socketPath);
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
});

describe("the in-container computer provider (brief task 16)", () => {
  it("reports no graphical display (inherited from the desktop provider)", () => {
    expect(provider.describe().capabilities.graphical).toBe(false);
  });

  it("runs a command through the helper and returns its output and exit code", async () => {
    const events = await run({ argv: ["echo", "hi"] } as CommandRequest);
    expect(stdoutOf(events)).toBe("hi\n");
    expect(exitOf(events)).toEqual({ type: "exit", code: 0 });
  });

  it("quotes each argument, so spaces and quotes reach the command unchanged", async () => {
    const events = await run({ argv: ["printf", "%s", "a b'c"] } as CommandRequest);
    expect(stdoutOf(events)).toBe("a b'c");
  });

  it("passes the command's exit code through", async () => {
    const events = await run({ argv: ["sh", "-c", "exit 3"] } as CommandRequest);
    expect(exitOf(events)).toEqual({ type: "exit", code: 3 });
  });

  it("the engine's secrets are not in the command's environment", async () => {
    process.env.ENCRYPTION_KEY = "must-not-leak";
    try {
      const events = await run({ argv: ["sh", "-c", 'echo "${ENCRYPTION_KEY:-unset}"'] } as CommandRequest);
      expect(stdoutOf(events)).toBe("unset\n");
    } finally {
      delete process.env.ENCRYPTION_KEY;
    }
  });

  it("a working directory is refused, not silently ignored", async () => {
    const events = await run({ argv: ["echo", "x"], cwd: "/etc" } as CommandRequest);
    expect(events[0]).toMatchObject({ type: "stderr" });
    expect(exitOf(events)).toEqual({ type: "exit", code: 1 });
  });

  it("an argument with a NUL byte is rejected before it reaches the helper", async () => {
    const events = await run({ argv: ["echo", "a\0b"] } as CommandRequest);
    expect(exitOf(events)).toEqual({ type: "exit", code: 1 });
  });

  it("the quoting helper produces a single shell word for any input", () => {
    expect(shellQuote("plain")).toBe("'plain'");
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });
});
