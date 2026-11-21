// The SIP leg's building blocks (voice calls plan, piece 2), pure TypeScript with no native dependency, so it
// fits the one tenant container: SIP message build/parse, digest auth (RFC 2617/8760 MD5), SDP offer/answer for
// G.711 u-law (PCMU), RTP packets, and the u-law codec. The UDP transport that wires these to voip.rokct.ai
// and to CallMedia is the next step; nothing here touches the network.
import { createHash, randomBytes } from "node:crypto";

export type SipMessage = { start: string; headers: Array<[string, string]>; body: string };

export function header(m: SipMessage, name: string): string | undefined {
  const n = name.toLowerCase();
  return m.headers.find(([k]) => k.toLowerCase() === n)?.[1];
}

export function parseSip(raw: string): SipMessage {
  const split = raw.indexOf("\r\n\r\n");
  const head = split >= 0 ? raw.slice(0, split) : raw;
  const body = split >= 0 ? raw.slice(split + 4) : "";
  const [start = "", ...lines] = head.split("\r\n");
  const headers: Array<[string, string]> = [];
  for (const l of lines) {
    if (/^[ \t]/.test(l) && headers.length) headers[headers.length - 1]![1] += " " + l.trim();
    else {
      const i = l.indexOf(":");
      if (i > 0) headers.push([l.slice(0, i).trim(), l.slice(i + 1).trim()]);
    }
  }
  return { start, headers, body };
}

export function buildSip(m: SipMessage): string {
  const hs = m.headers.filter(([k]) => k.toLowerCase() !== "content-length");
  return [m.start, ...hs.map(([k, v]) => `${k}: ${v}`), `Content-Length: ${Buffer.byteLength(m.body)}`, "", m.body].join("\r\n");
}

export function statusOf(m: SipMessage): number | undefined {
  const r = /^SIP\/2\.0 (\d{3})/.exec(m.start);
  return r ? Number(r[1]) : undefined;
}

const md5 = (s: string) => createHash("md5").update(s).digest("hex");

/** Answers a 401/407 challenge (WWW-Authenticate or Proxy-Authenticate value) with an Authorization value. */
export function digestAuth(challenge: string, o: { method: string; uri: string; username: string; password: string; cnonce?: string; nc?: number }): string {
  const p: Record<string, string> = {};
  for (const m of challenge.replace(/^Digest\s+/i, "").matchAll(/(\w+)=("([^"]*)"|[^,\s]+)/g)) p[m[1]!.toLowerCase()] = m[3] ?? m[2]!;
  const realm = p.realm ?? "";
  const nonce = p.nonce ?? "";
  const ha1 = md5(`${o.username}:${realm}:${o.password}`);
  const ha2 = md5(`${o.method}:${o.uri}`);
  const qop = (p.qop ?? "").split(",").map((s) => s.trim()).includes("auth") ? "auth" : "";
  const parts = [`username="${o.username}"`, `realm="${realm}"`, `nonce="${nonce}"`, `uri="${o.uri}"`, `algorithm=MD5`];
  if (qop) {
    const nc = (o.nc ?? 1).toString(16).padStart(8, "0");
    const cnonce = o.cnonce ?? randomBytes(8).toString("hex");
    parts.push(`response="${md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`)}"`, `qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`);
  } else parts.push(`response="${md5(`${ha1}:${nonce}:${ha2}`)}"`);
  if (p.opaque) parts.push(`opaque="${p.opaque}"`);
  return `Digest ${parts.join(", ")}`;
}

/** SDP offer for one audio stream, PCMU (0) plus telephone-event (101). */
export function sdpOffer(ip: string, port: number, session = Date.now()): string {
  return [
    "v=0", `o=sticks ${session} ${session} IN IP4 ${ip}`, "s=sticks", `c=IN IP4 ${ip}`, "t=0 0",
    `m=audio ${port} RTP/AVP 0 101`, "a=rtpmap:0 PCMU/8000", "a=rtpmap:101 telephone-event/8000", "a=fmtp:101 0-15", "a=ptime:20", "a=sendrecv", "",
  ].join("\r\n");
}

/** The far end's audio address from an SDP answer; refuses an answer without PCMU. */
export function sdpRemote(sdp: string): { ip: string; port: number } {
  const ip = /^c=IN IP4 (\S+)/m.exec(sdp)?.[1];
  const m = /^m=audio (\d+) RTP\/AVP ([\d ]+)/m.exec(sdp);
  if (!ip || !m) throw new Error("SDP answer has no audio address");
  if (!m[2]!.split(" ").includes("0")) throw new Error("far end does not accept PCMU");
  return { ip, port: Number(m[1]) };
}

/** One RTP packet (12-byte header, no extensions). */
export function rtpPacket(o: { seq: number; timestamp: number; ssrc: number; payloadType?: number; marker?: boolean }, payload: Buffer): Buffer {
  const h = Buffer.alloc(12);
  h[0] = 0x80;
  h[1] = ((o.marker ? 1 : 0) << 7) | (o.payloadType ?? 0);
  h.writeUInt16BE(o.seq & 0xffff, 2);
  h.writeUInt32BE(o.timestamp >>> 0, 4);
  h.writeUInt32BE(o.ssrc >>> 0, 8);
  return Buffer.concat([h, payload]);
}

export function parseRtp(b: Buffer): { payloadType: number; seq: number; timestamp: number; payload: Buffer } {
  if (b.length < 12 || b[0]! >> 6 !== 2) throw new Error("not RTP");
  const cc = b[0]! & 0x0f;
  return { payloadType: b[1]! & 0x7f, seq: b.readUInt16BE(2), timestamp: b.readUInt32BE(4), payload: b.subarray(12 + cc * 4) };
}

/** G.711 u-law. */
export function ulawEncode(sample: number): number {
  const BIAS = 0x84;
  let s = Math.max(-32635, Math.min(32635, sample | 0));
  const sign = s < 0 ? 0x80 : 0;
  if (sign) s = -s;
  s += BIAS;
  let exp = 7;
  for (let mask = 0x4000; (s & mask) === 0 && exp > 0; mask >>= 1) exp--;
  const mant = (s >> (exp + 3)) & 0x0f;
  return ~(sign | (exp << 4) | mant) & 0xff;
}

export function ulawDecode(u: number): number {
  const x = ~u & 0xff;
  const t = (((x & 0x0f) << 3) + 0x84) << ((x & 0x70) >> 4);
  return x & 0x80 ? 0x84 - t : t - 0x84;
}
