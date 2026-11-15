# Build brief: the Sticks server

Repo: `RokctAI/sticks-server`. Follow this file exactly.

Task 5b, then 6, 7 and onward, in order. Each task needs the tasks listed in its heading to be merged first.

## Rules that matter most
1. **Nothing runs on this computer except git, editing files and `gh`.**
   - Reading upstream code is fine: open it on GitHub, or `git clone` it and only read the files. Installing or building it is not.
   - No pnpm, node, npm, vitest, Docker, Postgres, the engine or the Python tests.
   - If you installed anything for this work in an earlier session, leave it alone. It has been cleaned up.
2. **Every check runs in CI on your PR.**
   - Read the result with `gh pr checks <n>`, and the failure log with `gh run view <id> --log-failed`.
   - Fix and push until it is green. A task is done only when CI is green.
3. **One task = one draft PR to `main`.**
   - Branch `kilo/<topic>`, made from the latest `main`.
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
This file is the whole brief. Read it on `main`, find the first task not marked DONE, and continue. The owner keeps it current as PRs merge.


Status as of 2026-11-15: tasks 1-6 and 5b merged (#7, #8, #10, #11, #12, #14, #17; CI #9). Task 6 merged as #17. Next: task 6b, then 7.
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
   - Branch `kilo/<short-topic>`, made from the latest `main`.
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

### Task 6b: cut messaging and the adapters barrel (spec §11.2, §9; needs 6; one PR, branch kilo/cut-messaging-adapters)
Decided, do not ask again:
- **Messaging:** spec §11.2 settles it. Cut every messaging app and the team-chat bridge (not mounted, not imported). Keep only `messaging/status`, which returns "none". Sticks talk to the user through the Sticks app and the onboarding chat only. Edit `apps/api/src/app.ts`, the router and the bridge directly (patch in `patches/`). Keep the routing test green: nothing in `contracts/used-procedures.txt` may 404.
- **Adapters barrel:** stop importing `@rakazo/adapters` as one barrel. In `app.ts`, import each provider we use from its own module path, and build only those. Providers we use: Postgres, the model and speech gateway (task 13), the in-container computer and sandbox (tasks 15-16), and the storage the engine already needs. Everything else is not imported. If a cut provider is still referenced, guard it so it is never constructed.
- Re-run the Measurements job and put the new idle RSS [measured] in the PR, beside 635.9 MB (#17). Target 150 MB. If it is still above 300 MB, list the five largest modules loaded at idle (from a heap or require trace in CI) and stop there.

### Task 7: the memory job driver as a supported mode, with the boot pass (spec §7.6 "Boot pass", §11.4; needs 5)
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

### Task 9: sign-in by Pulsar token (spec §5.3 row 1, §7.2, §11.1 "Sign-in"; needs 5)
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
- All model and speech providers point at `STICKS_GATEWAY_URL`, with the key read from `/run/secrets/gateway_key`.
- No provider key is read from the environment. Add a test that fails if one is.
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

### Task 19: the onboarding bot's harness side (spec §4.8; docs and samples only)
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

### Task 20: apps without a plugin still work in the trimmed engine (spec §4.7; needs 6)
- Check that upstream's paths for adding tools still work in the trimmed engine (`docs/integrations.md`, "Add your own tools"; `docs/build-a-plugin.md`):
  - an OpenAPI or GraphQL connector (a description file only);
  - an MCP plugin (`plugin.json` plus `mcp.json`).
- Add vitest cases for each of these:
  - an admin approves a connector before any Stick can use it;
  - read actions run freely, and write actions ask for approval (`packages/core/src/action-approval.ts`);
  - credentials are never sent to the model;
  - the call leaves from the engine, never from the sandbox.
- Do NOT build who writes new plugins (a builder Stick or a hub service). The spec leaves that open.

## When you are done with all of them
Reply to the owner with one line per PR: the number, the title, and merged / open / blocked.
