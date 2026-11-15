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

The engine reads the gateway key from `/run/secrets/gateway_key` at each request (patch 0005, `gatewayAuth`).
It passes that key as the provider's API key option, so pi-ai sends it in the header that provider uses
(for example `x-api-key` for anthropic, `Authorization: Bearer` for openai). The gateway receives the same
header a provider would. No key is read from the environment, and a missing secret file means the provider
is not configured, so nothing is sent.

The header per provider is pi-ai's choice, not a table in this repository. Confirming that the gateway
accepts each provider's header is part of the gateway's own contract.

The engine never reads a provider key from its environment. At startup it refuses to run if any variable
whose name ends in `_API_KEY` is set to a non-empty value (`PROVIDER_KEY_ENV_PATTERN` in
`overlay/apps/sticks-engine/src/gateway.ts`). The rule is the name pattern, so a provider added later is
covered without a list change.

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
- Wiring the engine's model catalogue to the gateway: built as patch 0005 (upstream's
  `packages/adapters/src/pi-runtime-models.ts`). Each provider's models and base URL point at
  `${STICKS_GATEWAY_URL}/<provider>`, and each provider's key is the gateway key (see Authentication).
  Settled from `@earendil-works/pi-ai@1.5.0` (the package named in upstream's `pnpm-lock.yaml`; its
  `dist/types.d.ts` on unpkg): a model has a `baseUrl`, and a provider's auth can resolve an API key.
  The routing is checked by CI's Engine typecheck and build. It has no unit test, because it is inlined in
  upstream's file (upstream's adapters package cannot import from `apps/`).
- Speech providers' base URL wiring (**BLOCKED**, same reason).
- The own-model-keys refusal: not built (an undecided proposal, spec 13).
