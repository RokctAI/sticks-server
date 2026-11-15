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

### Sender and transport: BLOCKED

- **BLOCKED: what `sender.kind` and `sender.id` Pulsar puts in the token.** The engine must know them
  to check the sender. Not built: the verifier takes them as arguments.
- **BLOCKED: which header the engine token travels in** (for example `Authorization: Bearer`).

## 2. Roles (task 9)

| Sticks role (Pulsar) | Upstream role | Status |
|---|---|---|
| `Sticks Owner` | organization `owner`, space `owner` | Proposed. |
| `Sticks Admin` | organization `admin`; the space stays `owner`, since upstream's space roles are only `owner` and `member` | Proposed; the spec does not settle it. |
| `Sticks Member` | space `member` | Proposed. |
| `Sticks Guest` | none | **BLOCKED: what a guest may do.** A token with this role is refused as `unknown_role`. |

The table is `STICKS_ROLE_MAP` in `overlay/apps/sticks-engine/src/pulsar-token.ts`.

## 3. Routes to remove (task 9): not done in this PR

Upstream's password, emailed-code, passkey and single sign-on routes are meant to be unmounted, so that
sign-in is by the engine token only. This PR does not do that. The token is verified but not yet
turned into a session, and that step needs the transport answer in section 1. Until then the routes
stay as they are. **BLOCKED: the transport answer in section 1.**

## 4. Later sections (not yet written)

- Settings from Pulsar (task 11): `POST /internal/settings`.
- Credits from Pulsar (task 12): `credits.reserve`, `credits.extend`, `credits.settle`.
- Engram (task 18): the end-of-day memory call.
