import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildSip, digestAuth, header, parseRtp, parseSip, rtpPacket, sdpOffer, sdpRemote, statusOf, ulawDecode, ulawEncode } from "./sip.js";

const md5 = (s: string) => createHash("md5").update(s).digest("hex");

describe("SIP building blocks", () => {
  it("parses and builds messages", () => {
    const m = parseSip("SIP/2.0 401 Unauthorized\r\nVia: SIP/2.0/UDP a\r\nWWW-Authenticate: Digest realm=\"r\",\r\n nonce=\"n\"\r\n\r\n");
    expect(statusOf(m)).toBe(401);
    expect(header(m, "www-authenticate")).toBe('Digest realm="r", nonce="n"');
    const out = buildSip({ start: "OPTIONS sip:x SIP/2.0", headers: [["Call-ID", "1"]], body: "hi" });
    expect(out).toBe("OPTIONS sip:x SIP/2.0\r\nCall-ID: 1\r\nContent-Length: 2\r\n\r\nhi");
  });

  it("computes the digest response (RFC 2617 qop=auth)", () => {
    const a = digestAuth('Digest realm="voip", nonce="abc", qop="auth"', { method: "REGISTER", uri: "sip:voip", username: "u", password: "p", cnonce: "c", nc: 1 });
    const want = md5(`${md5("u:voip:p")}:abc:00000001:c:auth:${md5("REGISTER:sip:voip")}`);
    expect(a).toContain(`response="${want}"`);
    const b = digestAuth('Digest realm="voip", nonce="abc"', { method: "INVITE", uri: "sip:1@voip", username: "u", password: "p" });
    expect(b).toContain(`response="${md5(`${md5("u:voip:p")}:abc:${md5("INVITE:sip:1@voip")}`)}"`);
  });

  it("offers PCMU and reads the answer", () => {
    expect(sdpOffer("10.0.0.1", 40000, 1)).toContain("m=audio 40000 RTP/AVP 0 101");
    expect(sdpRemote("v=0\r\nc=IN IP4 1.2.3.4\r\nm=audio 5004 RTP/AVP 0\r\n")).toEqual({ ip: "1.2.3.4", port: 5004 });
    expect(() => sdpRemote("c=IN IP4 1.2.3.4\r\nm=audio 5004 RTP/AVP 8\r\n")).toThrow("PCMU");
  });

  it("round-trips RTP and u-law", () => {
    const p = parseRtp(rtpPacket({ seq: 7, timestamp: 160, ssrc: 1 }, Buffer.from([1, 2])));
    expect(p).toMatchObject({ payloadType: 0, seq: 7, timestamp: 160 });
    expect([...p.payload]).toEqual([1, 2]);
    for (const s of [0, 1000, -1000, 30000, -30000]) expect(Math.abs(ulawDecode(ulawEncode(s)) - s)).toBeLessThan(Math.max(64, Math.abs(s) / 16));
  });
});
