# sticks-server

Our changes to the Sticks AI server, kept as a small patch set on top of a pinned upstream release.
No upstream source lives here. Upstream is read straight from https://github.com/elie222/rakazo
(Apache-2.0); there is no mirror or fork to depend on.

| Path | What it is |
|---|---|
| `upstream.pin` | The one upstream release tag we run (plus commit and image digests). Moves only by reviewed PR. |
| `patches/` | Our ordered patch set (`series`). Empty today: stock upstream until a real change is needed. |
| `contracts/used-procedures.txt` | The server calls our Dart app makes (generated from the Dart source by `scripts/extract_used_procedures.py`). Checked against every new upstream tag. |
| `scripts/sync_upstream.py` | Finds the newest upstream tag, applies our patches to it, checks the contract, writes a report. Never pushes. |
| `scripts/render_env.py` | Prints the image lines (tag + digest) the hub adds to a tenant's `.env`. |
| `templates/stick-defaults.md` | The default instruction block every Stick gets (use the shared board, work through a list without stopping). Applied by the backend with `scripts/stick_defaults.py`, never by patching upstream's prompt. |
| `scripts/keep_going.py` | Keep-going loop: when a Stick's run ends with open board tickets or scratchpad items and it is not waiting on the owner, send one "continue". Off per Stick by default; capped tries, per-day count and spend. Policy sample in `deploy/keep-going.sample.json`. Logic and tests only; the backend supplies the client. |
| `scripts/rakazo_client.py` | Small client for the Sticks server API (same wire format as the app). Connection settings from the environment only. |
| `scripts/apply_stick_defaults.py` | Writes the default instruction block into every active Stick (dry run unless `--write`; refuses to overwrite an edit made at the same moment). |
| `scripts/keep_going_runner.py` | Runs the keep-going loop against the server as a small sweeper (bounded batch per tick, saved cursor). Only Sticks switched on in the policy are read. The loop ends on complete (board empty) or blocked (with a reason). |
| `scripts/setup_tenant.py` | Tenant setup on the server: names the tenant's one space after the company and applies the default instructions. |
| `templates/report.md` | Report layout (status, patches, contract check, changelog, what to do). |
| `scripts/reporting_lines.py`, `docs/reporting-lines-and-templates.md` | Reporting lines, pings by role and Stick templates: design and tested reference rules. |
| `deploy/` | Sample settings and compose override (no secrets; settings are agreed one by one first). |
| `.github/workflows/sync-upstream.yml` | Weekly run that opens a draft PR to move the pin, or an issue when something conflicts. |

## How a sync works
1. The script looks for the newest `vX.Y.Z` tag on upstream (main and `edge` are never followed).
2. It clones that tag into a temp folder, applies `patches/series` on top, and checks every procedure
   in `contracts/used-procedures.txt` still exists in upstream's `packages/contracts/src/rpc.ts`.
3. It writes a report with the upstream changelog entries since our pin (Changed / Removed / Fixed) and a comparison of the pinned version with the new one by area (mobile, web, desktop, server, contract, infra, website...). If the mobile, web or desktop app changed, the report says CHECK BY HAND with the changed files and commit subjects, so someone can decide whether any of it is worth bringing to the Sticks app.
4. Exit code: `0` up to date, `10` newer tag ready (pin move proposed), `20` a patch conflicts,
   `30` the app would break. The pin never moves on `20` or `30`.
5. Never force-pushes, never writes to upstream, never changes `main` except through a merged PR.
   A new pin is tested on a test instance before the production server. Hub deploys read `upstream.pin`;
   only the control hub controls Docker.

Run it by hand: `python scripts/sync_upstream.py --report report.md` (add `--write-pin` to update the
pin file when the result is `10`). Tests: `python -m unittest discover -s tests -t .`

## Status
Seeded 2026-11-09. The script and tests were run locally against upstream `v0.8.0` (up to date, newer
tag, conflicting patch and missing procedure paths all checked). The scheduled workflow is NOT yet
run on GitHub. Nothing is deployed from here yet.

## Licence
Apache License 2.0 (see `LICENSE`), the same licence as upstream Rakazo. `NOTICE` records the
copyright and the upstream attribution. Any build or image made from upstream source plus our
patches must keep upstream's own LICENSE and NOTICE files.
