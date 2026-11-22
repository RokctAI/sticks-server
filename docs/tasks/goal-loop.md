# Goal loop: Sticks keep going until the work is done (Ray 11-11)

Ray: "completion loop, not another model–tool loop … Kilo's /goal system".

Keep-going (`keep-going.ts`, from #72) decided whether a Stick should continue, but nothing in the engine called it, so it never ran. Now:

- Upstream tells the engine each finalized run (patch 0006, `runFinishedHooks`).
- `keep-going-wiring.ts` reads what the Stick still has open: its tickets (todo, doing), its open scratchpad items, and the chat's **goal** if one is set. Message text is read through upstream's Prisma client, which decrypts it.
- keep-going decides as before (stops when the Stick asks the owner something, the owner wrote, a cap is reached, or nothing changes after 3 tries).
- To continue, one follow-up run is queued after the gap (a task plus a queued `follow_up` run, then `run.continue`, the same way upstream queues a group handoff).
- A Stick off duty or outside its working hours (`duty.ts`) is not pushed on.

## The goal

- Built-in plugin **goal**: `set_goal {thread_id, goal}` when the owner gives the Stick something to finish, and `complete_goal {thread_id, note}` only when it is really done, with what shows it.
- `GET /internal/goal?thread=ID` → `{goal: {goal, done, note} | null}` for the app. `POST /internal/goal` and `/internal/goal/done` as above.
- Engine secret, or a session of a member of the chat's organization.
- An unfinished goal counts as open work, so the Stick keeps going toward it, within the same caps (per day, per Stick spend through Pulsar, no-progress stop).

Settings: `keep_going` in `POST /internal/settings` (enabled, max_no_progress, max_per_day, gap_seconds).
