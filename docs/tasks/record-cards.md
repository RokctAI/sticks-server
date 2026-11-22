# Record cards (Ray 11-21: "Approved as long as ai is not calculating totals")

Before a Stick creates, updates or submits a Pulsar record it asks the person in chat with a card.

- Stick side: built-in plugin `record-confirm`. `ask_to_confirm_record` (POST /internal/record-requests, engine secret) carries `{thread_id, message_id?, module, action, record}`; `get_record_answer` reads the decision.
- The record is Pulsar's own draft: the Stick saves an unsubmitted draft first and passes what Pulsar returns. Amounts (`total`, `tax`, `lines[].amount`) must be text; numbers are refused.
- App side (caller: Sticks app record cards, agent#686): GET /internal/record-requests?thread=ID[&since=ISO] lists requests with `decision` (null = show Allow/Decline; set = show the answer after reload). POST /internal/record-requests/answer `{requestId, decision}` as the signed-in person; repeat answers return ok and change nothing.
- `module` is one of crm, selling, accounts, stock, hr, projects. Reads never ask.
