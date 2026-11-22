import { describe, expect, it } from "vitest";
import { applyDutyChange, DutyError, dutyState, DutyStore, parseHours, UNTIL_TOLD, withinHours } from "./duty.js";

const WEEKDAYS = { tz: "Africa/Johannesburg", days: { mon: [["08:00", "17:00"]], tue: [["08:00", "17:00"]] } };

function memoryStore() {
  const rows = new Map<string, { hours: unknown; off_until: Date | null; off_reason: string | null }>();
  const query = async (sql: string, p: unknown[] = []): Promise<unknown[]> => {
    const id = p[0] as string;
    const row = rows.get(id) ?? { hours: null, off_until: null, off_reason: null };
    if (sql.includes("SELECT")) return rows.has(id) ? [row] : [];
    if (sql.includes("(bot_id, hours)")) rows.set(id, { ...row, hours: p[1] === null ? null : JSON.parse(p[1] as string) });
    if (sql.includes("(bot_id, off_until")) rows.set(id, { ...row, off_until: p[1] as Date | null, off_reason: p[2] as string | null });
    return [];
  };
  return new DutyStore(query);
}

describe("working hours", () => {
  const hours = parseHours(WEEKDAYS);
  it("Monday 09:00 Johannesburg (07:00 UTC) is working; 18:00 and Sunday are resting", () => {
    expect(withinHours(hours, new Date("2026-11-23T07:00:00Z"))).toBe(true);
    expect(withinHours(hours, new Date("2026-11-23T16:00:00Z"))).toBe(false);
    expect(withinHours(hours, new Date("2026-11-22T09:00:00Z"))).toBe(false);
  });
  it("refuses bad time zones, days and ranges", () => {
    expect(() => parseHours({ tz: "Mars/Base", days: {} })).toThrow(DutyError);
    expect(() => parseHours({ tz: "UTC", days: { funday: [] } })).toThrow(DutyError);
    expect(() => parseHours({ tz: "UTC", days: { mon: [["17:00", "08:00"]] } })).toThrow(DutyError);
  });
  it("no hours set means always working", () => {
    expect(dutyState({ hours: null, offUntil: null, offReason: null }, new Date()).on_duty).toBe(true);
  });
});

describe("off duty when told", () => {
  const now = new Date("2026-11-23T07:00:00Z");
  it("off until told: stays off with no end, back on when told", async () => {
    const store = memoryStore();
    const off = await applyDutyChange(store, "b1", { off: { reason: "owner said stop" } }, now);
    expect(off).toEqual({ on_duty: false, state: "off_duty", reason: "owner said stop", until: null });
    expect((await store.get("b1")).offUntil?.getTime()).toBe(UNTIL_TOLD.getTime());
    expect((await applyDutyChange(store, "b1", { on: true }, now)).on_duty).toBe(true);
  });
  it("off until a time: back on by itself after it", async () => {
    const store = memoryStore();
    await applyDutyChange(store, "b1", { off: { until: "2026-11-23T08:00:00Z" } }, now);
    const d = await store.get("b1");
    expect(dutyState(d, now).state).toBe("off_duty");
    expect(dutyState(d, new Date("2026-11-23T08:00:01Z")).on_duty).toBe(true);
  });
  it("off duty wins over working hours; a past time is refused", async () => {
    const store = memoryStore();
    await applyDutyChange(store, "b1", { hours: WEEKDAYS, off: {} }, now);
    expect(dutyState(await store.get("b1"), now).state).toBe("off_duty");
    await expect(applyDutyChange(store, "b1", { off: { until: "2020-01-01T00:00:00Z" } }, now)).rejects.toThrow(DutyError);
  });
  it("outside hours reads as resting", async () => {
    const store = memoryStore();
    expect((await applyDutyChange(store, "b1", { hours: WEEKDAYS }, new Date("2026-11-22T09:00:00Z"))).state).toBe("resting");
  });
});
