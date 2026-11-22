import { describe, expect, it } from "vitest";
import { ALL_ON, mergeFeatures, readFeatures, saveFeatures } from "./features.js";

function db() {
  let row: unknown;
  return async (sql: string, p: unknown[] = []): Promise<unknown[]> => {
    if (sql.startsWith("CREATE")) return [];
    if (sql.startsWith("INSERT")) { row = { features: JSON.parse(p[0] as string) }; return []; }
    return row ? [row] : [];
  };
}

describe("hub feature switches", () => {
  it("everything is on until the hub says otherwise", async () => {
    expect(await readFeatures(db())).toEqual(ALL_ON);
  });
  it("a missing key keeps its last value; junk is ignored", async () => {
    const q = db();
    await saveFeatures(q, { voice_calls: false });
    const f = await saveFeatures(q, { plugin_building: false, voice_calls: "no", other: true });
    expect(f).toEqual({ ...ALL_ON, voice_calls: false, plugin_building: false });
  });
  it("merge ignores non-objects", () => {
    expect(mergeFeatures(ALL_ON, null)).toEqual(ALL_ON);
  });
});
