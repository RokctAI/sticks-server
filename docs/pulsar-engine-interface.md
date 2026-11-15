# Pulsar and the engine: the interface

What Pulsar (RokctAI/core) and the engine (this repo) agree on. Each section names the task that
settles it. Anything not yet settled is marked **BLOCKED** and is not built.

## 1. Engine token (task 9, spec 7.2 and 5.3)

Pulsar signs a short-lived token that says who the user is for this request. The engine verifies it.

**Format:** core's signed envelope (`RokctAI/core`, `pulsar/pulsar/envelope.py`, protocol version 1).

```json
{
  "v": 1,
  "sender": { "kind": "<settled by the owner>", "id": "<settled by the owner>" },
  "ts": "2026-11-15T10:00:00Z",
  "nonce": "<random, unique per sender in 10 minutes>",
  "body": { "tenant": "<tenant id>", "user": "<user id>", "role": "Sticks Member", "exp": 1789567500 },
  "sig": "<base64 ed25519 signature>"
}
```

- **Signature:** ed25519 over the UTF-8 string `v|sender.kind|sender.id|ts|nonce|sha256hex(canonical(body))`.
  Canonical JSON sorts keys at every level, with no spaces (core's `_canonical`).
- **Time:** `ts` must be within 300 seconds of the engine's clock. `exp` (epoch seconds) is five
  minutes after issue. An expired token is refused even if `ts` is fresh.
- **Replay:** a nonce is accepted once per sender in a 600-second window.
- **Body:** exactly `tenant`, `user`, `role` (a Sticks role name) and `exp`.
- **Tenant:** the token's `tenant` must be the tenant this engine serves. Otherwise it is refused.

**Errors (machine codes):** `malformed`, `bad_signature`, `stale`, `replay`, `wrong_tenant`,
`expired`, `unknown_role`.

### Public key

- File: `/run/secrets/pulsar_public_key`.
- Content: the raw 32-byte ed25519 public key, base64, as core's `generate_keypair` writes it.

### Sender and transport (settled 11-15, owner's decision)

- **Sender:** `sender.kind` = `"site"`; `sender.id` = the tenant's site host name, from the environment
  variable `STICKS_TENANT_SITE`. The engine builds the expected sender with `senderFromTenantSite`.
- **Transport:** `Authorization: Bearer <base64url of the JSON envelope>`. `envelopeFromAuthorization`
  reads it. The verifier then checks the envelope as above.

Both are in `overlay/apps/sticks-engine/src/pulsar-token.ts`, with tests.

## 2. Roles (task 9)

| Sticks role (Pulsar) | Upstream role | Status |
|---|---|---|
| `Sticks Owner` | organization `owner`, space `owner` | Proposed. |
| `Sticks Admin` | organization `admin`; the space stays `owner`, since upstream's space roles are only `owner` and `member` | Proposed; the spec does not settle it. |
| `Sticks Member` | space `member` | Proposed. |
| `Sticks Guest` | none | Behaviour settled 11-15: read-only chat, no tools, no runs, no memory writes. No upstream role gives those limits, so the token is still refused as `unknown_role` until the engine enforces them. |

The table is `STICKS_ROLE_MAP` in `overlay/apps/sticks-engine/src/pulsar-token.ts`.

**Remaining gap:** a guest session needs the engine's session layer to block tools, runs and memory writes.
That layer is not built (section 3), so mapping Guest now would give it member rights. Not mapped.

## 3. Routes to remove (task 9): not done in this PR

Upstream's password, emailed-code, passkey and single sign-on routes are meant to be unmounted, so that
sign-in is by the engine token only. This PR does not do that. The token is verified but not yet
turned into a session. The transport is settled (section 1), so the session step is the next piece of
task 9, not an open question. Until it lands the routes stay as they are.

## 4. Later sections (not yet written)

- Settings from Pulsar (task 11): `POST /internal/settings`.
- Credits from Pulsar (task 12): `credits.reserve`, `credits.extend`, `credits.settle`.
- Engram (task 18): the end-of-day memory call, section 5.

## 5. Engram: the end-of-day memory call (task 18; Pulsar side not built)

Once a day per tenant the engine summarises each chat active that day, writes the lasting facts to Engram
through Pulsar, then clears that chat's working context. The job is held in `next_wake_at` (spec 7.6); it
has no timer of its own. Implementation: `overlay/apps/sticks-engine/src/end-of-day.ts` (`runEndOfDay`,
`nextEndOfDayAt`), tested against a fake of every dependency.

**Call (engine to Pulsar):** `engram.remember`, one per chat per day.

```json
{ "tenant": "<tenant id>", "chat": "<chat id>", "day": "2026-11-15", "facts": "<summary text>" }
```

- Sent over the same unix socket as credits (`STICKS_PULSAR_SOCKET`), with the per-tenant secret.
- Success: Pulsar stores the facts in Engram for that tenant. Failure: the engine keeps the chat's
  working context and retries on the next run. The context is cleared only after success.
- The transport and the Pulsar endpoint are a core-side build. Until it exists the engine uses a fake.
- External memory providers (Supermemory, Serenity, Honcho) stay switched off in the Sticks build, so
  memory does not leave the tenant.

**Not in this PR:** the wiring from `runEndOfDay` to the real `next_wake_at` item and to the gateway
summariser, both of which depend on code in upstream and on the boot pass (task 7).
