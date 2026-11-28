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


FIX_WORDS = re.compile(r"^(fix|hotfix|revert)\b|^fix\(|\b(fix|fixes|fixed|bug|security|crash|regression|broken|leak|vulnerab\w*)\b", re.I)


def is_fix(title: str) -> bool:
    return bool(FIX_WORDS.search(title))


def fixes_first(titles: list[str]) -> list[str]:
    """Fixes first, each marked [fix]; then the rest, marked [feature]."""
    return [f"[fix] {t}" for t in titles if is_fix(t)] + [f"[feature] {t}" for t in titles if not is_fix(t)]


def split_counts(label: str, titles: list[str]) -> str:
    fixes = sum(1 for t in titles if is_fix(t))
    return f"- {label}: **{fixes} fixes**, {len(titles) - fixes} features ({len(titles)} commits)"


def patched_files(patches_dir: Path) -> dict[str, list[str]]:
    """Upstream files our patches touch: path -> patch names (from the patches' +++/--- headers)."""
    out: dict[str, list[str]] = collections.defaultdict(list)
    for patch in sorted(patches_dir.glob("*.patch")):
        for line in patch.read_text(encoding="utf-8", errors="replace").splitlines():
            m = re.match(r"^(?:\+\+\+|---) [ab]/(\S+)", line)
            if m and patch.name not in out[m.group(1)]:
                out[m.group(1)].append(patch.name)
    return dict(out)


def patch_section(touched: list[tuple[str, str]], patched: dict[str, list[str]],
                  commits: dict[str, list[str]] | None = None) -> list[str]:
    """Repo-wide: per patch, the files it touches that changed upstream. A patch that still applies can still need a look."""
    per: dict[str, list[str]] = collections.defaultdict(list)
    for status, path in touched:
        for name in patched.get(path, []):
            per[name].append(f"{path} ({ {'M': 'changed', 'D': 'deleted', 'A': 'added'}.get(status, status) })")
    lines = ["## Our patches (whole repo)", ""]
    if not per:
        return lines + ["No upstream change touches a file in patches/.", ""]
    for name in sorted(per):
        lines.append(f"- **{name}**")
        for entry in per[name]:
            lines.append(f"  - {entry}")
            for title in fixes_first((commits or {}).get(entry.split(" (")[0], [])):
                lines.append(f"    - {title}")
    return lines + ["", "Read each upstream commit above: upstream may now do what our patch does (duplicate work, even with no conflict).", ""]


def other_counts(counts: dict[str, int]) -> list[str]:
    """Everything outside apps/, one line per top-level folder."""
    if not counts:
        return []
    return ["## Rest of the repo", "", "; ".join(f"{k} {v}" for k, v in sorted(counts.items(), key=lambda kv: -kv[1])) + " files changed.", ""]


LEFT_OUT_REPO = "RokctAI/agent"
LEFT_OUT_PATH = "docs/sticks/left-out-on-purpose.md"


def fetch_left_out() -> str:
    """The Sticks app's list of Rakazo features left out on purpose (read with GH_TOKEN); empty when unreadable."""
    try:
        out = subprocess.run(["gh", "api", f"repos/{LEFT_OUT_REPO}/contents/{LEFT_OUT_PATH}",
                              "-H", "Accept: application/vnd.github.raw"], capture_output=True, text=True, timeout=60)
    except (OSError, subprocess.TimeoutExpired):
        return ""
    return out.stdout if out.returncode == 0 else ""


GENERIC_ACTIONS = {"events", "review", "submissions", "screen", "list", "get", "state"}


def _key(action: str) -> str:
    """`billing/*` -> billing; `bots/importPreview` -> import (a whole group only when the cell says *)."""
    group, _, name = action.partition("/")
    word = re.match(r"[a-z]+", name or "")
    if name == "*" or not word or word.group(0) in GENERIC_ACTIONS:
        return group.lower()
    return word.group(0)


def left_out_features(text: str) -> list[tuple[str, list[str]]]:
    """Table rows of the list: (feature, keywords). Keywords are the first part of each `group/action` cell."""
    rows = []
    for line in text.splitlines():
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if len(cells) < 3 or not line.lstrip().startswith("|") or set(cells[0]) <= set("-: "):
            continue
        keys = sorted({_key(k) for k in re.findall(r"`([^`]+)`", cells[1]) if "/" in k})
        if keys:
            rows.append((cells[0], keys))
    return rows


