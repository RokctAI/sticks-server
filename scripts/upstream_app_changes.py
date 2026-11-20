#!/usr/bin/env python3
"""Which parts of upstream's apps/ changed between two Rakazo release tags (watch only, nothing is synced).

We fork once and never follow upstream, but our Dart app copies upstream's app behaviour, so a new release can
mean work there. This lists the changed files under apps/, grouped by app and area, so that work can be planned.

  python scripts/upstream_app_changes.py --repo <path to a clone with both tags> --from v0.11.0 --to v0.13.0
Without --from, the release the Sticks app has caught up with (the "upstream" field of its version.json) is used; without --to, the newest tag.
"""
from __future__ import annotations

import argparse
import collections
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
# Apps whose changes matter for the Dart app first; the rest are listed after.
APP_ORDER = ["mobile", "web", "api", "desktop", "worker", "www"]


def git(repo: str, *args: str) -> str:
    return subprocess.run(["git", "-C", repo, *args], check=True, capture_output=True, text=True).stdout


def newest_tag(repo: str) -> str:
    tags = [t for t in git(repo, "tag", "--list", "v*").split() if re.fullmatch(r"v\d+\.\d+\.\d+", t)]
    return max(tags, key=lambda t: tuple(int(x) for x in t[1:].split(".")))


def area_of(path: str) -> tuple[str, str]:
    parts = path.split("/")
    app = parts[1] if len(parts) > 1 else "(root)"
    rest = parts[2:]
    if not rest:
        return app, "(app root)"
    if len(rest) == 1:
        return app, "(app root)"
    return app, "/".join(rest[:2]) if rest[0] in ("src", "lib", "app", "components") and len(rest) > 2 else rest[0]


def summarise(changes: list[tuple[str, str]]) -> dict[str, collections.Counter]:
    out: dict[str, collections.Counter] = collections.defaultdict(collections.Counter)
    for status, path in changes:
        app, area = area_of(path)
        out[app][area] += 1
    return out


def patched_files(patches_dir: Path) -> dict[str, list[str]]:
    """Upstream files our patches touch: path -> patch names (from the patches' +++/--- headers)."""
    out: dict[str, list[str]] = collections.defaultdict(list)
    for patch in sorted(patches_dir.glob("*.patch")):
        for line in patch.read_text(encoding="utf-8", errors="replace").splitlines():
            m = re.match(r"^(?:\+\+\+|---) [ab]/(\S+)", line)
            if m and patch.name not in out[m.group(1)]:
                out[m.group(1)].append(patch.name)
    return dict(out)


def patch_section(touched: list[tuple[str, str]], patched: dict[str, list[str]]) -> list[str]:
    """Upstream changes to files a patch touches. A patch that still applies can still need a second look."""
    hits = [(status, path) for status, path in touched if path in patched]
    lines = ["## Files our patches touch", ""]
    if not hits:
        return lines + ["No upstream change touches a file in patches/.", ""]
    lines += [f"{len(hits)} patched file(s) changed upstream. Re-read these patches before repinning, even if they still apply.", "", "| File | Change | Patches |", "|---|---|---|"]
    lines += [f"| {path} | {status} | {', '.join(patched[path])} |" for status, path in hits]
    return lines + [""]


def report(old: str, new: str, changes: list[tuple[str, str]], patch_lines: list[str] | None = None) -> str:
    if not changes:
        return f"# Upstream apps: {old} to {new}\n\nNo file under apps/ changed.\n\n" + "\n".join(patch_lines or [])
    groups = summarise(changes)
    lines = [f"# Upstream apps: {old} to {new}", "", f"{len(changes)} files changed under apps/.", ""]
    for app in sorted(groups, key=lambda a: (APP_ORDER.index(a) if a in APP_ORDER else 99, a)):
        total = sum(groups[app].values())
        lines += [f"## apps/{app} ({total} files)", "", "| Area | Files |", "|---|---|"]
        for area, n in groups[app].most_common():
            lines.append(f"| {area} | {n} |")
        lines.append("")
    lines += patch_lines or []
    lines += [f"The pin moves to {new} only after the Sticks app PR that catches up sets \"upstream\": \"{new}\" in its version.json."]
    return "\n".join(lines) + "\n"


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--repo", required=True)
    p.add_argument("--from", dest="old")
    p.add_argument("--to", dest="new")
    p.add_argument("--out")
    a = p.parse_args(argv)
    if a.old:
        old = a.old
    else:
        sys.path.insert(0, str(ROOT / "scripts"))
        from sync_upstream import reviewed_tag

        old = reviewed_tag()
        if not old:
            sys.stderr.write("could not read the app's version.json (GH_TOKEN?); pass --from\n")
            return 2
    new = a.new or newest_tag(a.repo)
    if old == new:
        text = f"# Upstream apps\n\nNo newer release than {old}.\n"
        changed = False
    else:
        raw = git(a.repo, "diff", "--name-status", "--no-renames", old, new, "--", "apps/")
        changes = [tuple(line.split("\t", 1)) for line in raw.splitlines() if "\t" in line]
        patched = patched_files(ROOT / "patches")
        touched_raw = git(a.repo, "diff", "--name-status", "--no-renames", old, new, "--", *patched) if patched else ""
        touched = [tuple(line.split("\t", 1)) for line in touched_raw.splitlines() if "\t" in line]
        text = report(old, new, changes, patch_section(touched, patched))  # type: ignore[arg-type]
        changed = bool(changes) or bool(touched)
    if a.out:
        Path(a.out).write_text(text, encoding="utf-8", newline="\n")
    sys.stdout.write(text)
    return 10 if changed else 0


if __name__ == "__main__":
    sys.exit(main())
