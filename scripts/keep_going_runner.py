#!/usr/bin/env python3
"""Run the keep-going loop against a Sticks server: a small sweeper, no socket per Stick.

Every tick it takes the next few Sticks that are not switched off in the policy file (the loop is
on for every Stick by default; a bounded batch, continuing from a saved cursor), reads each one's
state from the server and lets scripts/keep_going.py decide whether to send one "continue".
Sticks switched off are never read. State (counts, cursor) is kept in a small JSON file so restarts do not reset the caps.

  python scripts/keep_going_runner.py --policy keep-going.json --state keep-going-state.json --once
  python scripts/keep_going_runner.py --policy keep-going.json --state keep-going-state.json --interval 60

Policy file: same shape as deploy/keep-going.sample.json ("default" plus per-Stick overrides
under "sticks", keyed by bot id). Connection settings: scripts/sticks_client.py (environment).
What it reads: runs/list, threads/messages, tickets/list, scratchpad/list, usage/list.
What it writes: threads/send (the continue message), nothing else.
"""
from __future__ import annotations

import argparse
import dataclasses
import json
import math
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

from keep_going import PENDING_TICKET_STATUSES, Policy, Snapshot, StickState, check_stick
from sticks_client import SticksClient, SticksError

USAGE_PAGE = 100  # usage/list returns the newest 100 records (upstream v0.8.0)


def iso_to_epoch(value: str | None) -> float:
    if not value:
        return 0.0
    return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()


def message_text(message: dict) -> str:
    return "\n".join(b.get("text", "") for b in message.get("blocks") or [] if b.get("kind") == "text").strip()


def spend_today(records: list[dict], bot_id: str, today: str) -> float:
    """Sum of today's cost for this Stick. Unknown (inf) when the page may not reach back to midnight."""
    if len(records) >= USAGE_PAGE and all((r.get("createdAt") or "")[:10] == today for r in records):
        return math.inf  # more records today than one page shows: treat as over any cap
    return sum(r.get("costUsd") or 0.0 for r in records
               if r.get("botId") == bot_id and (r.get("createdAt") or "")[:10] == today)


class ServerSticks:
    """keep_going.Client backed by the Sticks server."""

    def __init__(self, client: SticksClient, now: float | None = None):
        self.client = client
        self.today = time.strftime("%Y-%m-%d", time.gmtime(now or time.time()))
        self._runs: list[dict] | None = None
        self._usage: list[dict] | None = None

    def _all_runs(self) -> list[dict]:
        if self._runs is None:  # one read per tick, shared by every Stick in the batch
            rows: dict[str, dict] = {}
            for flt in ("active", "recent"):
                for r in (self.client.call("runs/list", {"filter": flt}) or {}).get("runs", []):
                    rows[r["runId"]] = r
            self._runs = list(rows.values())
        return self._runs

    def _usage_records(self) -> list[dict]:
        if self._usage is None:
            self._usage = self.client.call("usage/list") or []
        return self._usage

    def snapshot(self, bot_id: str) -> Snapshot:
        runs = [r for r in self._all_runs() if r.get("botId") == bot_id and not r.get("groupId")]
        last_run = max(runs, key=lambda r: iso_to_epoch(r.get("updatedAt")), default=None)
        page = self.client.call("threads/messages", {"botId": bot_id}) or {}
        messages = [m for m in page.get("messages", []) if m.get("role") in ("user", "bot")]
        messages.sort(key=lambda m: (iso_to_epoch(m.get("createdAt")), m.get("seq", 0)))
        last = messages[-1] if messages else {}
        last_bot = next((m for m in reversed(messages) if m.get("role") == "bot"), {})
        tickets = (self.client.call("tickets/list", {"assigneeBotId": bot_id}) or {}).get("tickets", [])
        pads = self.client.call("scratchpad/list", {"botId": bot_id, "status": "open"}) or []
        return Snapshot(
            run_status=(last_run or {}).get("status", "none"),
            run_ended_at=iso_to_epoch((last_run or {}).get("updatedAt")),
            last_message_text=message_text(last_bot),
            last_message_from_owner=last.get("role") == "user",
            last_message_at=iso_to_epoch(last.get("createdAt")),
            pending_tickets=[{"id": t["id"], "title": t.get("title", ""), "status": t.get("status", "")}
                             for t in tickets if t.get("status") in PENDING_TICKET_STATUSES],
            open_scratchpad=[{"id": p["id"], "title": p.get("title", "")} for p in pads if p.get("status") == "open"],
            blocked_tickets=[{"id": t["id"], "title": t.get("title", "")} for t in tickets if t.get("status") == "blocked"],
            spend_today=spend_today(self._usage_records(), bot_id, self.today),
        )

    def send(self, bot_id: str, text: str, nonce: str) -> None:
        self.client.call("threads/send", {"botId": bot_id, "text": text, "clientNonce": nonce})


def policy_for(config: dict, bot_id: str) -> Policy:
    merged = {**config.get("default", {}), **config.get("sticks", {}).get(bot_id, {})}
    fields = {f.name for f in dataclasses.fields(Policy)}
    return Policy(**{k: v for k, v in merged.items() if k in fields})


def next_batch(enabled_ids: list[str], cursor: str, size: int) -> tuple[list[str], str]:
    """The next `size` ids after `cursor` (wrapping), and the new cursor."""
    ids = sorted(enabled_ids)
    if not ids:
        return [], ""
    start = next((i for i, x in enumerate(ids) if x > cursor), 0)
    batch = [ids[(start + i) % len(ids)] for i in range(min(size, len(ids)))]
    return batch, batch[-1]


def tick(client: SticksClient, config: dict, state: dict, batch_size: int, now: float | None = None) -> list[str]:
    """One sweep step. Returns log lines; updates `state` in place."""
    now = time.time() if now is None else now
    bots = [b for b in (client.call("bots/list") or []) if not b.get("archivedAt")]
    enabled = [b["id"] for b in bots if policy_for(config, b["id"]).enabled]
    batch, state["cursor"] = next_batch(enabled, state.get("cursor", ""), batch_size)
    server = ServerSticks(client, now)
    log = []
    for bot_id in batch:
        st = StickState(**state.setdefault("sticks", {}).get(bot_id, {}))
        try:
            decision, st = check_stick(server, bot_id, policy_for(config, bot_id), st, now=now)
        except SticksError as exc:
            log.append(f"{bot_id}: skipped ({exc.message})")
            continue
        state["sticks"][bot_id] = dataclasses.asdict(st)
        log.append(f"{bot_id}: {decision.outcome} ({decision.reason})")
    return log


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--policy", required=True, help="policy JSON (see deploy/keep-going.sample.json)")
    ap.add_argument("--state", required=True, help="state JSON (created if missing)")
    ap.add_argument("--batch", type=int, default=20, help="Sticks per tick")
    mode = ap.add_mutually_exclusive_group(required=True)
    mode.add_argument("--once", action="store_true")
    mode.add_argument("--interval", type=int, help="seconds between ticks (minimum 30)")
    args = ap.parse_args()
    config = json.loads(Path(args.policy).read_text())
    state_path = Path(args.state)
    state = json.loads(state_path.read_text()) if state_path.exists() else {}
    try:
        client = SticksClient.from_env()
    except SticksError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    while True:
        try:
            for line in tick(client, config, state, max(1, args.batch)):
                print(line)
        except SticksError as exc:
            print(f"tick failed: {exc}", file=sys.stderr)
        state_path.write_text(json.dumps(state, indent=1))
        if args.once:
            return 0
        time.sleep(max(30, args.interval))


if __name__ == "__main__":
    sys.exit(main())
