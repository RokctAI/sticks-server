# Moving one tenant's Rakazo data between dockers (Ray 11-22 "Go")

Caller: control's move runner (Paramount thread), between drain (sticks-server#91) and resume.

## CLI (bundled next to the engine)

Run inside the tenant service, which already has `STICKS_DATABASE_URL` and `/run/secrets/db_password`:

```
node /opt/sticks/build/up/apps/sticks-engine/dist/sticks-org.mjs export <organizationId> <file.json>
node /opt/sticks/build/up/apps/sticks-engine/dist/sticks-org.mjs export --only-org <file.json>   # one-tenant database
node /opt/sticks/build/up/apps/sticks-engine/dist/sticks-org.mjs import <file.json>
```

Exit 0 on success, 1 on failure (reason on stderr). Import runs in one transaction and skips rows already there, so it can be run again safely.

## What moves

`org-move.ts` reads the foreign keys from the database itself. It walks down from the tenant's `organization` row (spaces, Sticks, threads, messages, runs, memory and the rest), then adds the rows those point up to (for example the user a member is) without walking down from them, so no other tenant's rows are included. Rows go in parents first. Upstream's row-level security is bypassed for the session with its own `app.rls_bypass` setting.

## Encryption (must read)

Upstream encrypts message content per space (keys in `space_keys`, wrapped by a master key derived from `ENCRYPTION_KEY`) and stores connection secrets encrypted with `ENCRYPTION_KEY` directly. Rows are copied as they are, still encrypted. **The target docker must run with the source docker's `content_key` secret**, or the moved content and secrets cannot be read. Re-encrypting under a new key is not done here.

## Not moved

Rows with no foreign-key path to the organization (for example login sessions, which hang off the user). People sign in again on the new docker. The engine's own `sticks_*` tables (reactions, record cards, Stick Pulsar tokens, features, drain) have no foreign keys and are not moved yet. Features are re-sent by Pulsar; Stick Pulsar tokens must be re-issued after a move (rotate_token). Moving the rest is a follow-up.

## Proof

Unit tests in `org-move.test.ts` (one tenant out of a shared docker, nothing of the other tenant, second import changes nothing, ordering). Also run by hand against the upstream schema (a newer upstream checkout than the pinned v0.11.0; all migrations applied to Postgres 16, two tenants seeded with user, member, space, Stick, thread and message): export of tenant A held no row of tenant B, the first import added 7 rows, the second added 0.
