# Pulsar plugins (Ray 11-21: every part of Pulsar reachable from Rakazo by plugin)

- `pulsar-plugins.ts`: one plugin per area (`PULSAR_AREAS`: crm, selling, accounts, stock, hr, projects). Each has five tools: find and get (read-only), and create, update and submit (each write asks the owner, by upstream's approval rule).
- Seeded at boot as drafts (`pulsar-<area>`). Nothing is callable until a tenant admin approves the area, so approving an area is the switch.
- Proxy `/internal/pulsar/:area/:op`: it only touches that area's record types. It calls Pulsar's `/api/resource` at `STICKS_PULSAR_URL` (inside the same container) with `/run/secrets/pulsar_sticks_token`, the Sticks service user. That user's roles in Pulsar decide what is visible. Callers must be signed in or hold the engine secret.
- Callers: Stick runs (the plugin tools), and the call rules' contact check. The CRM area is the first one used, for calls (Contact, Lead, Customer).
- Not yet: the live end-to-end check (a real model calls the CRM plugin against a real Pulsar), to come as a manual workflow like `live-tool-use.yml`.
- Differs from the first proposal: calls run as the Sticks service user, not as the signed-in person, because plugin calls carry the plugin's connection rather than the person's session.
