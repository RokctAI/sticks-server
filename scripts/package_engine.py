"""Builds the engine for the tenant image (brief task 17; Ray 11-21: one Rakazo per tenant docker, only Postgres
outside). Runs build_engine.py (pinned upstream + our patches + overlay, typecheck and overlay tests), then
bundles the engine entry with esbuild. node_modules stay external and are imported by absolute path, so the
bundle must run from where it was built: the image keeps <workdir>/build/up as is.

    python3 scripts/package_engine.py --workdir /opt/sticks
    node /opt/sticks/build/up/apps/sticks-engine/dist/sticks-engine.mjs

Exit 0 on success and prints the bundle path; 2 when the build or the bundle fails.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import measure_engine as m  # noqa: E402


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--workdir", default="/opt/sticks")
    args = ap.parse_args(argv)
    checkout = m.build(Path(args.workdir))
    if checkout is None:
        return 2
    out = m.bundle(checkout)
    if out is None:
        return 2
    print(out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
