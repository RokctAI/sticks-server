#!/usr/bin/env python3
"""Put the default Stick instructions (templates/stick-defaults.md) into a Stick's instructions.

Rakazo builds its own base prompt in code, so changing it would be a patch on a hot upstream file
that conflicts every week. Instead the backend writes ONE marked block into each Stick's own
instructions (bots/create or bots/update) and re-adds it if the Stick edits it away. Only the
text between the markers is ours; anything else the owner or the Stick wrote is left alone.

  python scripts/stick_defaults.py < current_instructions.txt > new_instructions.txt
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
START = "<!-- sticks-defaults:start -->"
END = "<!-- sticks-defaults:end -->"


def default_block() -> str:
    return (ROOT / "templates" / "stick-defaults.md").read_text().strip()


def apply_block(instructions: str, block: str | None = None) -> str:
    """Return `instructions` with our block added, or replaced if it is already there. Idempotent."""
    block = (block or default_block()).strip()
    a, b = instructions.find(START), instructions.find(END)
    if a != -1 and b > a:
        return instructions[:a] + block + instructions[b + len(END):]
    if a != -1 or b != -1:  # a half-deleted marker: drop the stray marker, then add a whole block
        instructions = instructions.replace(START, "").replace(END, "")
    base = instructions.rstrip()
    return f"{base}\n\n{block}\n" if base else f"{block}\n"


def remove_block(instructions: str) -> str:
    a, b = instructions.find(START), instructions.find(END)
    if a == -1 or b < a:
        return instructions
    rest = (instructions[:a].rstrip() + "\n\n" + instructions[b + len(END):].lstrip()).strip()
    return rest + "\n" if rest else ""


if __name__ == "__main__":
    sys.stdout.write(apply_block(sys.stdin.read()))
