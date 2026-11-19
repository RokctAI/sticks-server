import { describe, expect, it } from "vitest";
import { dialDecision, type PhoneLine } from "./outbound-call-gate.js";

const NOW = new Date("2026-11-16T09:00:00Z");

const line = (overrides: Partial<PhoneLine> = {}): PhoneLine => ({
  status: "Active",
  didNumber: "+27215550123",
  sipUsername: "tenant-1",
  sipPassword: "secret",
  cancellationDate: null,
  ...overrides,
});

describe("a bot may dial only from a phone line the tenant has (telephony todo)", () => {
  it("an active line with a number and SIP credentials may dial", () => {
    expect(dialDecision(line(), NOW)).toEqual({ allowed: true });
  });

  it("no subscription means no dialing", () => {
    expect(dialDecision(null, NOW)).toEqual({ allowed: false, reason: "no telephony subscription for this tenant" });
    expect(dialDecision(undefined, NOW).allowed).toBe(false);
  });

  it("only an Active subscription may dial: Inactive, Cancelled and Suspended are refused", () => {
    for (const status of ["Inactive", "Cancelled", "Suspended"]) {
      expect(dialDecision(line({ status }), NOW)).toEqual({ allowed: false, reason: `subscription is ${status}` });
    }
  });

  it("no phone number allocated means no dialing, even when active", () => {
    expect(dialDecision(line({ didNumber: null }), NOW)).toEqual({
      allowed: false,
      reason: "no phone number allocated",
    });
    expect(dialDecision(line({ didNumber: "   " }), NOW).allowed).toBe(false);
  });

  it("a missing SIP username or password refuses the dial", () => {
    expect(dialDecision(line({ sipUsername: "" }), NOW).allowed).toBe(false);
    expect(dialDecision(line({ sipPassword: null }), NOW).allowed).toBe(false);
  });

  it("a cancellation date that has passed refuses the dial; a future one does not", () => {
    expect(dialDecision(line({ cancellationDate: new Date("2026-11-01T00:00:00Z") }), NOW).allowed).toBe(false);
    expect(dialDecision(line({ cancellationDate: new Date("2026-12-01T00:00:00Z") }), NOW).allowed).toBe(true);
  });
});
