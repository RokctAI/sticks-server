import { describe, expect, it } from "vitest";
import { addReaction, listReactions, ReactionError, validEmoji } from "./reactions.js";

function fakeDb() {
  const events = new Map([["m1", "t1"]]);
  const rx: Array<{ event_id: string; emoji: string; created_at: Date }> = [];
  const query = async (sql: string, v: unknown[] = []) => {
    if (sql.includes("FROM events WHERE")) return events.has(v[0] as string) ? [{ threadId: events.get(v[0] as string) }] : [];
    if (sql.startsWith("INSERT")) {
      let r = rx.find((x) => x.event_id === v[0] && x.emoji === v[1]);
      if (!r) rx.push((r = { event_id: v[0] as string, emoji: v[1] as string, created_at: new Date() }));
      return [r];
    }
    if (sql.startsWith("SELECT r.")) return rx.filter((r) => events.get(r.event_id) === v[0]);
    return [];
  };
  return { query, rx };
}

describe("Stick reactions", () => {
  it("accepts one emoji only", () => {
    expect(validEmoji("👍")).toBe(true);
    expect(validEmoji("👍🏽")).toBe(true);
    expect(validEmoji("❤️")).toBe(true);
    expect(validEmoji("ok")).toBe(false);
    expect(validEmoji("👍 nice")).toBe(false);
    expect(validEmoji("")).toBe(false);
  });

  it("stores a reaction once and lists it for the thread", async () => {
    const db = fakeDb();
    const r = await addReaction(db.query, "m1", "🎉");
    expect(r).toMatchObject({ messageId: "m1", threadId: "t1", emoji: "🎉", by: "stick" });
    await addReaction(db.query, "m1", "🎉");
    expect(db.rx).toHaveLength(1);
    expect(await listReactions(db.query, "t1")).toHaveLength(1);
  });

  it("refuses an unknown message", async () => {
    await expect(addReaction(fakeDb().query, "nope", "👍")).rejects.toBeInstanceOf(ReactionError);
  });
});
