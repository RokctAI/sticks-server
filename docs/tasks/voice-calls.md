# Voice calls (approved by Ray 11-21)

Plan: /mnt/project-files/sticks/voice-calls-plan.md (project files). Build order, one PR each:

1. Call rules (this PR): `call-rules.ts`, pure decisions with tests.
   - Who may be called: CRM, invoice or quote contacts only (Pulsar `telephony.may_call`), with an approved objective card, on an active line.
   - Do not call: the Stick asks why first. A Stick never calls them again. A company contact gets an owner task. "Not a bot" marks the contact humans only. Only a person sets or clears the final flag.
   - Incoming: the tenant setting "Sticks answer" chooses a call-role Stick, or rings the app for 20 seconds and then falls back to a Stick or voicemail.
   - Fake transfer between call-role Sticks, at most 3 per call.
   - Opening line: name, role and company. The Stick answers truthfully if asked whether it is an AI, and never claims to be human.
2. Speak and transcribe routed through the gateway, for voice chat in the app.
3. SIP leg plus the Stick call loop in the engine: the engine is the only SIP endpoint, with no PBX.
4. Incoming: call push to the app, an Opus/WebRTC relay to the app, ring timeout, transfers.
5. Launcher dialer: `telephony.dial {number}` returns a call id and a media URL, with call events and hang-up/mute/hold by call id.
6. Pulsar: `telephony.may_call`, the tenant setting, and the Call Log.

## PR 2: speech through the gateway (voice chat in the app)

- The engine is an OpenAI-compatible speech server at `${STICKS_ENGINE_URL}/internal/voice/v1` (audio/speech, audio/transcriptions, models). It adds the gateway key and forwards the request to `${STICKS_GATEWAY_URL}/openai/v1/...`.
- `GET /internal/voice/setup` (signed in) returns `{baseUrl, apiKey}`. The app saves these once as the Space's voice server through upstream's own `voice/credentials`, using provider "openai-compatible". The apiKey is a proxy token derived from the engine secret, so the gateway key never leaves the engine.
- Credits: each speak or transcribe call reserves and settles one block, at one credit until the gateway reports speech cost. A refusal answers 402 with the friendly message.
- App side: record audio and call upstream `voice/transcribe`, then play the audio from upstream `voice/speak`. No other app logic.
## PR 3: the call loop

- `call-loop.ts` `runCall`: opening line, then listen, ask the Stick, speak. It ends on the objective being met, refused or given up; the person hanging up; silence (two "are you still there?" prompts); 40 turns; or credits refused (a polite goodbye).
- The bot question is answered in code, never by the model.
- Do not call asks why first.
- Fake transfer: the same media, a new Stick with the handover summary, and its own opening line.
- Media is an interface (`CallMedia`: listen, say, hangup). The SIP/RTP leg comes in the next PR. Choice to make there: a SIP user agent in the tenant image (for example a small pjsua or baresip process driven by the engine) against `voip.rokct.ai`, with Opus or G.711 audio, streaming speech to text and text to speech through the gateway.

## PR 4: SIP building blocks

- `sip.ts`: pure TypeScript with no native dependency. It covers parsing and building SIP messages, MD5 digest auth with or without qop=auth, an SDP offer and answer for PCMU plus telephone-event, RTP packets, and the G.711 u-law codec.
- Not yet: the UDP transport (REGISTER, INVITE/ACK/BYE, RTP send and receive at 20 ms) that implements `CallMedia` against `voip.rokct.ai`. That needs a test SIP account (an org secret in occultation) to prove it against the real server; until then it is tested only against a fake.

## PR 5: the call hub (softphone, with no PBX)

- `call-hub.ts` `CallHub`: tracks each call and who holds our side of it: a Stick, "app" (a person), or voicemail.
  - `dial(number)`: `telephony.dial` from the launcher dialer or the app.
  - `incoming(...)`: the setting on means a Stick answers. The setting off means a push to the app, then a 20-second timer that falls back to a Stick or to voicemail.
  - `appAnswer`, `toOwner`: a Stick puts the caller through to the owner.
  - `hangup`, `setMute`, `setHold`.
- Events `{callId, state: ringing|answered|ended|failed, direction, number, by?, reason?}` go to the app and dialer socket.
- Still to wire: the SIP line (`CallLine`, from the sip.ts UDP transport), the WebRTC Opus relay, the push (FCM/APNs keys in occultation), and the `/internal/calls` routes.
