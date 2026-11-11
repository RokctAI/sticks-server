#!/usr/bin/env python3
"""Write the default Stick instruction block into every Stick of the signed-in account.

Reads each Stick's instructions (bots/list), adds or refreshes the marked block from
templates/stick-defaults.md (scripts/stick_defaults.py), and saves it with bots/update. Only Sticks
whose instructions would change are touched. `expectedInstructions` makes the server refuse the
update if the instructions changed in between, so an edit made at the same moment is never lost.
Archived Sticks are skipped. Run it at tenant setup, after a Stick is created, and nightly to
put the block back where a Stick edited it away.

  python scripts/apply_stick_defaults.py            # dry run: lists what would change
  python scripts/apply_stick_defaults.py --write    # saves the changes
  python scripts/apply_stick_defaults.py --remove --write   # takes the block out again

Connection settings: see scripts/sticks_client.py (environment only).
"""
from __future__ import annotations

import argparse
import sys

from sticks_client import SticksClient, SticksError
from stick_defaults import apply_block, default_block, remove_block

MAX_INSTRUCTIONS = 20000  # upstream BOT_INSTRUCTIONS_MAX_LENGTH (v0.8.0)


def planned_changes(bots: list[dict], block: str, remove: bool = False) -> list[tuple[dict, str]]:
    """(bot, new instructions) for every active Stick whose instructions would change."""
    out = []
    for bot in bots:
        if bot.get("archivedAt"):
            continue
        current = bot.get("instructions") or ""
        new = remove_block(current) if remove else apply_block(current, block)
        # The server trims instructions, so compare trimmed text or every run would "change" them.
        if new.strip() == current.strip():
            continue
        out.append((bot, new.strip()))
    return out


def apply(client: SticksClient, write: bool, remove: bool = False) -> tuple[list[str], list[str]]:
    """Returns (changed or would-change Stick names, problems)."""
    bots = client.call("bots/list") or []
    changed, problems = [], []
    for bot, new in planned_changes(bots, default_block(), remove):
        name = bot.get("name") or bot.get("id")
        if len(new) > MAX_INSTRUCTIONS:
            problems.append(f"{name}: instructions would exceed {MAX_INSTRUCTIONS} characters; not changed")
            continue
        if write:
            try:
                client.call("bots/update", {
                    "botId": bot["id"],
                    "instructions": new,
                    "expectedInstructions": bot.get("instructions") or "",
                })
            except SticksError as exc:
                problems.append(f"{name}: {exc.message}")
                continue
        changed.append(name)
    return changed, problems


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--write", action="store_true", help="save the changes (default: dry run)")
    ap.add_argument("--remove", action="store_true", help="take the block out instead of adding it")
    args = ap.parse_args()
    try:
        client = SticksClient.from_env()
        changed, problems = apply(client, args.write, args.remove)
    except SticksError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    verb = "updated" if args.write else "would update"
    print(f"{verb} {len(changed)} Stick(s)" + (": " + ", ".join(changed) if changed else ""))
    for p in problems:
        print(f"problem: {p}", file=sys.stderr)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
