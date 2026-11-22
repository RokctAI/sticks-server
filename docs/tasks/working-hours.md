# Working hours and off duty for Sticks (Ray 11-09)

Ray: working hours, "off duty when told not to work", resting states.

## What a Stick does

- **Working hours**: weekly hours in a time zone, per day a list of `["HH:MM","HH:MM"]`. A day not listed is a rest day. No hours set means always working.
- **Off duty**: the owner tells the Stick to stop. It goes off duty until told to come back, or until a time.
- Off duty or outside hours, the Stick starts no work by itself: its routines skip that occurrence (the schedule is kept, as upstream does for a deactivated owner). People writing to it still get an answer.

## How

- Upstream patch `0006-run-finished-hooks-and-routine-gates.patch` adds two small registries: `routineGates` (asked before a routine occurrence runs) and `runFinishedHooks` (told after a run is finalized; used next by keep-going and the goal loop).
- `duty.ts` stores `sticks_duty(bot_id, hours, off_until, off_reason)`; "until told" is stored as 9999-12-31.
- Built-in plugin **duty** (`set_duty`), seeded when `STICKS_ENGINE_URL` is https. The Stick calls it when the owner says stop, come back, or sets hours.
- `GET /internal/duty?stick=ID` (or `?thread=ID`) → `{stick, hours, on_duty, state: working|off_duty|resting, reason, until}`. Caller: the Sticks app, to show the Stick resting.
- `POST /internal/duty` with `stick_id` or `thread_id` and one of `{off:{until?, reason?}}`, `{on:true}`, `{hours}` or `{hours:null}`.
- Both need the engine secret or a session of a member of the Stick's own organization, so one tenant can never read or change another tenant's Stick.

## Not yet

- Keep-going now runs through `runFinishedHooks` and respects duty (see goal-loop.md).
- The app's resting look (Sticks app thread).
