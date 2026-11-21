import { describe, expect, it } from "vitest";
import { mayClearDoNotCall, mayStickDial, mayTransfer, onDoNotCall, openingLine, whoAnswers, type CallObjective, type CalleeLookup } from "./call-rules.js";

const now = new Date("2026-11-21T10:00:00Z");
const line = { status: "Active", didNumber: "+27100000000", sipUsername: "u", sipPassword: "p", cancellationDate: null };
const callee: CalleeLookup = { found: true, contact: "Acme", source: "crm", doNotCall: false, humansOnly: false, pendingDoNotCall: false };
const obj: CallObjective = { number: "+27820000000", contact: "Acme", objective: "Book a service", mayAgree: [], mustNotShare: [], giveUpAfter: "two refusals", approvedBy: "owner" };

describe("call rules", () => {
  it("dials only approved objectives to known contacts", () => {
    expect(mayStickDial(line, callee, obj, now)).toEqual({ allowed: true });
    expect(mayStickDial(line, { found: false }, obj, now).allowed).toBe(false);
    expect(mayStickDial(line, { ...callee, doNotCall: true }, obj, now).allowed).toBe(false);
    expect(mayStickDial(line, { ...callee, humansOnly: true }, obj, now).allowed).toBe(false);
    expect(mayStickDial(line, callee, { ...obj, approvedBy: null }, now).allowed).toBe(false);
    expect(mayStickDial(null, callee, obj, now).allowed).toBe(false);
  });

  it("asks why before do not call, and sends company contacts to the owner", () => {
    expect(onDoNotCall({ name: "Acme", isCompany: true }, "")).toEqual({ askWhy: true });
    const o = onDoNotCall({ name: "Acme", isCompany: true }, "I don't talk to bots");
    expect(o).toMatchObject({ markPending: true, humansOnly: true });
    expect((o as { ownerTask: string }).ownerTask).toContain("call them yourself");
    expect(onDoNotCall({ name: "Sam", isCompany: false }, "too busy")).toMatchObject({ humansOnly: false, ownerTask: null });
    expect(mayClearDoNotCall({ kind: "stick" })).toBe(false);
    expect(mayClearDoNotCall({ kind: "owner" })).toBe(true);
  });

  it("answers by setting, rings the app otherwise, and limits transfers", () => {
    expect(whoAnswers(true, ["s1"])).toEqual({ kind: "stick", stickId: "s1" });
    expect(whoAnswers(false, ["s1"])).toEqual({ kind: "ring_app", fallback: { kind: "stick", stickId: "s1" } });
    expect(whoAnswers(true, [])).toEqual({ kind: "ring_app", fallback: { kind: "voicemail" } });
    expect(mayTransfer({ transfers: 0, currentStick: "s1" }, "s2", ["s1", "s2"]).allowed).toBe(true);
    expect(mayTransfer({ transfers: 3, currentStick: "s1" }, "s2", ["s1", "s2"]).allowed).toBe(false);
    expect(mayTransfer({ transfers: 0, currentStick: "s1" }, "s3", ["s1", "s2"]).allowed).toBe(false);
  });

  it("opens with name, role and company, without saying AI", () => {
    const l = openingLine({ name: "Thandi", role: "accounts assistant", company: "South River" }, "Mr Dube");
    expect(l).toBe("Hello Mr Dube, this is Thandi, accounts assistant at South River.");
    expect(l).not.toMatch(/\bAI\b|bot/i);
  });
});
