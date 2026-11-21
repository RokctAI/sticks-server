# Task 17: tenant image

Status: not started (draft PR holds the task and notes).

## What to do

See BUILD-BRIEF 'Task 17'. One docker per tenant: Pulsar (Ignition serve) + engine + headless sandbox helper, no computer. Pin Pulsar by docker/PULSAR_COMMIT. The 'Image builds (not pushed)' CI job is the check.

## Rules

One PR per task off main, no stacking. Raw SQL tables; no secrets, model names or personal names (public repo). Tests in overlay vitest or tests/ (Python).

## Built (Ray 11-21: one Rakazo per tenant docker; tenants sharing a docker share it; only Postgres outside)

- `docker/Dockerfile` target `engine`: builds and bundles the engine (`scripts/package_engine.py`). CI's image job builds it, which also proves the engine builds inside the image.
- The tenant image is PlatformStack's Pulsar image. It takes `/opt/sticks` from this stage (`COPY --from=<sticks-server engine image or stage> /opt/sticks /opt/sticks`), with Node 24 in the runtime.
- Start: `node /opt/sticks/build/up/apps/sticks-engine/dist/sticks-engine.mjs`, port `API_PORT` (3100).
- Required env:
  - `STICKS_TENANT`, `STICKS_TENANT_SITE`
  - `STICKS_DATABASE_URL` (the shared Postgres; the password comes from /run/secrets/db_password)
  - `STICKS_PULSAR_SOCKET` (the unix socket to Pulsar in the same container)
  - `STICKS_GATEWAY_URL`
  - `STICKS_ENGINE_URL` (the public https address)
- Optional env: `STICKS_SETTINGS_URL`, `STICKS_IDLE_PUSH_URL`, `STICKS_HUB_ONBOARDING`/`STICKS_HUB_URL`, `STICKS_SIP_DOMAIN`, `STICKS_SANDBOX_SOCKET`, `STICKS_END_OF_DAY`, `STICKS_COMPANY_NAME`, `STICKS_TZ_OFFSET_MINUTES`.
- Secrets in /run/secrets: `db_password`, `content_key`, `gateway_key`, `pulsar_public_key`, and the engine secret shared with Pulsar.
- No provider `*_API_KEY` may be set: the engine refuses to start.
