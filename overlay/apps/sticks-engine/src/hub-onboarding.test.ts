import { describe, expect, it } from "vitest";
import { draftFromOpenApi } from "./plugin-builder.js";
import { callHub, HUB_METHOD_PATH, OnboardingError, onboardingEnabled, onboardingPluginDocument, readOnboardingToken, saveOnboardingToken } from "./hub-onboarding.js";

const reply = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), { status });

describe("hub onboarding (control#204 engine side)", () => {
  it("is off unless asked, and needs a hub URL when on", () => {
    expect(onboardingEnabled({})).toBeUndefined();
    expect(onboardingEnabled({ STICKS_HUB_ONBOARDING: "1", STICKS_HUB_URL: "https://hub.example/", STICKS_ENGINE_URL: "https://t.example" })).toEqual({ hubUrl: "https://hub.example", engineUrl: "https://t.example" });
    expect(() => onboardingEnabled({ STICKS_HUB_ONBOARDING: "1", STICKS_HUB_URL: "https://h", STICKS_ENGINE_URL: "http://t" })).toThrow();
    expect(() => onboardingEnabled({ STICKS_HUB_ONBOARDING: "1" })).toThrow();
  });

  it("stores one token and reads it back", async () => {
    let stored: string | undefined;
    const query = async (sql: string, values: unknown[] = []) => {
      if (sql.startsWith("INSERT")) stored = values[0] as string;
      if (sql.startsWith("SELECT")) return stored ? [{ token: stored }] : [];
      return [];
    };
    expect(await readOnboardingToken(query)).toBeUndefined();
    await saveOnboardingToken(query, " tok ");
    expect(await readOnboardingToken(query)).toBe("tok");
    await expect(saveOnboardingToken(query, 5)).rejects.toThrow(OnboardingError);
  });

  it("sends the stored token, never the model's, and unwraps the reply", async () => {
    let sent: { url: string; body: any } | undefined;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      sent = { url, body: JSON.parse(init.body as string) };
      return new Response(JSON.stringify({ message: { saved: true } }), { status: 200 });
    }) as unknown as typeof fetch;
    const out = await callHub("https://hub.example", "real", "save-answer", { key: "name", answer: "Acme", session_token: "fake" }, fetchImpl);
    expect(out).toEqual({ saved: true });
    expect(sent?.url).toBe(`https://hub.example${HUB_METHOD_PATH}`);
    expect(sent?.body).toEqual({ cmd: "control:onboarding_save_answer", payload: { key: "name", answer: "Acme", session_token: "real" } });
  });

  it("turns hub refusals into plain errors", async () => {
    await expect(callHub("https://h", "t", "state", {}, reply(403, {}) as unknown as typeof fetch)).rejects.toMatchObject({ status: 403 });
    await expect(callHub("https://h", "t", "finish", {}, reply(417, { exception: "bad key" }) as unknown as typeof fetch)).rejects.toMatchObject({ status: 422, message: "bad key" });
    await expect(callHub("https://h", "t", "state", {}, reply(500, {}) as unknown as typeof fetch)).rejects.toMatchObject({ status: 502 });
  });

  it("describes a plugin the builder accepts, with three operations", () => {
    const draft = draftFromOpenApi("hub-onboarding", onboardingPluginDocument("https://t.example"));
    expect(draft.operations.map((o) => o.operationId).sort()).toEqual(["onboarding_finish", "onboarding_save_answer", "onboarding_state"]);
  });
});
