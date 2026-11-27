# Plugin build requests and skills

Status: GitHub plugin seeding is done (built-in, seeded at boot from github-plugin-document.ts).

## Still to do

- Removed on 11-27 (owner's word): plugin build requests and the "Build a plugin" skill. A Stick does not write a plugin when a service has none; plugins are ours (built-in or seeded). plugin-builder.ts and plugin-draft-store.ts stay: they turn our own descriptions into stored, admin-approved plugins. Patch 0007 drops the "Building a plugin" entry from upstream's built-in docs list, the only place the bot was taught to write one.
- Upstream's installed-connector record (there is no seeding hook at v0.11.0). Revisit on the v0.13.0 repin.
