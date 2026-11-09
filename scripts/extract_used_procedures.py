#!/usr/bin/env python3
"""Keep contracts/used-procedures.txt in step with what the Dart app really calls.

The Sticks app (RokctAI/agent, agent/dart/lib/src/sticks) names server procedures as string
literals like 'threads/send'. This reads every such literal from a checkout of that folder.

  python scripts/extract_used_procedures.py --dart-dir <path to .../lib/src/sticks> --write
  python scripts/extract_used_procedures.py --dart-dir <path> --check   (exit 1 if the list is stale)

Literals that are media types (application/json, image/png ...) are ignored. Run it, with --write,
whenever the app starts calling something new, and with --check before moving the pin.
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LISTFILE = ROOT / "contracts" / "used-procedures.txt"
LITERAL = re.compile(r"'([a-z][A-Za-z]+/[A-Za-z]+)'")
MEDIA = {"application", "image", "text", "audio", "video", "font", "multipart", "message", "model"}
HEADER = [
    "# Server procedures our Dart app calls, as group/name, taken from the string literals in",
    "# agent/dart/lib/src/sticks. The sync robot checks every line still exists in the new upstream",
    "# tag's packages/contracts/src/rpc.ts. Regenerate with scripts/extract_used_procedures.py --write.",
]


def extract(text: str) -> set[str]:
    return {m for m in LITERAL.findall(text) if m.split("/")[0] not in MEDIA}


def extract_dir(path: Path) -> list[str]:
    found: set[str] = set()
    for f in path.rglob("*.dart"):
        found |= extract(f.read_text(errors="ignore"))
    return sorted(found)


def read_list(text: str) -> list[str]:
    return [l.strip() for l in text.splitlines() if l.strip() and not l.strip().startswith("#")]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dart-dir", required=True, help="path to agent/dart/lib/src/sticks")
    mode = ap.add_mutually_exclusive_group(required=True)
    mode.add_argument("--write", action="store_true")
    mode.add_argument("--check", action="store_true")
    args = ap.parse_args()
    root = Path(args.dart_dir)
    if not root.is_dir():
        print(f"not a folder: {root}", file=sys.stderr)
        return 2
    found = extract_dir(root)
    if not found:
        print("no procedures found: wrong folder?", file=sys.stderr)
        return 2
    current = read_list(LISTFILE.read_text()) if LISTFILE.exists() else []
    if args.write:
        LISTFILE.write_text("\n".join(HEADER + found) + "\n")
        print(f"wrote {len(found)} procedures")
        return 0
    missing = [p for p in found if p not in current]
    extra = [p for p in current if p not in found]
    if missing:
        print("used-procedures.txt is stale; the app calls these but the list lacks them:")
        print("\n".join(f"  {p}" for p in missing))
    if extra:
        print("listed but no longer in the app (harmless, remove on the next --write):")
        print("\n".join(f"  {p}" for p in extra))
    return 1 if missing else 0


if __name__ == "__main__":
    sys.exit(main())
