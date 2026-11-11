#!/usr/bin/env python3
"""Tenant setup steps that run against the tenant's Sticks server, after the hub starts it.

Agreed rules this applies:
  - One space per tenant (one company per tenant), named from the company name. The account's
    current space is renamed; no second space is created.
  - Every Stick gets the default instruction block (scripts/apply_stick_defaults.py).
Server settings (env, e.g. TICKET_BOARD_ENABLED) are the hub's job and are not touched here.

  python scripts/setup_tenant.py --company "Example Holdings"            # dry run
  python scripts/setup_tenant.py --company "Example Holdings" --write

Connection settings: scripts/sticks_client.py (environment only).
"""
from __future__ import annotations

import argparse
import sys

from apply_stick_defaults import apply as apply_defaults
from sticks_client import SticksClient, SticksError

SPACE_NAME_MAX = 60  # upstream spaceName limit (v0.8.0)


def space_name(company: str) -> str:
    name = " ".join(company.split())
    if not name:
        raise ValueError("company name is empty")
    return name[:SPACE_NAME_MAX].rstrip()


def setup(client: SticksClient, company: str, write: bool) -> list[str]:
    log = []
    nav = client.call("spaces/list") or {}
    current = nav.get("current") or {}
    target = space_name(company)
    if current.get("name") == target:
        log.append(f"space already named {target!r}")
    else:
        if write:
            client.call("spaces/rename", {"spaceId": current["id"], "name": target})
        log.append(f"{'renamed' if write else 'would rename'} space {current.get('name')!r} to {target!r}")
    others = [s for s in nav.get("spaces", []) if s.get("id") != current.get("id")]
    if others:
        log.append(f"note: the account has {len(others)} other space(s); one space per tenant is the rule, check by hand")
    changed, problems = apply_defaults(client, write)
    log.append(f"{'updated' if write else 'would update'} default instructions on {len(changed)} Stick(s)")
    log.extend(f"problem: {p}" for p in problems)
    return log


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--company", required=True)
    ap.add_argument("--write", action="store_true", help="make the changes (default: dry run)")
    args = ap.parse_args()
    try:
        for line in setup(SticksClient.from_env(), args.company, args.write):
            print(line)
    except (SticksError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
