# The model gateway: the contract (spec 4.4, 8.3; brief task 13)

The model gateway is a separate service. It is a pass-through: it speaks each provider's own API,
unchanged, under one path prefix per provider. It holds the provider keys. The tenant holds only its own
gateway key.

## Paths

`${STICKS_GATEWAY_URL}/<provider>/<the provider's own path>`

Examples:
- `${STICKS_GATEWAY_URL}/anthropic/v1/messages`
- `${STICKS_GATEWAY_URL}/openai/v1/chat/completions`
- `${STICKS_GATEWAY_URL}/openai/v1/audio/speech`

The engine sets each provider SDK's base URL to `${STICKS_GATEWAY_URL}/<provider>`. The SDK then adds
its own paths, so the gateway sees exactly the paths the provider's API defines.

## Authentication

The engine reads the gateway key from `/run/secrets/gateway_key`. It sends that key where the provider's
own key would go, in the header that provider's SDK uses:

| Provider | Header | Settled |
|---|---|---|
| `anthropic` | `x-api-key: <gateway key>` | yes |
| `openai` | `Authorization: Bearer <gateway key>` | yes |
| any other provider | not settled | **BLOCKED: list the providers upstream supports and each one's header** |

The engine never reads a provider key from its environment. At startup it refuses to run if any variable
in `PROVIDER_KEY_ENV_NAMES` (`overlay/apps/sticks-engine/src/gateway.ts`) is set to a non-empty value.

## Streaming

Streaming is the provider's own. The gateway passes the provider's stream through unchanged; it does not
rewrite the events.

## Errors

| Status | Meaning |
|---|---|
| 401 | The gateway key is unknown or revoked. Revocation takes effect within the key-check cache (60 s). |
| 402 | The tenant is over its spend ceiling. The gateway counts spend itself between hub checks. |

Other statuses are the provider's own, passed through.

## Not in this contract

- The gateway's internal checks with the hub (key check, balance check, caches, grace period). That is the
  gateway's own design (spec 4.4) and not the engine's.
- Wiring the engine's model catalogue to these base URLs (**BLOCKED**). Upstream's pi runtime bakes each
  provider's base URL into its catalogue (`packages/adapters/src/pi-runtime-models.ts`). Changing it needs
  the `pi-ai` model type (its base URL field and key option), which is not in this repository and is only
  checked by a CI typecheck. It is the next step for this task.
- Speech providers' base URL wiring (**BLOCKED**, same reason).
- The own-model-keys refusal: not built (an undecided proposal, spec 13).
