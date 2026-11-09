# Reporting lines, pings and Stick templates (design, 2026-11-09)

Checked against upstream v0.8.0 (our pin). Backend building waits until after app testing; this file
and `scripts/reporting_lines.py` (tested reference rules) are the spec.

## What v0.8.0 has
- `Bot.parentBotId` (prisma schema): the CREATOR only. No manager/`reports_to` field, no roles, no HR.
- `bots.duplicate`, "Import an agent" (OpenClaw/Hermes/other assistants), and a plugin marketplace
  (`marketplace.catalog`: MCP connectors and skill packs). **No bot/Stick templates and no
  versioning.** Duplicates are copies, not linked to a source.

## Reporting lines (owner's rulings)
- One `reports_to` per Stick (None = the owner), separate from `created_by`.
- A ping is a one-line text (140 chars) plus the sender id. It wakes ONLY the `reports_to` Stick
  (or the owner) for one short run. Nothing stays listening; a repeat of a ping still waiting is dropped;
  an inactive manager is skipped to the next one up.
- Only the owner or an HR Stick can change `reports_to`. A Stick never changes its own, not even HR;
  managers (chief of staff included) ask HR. Every change is logged (who, from, to, reason); pings read the
  field, so they follow the new line at once.
- Creating a Stick goes through HR (or the owner), who also sets its line. Promotion = owner tells the
  senior, the senior asks HR, HR updates `reports_to`.
- Setup offers to create an HR Stick and a Chief of Staff (`deploy/setup-sticks.sample.json`); if the
  owner skips HR, the owner alone makes the changes. TICKET_BOARD_ENABLED, the default instruction block and
  the keep-going loop are in PR #2.
- Backend: Frappe holds the field and log (like roles); a thin hook on `bots/create` and the message
  tools enforces it. Rakazo's `parentBotId` stays untouched, so no patch on hot upstream files.

## Stick templates (proposal; makes Sticks sellable)
A template = instructions + default skills + tool/MCP list + model choice + role + sample routines, with
NO memory, keys or owner data. Stored in Frappe as `Stick Template` rows, each immutable once published:
`template_id`, `version` (semver), `changelog`, `min_server_tag`, `published_by`, `price`.
- Install = create a Stick from `template_id@version` and remember it (`template_id`, `version`).
- Updating is the owner's choice: the Stick shows "v1.3 available"; we never overwrite a Stick's edits.
  The default-instruction block is kept separate (marked section) so template updates and ours don't clash.
- Marketplace later: sellers publish new versions; buyers keep old ones; billing through Rokct Pay.
- Hub-built, not a Rakazo patch: the hub calls `bots/create` with the template's fields.
