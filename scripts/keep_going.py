#!/usr/bin/env python3
"""Keep-going loop for Sticks: when a run ends and the Stick still has open work, ask it to continue.

Rakazo runs one turn per wake and then stops. This is our own piece (not a Rakazo patch). The
backend calls `check_stick` when a Stick's run ends. It continues the Stick only if ALL hold:

  1. the Stick is not switched off in the policy (ON by default; each Stick can be switched off);
  2. the run ended normally (status `completed`; never `waiting_input` / `waiting_takeover` /
     `failed` / `cancelled`, and never while another run is working);
  3. it has pending work: board tickets assigned to it in `todo` or `doing`, or open (not parked,
     not done) scratchpad items;
  4. it is NOT blocked on the owner. Blocked means any of: the run paused for an answer
     (`waiting_input` from ask_user, or `waiting_takeover`); the last message the Stick wrote ends
     in a question or asks the owner to decide; or the owner wrote after the run ended;
  5. the caps hold: at most `max_tries_without_progress` continues in a row when the pending
     work has not changed, `max_per_day` per Stick per day, `min_gap_seconds` between continues,
     and `max_spend_per_day` (the caller supplies today's spend).

Goal-loop rule: the loop ends only when the work is COMPLETE (the board shows no open ticket or
scratchpad item, whatever the Stick says) or BLOCKED with a reason (a blocked ticket's title, the
paused run, or the question it asked). If the Stick says "done" while the board still shows open
work, the continue message says so and asks it to finish or mark each item done or blocked.
Each decision carries `outcome` (continue, complete, blocked, waiting, working, capped, off).

A ticket in `blocked` or `review` is not pending: the Stick says it is blocked by moving the
ticket to `blocked` (the default instruction in templates/stick-defaults.md tells it to).

The decision is a pure function (`decide`) so it is easy to test; `check_stick` talks to a client
object the backend provides (see `Client`). Nothing here touches Docker or pushes anywhere.
"""
from __future__ import annotations

import hashlib
import re
import time
from dataclasses import dataclass, field
from typing import Protocol

PENDING_TICKET_STATUSES = {"todo", "doing"}
PAUSED_RUN_STATUSES = {"waiting_input", "waiting_takeover"}
WORKING_RUN_STATUSES = {"queued", "leased", "running"}
MARKER = "[auto-continue"
BLOCKER_PHRASES = (
    "let me know", "please confirm", "please advise", "waiting for your", "waiting on you",
    "need your", "your call", "which one would you", "do you want me to", "should i ",
    "shall i ", "can you confirm", "need you to",
)


@dataclass
class Policy:
    enabled: bool = True  # on for every Stick unless switched off for it
    max_tries_without_progress: int = 3
    max_per_day: int = 20
    min_gap_seconds: int = 60
    max_spend_per_day: float = 5.0  # US dollars (usage/list costUsd) per Stick per day; 0 = no spend allowed
    include_scratchpad: bool = True


@dataclass
class StickState:
    """Persisted by the caller (a small JSON blob per Stick)."""
    day: str = ""
    continues_today: int = 0
    last_continue_at: float = 0.0
    last_signature: str = ""
    tries_on_signature: int = 0


@dataclass
class Snapshot:
    run_status: str
    run_ended_at: float
    last_message_text: str
    last_message_from_owner: bool
    last_message_at: float
    pending_tickets: list[dict] = field(default_factory=list)  # {"id","title","status"}
    open_scratchpad: list[dict] = field(default_factory=list)  # {"id","title"}
    blocked_tickets: list[dict] = field(default_factory=list)  # {"id","title"}: shown as the reason
    spend_today: float = 0.0


@dataclass
class Decision:
    send: bool
    reason: str
    signature: str = ""
    # Goal status, like a /goal loop: continue | complete | blocked | waiting | working | capped | off.
    # The loop ends only on complete (the board has no open work) or blocked (with a reason);
    # capped is a safety stop the owner should look at, never reported as complete.
    outcome: str = ""


def looks_blocked(text: str) -> bool:
    """True when the Stick's last message asks the owner something or waits on them."""
    t = (text or "").strip()
    if not t:
        return False
    tail = re.sub(r"[\s\"'”’)\]*_~`>.!]+$", "", t[-400:])
    if tail.endswith("?"):
        return True
    low = t[-400:].lower()
    return any(p in low for p in BLOCKER_PHRASES)


DONE_CLAIM = re.compile(r"\b(all done|finished|completed?|done)\b", re.I)


def claims_done(text: str) -> bool:
    """The Stick says it is finished. A claim only: the board decides (see continue_text)."""
    return bool(DONE_CLAIM.search((text or "")[-400:]))


def signature_of(snap: Snapshot, policy: Policy) -> str:
    parts = sorted(f"t:{t['id']}:{t.get('status','')}" for t in snap.pending_tickets)
    if policy.include_scratchpad:
        parts += sorted(f"s:{s['id']}" for s in snap.open_scratchpad)
    return hashlib.sha1("|".join(parts).encode()).hexdigest()[:12]


