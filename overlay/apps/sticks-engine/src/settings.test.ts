import { describe, expect, it } from "vitest";
import { applyLimits, DEFAULT_SETTINGS, parseSettings, pullSettings, SettingsError, SettingsStore } from "./settings.js";

describe("settings from Pulsar (brief task 11)", () => {
  it("parses Pulsar's snake_case payload and keeps unset fields", () => {
    const { settings } = parseSettings({
      settings: { default_model: "openai/gpt-oss-120b", approvals: "ask_all", keep_going: { max_per_day: 5 } },
    });
    expect(settings.defaultModel).toBe("openai/gpt-oss-120b");
    expect(settings.approvals).toBe("ask_all");
    expect(settings.keepGoing).toEqual({ ...DEFAULT_SETTINGS.keepGoing, maxPerDay: 5 });
    expect(settings.sleepDelaySeconds).toBe(DEFAULT_SETTINGS.sleepDelaySeconds);
  });

  it("refuses unknown keys and out-of-range values", () => {
    expect(() => parseSettings({ settings: { colour: "red" } })).toThrow(SettingsError);
    expect(() => parseSettings({ settings: { approvals: "sometimes" } })).toThrow(SettingsError);
    expect(() => parseSettings({ settings: { sleep_delay_seconds: 5 } })).toThrow(SettingsError);
    expect(() => parseSettings({ settings: { browser_allowed: "yes" } })).toThrow(SettingsError);
    expect(() => parseSettings(null)).toThrow(SettingsError);
  });

  it("hub limits win over the tenant's values", () => {
    const { settings, limits } = parseSettings({
      settings: { sleep_delay_seconds: 3600, browser_allowed: true, home_quota_mb: 4096, keep_going: { max_per_day: 50 } },
      hub_settings: { limits: { sleep_delay_seconds: 900, browser_allowed: false, home_quota_mb: 2048, keep_going_max_per_day: 20 } },
    });
    const out = applyLimits(settings, limits);
    expect(out.sleepDelaySeconds).toBe(900);
    expect(out.browserAllowed).toBe(false);
    expect(out.homeQuotaMb).toBe(2048);
    expect(out.keepGoing.maxPerDay).toBe(20);
    expect(applyLimits({ ...settings, sleepDelaySeconds: 300 }, limits).sleepDelaySeconds).toBe(300);
  });

  it("the store writes through and survives a reload; a bad payload changes nothing", async () => {
    let row: unknown;
    const query = async (sql: string, values: unknown[] = []) => {
      if (sql.startsWith("SELECT")) return row ? [{ body: row }] : [];
      if (sql.startsWith("INSERT")) row = JSON.parse(values[0] as string);
      return [];
    };
    const a = new SettingsStore(query);
    await a.load();
    await a.update({ settings: { approvals: "never" } });
    await expect(a.update({ settings: { approvals: "x" } })).rejects.toThrow(SettingsError);
    expect(a.get().approvals).toBe("never");
    const b = new SettingsStore(query);
    expect((await b.load()).approvals).toBe("never");
  });

  it("pulls with the engine secret and reports a refused pull", async () => {
    const seen: string[] = [];
    const ok = (async (_url: string, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get("authorization") ?? "");
      return new Response(JSON.stringify({ settings: {} }));
    }) as typeof fetch;
    expect(await pullSettings("http://pulsar/settings", "s3cret", ok)).toEqual({ settings: {} });
    expect(seen).toEqual(["Bearer s3cret"]);
    const no = (async () => new Response("", { status: 401 })) as typeof fetch;
    await expect(pullSettings("http://pulsar/settings", "s3cret", no)).rejects.toThrow("401");
  });
});
