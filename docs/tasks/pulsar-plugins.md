# Pulsar plugins (Ray 11-21: every part of Pulsar reachable from Rakazo by plugin)

- `pulsar-plugins.ts`: one plugin per area (`PULSAR_AREAS`: crm, selling, accounts, stock, hr, projects). Each has five tools: find and get (read-only), and create, update and submit (each write asks the owner, by upstream's approval rule).
- Seeded at boot as drafts (`pulsar-<area>`). Nothing is callable until a tenant admin approves the area, so approving an area is the switch.
- Proxy `/internal/pulsar/:area/:op`: it only touches that area's record types. It calls Pulsar's `/api/resource` at `STICKS_PULSAR_URL` (inside the same container) with the calling Stick's own token (see Stick accounts). That Stick user's roles in Pulsar decide what is visible. Only the engine secret is accepted (Stick runs); a person's session, guest or not, gets 401.
- Callers: Stick runs (the plugin tools), and the call rules' contact check. The CRM area is the first one used, for calls (Contact, Lead, Customer).
- Not yet: the live end-to-end check (a real model calls the CRM plugin against a real Pulsar), to come as a manual workflow like `live-tool-use.yml`.
- Differs from the first proposal: calls run as the Stick's own Pulsar user, not as the signed-in person, because plugin calls carry the plugin's connection rather than the person's session.

## Stick accounts (Ray 11-22: "in sticks a bot has account similar to human")
- Each Stick is its own Pulsar user with a role the tenant gives it. The proxy uses the Stick's own token for the Stick named in `X-Sticks-Stick`; there is no shared Sticks account.
- `X-Sticks-Requested-By` (the person who asked or approved) is passed to Pulsar as `X-Requested-By`, so the record shows the Stick as the doer and the person as requester.
- Only people the tenant allows to work with a Stick can direct it; that is enforced where a run starts, since this proxy takes the engine secret only. Create, update and submit asking the owner is also enforced upstream, not in this proxy.
- Needs in core: a Pulsar user per Stick, its token into the tenant secrets, and recording `X-Requested-By` on changes.
