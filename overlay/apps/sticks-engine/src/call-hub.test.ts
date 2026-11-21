import { describe, expect, it } from "vitest";
import { CallHub, type CallEvent } from "./call-hub.js";

function hub() {
  const events: CallEvent[] = [];
  const log: string[] = [];
  const timers: Array<() => void> = [];
  const h = new CallHub({
    line: { dial: async () => ({ lineCallId: "L1" }), answer: async (id) => void log.push(`answer:${id}`), hangup: async (id) => void log.push(`hangup:${id}`) },
    notify: (e) => void events.push(e),
    startStick: (c, s) => void log.push(`stick:${s}`),
    pushApp: async (e) => void log.push(`push:${e.state}`),
    voicemail: () => void log.push("voicemail"),
    setTimer: (fn) => void timers.push(fn),
  });
  return { h, events, log, timers };
}

describe("call hub", () => {
  it("dials out for a person and reports ringing, answered, ended", async () => {
    const t = hub();
    const c = await t.h.dial("+27820000000");
    t.h.farAnswered(c.id);
    await t.h.hangup(c.id);
    expect(t.events.map((e) => e.state)).toEqual(["ringing", "answered", "ended"]);
    expect(t.log).toContain("hangup:L1");
  });

  it("lets a Stick answer when the setting is on", async () => {
    const t = hub();
    await t.h.incoming("L2", "+2711", true, ["s1"]);
    expect(t.log).toEqual(["answer:L2", "stick:s1"]);
  });

  it("rings the app when off, and the person can answer", async () => {
    const t = hub();
    await t.h.incoming("L3", "+2711", false, ["s1"]);
    expect(t.log).toEqual(["push:ringing"]);
    const id = [...t.h.calls.keys()][0]!;
    expect(await t.h.appAnswer(id)).toBe(true);
    expect(t.h.calls.get(id)!.holder).toBe("app");
    t.timers[0]!(); // the timeout after answering does nothing
    expect(t.log.filter((l) => l.startsWith("stick"))).toHaveLength(0);
  });

  it("falls back to a Stick, or voicemail, when nobody answers", async () => {
    const a = hub();
    await a.h.incoming("L4", "+2711", false, ["s1"]);
    a.timers[0]!();
    await new Promise((r) => setTimeout(r, 0));
    expect(a.log).toContain("stick:s1");
    const b = hub();
    await b.h.incoming("L5", "+2711", false, []);
    b.timers[0]!();
    await new Promise((r) => setTimeout(r, 0));
    expect(b.log).toContain("voicemail");
  });
});
