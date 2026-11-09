#!/usr/bin/env python3
"""Reporting lines for Sticks: who a Stick reports to, who may change it, and where its pings go.

Reference logic for the backend (it lives in Frappe later; Rakazo v0.8.0 only stores `parentBotId`,
the creator, and has no manager field). Pure functions over a plain dict so the rules are testable.
Nothing here listens or polls: a ping is one event that wakes one manager for one short run.

State shape:
  {"sticks": {id: {"role": "hr"|"chief_of_staff"|..., "reports_to": id|None, "created_by": id|None,
                   "active": bool}},
   "log": [ ... appended by set_reports_to ... ]}
`reports_to` None means the Stick reports to the owner. The owner is the actor id OWNER.

  python scripts/reporting_lines.py state.json set <actor> <stick> <manager|-> "<reason>"
"""
from __future__ import annotations

import json
import sys
import time

OWNER = "owner"
HR_ROLE = "hr"
PING_MAX = 140


class ReportingError(ValueError):
    pass


def _chain(state: dict, start: str | None) -> list[str]:
    seen: list[str] = []
    cur = start
    while cur and cur != OWNER:
        if cur in seen:
            raise ReportingError("loop in reporting lines")
        seen.append(cur)
        cur = state["sticks"][cur].get("reports_to")
    return seen


def can_change(state: dict, actor: str, stick: str) -> bool:
    """Only the owner or an active HR Stick, and never a Stick for itself."""
    if actor == stick:
        return False
    if actor == OWNER:
        return True
    a = state["sticks"].get(actor)
    return bool(a and a.get("active", True) and a.get("role") == HR_ROLE)


def set_reports_to(state: dict, actor: str, stick: str, manager: str | None, reason: str,
                   now: float | None = None) -> dict:
    """Change who `stick` reports to. Logs the change; pings follow it at once (they read this field)."""
    if stick not in state["sticks"]:
        raise ReportingError(f"unknown Stick {stick}")
    if not can_change(state, actor, stick):
        raise ReportingError("only the owner or an HR Stick can change who a Stick reports to, "
                             "and a Stick can never change its own")
    if manager in (None, "-", OWNER):
        manager = None
    else:
        m = state["sticks"].get(manager)
        if m is None or not m.get("active", True):
            raise ReportingError(f"manager {manager} is unknown or not active")
        if manager == stick or stick in _chain(state, manager):
            raise ReportingError("that would make a loop")
    if not reason.strip():
        raise ReportingError("a reason is required")
    old = state["sticks"][stick].get("reports_to")
    state["sticks"][stick]["reports_to"] = manager
    entry = {"at": now if now is not None else time.time(), "actor": actor, "stick": stick,
             "from": old, "to": manager, "reason": reason.strip()}
    state.setdefault("log", []).append(entry)
    return entry


def route_ping(state: dict, sender: str, text: str, pending: list[dict] | None = None) -> dict | None:
    """Where a short ping from `sender` goes. Returns the event, or None when it is a duplicate.

    The target is the sender's `reports_to` (the owner if none), NOT its creator. Only that one
    manager is woken; nobody else sees it. A repeat of a ping still waiting is dropped.
    """
    if sender not in state["sticks"]:
        raise ReportingError(f"unknown Stick {sender}")
    text = " ".join(text.split())
    if not text:
        raise ReportingError("empty ping")
    if len(text) > PING_MAX:
        text = text[: PING_MAX - 1] + "…"
    target = state["sticks"][sender].get("reports_to") or OWNER
    if target != OWNER and not state["sticks"][target].get("active", True):
        target = state["sticks"][target].get("reports_to") or OWNER  # skip an inactive manager
    ev = {"to": target, "from": sender, "text": text, "wake": "one short run"}
    if any(p["to"] == ev["to"] and p["from"] == sender and p["text"] == text for p in (pending or [])):
        return None
    return ev


def create_stick(state: dict, actor: str, new_id: str, role: str, reports_to: str | None) -> None:
    """Creating a Stick is done by the owner or an HR Stick, who also sets its line. A manager asks HR."""
    if not can_change(state, actor, new_id):
        raise ReportingError("ask HR (or the owner) to create the Stick; managers go through HR too")
    if new_id in state["sticks"]:
        raise ReportingError("Stick already exists")
    state["sticks"][new_id] = {"role": role, "reports_to": None, "created_by": actor,
                               "active": True}
    set_reports_to(state, actor, new_id, reports_to, "created")


if __name__ == "__main__":
    if len(sys.argv) != 7 or sys.argv[2] != "set":
        sys.exit(__doc__)
    st = json.load(open(sys.argv[1]))
    try:
        print(json.dumps(set_reports_to(st, sys.argv[3], sys.argv[4], sys.argv[5], sys.argv[6])))
    except ReportingError as e:
        sys.exit(f"refused: {e}")
    json.dump(st, open(sys.argv[1], "w"), indent=2)
