import { describe, expect, it } from "vitest";
import { forwardVoice, voiceProxyToken } from "./voice-proxy.js";

const secret = "s3cret";
const auth = { authorization: `Bearer ${voiceProxyToken(secret)}` };

function deps(reserve: { ok: boolean; block_micros?: number; reason?: string } = { ok: true, block_micros: 100_000 }) {
  const calls: string[] = [];
  const sent: Array<[string, RequestInit]> = [];
  return {
    calls,
    sent,
    d: {
      gatewayUrl: "https://gw.example",
      gatewayKey: "gk",
      engineSecret: secret,
      credits: { call: async (p: string) => (calls.push(p), p === "/credits/reserve" ? reserve : { ok: true }) },
      fetch: (async (u: string, i: RequestInit) => (sent.push([u, i]), new Response("audio"))) as unknown as typeof fetch,
    },
  };
}

describe("voice proxy", () => {
  it("forwards speech with the gateway key and charges credits", async () => {
    const t = deps();
    const r = await forwardVoice(t.d, "audio/speech", new Request("http://e/x", { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: "{}" }));
    expect(await r.text()).toBe("audio");
    expect(t.sent[0]![0]).toBe("https://gw.example/openai/v1/audio/speech");
    expect(new Headers(t.sent[0]![1].headers).get("authorization")).toBe("Bearer gk");
    expect(t.calls).toEqual(["/credits/reserve", "/credits/settle"]);
  });

  it("refuses a wrong token, an unknown path, and no credits with friendly words", async () => {
    const t = deps({ ok: false, reason: "platform balance 0" });
    expect((await forwardVoice(t.d, "audio/speech", new Request("http://e/x", { method: "POST" }))).status).toBe(401);
    expect((await forwardVoice(t.d, "chat/completions", new Request("http://e/x", { headers: auth }))).status).toBe(404);
    const r = await forwardVoice(t.d, "audio/speech", new Request("http://e/x", { method: "POST", headers: auth, body: "{}" }));
    expect(r.status).toBe(402);
    expect(JSON.stringify(await r.json())).not.toContain("balance");
  });

  it("lists models without charging", async () => {
    const t = deps();
    await forwardVoice(t.d, "models", new Request("http://e/x", { headers: auth }));
    expect(t.calls).toEqual([]);
  });
});
