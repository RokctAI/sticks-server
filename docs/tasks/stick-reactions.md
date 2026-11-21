# Stick reactions

A Stick can react to one of the owner's messages with a single emoji. Upstream has no reactions, so they live in our own table `sticks_reactions` (event_id = upstream `events.id`, emoji).

- Tool: the built-in plugin "reactions" gives every Stick `react_to_message {message_id, emoji}`. It is seeded only when `STICKS_ENGINE_URL` is https.
- Write: `POST /internal/reactions {message_id, emoji}` (engine secret or a signed-in session). The same emoji twice is one reaction.
- Read (the app): `GET /internal/reactions?thread=<threadId>[&since=<ISO time>]` answers `{reactions: [{messageId, threadId, emoji, by: "stick", at}]}`, oldest first. With `since`, only newer ones: the app polls with the last `at` while a chat is open, and buzzes on each new one.
- Live push in upstream's event stream needs the run hooks patch (v0.13.0 repin); until then the app polls.
