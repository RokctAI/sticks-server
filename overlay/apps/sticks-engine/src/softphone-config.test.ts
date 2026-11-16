import { describe, expect, it } from "vitest";
import { DEFAULT_SIP_DOMAIN, softphoneConfigFromEnv } from "./softphone-config.js";

describe("the softphone's SIP domain is configuration (telephony todo)", () => {
  it("defaults to voip.rokct.ai when nothing is set", () => {
    expect(DEFAULT_SIP_DOMAIN).toBe("voip.rokct.ai");
    expect(softphoneConfigFromEnv({})).toEqual({ domain: "voip.rokct.ai" });
    expect(softphoneConfigFromEnv({ STICKS_SIP_DOMAIN: "   " })).toEqual({ domain: "voip.rokct.ai" });
  });

  it("a changed domain is taken from the environment, lower-cased", () => {
    expect(softphoneConfigFromEnv({ STICKS_SIP_DOMAIN: "VoIP.Example.co.za" })).toEqual({
      domain: "voip.example.co.za",
    });
  });

  it("a value with a scheme, a port, a path or spaces is refused at start", () => {
    for (const bad of ["sip:voip.rokct.ai", "voip.rokct.ai:5060", "voip.rokct.ai/x", "voip rokct.ai", "-bad.example"]) {
      expect(() => softphoneConfigFromEnv({ STICKS_SIP_DOMAIN: bad })).toThrow("bare host name");
    }
  });
});
