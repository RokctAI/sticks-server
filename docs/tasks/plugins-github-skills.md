# Plugin build requests and skills

Status: GitHub plugin seeding is done (built-in, seeded at boot from github-plugin-document.ts).

## Still to do

- Plugin build requests: a bot builds a plugin when none exists, and an admin approves it. The decisions were settled in #63; the pieces are plugin-builder.ts, plugin-draft-store.ts and callGateForStored.
- Skill registration.
- Upstream's installed-connector record (there is no seeding hook at v0.11.0). Revisit on the v0.13.0 repin.
