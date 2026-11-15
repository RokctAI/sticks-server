import { once } from "node:events";
import { request as httpRequest, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createClientIpResolver } from "../../api/src/client-ip.js";
import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import { type NodeEnv, serveFetch, waitForDrain } from "./serve.js";

describe("waitForDrain (5b review fix)", () => {
  it("returns at once when the response is already destroyed (no 'close' will fire again)", async () => {
    const res = Object.assign(new EventEmitter(), { destroyed: true, writableEnded: false });
    await expect(waitForDrain(res as unknown as ServerResponse)).resolves.toBeUndefined();
  });

  it("returns at once when the response has already ended", async () => {
    const res = Object.assign(new EventEmitter(), { destroyed: false, writableEnded: true });
    await expect(waitForDrain(res as unknown as ServerResponse)).resolves.toBeUndefined();
  });

  it("waits for drain on a live response, and resolves on drain", async () => {
    const res = Object.assign(new EventEmitter(), { destroyed: false, writableEnded: false });
    let resolved = false;
    const waiting = waitForDrain(res as unknown as ServerResponse).then(() => {
      resolved = true;
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(resolved).toBe(false);
    res.emit("drain");
    await waiting;
    expect(resolved).toBe(true);
  });
});

const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.closeAllConnections?.();
  for (const server of servers.splice(0)) server.close();
});

async function listen(fetch: (request: Request, env: NodeEnv) => Response | Promise<Response>) {
  const server = serveFetch({ fetch }, 0, "127.0.0.1");
  servers.push(server);
  await once(server, "listening");
  return (server.address() as { port: number }).port;
}

/** A GET from a given local address; resolves with the response body text. */
function get(port: number, localAddress?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path: "/", localAddress }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve(Buffer.concat(chunks).toString()));
    });
    req.on("error", reject);
    req.end();
  });
}

async function waitFor(check: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("client abort", () => {
  it("cancels the app's stream and stops reading when the client disconnects mid-stream", async () => {
    let cancelled = false;
    let pulls = 0;
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(encoder.encode("chunk\n"));
        return new Promise((resolve) => setTimeout(resolve, 5));
      },
      cancel() {
        cancelled = true;
      },
    });
    const port = await listen(() => new Response(body));

    await new Promise<void>((resolve, reject) => {
      const req = httpRequest({ host: "127.0.0.1", port, path: "/" }, (res) => {
        res.once("data", () => {
          req.destroy();
          resolve();
        });
      });
      req.on("error", () => undefined); // the destroy above ends the request on purpose
      req.on("close", () => undefined);
      req.end();
      setTimeout(() => reject(new Error("no first chunk")), 5_000).unref();
    });

    await waitFor(() => cancelled, 5_000);
    const pullsAtCancel = pulls;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(cancelled).toBe(true);
    expect(pulls).toBe(pullsAtCancel); // no further reads after the cancel
  });
});

describe("client address reaches upstream's per-IP limits", () => {
  it("passes the socket to the app so the address is the caller's, not the proxy's", async () => {
    const port = await listen((_request, env) => new Response(env.incoming.socket.remoteAddress ?? ""));
    expect(await get(port, "127.0.0.1")).toBe("127.0.0.1");
    expect(await get(port, "127.0.0.2")).toBe("127.0.0.2");
  });

  it("gives two different callers two different limit keys (end to end, through upstream's resolver)", async () => {
    const resolve = createClientIpResolver({ trustedProxies: ["127.0.0.1"], header: "x-forwarded-for" });
    const port = await listen(async (_request, env) =>
      new Response((await resolve({ peer: env.incoming.socket.remoteAddress })) ?? "none"),
    );
    const first = await get(port, "127.0.0.1");
    const second = await get(port, "127.0.0.2");
    expect(first).not.toBe(second);
    expect([first, second].sort()).toEqual(["127.0.0.1", "127.0.0.2"]);
  });

  it("ignores X-Forwarded-For from a peer that is not a trusted proxy", async () => {
    const resolve = createClientIpResolver({ trustedProxies: ["10.0.0.1"], header: "x-forwarded-for" });
    expect(await resolve({ peer: "127.0.0.1", forwarded: "203.0.113.9" })).toBe("127.0.0.1");
    expect(await resolve({ peer: "10.0.0.1", forwarded: "203.0.113.9" })).toBe("203.0.113.9");
  });
});
