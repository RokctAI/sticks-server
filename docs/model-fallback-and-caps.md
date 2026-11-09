# Model fallback, run caps and token cost

Config only. Nothing here patches upstream, so the weekly sync is unaffected. Settings are in
`deploy/env.resilience.sample`. Names were checked against upstream v0.8.0; **nothing was run or
tested on a live instance**.

## 1. A provider 429 should not fail the run
- Upstream has one deployment default (`PI_DEFAULT_PROVIDER` + `PI_DEFAULT_MODEL`) and no ordered
  fallback chain for a Stick's main model. Users can add ordered backups per account in
  Settings > Models, but only the approval checker is documented to use them.
- Smallest fix: point the default at a router (`PI_DEFAULT_PROVIDER=openrouter`), so one upstream
  provider's limit is absorbed by the router. Raise `MODEL_STREAM_MAX_RETRIES` to 3 for transient failures.
- Must test: force a 429 on the primary and confirm the run completes on another model. If it does
  not, the next step is a backend retry (our Frappe layer re-sends on another model) or a patch in
  `patches/`, decided after testing.
- App: show only a friendly "busy, trying again" line, never the provider error.
- Model names in the app stay the friendly map (Auto, Everyday, Pro); the map must include any fallback model.

## 2. Stuck work and run caps
| Setting | Effect | Proposed |
|---|---|---|
| `MAX_TOOL_CALLS_PER_TURN` | soft-stops a runaway turn, still sends a final message | 60 |
| `COMPUTER_MAX_ACTIVE_UNBILLED_MS` / `COMPUTER_MAX_ACTIVE_MS` | hard uptime cap per computer | 1 hour |
| `SANDBOX_IDLE_MS` | idle sleep; the two caps above turn off when this is 0 | 600000 |
| `BOT_MESSAGE_MAX_HOPS` | stops bot-to-bot loops | 6 |

These limit resources, not the number of Sticks. A true configurable stuck-run timeout (upstream
issue #4037) does not exist; it would be a patch, after testing.

## 3. Token cost
- Biggest levers: the default model per Stick (Auto is the cheap tier), the tool-call cap above,
  and the shorter-replies toggle in the app.
- Per-role tool menus from Frappe permissions and the token-saving instruction are backend work
  (see rakazo-token-saving-notes.md); not built here.
- Upstream issue #3843 (built-in tools behind search) is open; adopt it on a weekly sync if it ships.
- Provider budgets and rate limits are set with the provider; the run caps are not a currency budget.
