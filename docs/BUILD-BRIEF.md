# Build brief: the Sticks server

Repo: `RokctAI/sticks-server`. Follow this file exactly.

Task 5b, then 6, 7 and onward, in order. Each task needs the tasks listed in its heading to be merged first.

## DO THIS NOW (read first; overrides everything below)
Merged up to #60, see report #38. The upstream clone is `~/sticks-upstream` (v0.11.0). Reuse it; never clone again.
These answers SETTLE the items report #38 lists as BLOCKED (11-20). Do not re-ask them:
- **Task 9 session layer:** a verified Pulsar token signs the user in through better-auth's own session creation. The user row is keyed by the Pulsar user id (upsert on each sign-in; email `<user id>@<tenant>.sticks.invalid`, never used to send mail). The session lasts 12 hours; a fresh token renews it. After a test proves this, unmount password, code, passkey and SSO routes. This unblocks tasks 10, 11, 12 and 14.
- **Guest role:** map `Sticks Guest` to upstream's lowest member role, with tools, runs and memory writes refused by our overlay check.
- **Task 18 summariser:** two-phase. End-of-day enqueues upstream's `history.compact` job per chat, and finishes the day (remember, clear) when that job completes. No patch exposing memoryProviders. The Engram write keeps its fake until core ships the endpoint; that is core's work, not here.
- **#40 counts:** add a counter to upstream's stream response handler through a file in `patches/` (count open responses, not subscriptions). Live scripts: the helper records each process group it starts and counts the groups still alive (check with `kill(-pgid, 0)`). Then push on change and the sleeping notice.
- **#41 boot seeding:** ship the GitHub description as a TypeScript module (an exported object), not a file read through `import.meta.url`, so it survives the esbuild bundle.
- **#42 skill:** build the plugin-building tool and the request route from the 11-17 update below first, then register the skill with a one-entry patch to upstream's SKILLS list.
- **Task 17 tenant image:** pin Pulsar by commit in `docker/PULSAR_COMMIT`. CI builds the engine layers only; the Pulsar layer is built where core is reachable. Write the stage now with a build arg.
- **#50 review note:** `sendToHelper` uses a fixed 130 s timeout. Make it the request's `timeoutMs` plus 10 s, so long commands are not cut off by the client.
Work list, one draft PR per line, no CI checks between:
1. Task 9 session layer (with the Guest mapping).
2. Tasks 10, 11, 12, 14 in order, each its own PR.
3. Task 18 summariser (two-phase).
4. #40 counts, push on change, sleeping notice.
5. #41 description as a module, and the boot call.
6. #42 plugin build requests (the 11-17 update below), then the skill registration.
7. Task 17 tenant image stage.
8. The `sendToHelper` timeout fix, and the `startHelper` comment ("the runner makes the engine's user the owner").
9. Task 23 freeze fallback (spec 7.6) once a cold-start number is in a report; task 24 CI check that every `patches/` file applies to v0.11.0.
10. Append the results to report #38. Then reply in two lines.

## Rules that matter most
1. **Nothing runs on this computer except git, editing files and `gh`.**
   - Reading upstream code is fine: open it on GitHub, or `git clone` it and only read the files. Installing or building it is not.
   - No pnpm, node, npm, vitest, Docker, Postgres, the engine or the Python tests.
   - If you installed anything for this work in an earlier session, leave it alone. It has been cleaned up.
2. **Every check runs in CI on your PR.**
   - Read the result with `gh pr checks <n>`, and the failure log with `gh run view <id> --log-failed`.
   - Fix and push until it is green. A task is done only when CI is green.
3. **One task = one draft PR to `main`.**
   - Branch `rokct/<topic>` (never `kilo/`), made from the latest `main`.
   - Never stacked, never force-pushed, never pushed to `main`.
   - Do not edit `.github/workflows/ci.yml`.
4. **Fork forever.** We never follow upstream after v0.11.0. Overlay files may replace upstream files.
5. **Files and text.**
   - LF line endings.
   - No secrets anywhere.
   - No AI model names in commits or PR text.
   - No personal names in code.
   - No `rakazo` in new file names.
   - Our TypeScript goes under `overlay/`; an overlay file may replace an upstream file.
   - Never delete feature code.
5. **Numbers.** [measured] numbers come only from CI job summaries, with the link.
6. **Toolchain.** At v0.11.0, upstream uses pnpm 12.18.0 (via corepack) and Node `^24.15.0 || >=26.0.0`. Never hard-code either.
7. **When the spec does not settle something,** write `BLOCKED: <question>` in the PR and move to the next task that does not depend on it. Do not build anything listed in the spec's §13 "Proposals, not yet decided".
8. **You cannot message anyone.** End each reply with a block the owner can paste into the project chat:
   - the PR number and link;
   - the CI run link and its result;
   - one line saying what the PR does;
   - the claims to verify.


## How to use this file
This file is the whole brief. Read it on `main`. The owner keeps it current as PRs merge.

