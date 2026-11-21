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
