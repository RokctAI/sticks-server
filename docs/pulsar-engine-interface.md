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
| `Sticks Guest` | space `member`, marked guest | Settled 11-20. A guest session may only read (GET, HEAD, OPTIONS); every other request answers 403. Sending chat messages is not allowed for guests in v1. |

The table is `STICKS_ROLE_MAP` in `overlay/apps/sticks-engine/src/pulsar-token.ts`. Guests are recorded in the
engine's `sticks_guest` table at sign-in.

## 3. Sign-in and closed routes (task 9, built)

- `POST /internal/pulsar/sign-in` with `Authorization: Bearer <base64url envelope>` (section 1). On success it
  creates or updates the user row (id = the Pulsar user id; email `<user>@<tenant>.sticks.invalid`, never mailed),
  sets the role in the tenant's organization and default space when first boot has created them, and opens a
  12-hour session. It answers `{ token, expiresAt }`; the app sends `token` as `Authorization: Bearer <token>`.
  A fresh Pulsar token signs in again. Errors answer 401 with the token error code, or 503 when
  `/run/secrets/pulsar_public_key` is missing.
- Every other upstream route under `/api/auth/` answers 404, except `get-session`, `sign-out` and `capabilities`.
  Password, emailed code, passkey, SSO and sign-up are therefore unreachable.
- The engine needs `STICKS_TENANT` (the tenant id in tokens) and `STICKS_TENANT_SITE` (the sender id).

## 4. Settings from Pulsar (task 11, built)

- Push: `POST /internal/settings` with `Authorization: Bearer <engine secret>` (`/run/secrets/engine_secret`).
- Pull: at boot, `GET ${STICKS_SETTINGS_URL}` with the same bearer, when the variable is set. A failed pull keeps the stored settings.
- Body (snake_case; every field optional; unknown fields are refused with 400):

```json
{
  "settings": {
    "default_model": "openai/gpt-oss-120b",
    "approvals": "ask_writes | ask_all | never",
    "sleep_delay_seconds": 600,
    "browser_allowed": false,
    "home_quota_mb": 1024,
    "keep_going": { "enabled": true, "max_no_progress": 3, "max_per_day": 20, "gap_seconds": 60 }
  },
  "hub_settings": { "limits": { "sleep_delay_seconds": 900, "home_quota_mb": 2048, "browser_allowed": false, "keep_going_max_per_day": 20 } }
}
```

- Hub limits win: each limited number is capped, and `browser_allowed: false` in the limits turns the browser off.
- The answer is the effective settings. They are stored in the engine's `sticks_settings` table.

## 5. Credits (task 12, engine side built)

The engine calls Pulsar over the unix socket in `STICKS_PULSAR_SOCKET`. Each call is `POST` with JSON and `Authorization: Bearer <engine secret>`. Amounts are micro-dollars, and 10,000 make one credit (1 credit = 1 US cent).

| Call | Body | Answer |
|---|---|---|
| `/credits/reserve` | `{run, stick, user}` | `{ok: true, block_micros}`, or `{ok: false, reason}`. The run does not start, and the user sees the reason. |
| `/credits/extend` | `{run}` | `{ok: true, block_micros}` adds a block, or `{ok: false, reason}` stops the run with "credits exhausted". |
| `/credits/settle` | `{run, used_micros, usage}` | `{ok: true}`. Idempotent on `run`: Pulsar must accept a repeat and charge once. |

Each model call takes its maximum cost off the block in memory, with no call to Pulsar. Below 20 percent left, the engine extends. Runs are kept in `sticks_credit_runs`. At boot the engine settles every run that has no `settled_at`, so a crash before settle is still charged.

## 6. Later sections (not yet written)

- Engram (task 18): the end-of-day memory call, section 7.

## 7. Engram: the end-of-day memory call (task 18; Pulsar side not built)

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
