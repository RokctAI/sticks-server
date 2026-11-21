// Speech for voice chat in the app (voice calls plan, piece 1). Upstream's voice settings accept an
// OpenAI-compatible speech server (base URL plus key). We point that at the engine itself: this proxy adds the
// gateway key (which never leaves the engine), forwards to the gateway's openai path, and charges credits.
// The key upstream stores is a proxy token derived from the engine secret, useful only against this proxy.
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { gatewayHeaders, gatewayUrlFor } from "./gateway.js";
import { CreditsRefused, type CreditsTransport } from "./pulsar-credits.js";

/** The only upstream paths we forward: speech, transcription, and the model list upstream checks on save. */
export const VOICE_PATHS = new Set(["audio/speech", "audio/transcriptions", "models"]);

export function voiceProxyToken(engineSecret: string): string {
  return createHmac("sha256", engineSecret).update("sticks-voice-proxy").digest("hex");
}

export function proxyTokenMatches(header: string | undefined, engineSecret: string): boolean {
  const got = Buffer.from((header ?? "").replace(/^Bearer\s+/i, ""));
  const want = Buffer.from(voiceProxyToken(engineSecret));
  return got.length === want.length && timingSafeEqual(got, want);
}

export type VoiceProxyDeps = {
  gatewayUrl: string;
  gatewayKey: string;
  engineSecret: string;
  credits?: CreditsTransport | undefined;
  fetch?: typeof fetch;
};

/**
 * Forwards one request. `path` is the part after /internal/voice/v1/. Speech and transcription reserve and
 * settle one block each (run id voice:<uuid>); a refusal answers 402 with the friendly message.
 */
export async function forwardVoice(deps: VoiceProxyDeps, path: string, req: Request): Promise<Response> {
  if (!VOICE_PATHS.has(path)) return Response.json({ error: "not found" }, { status: 404 });
  if (!proxyTokenMatches(req.headers.get("authorization") ?? undefined, deps.engineSecret)) return Response.json({ error: "unauthorized" }, { status: 401 });
  const charged = path !== "models" && deps.credits;
  const run = `voice:${randomUUID()}`;
  let block = 0;
  if (charged) {
    const r = await deps.credits!.call("/credits/reserve", { run, stick: "voice", user: "voice" });
    if (!r.ok || !r.block_micros) {
      const e = new CreditsRefused(r.reason ?? "credits refused");
      return Response.json({ error: { message: e.friendly } }, { status: 402 });
    }
    block = r.block_micros;
  }
  const headers = new Headers(gatewayHeaders("openai", deps.gatewayKey));
  const type = req.headers.get("content-type");
  if (type) headers.set("content-type", type);
  const init: RequestInit & { duplex?: string } = { method: req.method, headers };
  if (req.method !== "GET" && req.method !== "HEAD") {
    init.body = await req.arrayBuffer();
  }
  try {
    return await (deps.fetch ?? fetch)(`${gatewayUrlFor(deps.gatewayUrl, "openai")}/v1/${path}`, init);
  } finally {
    // The gateway reports no cost on speech yet: one credit per call, at most the block.
    if (charged) await deps.credits!.call("/credits/settle", { run, used_micros: Math.min(block, 10_000), usage: { voice: path } }).catch(() => undefined);
  }
}
