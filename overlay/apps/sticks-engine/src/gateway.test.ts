import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  gatewayHeaders,
  gatewayUrlFor,
  providerKeysInEnv,
  readGatewayKey,
} from "./gateway.js";

const KEY = "gw-test-key-0001";

describe("gateway URLs and headers (spec 4.4, brief task 13)", () => {
  it("builds one base URL per provider, with no double slash", () => {
    expect(gatewayUrlFor("https://gateway.example/", "anthropic")).toBe("https://gateway.example/anthropic");
    expect(gatewayUrlFor("http://127.0.0.1:9000///", "openai")).toBe("http://127.0.0.1:9000/openai");
  });

  it("refuses a provider id that is not a plain name, and a non-http gateway", () => {
    expect(() => gatewayUrlFor("https://g", "../admin")).toThrow("not a provider id");
    expect(() => gatewayUrlFor("https://g", "Anthropic")).toThrow("not a provider id");
    expect(() => gatewayUrlFor("ftp://g", "anthropic")).toThrow("http(s)");
  });

  it("sends the gateway key in each provider's own header", () => {
    expect(gatewayHeaders("anthropic", KEY)).toEqual({ "x-api-key": KEY });
    expect(gatewayHeaders("openai", KEY)).toEqual({ authorization: `Bearer ${KEY}` });
  });

  it("refuses a provider with no settled header, and an empty key", () => {
    expect(() => gatewayHeaders("unknown-vendor", KEY)).toThrow("no auth header");
    expect(() => gatewayHeaders("openai", "")).toThrow("empty");
  });

  it("reads the gateway key from /run/secrets/gateway_key (a folder for tests)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sticks-gw-"));
    try {
      await writeFile(join(dir, "gateway_key"), `${KEY}\n`);
      expect(readGatewayKey(dir)).toBe(KEY);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("no provider key in the engine's environment (brief task 13)", () => {
  it("an unset or empty provider key does not count", () => {
    expect(providerKeysInEnv({ OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "   " })).toEqual([]);
  });

  it("a provider key set in the environment is named, so startup can refuse it", () => {
    expect(providerKeysInEnv({ OPENAI_API_KEY: "sk-real-looking", PATH: "/bin" })).toEqual(["OPENAI_API_KEY"]);
  });
});

/**
 * A small fake of the gateway (spec 4.4): a pass-through under one path per provider. It checks the
 * prefix and the gateway key in the provider's header, answers a canned reply, streams one, and
 * refuses a key it does not know (401) or a tenant over its ceiling (402).
 */
describe("against a fake gateway", () => {
  let server: Server;
  let base: string;
  let ceilingExceeded = false;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://gw");
      const path = url.pathname;
      const provider = path.split("/")[1];
      const expected = provider === "anthropic" ? req.headers["x-api-key"] : req.headers.authorization;
      const ok = provider === "anthropic" ? expected === KEY : expected === `Bearer ${KEY}`;
      if (!ok) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "bad_key" }));
        return;
      }
      if (ceilingExceeded) {
        res.writeHead(402, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "over_ceiling" }));
        return;
      }
      if (provider === "anthropic" && path === "/anthropic/v1/messages") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "message", content: [{ type: "text", text: "canned" }] }));
        return;
      }
      if (provider === "openai" && path === "/openai/v1/chat/completions") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write('data: {"choices":[{"delta":{"content":"he"}}]}\n\n');
        res.end("data: [DONE]\n\n");
        return;
      }
      res.writeHead(404);
      res.end();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as { port: number };
    base = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    server.close();
  });

  it("a messages call reaches the provider's prefix with the gateway key in its header", async () => {
    const response = await fetch(`${gatewayUrlFor(base, "anthropic")}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", ...gatewayHeaders("anthropic", KEY) },
      body: JSON.stringify({ model: "m", messages: [] }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ type: "message" });
  });

  it("a streamed chat call returns the provider's own stream", async () => {
    const response = await fetch(`${gatewayUrlFor(base, "openai")}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...gatewayHeaders("openai", KEY) },
      body: JSON.stringify({ model: "m", stream: true, messages: [] }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(await response.text()).toContain("[DONE]");
  });

  it("an unknown key is refused with 401", async () => {
    const response = await fetch(`${gatewayUrlFor(base, "anthropic")}/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": "not-a-key" },
      body: "{}",
    });
    expect(response.status).toBe(401);
  });

  it("a tenant over its ceiling is refused with 402", async () => {
    ceilingExceeded = true;
    try {
      const response = await fetch(`${gatewayUrlFor(base, "openai")}/v1/chat/completions`, {
        method: "POST",
        headers: gatewayHeaders("openai", KEY),
        body: "{}",
      });
      expect(response.status).toBe(402);
    } finally {
      ceilingExceeded = false;
    }
  });
});
