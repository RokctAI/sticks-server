import { describe, expect, it } from "vitest";
import { BRIEF_CRON, BRIEF_NAME, ensureInboxWatch, ensureMorningBrief, INBOX_WATCH_NAME, tenantTimezone } from "./lead-stick.js";

/** A fake SQL: the bots and routines tables as arrays, answering only the queries lead-stick.ts sends. */
function fakeDb(
  bots: Array<{ id: string; spaceId: string; userId: string; createdAt: string; archivedAt?: string }>,
  routines: Array<{ id: string; botId: string; name: string }> = [],
  gmailSpaces: string[] = [],
) {
  const inserted: unknown[][] = [];
  const query = async (text: string, values: unknown[] = []) => {
    if (text.includes("FROM bots")) {
      const first = new Map<string, (typeof bots)[number]>();
      for (const b of bots.filter((b) => !b.archivedAt).sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
        if (!first.has(b.spaceId)) first.set(b.spaceId, b);
      }
      return [...first.values()].map(({ id, spaceId, userId }) => ({ id, spaceId, userId }));
    }
    if (text.includes("FROM connections")) return gmailSpaces.includes(`${values[0]}/${values[1]}`) ? [{ id: "c1" }] : [];
    if (text.includes("FROM routines")) return routines.filter((r) => r.botId === values[0] && r.name === values[1]);
    if (text.includes("INSERT INTO routines")) {
      inserted.push(values);
      return [];
    }
    throw new Error(`unexpected query: ${text}`);
  };
  return { query, inserted };
}

const team = [
  { id: "tumi", spaceId: "s1", userId: "u1", createdAt: "2026-11-02" },
  { id: "kabelo", spaceId: "s1", userId: "u1", createdAt: "2026-11-01" },
];

describe("lead Stick morning brief (owner's ruling 27 Nov: the top Stick is proactive)", () => {
  it("the Stick created first gets a weekday 07:30 brief, and its first wake is queued", async () => {
    const db = fakeDb(team);
    const woken: Array<[string, Date]> = [];
    const now = new Date("2026-11-27T04:00:00Z"); // Friday 06:00 in Johannesburg
    expect(await ensureMorningBrief(db.query, "Africa/Johannesburg", async (id, at) => woken.push([id, at]), now)).toBe(1);
    const row = db.inserted[0]!;
    expect(row[2]).toBe("kabelo");
    expect(row[4]).toBe(BRIEF_NAME);
    expect(row[6]).toEqual([BRIEF_CRON]);
    expect((row[8] as Date).toISOString()).toBe("2026-11-27T05:30:00.000Z");
    expect(woken).toEqual([[row[0], row[8]]]);
  });

  it("is added once: a Stick that has it, active or paused by the owner, is left alone", async () => {
    const db = fakeDb(team, [{ id: "r1", botId: "kabelo", name: BRIEF_NAME }]);
    expect(await ensureMorningBrief(db.query, "UTC", async () => {})).toBe(0);
    expect(db.inserted).toEqual([]);
  });

  it("each tenant's space gets its own lead and brief, and nothing of another's", async () => {
    const db = fakeDb([...team, { id: "lerato", spaceId: "s2", userId: "u2", createdAt: "2026-11-10" }, { id: "sipho", spaceId: "s2", userId: "u2", createdAt: "2026-11-11" }]);
    expect(await ensureMorningBrief(db.query, "UTC", async () => {})).toBe(2);
    expect(db.inserted.map((r) => [r[1], r[2], r[3]]).sort()).toEqual([["s1", "kabelo", "u1"], ["s2", "lerato", "u2"]]);
  });

  it("an archived first Stick hands the lead to the next one", async () => {
    const db = fakeDb([{ ...team[1]!, archivedAt: "2026-11-20" }, team[0]!]);
    await ensureMorningBrief(db.query, "UTC", async () => {});
    expect(db.inserted[0]![2]).toBe("tumi");
  });

  it("no Sticks yet: nothing is added", async () => {
    const db = fakeDb([]);
    expect(await ensureMorningBrief(db.query, "UTC", async () => {})).toBe(0);
  });

  it("the zone comes from STICKS_TIMEZONE, else the whole-hour offset", () => {
    expect(tenantTimezone({ STICKS_TIMEZONE: "Africa/Johannesburg" }, 0)).toBe("Africa/Johannesburg");
    expect(tenantTimezone({}, 120)).toBe("Etc/GMT-2");
    expect(tenantTimezone({}, -300)).toBe("Etc/GMT+5");
    expect(tenantTimezone({}, 330)).toBe("UTC");
    expect(tenantTimezone({}, 0)).toBe("UTC");
  });
});

describe("lead Stick inbox watch: wakes only on new mail, after Gmail is connected", () => {
  it("no Gmail connection: nothing is added", async () => {
    const db = fakeDb(team);
    expect(await ensureInboxWatch(db.query, "UTC", async () => {})).toBe(0);
    expect(db.inserted).toEqual([]);
  });

  it("Gmail held by another user in the space does not count: the watch runs as the lead's user", async () => {
    const db = fakeDb(team, [], ["s1/u9"]);
    expect(await ensureInboxWatch(db.query, "UTC", async () => {})).toBe(0);
  });

  it("with Gmail connected, the lead gets a read-only tool watch on new unread mail, checked right away", async () => {
    const db = fakeDb(team, [], ["s1/u1"]);
    const woken: string[] = [];
    const now = new Date("2026-11-27T08:00:00Z");
    expect(await ensureInboxWatch(db.query, "UTC", async (id) => void woken.push(id), now)).toBe(1);
    const row = db.inserted[0]!;
    expect(row[2]).toBe("kabelo");
    expect(row[4]).toBe(INBOX_WATCH_NAME);
    expect(row[6]).toEqual([]);
    const watch = JSON.parse(row[8] as string);
    expect(watch).toMatchObject({ kind: "tool", tool: "GMAIL_FETCH_EMAILS", track: ["messageId"], everyMinutes: 15 });
    expect((row[9] as Date).getTime() - now.getTime()).toBe(2_000);
    expect(woken).toEqual([row[0]]);
  });

  it("is added once", async () => {
    const db = fakeDb(team, [{ id: "r1", botId: "kabelo", name: INBOX_WATCH_NAME }], ["s1/u1"]);
    expect(await ensureInboxWatch(db.query, "UTC", async () => {})).toBe(0);
  });
});
