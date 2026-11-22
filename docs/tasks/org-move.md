# Moving one tenant's Rakazo data between dockers (Ray 11-22 "Go")

Caller: control's move runner (Paramount thread), between drain (sticks-server#91) and resume.

## CLI (bundled next to the engine)

Run inside the tenant service, which already has `STICKS_DATABASE_URL` and `/run/secrets/db_password`:

```
node /opt/sticks/build/up/apps/sticks-engine/dist/sticks-org.mjs export --site <site> <file.json> [--move-key <keyfile>]   # shared docker
node /opt/sticks/build/up/apps/sticks-engine/dist/sticks-org.mjs export <organizationId> <file.json>
node /opt/sticks/build/up/apps/sticks-engine/dist/sticks-org.mjs export --only-org <file.json>   # one-tenant database
node /opt/sticks/build/up/apps/sticks-engine/dist/sticks-org.mjs import <file.json> [--move-key <keyfile>]
```

`--move-key`: a one-off file of at least 32 random characters that the move runner makes, gives to both export and import, then deletes. With it the tenant's Stick Pulsar tokens move too: export opens them with the source engine secret and seals them with the move key, import opens them with the move key and seals them with the target engine secret. No plain token is ever written to the file. Without it the tokens are skipped (`skipped_stick_tokens` in the output) and must be re-issued with rotate_token.

## Drain one tenant

All need the engine secret. `{site}` acts on that tenant only; `{}` keeps the old whole-engine behaviour.

- `POST /internal/drain {site}` → `{draining:true, site, active_runs}`. Writes from that tenant's sessions get 503 `{error:"moving", retry:true}`, and its sign-ins too. Other tenants keep working. Kept in `sticks_drain_sites`, so a restart keeps refusing.
- `GET /internal/idle?site=<site>` → `{idle, since, next_wake_at}`. Runs and routines are that tenant's only. Open streams and live scripts carry no tenant, so they are counted for the whole engine: a busy neighbour can delay idle, never hide this tenant's work.
- `POST /internal/resume {site}` → `{draining:false, site}`. Also reloads the tenant list, so a tenant just imported from another docker can sign in.
- Unknown site: 404.

Exit 0 on success, 1 on failure (reason on stderr). Import runs in one transaction and skips rows already there, so it can be run again safely.

## What moves

`org-move.ts` reads the foreign keys from the database itself. It walks down from the tenant's `organization` row (spaces, Sticks, threads, messages, runs, memory and the rest), then adds the rows those point up to (for example the user a member is) without walking down from them, so no other tenant's rows are included. Rows go in parents first. Upstream's row-level security is bypassed for the session with its own `app.rls_bypass` setting.

## Encryption (must read)

Upstream encrypts message content per space with data keys in `space_keys`, wrapped by a master key derived from the docker's `content_key`. A shared docker's `content_key` must never be copied to another docker.

- **With `--move-key`** (on both export and import): export opens only this tenant's space keys with the source `content_key` and wraps them with the move key; import opens them with the move key and wraps them with the target docker's own `content_key` (`content-rewrap.ts`). No plain key is written to the file. Proved against upstream's own key provider: the moved key opens with the target key and not with the source key.
- **Without `--move-key`**: space keys are copied as they are, so the target must have the same `content_key`. The move runner must refuse a move between dockers with different content keys unless it passes `--move-key`.
- A space key wrapped by any master key other than the derived one (`ENCRYPTION_MASTER_KEYS` or a key manager) is refused, so nothing moves unreadable.
- **Not re-encrypted yet:** stored connection secrets (upstream's secret store, encrypted with `content_key` directly). On a docker with another `content_key` they must be entered again.

## Not moved

Rows with no foreign-key path to the organization (for example login sessions, which hang off the user). People sign in again on the new docker. The engine's own rows for the tenant move with it (`engine-rows.ts`): its `sticks_tenants` row, Stick Pulsar tokens (with `--move-key`), keep-going switches, credit pauses, record cards and guest marks. Not moved: reactions (no tenant link), and the per-docker settings and features rows (Pulsar re-sends features).

## Proof

Unit tests in `org-move.test.ts` (one tenant out of a shared docker, nothing of the other tenant, second import changes nothing, ordering). Also run by hand against the upstream schema (a newer upstream checkout than the pinned v0.11.0; all migrations applied to Postgres 16, two tenants seeded with user, member, space, Stick, thread and message): export of tenant A held no row of tenant B, the first import added 7 rows, the second added 0.
