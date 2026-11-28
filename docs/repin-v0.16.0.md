# Repin v0.11.0 -> v0.16.0 (2026-11-28)

Ray, 2026-11-28: the app repins first so the server can repin. The Sticks app needs no code change for v0.16.0
(all 131 procedures in contracts/used-procedures.txt exist in the split contract), so its version.json moves to
v0.16.0 together with this pin. This also settles issue #98 (the 23 Nov sync stopped at patch 0001).

## What changed upstream that touched us
- Files moved into subfolders: run-*.ts under packages/adapters/src/runs/{assembly,tools,executor}, db events
  under packages/db/src/threads, client and row security under packages/db/src/database, content keys under
  packages/db/src/encryption, action-approval under packages/core/src/runs, cron under core/src/routines/schedule.ts,
  builtin-skills became tools/builtin-skills.prompt.ts, desktop-sandbox under providers/computer/desktop,
  api helpers under apps/api/src/{http,account,email,messaging,...}.
- packages/contracts/src/rpc.ts and domain.ts were split per area. scripts/sync_upstream.py now reads the
  split files (contract_source) when rpc.ts is gone.
- The ticket board moved behind Labs (#4575): the engine sets deploymentLabs: ["board"] instead of
  ticketBoardEnabled.
- Messaging is now built by configuredMessaging and started with a delivery and team-chat pair; patch 0004
  cuts both and the Slack callback. isMessagingInstallationActive is undefined.
- Sign-in and referral emails now depend on emailCopyAvailable; patch 0003 still cuts them.
- Approval gate: the second outboundSiteGate call (pages on the bot's computer) keeps upstream behaviour.
  Patch 0010 now looks up taint only when a check needs it (the lookup reads the run's attempts), and a search
  result's exact URL is not treated as a link from outside content (it came from the bot's own search).

## Checks run (local, Node 22 with engine-strict off)
- All patches apply in order with plain `git apply` on a fresh v0.16.0 checkout.
- tsc --noEmit clean for packages/core, contracts, db, adapters, apps/api and apps/sticks-engine, apart from
  upstream's own stripe-invoice-refund.ts error, which is in a file no patch touches.
- vitest packages/core and packages/adapters/src/runs: compared with stock v0.16.0, six tests change result,
  all from patch 0010 by design: a send after outside content goes to a person instead of Auto Review or an
  always-allow rule (executor-readonly-approval.test.ts: four "Auto Review of targets only outside content
  named" cases and the two "runs demo_send_message in a webhook run when it is always allowed" cases).
- Overlay: 46 of 49 test files pass (303 tests); the three that need Postgres in a container could not start
  here and run in CI.

## Self-host notes for the platform (from the upstream changelog)
- v0.16.0 refuses signed-in browser requests from origins outside the trusted web origins: add the Sticks web
  address to the extra auth origins.
- Without NODE_ENV=production the sign-in rate limit is off unless AUTH_RATE_LIMIT_ENABLED=true.
- After deploy, once the old release has stopped, run `content-encryption migrate` (v0.14.0).
- Welcome, referral and similar emails need EMAIL_COPY_DIR (we cut them anyway).
- BOT_MESSAGE_MAX_HOPS is gone (fixed at 100).
