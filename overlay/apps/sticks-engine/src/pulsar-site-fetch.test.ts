import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { fetchForSite } from "./pulsar-site-fetch.js";

async function withServer(fn: (base: string, seen: Array<{ host?: string; method?: string; body: string; auth?: string }>) => Promise<void>) {
  const seen: Array<{ host?: string; method?: string; body: string; auth?: string }> = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ host: req.headers.host, method: req.method, body, auth: req.headers.authorization });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen);
  } finally {
    server.close();
  }
}

describe("calls to one tenant's Pulsar site", () => {
  it("sends Host: <tenant site> while connecting to the docker's Pulsar address, with method, auth and body", async () => {
    await withServer(async (base, seen) => {
      const res = await fetchForSite("acme.example")(`${base}/api/method/api.sticks.create_account`, {
        method: "POST",
        headers: { authorization: "token abc", "content-type": "application/json" },
        body: JSON.stringify({ stick_id: "s1" }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(seen[0]).toEqual({ host: "acme.example", method: "POST", body: '{"stick_id":"s1"}', auth: "token abc" });
    });
  });
  it("a GET to another tenant's site carries that site", async () => {
    await withServer(async (base, seen) => {
      await fetchForSite("beta.example")(`${base}/api/resource/Customer?limit=1`, { method: "GET", headers: { authorization: "token b" } });
      expect(seen[0]!.host).toBe("beta.example");
    });
  });
  it("without a site (one tenant per engine) the URL's own host is used", async () => {
    await withServer(async (base, seen) => {
      await fetchForSite(undefined)(`${base}/x`, { method: "GET" });
      expect(seen[0]!.host).toBe(new URL(base).host);
    });
  });
});