def decide(snap: Snapshot, policy: Policy, state: StickState, now: float, today: str) -> Decision:
    if not policy.enabled:
        return Decision(False, "off for this Stick", outcome="off")
    if snap.run_status in WORKING_RUN_STATUSES:
        return Decision(False, "a run is still working", outcome="working")
    if snap.run_status in PAUSED_RUN_STATUSES:
        return Decision(False, f"blocked: run is {snap.run_status} (waiting for the owner)", outcome="blocked")
    if snap.run_status != "completed":
        outcome = "waiting" if snap.run_status == "none" else "capped"  # none: no run yet
        return Decision(False, f"run ended as {snap.run_status}; not continuing", outcome=outcome)
    if snap.last_message_from_owner and snap.last_message_at >= snap.run_ended_at:
        return Decision(False, "the owner wrote after the run ended; their message comes first", outcome="waiting")
    pending = bool(snap.pending_tickets) or (policy.include_scratchpad and bool(snap.open_scratchpad))
    if not pending:
        if snap.blocked_tickets:
            titles = "; ".join(t.get("title", "") for t in snap.blocked_tickets[:3])
            return Decision(False, f"blocked: {titles}", outcome="blocked")
        return Decision(False, "complete: no open tickets or scratchpad items", outcome="complete")
    if looks_blocked(snap.last_message_text):
        tail = " ".join(snap.last_message_text.split())[-160:]
        return Decision(False, f"blocked: last message asks the owner: {tail}", outcome="blocked")
    sig = signature_of(snap, policy)
    count_today = state.continues_today if state.day == today else 0
    if count_today >= policy.max_per_day:
        return Decision(False, f"daily cap reached ({policy.max_per_day})", sig, "capped")
    if now - state.last_continue_at < policy.min_gap_seconds:
        return Decision(False, "too soon after the last continue", sig, "waiting")
    if snap.spend_today >= policy.max_spend_per_day:
        return Decision(False, "spend cap reached for today", sig, "capped")
    tries = state.tries_on_signature if state.last_signature == sig else 0
    if tries >= policy.max_tries_without_progress:
        return Decision(False, f"stalled: {tries} continues without the open work changing", sig, "capped")
    return Decision(True, "open work and not blocked", sig, "continue")


def apply_decision(state: StickState, decision: Decision, now: float, today: str) -> StickState:
    """The new state after a continue was sent."""
    if state.day != today:
        state.day, state.continues_today = today, 0
    state.continues_today += 1
    state.last_continue_at = now
    state.tries_on_signature = state.tries_on_signature + 1 if state.last_signature == decision.signature else 1
    state.last_signature = decision.signature
    return state


def continue_text(snap: Snapshot, state: StickState, policy: Policy) -> str:
    same = state.last_signature == signature_of(snap, policy)  # open work unchanged since last continue
    n = state.tries_on_signature + 1 if same else 1
    nxt = (snap.pending_tickets[0]["title"] if snap.pending_tickets
           else snap.open_scratchpad[0]["title"] if snap.open_scratchpad else "your open work")
    if claims_done(snap.last_message_text):
        # Completion is checked against the board, not taken from the Stick's word.
        open_titles = "; ".join(t["title"] for t in (snap.pending_tickets or snap.open_scratchpad)[:3])
        return (
            f"{MARKER} {n}/{policy.max_tries_without_progress}] You said this is done, but these are still "
            f"open: {open_titles}. Finish them, or set each one to done, or to blocked with the reason."
        )
    return (
        f"{MARKER} {n}/{policy.max_tries_without_progress}] Continue with your open work, next: {nxt}. "
        "Keep going without waiting for me. If you are blocked on something only I can decide, "
        "set that ticket to blocked and say exactly what you need."
    )


class Client(Protocol):
    """What the backend provides (calls Rakazo's tickets/*, scratchpad/*, threads/*, runs/* and usage)."""
    def snapshot(self, bot_id: str) -> Snapshot: ...
    def send(self, bot_id: str, text: str, nonce: str) -> None: ...


def check_stick(client: Client, bot_id: str, policy: Policy, state: StickState,
                now: float | None = None, today: str | None = None) -> tuple[Decision, StickState]:
    """Call when a run for `bot_id` ends. Returns the decision and the (possibly updated) state."""
    now = time.time() if now is None else now
    today = today or time.strftime("%Y-%m-%d", time.gmtime(now))
    if not policy.enabled:  # do not even read the Stick's data when it is off
        return Decision(False, "off for this Stick", outcome="off"), state
    snap = client.snapshot(bot_id)
    decision = decide(snap, policy, state, now, today)
    if decision.send:
        text = continue_text(snap, state, policy)
        client.send(bot_id, text, nonce=f"keepgoing:{bot_id}:{int(now)}")
        state = apply_decision(state, decision, now, today)
    return decision, state
