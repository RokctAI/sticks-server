import { describe, expect, it } from "vitest";
import { ensureOnboardingStick, ONBOARDING_SPAWN_KEY } from "./onboarding-stick.js";

describe("Onboarding Stick", () => {
  it("is made once, in the default space, owned by the given user", async () => {
    const bots: unknown[][] = [];
    const query = async (sql: string, values: unknown[] = []) => {
      if (sql.includes("FROM bots")) return bots.length ? [{ id: bots[0][0] }] : [];
      if (sql.includes("FROM spaces")) return [{ id: "space-1" }];
      if (sql.startsWith("INSERT INTO bots")) bots.push(values);
      return [];
    };
    const first = await ensureOnboardingStick(query, "user-1");
    const second = await ensureOnboardingStick(query, "user-2");
    expect(second).toBe(first);
    expect(bots).toHaveLength(1);
    expect(bots[0][1]).toBe("space-1");
    expect(bots[0][2]).toBe("user-1");
    expect(bots[0][7]).toBe(ONBOARDING_SPAWN_KEY);
  });

  it("waits when the tenant has no space yet", async () => {
    expect(await ensureOnboardingStick(async () => [], "u")).toBeUndefined();
  });
});
