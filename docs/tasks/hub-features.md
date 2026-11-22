# Hub feature switches (Ray 11-22 "Yes")

- Hub: agent#687 resolves `features` per plan with tenant overrides on `get_subscription_status`. Screen waits for Ray's OK on the render.
- Pulsar: core#1630 stores them and posts to the engine when they change.
- Engine (this PR): `POST /internal/features` (engine secret) stores them; `GET /internal/features` (signed in or engine secret) returns them. Missing keys keep their last value; none ever received = all on.
- Keys: plugin_building, unsupported_service_plugins, voice_calls, hands_on.
- Callers: Pulsar posts; the Sticks app hides hands-on/voice from GET.
- Still to wire: plugin building is inside upstream Rakazo (no HTTP route of ours), so blocking it needs an upstream patch; voice calls gate goes into the call hub when calls are wired.
