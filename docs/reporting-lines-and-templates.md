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

## Stick templates (proposal)
We run upstream at the pin with our patches on top; no upstream source is copied here.
A template is the package we pre-create Sticks from: persona, instructions, role, default skills and tools,
model. It holds no memory, keys or owner data. Today a new Stick starts as an empty "baby" until the user talks;
a template just gives it a starting kit.
- Stored in Frappe as `Stick Template` rows: `template_id`, `version` (a whole number, 1, 2, 3), `changelog`.
  Fixing a problem that traces to a template publishes the next version; old versions are kept, never edited.
- The BACKEND tracks `template_id` and `version` per Stick. The Stick never sees either: it only sees its own
  current instructions, so it cannot get confused about which version it is.
- New Sticks use the latest version. Existing Sticks keep what they were made from; moving one to a newer
  version is a backend action (owner or HR), and the Stick's own edits are never silently overwritten.
- The marked default-instruction block (#2) stays separate from the template text.
- Selling templates in a marketplace is optional and later; the same versioned rows would serve it.
- Hub-built: the hub calls `bots/create` with the template's fields. No Rakazo patch.