## How a session runs (owner, 11-15; this overrides any older "stop" or "report" rule)
- Work through **every** task whose needs are already merged on `main`, in the order below. One draft PR per task, each branched from the latest `main`. Never stack.
- **Clone upstream once.** Keep one clone of v0.11.0 in a fixed folder (for example `~/sticks-upstream`), reused by every task and every session. Before cloning, check if it exists; if it does, `git -C <folder> checkout -- . && git -C <folder> clean -fd` to reset it instead of cloning again. Never clone per task. Delete it only when all tasks are DONE.
- **A blocked task never stops the session.** If a task is BLOCKED, write why in the report and go straight on to every other task whose needs are merged. Only stop when no such task is left. Today that means 7, 9, 13, 15 and 20 can all start now, alongside 6b-3.
- Do not wait for CI. Push, open the PR, and go straight to the next task. Never start a background monitor, watcher or sleep loop.
- Before you report, read each PR's checks once (`gh pr checks <n>`). Fix any red ones, push, and move on.
- **Reports go in a report PR, not in chat.** Keep one docs-only draft PR to `main` (branch `rokct/report-<date>-<n>`) that adds `docs/reports/<date>-<n>.md`. After each step PR, append one short section: task, PR link, what it does, CI result, claims to verify, anything BLOCKED or decided. If the previous report PR is merged, open a new one (new file, new branch from `main`); never edit a merged report.
- Stop when every task left needs a PR that is not merged yet. Your final reply in chat is at most two lines: the report PR link and "done" or "blocked: <one line>". This replaces both paste blocks above.

### Which open tasks can run in the same session
After 6b-1, 6b-2 and 6b-3 (in order), these groups only need work that is already merged:
- **Independent now (each needs only task 5, 3 or 6):** 7, 9, 13, 15, 19, 20.
- **Once 20 is merged:** 21 and 22.
- **Once 7 is merged:** 8. **Once 9 is merged:** 10 and 11. **Once 15 is merged:** 16 and 17.
- **Once 7 and 9 are merged:** 12. **Once 7 and 12 are merged:** 14. **Once 7 and 13 are merged:** 18.
So one session can open 7, 9, 13, 15, 19 and 20 side by side. The 6b steps are a chain, so open only the first unmerged one.


