# Many tenants in one engine (Ray 11-22)

Ray: "The rule was one docker had one rakazo inside. It didn't limit tenants. A shared docker means all tenants will use that same rakazo that is inside their docker."

## Step 1 (this PR): each tenant its own organization, chosen at sign-in

- `tenants.ts`: table `sticks_tenants` (tenant, signing site, organization, default space, Pulsar public key). Each tenant gets its own upstream organization and default space; upstream's membership and per-space row-level security keep tenants apart.
- `POST /internal/tenants` (engine secret) `{tenant, site, company, public_key}`: caller is Pulsar's first start (core). Create-only: repeating it with the same key is harmless; a different key for an existing tenant is refused (409), and so is a tenant name or site that belongs to another tenant (400). Key rotation will be its own call, signed by the current key (later).
- Sign-in (`pulsar-front.ts`): the site that signed the token names the tenant; only that tenant's key can verify it, and the session lands in that tenant's organization and space. The tenant list is held in memory, so a refused token still costs no database call.
- A token whose Pulsar user name contains `/` is refused (401) for every tenant, and an unknown signing site with no legacy key also gets 401 (nothing about the setup is revealed).
- User ids carry the tenant (`acme/Administrator`), since every tenant has its own "Administrator".
- Backward compatible: with `STICKS_TENANT` set (one engine per tenant, today's PlatformStack), that tenant is registered at boot on its existing organization with plain user ids, so its users, chats and Sticks stay theirs. `STICKS_TENANT` is no longer required.

## Step 2 (part): each Stick talks to its own tenant's Pulsar site

- One Pulsar in the docker serves every tenant's site. The Pulsar plugin proxy and the Stick account setup now send `X-Frappe-Site-Name: <the Stick's tenant site>` (Frappe's standard header for picking a site), looked up from the Stick's organization in `sticks_tenants` (`pulsarSiteForStick`). A Stick of tenant A therefore reads and writes only tenant A's site. With no registered tenant (one engine per tenant), nothing changes.
- Still to check on a running shared docker: that the Pulsar fork keeps Frappe's header handling.

## Next steps

2. Rest of step 2: Stick accounts and keys (the Pulsar proxy, record cards, onboarding and features still assume one tenant).
3. Credits per tenant (each run charged to its own tenant's Pulsar).
4. Two-tenant isolation tests on a real database.