def _segments(path: str) -> set[str]:
    return {seg.lower() for seg in re.split(r"[/._-]", path) if seg}


def left_out_section(changes: list[tuple[str, str]], text: str) -> list[str]:
    """Changed files that belong to a feature the app leaves out on purpose: skipped, not a gap."""
    where = f"{LEFT_OUT_REPO} `{LEFT_OUT_PATH}`"
    if not text:
        return ["## Left out on purpose", "", f"Could not read {where}; check it by hand before planning app work.", ""]
    hits = []
    for feature, keys in left_out_features(text):
        files = [path for _, path in changes if _segments(path) & set(keys)]
        if files:
            hits.append(f"| {feature.replace('|', '/')} | {', '.join(keys)} | {len(files)} |")
    lines = ["## Left out on purpose", "", f"Also check {where}: changes to these features are skipped on purpose, not gaps."]
    if hits:
        lines += ["", "| Feature (skipped on purpose) | Matched | Files |", "|---|---|---|"] + hits
    else:
        lines += ["", "No changed file matches a listed feature."]
    return lines + [""]


def report(old: str, new: str, changes: list[tuple[str, str]], patch_lines: list[str] | None = None,
           notes: dict[tuple[str, str], list[str]] | None = None) -> str:
    if not changes:
        return f"# Upstream apps: {old} to {new}\n\nNo file under apps/ changed.\n\n" + "\n".join(patch_lines or [])
    groups = summarise(changes)
    lines = [f"# Upstream apps: {old} to {new}", "", f"{len(changes)} files changed under apps/.", ""] + [l for l in (patch_lines or []) if l is not None]
    for app in sorted(groups, key=lambda a: (APP_ORDER.index(a) if a in APP_ORDER else 99, a)):
        total = sum(groups[app].values())
        lines += [f"## apps/{app} ({total} files)", "", "| Area | Files | What changed (upstream commits) |", "|---|---|---|"]
        for area, n in groups[app].most_common():
            what = "; ".join((notes or {}).get((app, area), [])) or "-"
            lines.append(f"| {area} | {n} | {what} |")
        lines.append("")
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
        notes = {}
        for app, areas in summarise(changes).items():  # type: ignore[arg-type]
            for area in areas:
                where = f"apps/{app}" if area == "(app root)" else f"apps/{app}/{area}"
                subjects = git(a.repo, "log", "--no-merges", "--format=%s", f"{old}..{new}", "--", where).splitlines()
                marked = fixes_first(subjects)
                nfix = sum(1 for t in subjects if is_fix(t))
                notes[(app, area)] = [f"{nfix} fix(es), {len(subjects) - nfix} feature(s)"] + [t.replace("|", "/")[:90] for t in marked[:3]] + ([f"+{len(marked) - 3} more"] if len(marked) > 3 else [])
        rest: dict[str, int] = collections.Counter()
        for line in git(a.repo, "diff", "--name-only", "--no-renames", old, new, "--", ".", ":(exclude)apps/").splitlines():
            rest[line.split("/")[0] if "/" in line else "(root files)"] += 1
        app_titles = git(a.repo, "log", "--no-merges", "--format=%s", f"{old}..{new}", "--", "apps/").splitlines()
        patch_titles = git(a.repo, "log", "--no-merges", "--format=%s", f"{old}..{new}", "--", *[p for _, p in touched]).splitlines() if touched else []
        summary = ["## Fixes and features", "", split_counts("apps/", app_titles), split_counts("files our patches touch", patch_titles),
                   "", "Fixes are listed first everywhere below. A title counts as a fix when it says fix, bug, security, crash, regression, leak or revert.", ""]
        summary += left_out_section(changes, fetch_left_out())  # type: ignore[arg-type]
        text = report(old, new, changes, summary + patch_section(touched, patched, {path: git(a.repo, "log", "--no-merges", "--format=%s", f"{old}..{new}", "--", path).splitlines() for _, path in touched}) + other_counts(rest), notes)  # type: ignore[arg-type]
        changed = bool(changes) or bool(touched)
    if a.out:
        Path(a.out).write_text(text, encoding="utf-8", newline="\n")
    sys.stdout.write(text)
    return 10 if changed else 0


if __name__ == "__main__":
    sys.exit(main())