Status as of 2026-11-15: tasks 1-6 and 5b merged (#7, #8, #10, #11, #12, #14, #17; CI #9). Task 6 merged as #17. 6b-2 merged as #23 (idle RSS [measured] 397.3 MB built, 620.2 MB tsx, run 43736449751); 19 merged as #24. Next: 6b-3 (measurement only), and 7, 9, 13, 15, 20 alongside it.
Report #25 merged; 6b-3 is #28.
The sync work already merged (#7, #8, #11) stays as it is; just add no more.

**Nothing runs on this computer except git and editing files.**
To read upstream code, open it on GitHub or `git clone` it and only read the files. Never run pnpm install, node, a build, docker or tests on this computer.
- Do not run pnpm, node, npm, vitest, Docker, Postgres, the engine, or the Python tests here. they slow the owner's computer.
- Every check runs in GitHub Actions, in the repo's `ci` workflow, on your PR. The repo is public, so CI costs nothing.
- Your loop for each task:
  1. Write the code.
  2. Push the branch and open the draft PR.
  3. Read the CI result with `gh pr checks <number>`. For a failure, read the log with `gh run view <run id> --log-failed`.
  4. Fix and push again until CI is green.

## What you are building

- **This repo, `RokctAI/sticks-server`, holds our changes to the upstream engine.** The engine is the open-source agent server at `https://github.com/elie222/rakazo` (Apache-2.0). This repo holds no copy of its source.
- **The design is fixed.** It is in `RokctAI/core`, file `docs/sticks-saas-backend-spec.md` (merged 14 Nov in core#1533). That file is the SaaS spec (first opened as core#1485), revised with the owner's later rulings. Read it once before task 1, and again for each task: every task names its spec section. Where this brief and the spec differ, the spec wins; say so in the PR.
- **The target:** one Docker container per tenant holds three processes.
  - **Pulsar** is our Python backend from `RokctAI/core`. It holds accounts, roles, credits and settings.
  - **The engine** is upstream, trimmed to one Node process.
  - **A small headless code sandbox** runs as the non-root user `sticks`.
- **The rest of the setup:**
  - There is no computer and no desktop in v1.
  - Postgres is one shared server outside the container, with one database per tenant.
  - All model and speech calls go to our model gateway, which is a separate service.

**Not in this repo. Do not build these:**
- Pulsar code: the credit doctypes, signing tokens, settings and the onboarding tools. These live in `RokctAI/core`.
- The runner: container lifecycle, firewall rules and wake on request. This belongs to the control hub.
- The model gateway.

Where a task here needs one of these, build our side against a fake in the tests. Write the exact interface in `docs/pulsar-engine-interface.md`, so the core side can be built to match.

## Rules (all tasks)

1. **One task = one draft PR to `main`.**
   - Branch `rokct/<short-topic>`, made from the latest `main`.
   - No stacked PRs: never branch from another unmerged branch.
   - If a task says "needs task N merged", wait until it is merged on `main`.
2. **Never force-push. Never push to `main`.** Never open a PR or issue on `elie222/rakazo`.
3. **Line endings.** LF only. Keep `.gitattributes` as it is.
4. **No secrets anywhere:** not in code, tests, samples, logs or PR text.
   - Settings come from the environment or from files under `/run/secrets/`.
   - Samples use placeholders like `<gateway-key>`.
5. **Names.**
   - No AI model names or IDs in commit messages, PR text or code comments.
   - No personal names or Stick names in code, defaults or tests.
   - No `rakazo` in any new file or folder name. Use `sticks` or `engine`.
6. **Do not edit upstream files.**
   - **We fork once and never follow upstream again** (the owner, 11-15). Never add work whose only purpose is keeping up with upstream Rakazo (no sync, no re-sync checks, no exit-code contract work).
   - Our TypeScript goes under `overlay/` as new files. Edits to upstream files go in `patches/` (as in 0001). The build keeps refusing overlay files that would replace an upstream file; do not change that. Do not ask about this again.
   - `patches/` stays usable for small edits; no reason line needed.
7. **Never delete feature code.** If something should go, say so in the PR and leave it.
8. **Checks run in CI only** (the `ci` workflow):
   - The **Python tests** job runs on every PR. It also fails on any CRLF file.
   - The **Engine** job runs `scripts/build_engine.py` once that file exists (task 3): the upstream install, the typecheck, and our vitest files.
   - The **Measurements** job runs `scripts/measure_engine.py` once it exists (task 6).
   - The **Images** job builds every stage of `docker/Dockerfile` once it exists (task 17).
   - A task is done only when CI is green on the PR. Paste the CI run link and the result in the PR.
9. **Label every number in the PR.** Mark it **[measured]**, with a link to the CI job summary it came from, or **[estimate]**. Never present a guess as measured. You measure nothing on this computer.
10. **When the spec does not settle something, stop.** Write `BLOCKED: <question>` in the PR and stop that task. Do not invent a design. Items listed under "Proposals, not yet decided" in the spec's section 13 are NOT to be built.
11. **After opening each PR (you have no messaging tool, so do not try to send anything):**
    - End your reply with a short block for the owner to paste into the project chat:
      - the PR number and link;
      - the CI run link and its result;
      - one line saying what it does;
      - the list of claims to verify.
    - Do not mark the PR ready yourself. The gatekeeper verifies it and flips it, then it is merged for you.
    - Before starting a task that needs another task, check that the other task's PR is merged on `main`.

## Tasks, in order

### Tasks 1 and 2: DONE (merged as #7 and #8). Task 3: DONE (merged as #10).

**Toolchain (checked on upstream v0.11.0):**
- pnpm 12.18.0, taken from upstream's `packageManager` field through corepack;
- Node `^24.15.0 || >=26.0.0`.

CI uses Node 24 with corepack. Never hard-code either version.

### CI workflow: merged (#9), so task 3 can start
It adds `.github/workflows/ci.yml`. Do not edit that file in your tasks. If a job there needs a change, say so in your PR and leave the file as it is.

### Task 3: overlay folder and engine build script (spec §11.4; needs #9 merged)
- **`overlay/`:** new files copied onto the upstream checkout at the same relative paths. Add `overlay/README.md` explaining this.
- **`scripts/build_engine.py`:**
  1. Clone the pinned tag into the folder given by `--workdir` (CI passes one).
  2. Apply `patches/series`.
  3. Copy `overlay/` on top. **Refuse** if any overlay file would overwrite an existing upstream file, and exit 2 listing them.
  4. Run `pnpm install --frozen-lockfile` and upstream's typecheck. The pnpm version comes from upstream's own `packageManager` field through corepack (at v0.11.0: pnpm 12.18.0; Node `^24.15.0 || >=26.0.0`). Do not hard-code a version.
  5. Run `vitest run` on our overlay test files only.
- Python tests cover the refuse-overwrite rule and the patch order, using small fake folders, no network and no pnpm.
- You do not run it. CI's Engine job runs it on your PR.
- README: add the two new paths to the table.

### Task 4: DONE (merged as #11). No further sync work: we never follow upstream.
- After a newer tag is found, `sync_upstream.py` runs `build_engine.py` against the new tag.
- If the overlay no longer builds, exit `40` ("our engine code breaks"), and the pin does not move.
- Update the exit-code list in the README and in `.github/workflows/sync-upstream.yml` (open an issue on `40`, like `20` and `30`).

### Task 5: DONE (merged as #12). One-process engine, composition root (spec §4.2, §11.1 rows 1, 7, 9, 10; needs 3)
- New app under `overlay/apps/sticks-engine/`.
- It starts upstream's API and worker in **one** Node process using `createApp` (`apps/api/src/app.ts`), with `WAKEUP_DRIVER=memory` and `TICKET_BOARD_ENABLED=true`.
- There is no web server, no Caddy and no separate worker.
- Events are delivered in process, with no Postgres notification listener.
- The database pool closes idle connections after 30 s.
- **Database (spec §4.3, §8.2):**
  - Connect to the shared Postgres with the tenant's one login. Read the password from `/run/secrets/db_password`, never from the environment.
  - Keep the default `public` schema.
  - Run upstream's migrations on boot.
  - Never create roles or grant role membership. Do not run upstream's step that adds the app login to `rakazo_app`.
- **Content encryption (spec §8.3):** read the master key from `/run/secrets/content_key` and pass it to upstream's content encryption. It must never be written to the volume or the database.
- Endpoints: `GET /health`.
- Test: a vitest that starts the root against a test database (use upstream's `packages/testkit`), sends one message and sees one run complete.

### Task 5b: DONE (merged as #14). pool idle close, client IP and overlay typecheck (needs 5; one small PR, branch kilo/engine-pool-ip)
- **Pool idle close:** change upstream's `packages/db/src/client.ts` directly (patch in `patches/` or an overlay file replacing it; we never follow upstream). Make `idleTimeoutMillis` an option of `createPool`, default unchanged (0). The engine root passes 30000. Add a vitest case that the option reaches the pool.
- **Overlay typecheck:** in `scripts/build_engine.py`, after the overlay is copied, run `tsc --noEmit` over our overlay files with a tsconfig in `overlay/` that extends upstream's base config. A type error fails the build. Do not edit ci.yml: the Engine job already runs build_engine.py.
- **Client abort:** in serve.ts, when the client disconnects mid-stream (req "close"), cancel the response body stream and stop reading; add a test.
- **Client IP:** in the node:http adapter, pass the real client address on: take `req.socket.remoteAddress`, set it where upstream's per-IP limit reads the IP (check which header or field upstream uses; only trust `X-Forwarded-For` when the request comes from the tenant's own proxy, which the spec puts in front). Add a test that two different addresses get separate limits.

### Task 6: DONE (merged as #17). Cut what Sticks does not use (spec §11.2, §5.2; needs 5)
- **Also in this PR (two small fixes from 5b review):** (1) `serve.ts` waitForDrain: return at once when `res.destroyed` or `res.writableEnded`, so an aborted request never hangs; add a test. (2) `build_engine.py`: if `tsc` exits non-zero and printed no `error TS` line at all, fail the build.
- The composition root must not import the modules on the §11.2 list (messaging apps, phone calls and call push, bot email, referrals and plans, desktop sockets, push, wallet and purchases, account import and export, plugin submissions, remote computer providers, analytics). Where upstream imports one statically, use a patch that makes the import lazy, with a one-line reason.
- **Rule:** nothing that a call in `contracts/used-procedures.txt` needs may be cut. Add a test that loads that file and checks each procedure is still routed.
- `organizations/create` and `spaces/create` are refused with a clear error.
- Add `scripts/measure_engine.py --workdir <dir> --summary <file>`. It starts the built engine against a Testcontainers Postgres, reads its idle memory (RSS), and writes a small table to the summary file.
- CI's Measurements job runs it. Copy the number into the PR as [measured], with the CI link.

### Task 6b: split into three PRs, in this order (decided; do not ask again)
Do each as its own draft PR. After each one, record the idle RSS [measured] from CI in the PR. If after any step RSS is at or under 150 MB, mark the remaining 6b steps "skipped, target met" and move to task 7.

#### Task 6b-1: DONE (merged as #20; idle RSS [measured] 625.4 MB tsx, 441.4 MB built, run 43734567780). Measure the built engine (needs 6; branch rokct/measure-built)
- In `scripts/measure_engine.py`, bundle the engine entry with esbuild (already in upstream's dev dependencies; if not, use the version upstream's lockfile has) into one file, with workspace packages bundled and node_modules external. Run it with plain `node`, not tsx.
- Report both numbers in the summary: tsx RSS and built RSS, [measured].
- Change only the measure script and its test.

#### Task 6b-2: DONE (merged as #23). Cut messaging (needs 6b-1; branch rokct/cut-messaging)
- Spec §11.2: messaging apps and the team-chat bridge go. `messaging/status` stays and answers "none".
- One patch (`patches/0004-...`) touching: app.ts, the router deps, `routes/messaging.ts`, the team-chat judge and inbound paths, the thread-send path, and the account-import hooks. Where code needs a messaging object, pass a no-op object that does nothing and reports "none"; that keeps type changes small.
- CI typecheck is your compiler: push, read the tsc errors with `gh run view --log-failed`, fix, push again. Several CI rounds are expected and fine.

#### Task 6b-3: DONE (merged as #28; 405.1 MB built, 622.1 MB tsx [measured], run 43738227283). Find what uses the memory, in CI (decided 11-15; needs 6b-2; branch rokct/memory-profile)
- Measurement only, no barrel changes. In `scripts/measure_engine.py`, for the built run, also start node with `--heap-prof` (or take one heap snapshot after the 10 s settle) and add a table to the job summary: the 15 largest packages by retained size at idle (group by `node_modules/<package>`), [measured].
- That is all. Changing the barrel waits until the owner's thread reads that table and writes the next step here. Not your decision.

#### Task 6b-4: DONE (merged as #37; no lazy import possible without changing exports; 6b chain stopped). Lazy-load the email and CSS tooling (decided 11-15 from #28's table; needs 6b-3; branch rokct/lazy-email-css)
- At idle the engine holds jsdom, css-tree, react-email, tailwindcss, sucrase, nodemailer (and their deps). Idle Sticks do not send email or render HTML. Find the modules that import them at load time (start from the mail/email-render modules in the adapters barrel) and change those imports to `await import()` inside the function that uses them. Exported names and types stay the same.
- In `measure_engine.py`, split the "other" row of the heap table by URL prefix (node:, file: outside node_modules, eval/anonymous), so the next read shows where the 62% sits.
- Record the new built RSS [measured]. Do not change the 150 MB target; if this step saves under 30 MB, say so in the report and stop the 6b chain there.

### Task 7: DONE (merged as #32). the memory job driver as a supported mode, with the boot pass (spec §7.6 "Boot pass", §11.4; needs 5)
- On every start, before serving, run one pass that recovers:
  - runs whose lease expired;
  - waiting runs now due;
  - routines now due;
  - completed runs with no keep-going decision;
  - runs with usage records but no credit settlement.
- After the pass, hold **one** timer for the nearest due item. Nothing polls.
- Tests: restart with queued work, crash in the middle of a run, a lost timer.

### Task 8: idle and next-wake endpoint (spec §7.6; needs 7)
- `GET /internal/idle` returns `{ "idle": bool, "since": iso, "next_wake_at": iso|null }`, using exactly the rules in §7.6.
- It also pushes on change to the address in `STICKS_IDLE_PUSH_URL`, if set.
- After the quiet period, close idle client streams with a "sleeping" notice.
- On a stop signal: finish or lease out work, close all database connections, then exit.
- Protect `/internal/*` with the per-tenant secret read from `/run/secrets/engine_secret`.
- Extend `scripts/measure_engine.py` to also time a cold start to the first response (target: 3 s). Spec §9.7 item 1 says these numbers decide between stopping and freezing a sleeping tenant. Take both numbers from CI's Measurements job.

### Task 9: verifier merged as #33; wiring is task 9b. sign-in by Pulsar token (spec §5.3 row 1, §7.2, §11.1 "Sign-in"; needs 5)
- The engine accepts only a short-lived token signed by Pulsar: ed25519, payload `{tenant, user, role, exp}`. Read core's `pulsar.envelope` code in `RokctAI/core` and match its format exactly.
- The public key comes from `/run/secrets/pulsar_public_key`.
- The first valid token for a new user creates the thin user row.
- Map the roles: `Sticks Owner`, `Sticks Admin`, `Sticks Member`, `Sticks Guest` to upstream's roles. Put the mapping table in the PR.
- Password, emailed code, passkey and single sign-on routes are not mounted.
- Write the token format in `docs/pulsar-engine-interface.md`.
- Tests: valid, expired, wrong key, wrong tenant, unknown role.

### Task 10: first boot (spec §7.1 step 3; needs 9)
- Move what `scripts/setup_tenant.py` and `scripts/apply_stick_defaults.py` do into the engine's first boot.
  - Create the one organization and the one space, named after the company (from `STICKS_COMPANY_NAME`).
  - Every new Stick gets `templates/stick-defaults.md`.
- Keep the Python scripts. Mark them in the README as "replaced by engine first boot".

### Task 11: settings from Pulsar (spec §5.1 "Sticks Settings", §5.3 row 4; needs 9)
- `POST /internal/settings` (secret-protected) receives: default model, approvals policy, sleep delay, browser allowed, home quota and keep-going defaults.
- The engine also pulls the settings at boot. Hub limits (`hub_settings.limits`) win over local values.
- Write the shape in `docs/pulsar-engine-interface.md`. Test it with a fake Pulsar.

### Task 12: credits from Pulsar (spec §6, §5.3 rows 2-3; needs 9 and 7)
- **A `ModelCallObserver`** (`packages/adapter-kit/src/types.ts`) that draws from a Pulsar reservation, so a run spends from its block:
  - **run start:** `credits.reserve(run, stick, user)`. A refusal means the run does not start, and the user sees the reason.
  - **each call:** subtract the call's maximum cost from the block in memory, with no network call.
  - **below 20 percent of the block:** `credits.extend(run)`. A refusal means upstream's existing "credits exhausted" error.
  - **run end:** `credits.settle(run, used_micros, usage)`, idempotent on the run id.
  - **boot:** re-send `settle` for unsettled runs (the boot pass from task 7).
- **Transport:** the calls go to Pulsar over the unix socket in `STICKS_PULSAR_SOCKET`, with the per-tenant secret.
- **Units:** micro-dollars, with 10,000 per credit.
- **Stripe:** pass the billing override to `createApp` so upstream's Stripe billing is never used.
- Write the three calls in `docs/pulsar-engine-interface.md`. Test against a fake Pulsar: refusal, extend, a crash before settle, and a double settle.

### Task 13: model and speech calls through the gateway (spec §4.4, §8.3, §11.1 "Model and speech keys"; needs 5)
**Gateway protocol (decided 11-15, not BLOCKED any more):** the gateway is a pass-through proxy that speaks each provider's own API unchanged, under a path prefix per provider: `${STICKS_GATEWAY_URL}/<provider>/...` (for example `/anthropic/v1/messages`, `/openai/v1/chat/completions`, `/openai/v1/audio/speech`). The tenant sends its gateway key where the provider's API key would go (`Authorization: Bearer` or `x-api-key`, whichever that provider's SDK uses). Streaming is the provider's own streaming.
- So the engine only changes base URLs and keys: for every model and speech provider upstream supports, set its SDK `baseURL` to `${STICKS_GATEWAY_URL}/<provider>` and its key to the content of `/run/secrets/gateway_key`.
- No provider key is read from the environment. Add a test that fails if one is.
- Test with a small fake gateway in vitest (an HTTP server that checks the path prefix and the key, and returns a canned reply and a canned stream). Do not build the gateway itself; it is a separate service.
- Write the contract in `docs/gateway-protocol.md` (prefixes, auth header per provider, streaming, error codes 401 bad key and 402 over ceiling).
- Do NOT build the "own model keys" refusal: it is an undecided proposal.

### Task 14: keep-going inside the engine (spec §7.5; needs 7 and 12)
- **Port the decision:** port `decide` from `scripts/keep_going.py` to TypeScript unchanged. Port every case in `tests/test_backend.py` that covers it as a vitest fixture, and all of them must pass.
- **When it runs:** listen to the engine's own run-finished event, and act on `completed` only.
- **Counters:** keep them in our own table `sticks_keep_going`, created with `CREATE TABLE IF NOT EXISTS` by our module. Do not add a Prisma migration.
- **Switch:** the per-Stick on/off switch is in the same table, on by default.
- **Defaults:** 3 tries without progress, 20 a day, 60 s gap. The spend cap is Pulsar's Stick daily cap: a refused `credits.reserve` gives the outcome "capped".
- **On continue:** create the next run after the gap, the same way `ticket-wake.ts` does.
- **Old sweeper:** keep `scripts/keep_going_runner.py`, and mark it in the README as "replaced by the in-engine loop; do not deploy".

### Task 15: the sandbox helper (spec §4.6, §8.1; needs 3)
- **Env rule:** the engine holds `ENCRYPTION_KEY` (and other secrets) in its own environment. Start every sandbox process with an explicit, minimal `env` (PATH, HOME, LANG, and only what the job needs). Never pass `process.env` on. Add a test that a sandbox process cannot see `ENCRYPTION_KEY`.
- **A small helper process** that runs as user `sticks`:
  - it takes upstream's control-style commands over a unix socket only `engine` and `sticks` can open;
  - it runs shell and file operations in `/data/home/sticks/<stick id>`.
- **It keeps both upstream 0.9.0 fixes:**
  - never load code from a Stick's home;
  - never inherit the control token.
- **Environment:** it never passes its own environment to commands.
- **Limits:** if a cgroup subtree is delegated, cap it at 512 MB and 256 pids. Otherwise use per-process limits.
- **Browser:** headless Chromium starts for one run only when "browser allowed" is on, with a profile per Stick (`/data/home/sticks/<stick id>/.browser`), and it stops at run end.
- **Self-test script `sandbox-selftest`,** run as `sticks`: try loopback, the container's own address, the Postgres address, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16` and `169.254.169.254`. Exit non-zero if any connection succeeds. It only checks; the runner installs the firewall rules.

### Task 16: the in-container computer provider (spec §11.1 "Docker computers"; needs 5 and 15)
- A provider built from `DesktopSandboxProvider` (`packages/adapters/src/desktop-sandbox.ts`) that sends every command to the task 15 helper instead of running it as the engine's user. It reports `graphical: false`.
- It must run in production. Add a new class rather than editing `assertHostCommandsAllowed`.
- No Docker socket, no supervisor.

### Task 17: images (spec §4.6 "The image", §4.2, §9.4, §12 items 7 and 9; needs 15)
- **One Dockerfile**, `docker/Dockerfile`, with named stages (`FROM ... AS <name>`; CI builds every stage and reports its size), built from upstream's `infra/sandboxes/computer/Dockerfile`, with two targets and tags:
  - `sandbox` (v1): shell tools, Python, git, curl, PDF and office libraries, headless Chromium, no display stack;
  - `desktop`: adds the display stack. Build it, but nothing uses it yet.
- **The tenant image** adds Pulsar from `RokctAI/core` at a pinned commit, the engine from task 5 and a minimal init.
  - **Init** starts `pulsar`, `engine` and `sandbox` as their own users, reaps child processes and forwards signals.
  - **Filesystem:** the root is read-only, with `/data/home`, `/data/engine` and `/data/pulsar` on the volume and secrets on tmpfs.
  - **Health:** Pulsar `/api/method/ping`, engine `/health`, and the sandbox self-test.
- No secret is baked into any image. No Docker socket.
- Image sizes come from CI's Images job summary.
- Extend `scripts/measure_engine.py` for these spec §9.7 measurements, and take the numbers from CI:
  - headless Chromium peak memory on a typical page (item 3);
  - one full run and one keep-going sequence under the 1 GB cap (item 5);
  - the `sticks` self-test in Docker (item 6).
- You build no images on this computer.

### Task 18: end-of-day memory into Engram (the owner's ruling of 14 Nov; needs 7 and 13)
- Once a day per tenant, at the tenant's end of day, an item due at that time does the following:
  1. for each chat active that day, summarise it with the engine's own history-summary code, through the gateway;
  2. write the lasting facts to Engram through a new memory-provider adapter (`rokct`), beside upstream's Supermemory, Serenity and Honcho;
  3. clear that chat's working context, so the next day starts small. The messages stay readable in the app.
- **No timer of its own:** the job is held in `next_wake_at` like a routine (spec §7.6), and never polls.
- **Pulsar's Engram endpoint is not built yet** (core side). Build against a fake, and write the call in `docs/pulsar-engine-interface.md`.
- **No outside memory:** the external memory providers are switched off in the Sticks build, so memory never leaves the tenant.

### Task 19: DONE (merged as #24). The onboarding bot's harness side (spec §4.8; docs and samples only)
- **Scale (decided):** one onboarding bot serves any number of users at once. Each chat is a separate session; the bot keeps no state in memory between turns (all state in the hub DB). The hub runs as many harness workers as needed behind a load balancer. Real limits are the gateway's provider rate limits and Postgres connections (use a pooler). Write this in the sample docs.
- **The logic lives in Pulsar's control SDK** (not here). The harness only gets tools and an instruction.
- **Add `templates/onboarding-bot.md`**, the bot's instruction, from spec §4.8:
  - ask the core questions first, one at a time;
  - save each answer as soon as it is given;
  - never guess or fill in an answer;
  - say which documents are unlocked;
  - call finish only when the tenant says they are done;
  - when the tenant returns, call onboarding state first and continue from the next unanswered question.
- **Add `deploy/onboarding-connector.sample.json`:** the connector entry for the three control-SDK tools (onboarding state, save answer, finish), with placeholder URLs.
- No code.

### Task 20: DONE (merged as #36). apps without a plugin still work in the trimmed engine (spec §4.7; needs 6)
- Check that upstream's paths for adding tools still work in the trimmed engine (`docs/integrations.md`, "Add your own tools"; `docs/build-a-plugin.md`):
  - an OpenAPI or GraphQL connector (a description file only);
  - an MCP plugin (`plugin.json` plus `mcp.json`).
- Add vitest cases for each of these:
  - an admin approves a connector before any Stick can use it;
  - read actions run freely, and write actions ask for approval (`packages/core/src/action-approval.ts`);
  - credentials are never sent to the model;
  - the call leaves from the engine, never from the sandbox.
- Who writes new plugins: we do (task 21, a Stick skill, was removed 11-27).

### Task 21: plugin builder skill (REMOVED 11-27 on the owner's word: Sticks no longer builds plugins; do not build this)
_Original text, kept for the record:_
### Task 21 (original): plugin builder skill (owner's ruling 11-15, settles spec §4.7's open point; needs 20)
- Sticks can write a plugin for us when none exists. Add a built-in skill "Build a plugin" to the engine.
- Input: the service name and its API docs (OpenAPI or GraphQL URL, or its API reference). Output: a connector description (OpenAPI/GraphQL file, read actions free, write actions need approval) saved as a draft plugin in the tenant.
- The draft is never live until a tenant admin approves it (task 20's approval path). Credentials are entered by the admin, never seen by the model.
- If an MCP plugin is needed (logic a description cannot carry), the skill writes the request in the report as BLOCKED: we host MCP servers, Sticks do not.
- Tests: a sample OpenAPI file turns into a draft plugin; a draft cannot be called before approval.

### Task 22: built-in GitHub plugin (owner's ruling 11-15; needs 20)
- First check upstream v0.11.0 for an existing GitHub integration or plugin. If one exists, keep it and make sure the trim did not remove it.
- Otherwise ship `plugins/github/` as a connector description covering: repos (list, get), contents (read, create/update file), issues (list, get, create, comment), pull requests (list, get, create, comment, merge). Reads free, writes need approval.
- Auth: the user's own GitHub token or GitHub App installation, stored as a connector credential, never sent to the model.
- Installed and enabled by default in every tenant (still needs the user's token to work).
- Tests: the plugin loads; a read call goes out with the credential header; a write call asks for approval.

### Update 11-17: plugin build requests (REMOVED 11-27: the build-request flow below is no longer wanted; GitHub seeding in task 22 stays)
_Original heading:_ Update 11-17: plugin build requests (amends tasks 21 and 22; the wording above is kept unchanged)
Settled 11-20 (the six decisions below are accepted; change them only if the owner says so).

Principle: we build our own plugins and do not depend on third-party connectors. GitHub is the first built-in. The tenant wants a task done; a connector is only the means.

Flow when a Stick needs a service that has no plugin:
1. The Stick tells the tenant the task needs a connector for that service, and offers to build one. The tenant can agree or decline. Declining ends the request; the Stick does not ask again for the same service unless the tenant asks.
2. The offer and the approval screen are plain language, for a tenant who is not a developer. They show: the service, why the task needs it, what the Stick will be able to read, what it will change (writes ask each time), and whether a connection is needed. The tenant-facing text does not use terms such as API key, token, OpenAPI or GraphQL.
3. A tenant admin (`Sticks Admin` role) agrees or declines the request. A Stick cannot approve its own request.
4. If agreed, the builder (task 21) creates a draft from the service's API documentation. The draft is not callable until it is built.
5. If the service needs a login, token or key, the Stick guides the tenant through the connection step by step in the app. The credential is entered in the app, stored as a connector credential, and never sent to the model or shown in chat. If the tenant cannot complete it, the request stays open.
6. Once built, the plugin stays built and callable for that tenant. Each write call still asks for approval through `packages/core/src/action-approval.ts`. No further admin approval is needed per use.

State of a request in `plugin_draft`: requested, declined, agreed (building), built. A request is callable only when built. The connection step is a separate field, so a built plugin can still be waiting for its connection.

GitHub (task 22): built by us and shipped with the engine. Seeded at boot if missing, as an approved team catalog entry, installed and enabled per tenant. It does not go through a tenant build request. The tenant's own token is the connection step.

How this relates to the spec: spec §4.7 step 3 says a tenant admin approves the connector before any Stick can use it. This update puts the admin's approval on the build request, before the connector exists. A built plugin is then usable without a second approval. This is the intended reading of §4.7 step 3.

Tests for task 21 (in addition to the tests above): a request cannot be agreed by the Stick that raised it; a declined request is not rebuilt; a draft cannot be called before it is built; a built plugin with no connection yet cannot be called.

Reviewer: check this update does not regress the wording of tasks 21 and 22 above. That wording is kept unchanged. The one reading that changes is task 21's "the draft is never live until a tenant admin approves it": under this update the admin approves the request, and the draft is still not callable until built. Check the two readings are consistent and that nothing above was dropped.

Settled decisions:
1. The admin approves the build request, not the draft (changes the reading of §4.7 step 3 and task 21).
2. A built plugin is callable without a second admin approval; write calls still ask each time.
3. GitHub is seeded as an approved team entry and needs no tenant build request.
4. A declined request is not offered again for the same service unless the tenant asks.
5. The tenant-facing text is plain language with no technical terms.
6. The connection step is guided in the app, and credentials never reach the model or chat.

### Task 25: hub sign-in token as a small standalone SDK (owner's note 11-15, reworded 11-20; after task 9 merges)
- Sticks signs users in with a short-lived token signed by the hub (`overlay/apps/sticks-engine/src/pulsar-token.ts` verifies it; `pulsar-session.ts` and `pulsar-front.ts` turn it into a session). Gravity needs the same sign-in, and Gravity is neither Frappe nor Pulsar.
- So the SDK is backend-agnostic: pure verification with no Frappe, Pulsar or network calls. Input: the token (Bearer value) plus the hub's public key, the expected sender, the app's tenant id and the clock. Output: `{user, role, tenant, exp}` or a coded error (malformed, bad_signature, stale, replay, expired, wrong_tenant, unknown_role). It also ships the replay cache. Role names are passed in by the app, not fixed.
- Where (the owner's ruling 11-20): the private `RokctAI/users` repo, which already holds the auth SDK, under `auth/hub-token/` (TypeScript package `@rokct/hub-token` in `auth/hub-token/ts`, Python package `hub_token` in `auth/hub-token/py`), with the same test vectors on both sides. Not in control, not in a public repo.
- Install: no registry. Apps pin a git tag of the users repo, `hub-token-vX.Y.Z`. TypeScript (pnpm): `"@rokct/hub-token": "github:RokctAI/users#hub-token-vX.Y.Z&path:auth/hub-token/ts"`. Python: `hub-token @ git+https://github.com/RokctAI/users@hub-token-vX.Y.Z#subdirectory=auth/hub-token/py`.
- Access: the org secret `MONOREPO_PAT` (never a per-repo secret, never printed). In CI, before installing: `git config --global url."https://x-access-token:${MONOREPO_PAT}@github.com/".insteadOf "https://github.com/"` with the secret passed as an env var to that step only. In Docker: a BuildKit secret (`--secret id=gh_token,env=MONOREPO_PAT`) mounted only in the install step (`RUN --mount=type=secret,id=gh_token ...`), so it never lands in an image layer.
- Versions: semver tags. A new token format would be a new envelope `v` (2), accepted alongside 1 for a release, so an app on an older tag keeps working until it bumps. It must pass `sdk_validator.py`. It is a backend library, not app-facing, so the demo data, tour and guide rules do not apply.
- Backward compatible: the token format stays exactly as docs/pulsar-engine-interface.md section 1 says; nothing that issues or accepts tokens today changes. The engine then imports it instead of its own copy.
- What stays in each app: turning the verified user into that app's own session (for Sticks: upstream session rows, closed routes, guests).

## When you are done with all of them
Reply to the owner with one line per PR: the number, the title, and merged / open / blocked.
