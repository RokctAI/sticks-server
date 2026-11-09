#!/usr/bin/env python3
"""Check upstream (elie222/rakazo) for a newer release tag and test our patch set against it.

Read-only with respect to every remote: it never pushes and never force-pushes. Upstream is read
directly from UPSTREAM_REPO in upstream.pin (no mirror dependency; MIRROR_REPO is optional). It clones the new tag into a temporary folder, applies patches/series on top of it, checks
that every procedure in contracts/used-procedures.txt still exists, collects the upstream
changelog entries since the pin, compares the pinned version with the new one by area (mobile, web,
desktop, server, contract, infra...) and writes a report.

Exit codes:
  0   up to date (nothing newer than the pin)
  10  a newer tag exists and everything applies: propose moving the pin
  20  at least one patch does not apply (conflict report written)
  30  the contract check failed (the app calls a procedure that no longer exists)
  2   usage or environment error

Usage:
  python scripts/sync_upstream.py [--report report.md] [--write-pin] [--tag vX.Y.Z]
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.request
from pathlib import Path
from string import Template

ROOT = Path(__file__).resolve().parent.parent
TAG_RE = re.compile(r"^v(\d+)\.(\d+)\.(\d+)$")


# ---- small pure helpers (tested in tests/test_sync.py) -------------------------------------


def read_pin(path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        out[key.strip()] = value.strip()
    return out


def parse_series(text: str) -> list[str]:
    return [l.strip() for l in text.splitlines() if l.strip() and not l.strip().startswith("#")]


def tag_key(tag: str) -> tuple[int, int, int] | None:
    m = TAG_RE.match(tag)
    return (int(m.group(1)), int(m.group(2)), int(m.group(3))) if m else None


def newest_tag(ls_remote_output: str) -> str | None:
    best: tuple[tuple[int, int, int], str] | None = None
    for line in ls_remote_output.splitlines():
        parts = line.split()
        if len(parts) != 2 or not parts[1].startswith("refs/tags/"):
            continue
        tag = parts[1][len("refs/tags/"):]
        key = tag_key(tag)
        if key and (best is None or key > best[0]):
            best = (key, tag)
    return best[1] if best else None


def used_procedures(text: str) -> list[str]:
    return [l.strip() for l in text.splitlines() if l.strip() and not l.strip().startswith("#")]


def contract_procedures(rpc_ts: str) -> set[str]:
    """Procedure names as group/name from upstream's contract router (packages/contracts/src/rpc.ts).

    The router is an object of groups ("  bots: {") holding procedures ("    list: oc...").
    """
    group: str | None = None
    out: set[str] = set()
    for line in rpc_ts.splitlines():
        m = re.match(r"^  (\w+): \{\s*$", line)
        if m:
            group = m.group(1)
            continue
        if re.match(r"^  \},?\s*$", line):
            group = None
            continue
        m = re.match(r"^    (\w+): oc\b", line)
        if m and group:
            out.add(f"{group}/{m.group(1)}")
    return out


def changelog_since(changelog: str, pinned_tag: str, new_tag: str, keep=("Changed", "Removed", "Fixed")) -> str:
    """Bullets under the chosen headings for versions after the pin up to the new tag."""
    lo, hi = tag_key(pinned_tag), tag_key(new_tag)
    if not lo or not hi:
        return "(could not read versions)"
    out: list[str] = []
    version: tuple[int, int, int] | None = None
    heading = ""
    for line in changelog.splitlines():
        m = re.match(r"^## \[(\d+)\.(\d+)\.(\d+)\]", line)
        if m:
            version = (int(m.group(1)), int(m.group(2)), int(m.group(3)))
            heading = ""
            if lo < version <= hi:
                out.append(f"\n**{m.group(1)}.{m.group(2)}.{m.group(3)}**")
            continue
        if line.startswith("## "):  # [Unreleased] or others
            version = None
            continue
        if version is None or not (lo < version <= hi):
            continue
        h = re.match(r"^### (\w+)", line)
        if h:
            heading = h.group(1)
            if heading in keep:
                out.append(f"_{heading}_")
            continue
        if heading in keep and line.startswith("- "):
            out.append(line[:300])
    return "\n".join(out).strip() or "(no entries under those headings)"


# Areas of the upstream repo, first match wins. WATCH areas are the client apps: a change there may be
# worth bringing to our Sticks app by hand, so the report calls them out.
AREAS: list[tuple[str, tuple[str, ...], bool]] = [
    ("Mobile app", ("apps/mobile/",), True),
    ("Web app", ("apps/web/", "packages/ui-web/", "packages/chat-ui/", "packages/ui-tokens/", "packages/page-kit/"), True),
    ("Desktop app", ("apps/desktop/",), True),
    ("API contract (what our app calls)", ("packages/contracts/",), False),
    (
        "Server (api, worker, adapters, core, db, auth, memory)",
        (
            "apps/api/", "apps/worker/", "packages/adapters/", "packages/adapter-kit/", "packages/core/",
            "packages/db/", "packages/auth/", "packages/memory/", "packages/logging/",
        ),
        False,
    ),
    ("Infra and deploy", ("infra/",), False),
    ("Website", ("apps/www/",), False),
    ("Tests and tooling", ("packages/testkit/",), False),
    ("Docs", ("docs/", "README", "CHANGELOG", "VISION"), False),
]


def area_of(path: str) -> str:
    for label, prefixes, _watch in AREAS:
        if path.startswith(prefixes):
            return label
    return "Other"


def summarize_diff(numstat: str) -> dict[str, dict]:
    """Group `git diff --numstat` output by area: file list, added and removed lines."""
    out: dict[str, dict] = {}
    for line in numstat.splitlines():
        parts = line.split("\t")
        if len(parts) != 3:
            continue
        add, rem, path = parts
        a = out.setdefault(area_of(path), {"files": [], "added": 0, "removed": 0})
        a["files"].append(path)
        a["added"] += int(add) if add.isdigit() else 0
        a["removed"] += int(rem) if rem.isdigit() else 0
    return out


def is_noise(path: str) -> bool:
    """Tests and translation files: counted in the table, left out of the file list."""
    return path.endswith((".po", ".test.ts", ".test.tsx", ".test.js", ".spec.ts")) or "/e2e/" in path


def format_changes(summary: dict[str, dict], subjects: dict[str, list[str]] | None = None) -> str:
    """Markdown for the report: a line per area, and details for the watched client apps."""
    if not summary:
        return "No file changes between the two versions."
    order = [a[0] for a in AREAS] + ["Other"]
    watch = {a[0] for a in AREAS if a[2]}
    lines = ["| Area | Files | Added | Removed |", "|---|---|---|---|"]
    for label in order:
        if label in summary:
            v = summary[label]
            mark = " **(check by hand)**" if label in watch else ""
            lines.append(f"| {label}{mark} | {len(v['files'])} | +{v['added']} | -{v['removed']} |")
    changed_watch = [l for l in order if l in watch and l in summary]
    lines.append("")
    if changed_watch:
        lines.append(
            "**CHECK BY HAND: client app code changed (" + ", ".join(changed_watch) + ").** "
            "Decide whether any of it is worth bringing to the Sticks mobile app. "
            "Changed files (first 25 per area; tests and translations left out of the list):"
        )
        for label in changed_watch:
            lines.append(f"\n_{label}_")
            shown = [f for f in summary[label]["files"] if not is_noise(f)]
            lines.extend(f"- `{f}`" for f in shown[:25])
            extra = len(shown) - 25
            if extra > 0:
                lines.append(f"- ...and {extra} more")
            for subj in (subjects or {}).get(label, [])[:15]:
                lines.append(f"  - commit: {subj}")
    else:
        lines.append("No change in the mobile, web or desktop apps.")
    return "\n".join(lines)


# ---- git and network ------------------------------------------------------------------------


def run(cmd: list[str], cwd: Path | None = None, check: bool = True) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, cwd=cwd, text=True, capture_output=True, check=check)


def ls_remote_tags(url: str) -> str:
    r = run(["git", "ls-remote", "--tags", "--refs", url], check=False)
    return r.stdout if r.returncode == 0 else ""


def find_new_tag(pin: dict[str, str]) -> tuple[str | None, str]:
    """Newest release tag from the optional mirror, then UPSTREAM_REPO. Returns (tag, source)."""
    for label, key in (("mirror", "MIRROR_REPO"), ("upstream", "UPSTREAM_REPO")):
        url = pin.get(key)
        if not url:
            continue
        tag = newest_tag(ls_remote_tags(url))
        if tag:
            return tag, f"{label} ({url})"
    return None, "none reachable"


def clone_tag(pin: dict[str, str], tag: str, dest: Path) -> str:
    for key in ("MIRROR_REPO", "UPSTREAM_REPO"):
        url = pin.get(key)
        if not url:
            continue
        r = run(["git", "clone", "--depth", "1", "--branch", tag, url, str(dest)], check=False)
        if r.returncode == 0:
            return url
        shutil.rmtree(dest, ignore_errors=True)
    raise RuntimeError(f"could not clone tag {tag} from upstream")


def apply_patches(checkout: Path, patches_dir: Path, series: list[str]) -> tuple[list[str], list[str]]:
    """Apply in order. Returns (applied, problems). Stops at the first patch that does not apply."""
    applied: list[str] = []
    problems: list[str] = []
    for i, name in enumerate(series):
        patch = (patches_dir / name).resolve()
        if not patch.is_file():
            problems.append(f"`{name}`: file listed in series but missing")
            problems.extend(f"`{n}`: not tried" for n in series[i + 1:])
            break
        r = run(["git", "apply", "--check", str(patch)], cwd=checkout, check=False)
        if r.returncode == 0:
            run(["git", "apply", str(patch)], cwd=checkout)
            applied.append(name)
            continue
        # Explain: which hunks fail (apply into a scratch copy with --reject).
        scratch = Path(tempfile.mkdtemp(prefix="sync-reject-"))
        try:
            shutil.copytree(checkout, scratch / "co", symlinks=True)
            rr = run(["git", "apply", "--reject", str(patch)], cwd=scratch / "co", check=False)
            detail = "\n".join((rr.stderr or "").splitlines()[:25])
        finally:
            shutil.rmtree(scratch, ignore_errors=True)
        problems.append(f"`{name}` does not apply:\n```\n{detail}\n```")
        problems.extend(f"`{n}`: not tried (after a failed patch)" for n in series[i + 1:])
        break
    return applied, problems


def compare_versions(checkout: Path, old_tag: str, new_tag: str) -> str:
    """Which parts of upstream changed between the pinned tag and the new tag (best effort)."""
    try:
        r = run(["git", "fetch", "--depth=1", "origin", f"refs/tags/{old_tag}:refs/tags/{old_tag}"], cwd=checkout, check=False)
        if r.returncode != 0:
            return f"(could not fetch the pinned tag `{old_tag}` to compare: {r.stderr.strip()[:200]})"
        numstat = run(["git", "diff", "--numstat", old_tag, new_tag], cwd=checkout).stdout
        summary = summarize_diff(numstat)
        subjects: dict[str, list[str]] = {}
        # Commit subjects since the pin, if the host lets us fetch just that range.
        d = run(
            ["git", "fetch", f"--shallow-exclude={old_tag}", "origin", f"refs/tags/{new_tag}:refs/tags/{new_tag}"],
            cwd=checkout,
            check=False,
        )
        if d.returncode == 0:
            for label, prefixes, watch in AREAS:
                if watch and label in summary:
                    log = run(
                        ["git", "log", "--format=%s", f"{old_tag}..{new_tag}", "--", *[p.rstrip("/") for p in prefixes]],
                        cwd=checkout,
                        check=False,
                    ).stdout
                    subjects[label] = [l for l in log.splitlines() if l][:15]
        return format_changes(summary, subjects)
    except Exception as exc:  # a failed comparison must not hide the rest of the report
        return f"(comparison failed: {exc})"


def image_digest(image: str, tag: str) -> str:
    """Best effort: manifest digest of an image tag on ghcr.io (anonymous read). '' on any failure."""
    try:
        repo = image.split("ghcr.io/", 1)[1]
        with urllib.request.urlopen(f"https://ghcr.io/token?scope=repository:{repo}:pull", timeout=20) as r:
            token = json.load(r)["token"]
        req = urllib.request.Request(
            f"https://ghcr.io/v2/{repo}/manifests/{tag}",
            method="HEAD",
            headers={
                "Authorization": f"Bearer {token}",
                "Accept": "application/vnd.oci.image.index.v1+json, "
                "application/vnd.docker.distribution.manifest.list.v2+json, "
                "application/vnd.oci.image.manifest.v1+json",
            },
        )
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.headers.get("docker-content-digest", "")
    except Exception:
        return ""


def write_pin(path: Path, pin: dict[str, str], tag: str, commit: str) -> None:
    pin = dict(pin)
    pin["TAG"], pin["COMMIT"] = tag, commit
    pin["APP_IMAGE_DIGEST"] = image_digest(pin.get("APP_IMAGE", ""), tag)
    pin["COMPUTER_IMAGE_DIGEST"] = image_digest(pin.get("COMPUTER_IMAGE", ""), tag)
    missing = [k for k in ("APP_IMAGE_DIGEST", "COMPUTER_IMAGE_DIGEST") if not pin[k]]
    if missing:  # never write a pin that falls back to a movable tag
        raise RuntimeError(f"no image digest found for {tag} ({', '.join(missing)}); not writing the pin")
    header = [l for l in path.read_text().splitlines() if l.startswith("#")]
    body = [f"{k}={v}" for k, v in pin.items()]
    path.write_text("\n".join(header + body) + "\n")


# ---- main -----------------------------------------------------------------------------------


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--report", help="write the markdown report here (default: stdout)")
    ap.add_argument("--write-pin", action="store_true", help="on exit 10, rewrite upstream.pin to the new tag")
    ap.add_argument("--tag", help="test this tag instead of the newest one")
    args = ap.parse_args()

    if args.tag and not tag_key(args.tag):
        print(f"--tag {args.tag!r} is not a release tag like v0.9.0", file=sys.stderr)
        return 2
    pin = read_pin(ROOT / "upstream.pin")
    pinned = pin.get("TAG", "")
    if not tag_key(pinned):
        print("upstream.pin has no valid TAG", file=sys.stderr)
        return 2
    new_tag, source = (args.tag, "--tag") if args.tag else find_new_tag(pin)
    if not new_tag:
        print("no release tag reachable on upstream", file=sys.stderr)
        return 2

    values = {
        "pinned_tag": pinned,
        "new_tag": new_tag,
        "source": source,
        "date": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
    }
    if tag_key(new_tag) <= tag_key(pinned):
        values.update(status="UP TO DATE", result="Nothing newer than the pin.", patches="-", contract="-",
                      changelog="-", changes="-", next_steps="Nothing to do.")
        emit(values, args.report)
        return 0

    work = Path(tempfile.mkdtemp(prefix="sync-upstream-"))
    code = 10
    try:
        checkout = work / "up"
        clone_tag(pin, new_tag, checkout)
        commit = run(["git", "rev-parse", "HEAD"], cwd=checkout).stdout.strip()

        series = parse_series((ROOT / "patches" / "series").read_text())
        applied, problems = apply_patches(checkout, ROOT / "patches", series)
        if problems:
            code = 20
            patches_txt = "\n".join([f"Applied: {', '.join(applied) or 'none'}", ""] + problems)
        else:
            patches_txt = f"All {len(applied)} patch(es) apply." if applied else "No patches (stock upstream)."

        rpc = checkout / "packages" / "contracts" / "src" / "rpc.ts"
        used = used_procedures((ROOT / "contracts" / "used-procedures.txt").read_text())
        if rpc.is_file():
            have = contract_procedures(rpc.read_text())
            missing = [u for u in used if u not in have]
            if missing:
                code = 30 if code == 10 else code
                contract_txt = "Missing in the new tag (the app would break):\n" + "\n".join(f"- {m}" for m in missing)
            else:
                contract_txt = f"All {len(used)} procedures the app calls still exist."
        else:
            code = 30 if code == 10 else code
            contract_txt = "packages/contracts/src/rpc.ts not found: upstream moved its contract; check by hand."

        changes = compare_versions(checkout, pinned, new_tag)

        cl = checkout / "CHANGELOG.md"
        changelog = changelog_since(cl.read_text(), pinned, new_tag) if cl.is_file() else "(no CHANGELOG.md)"

        if code == 10:
            status, result = "NEWER TAG READY", f"`{new_tag}` is newer than `{pinned}` and our patches and contract check pass."
            steps = "Open a DRAFT PR moving the pin (the robot does this), test on a test instance, then let the gatekeeper review."
            if args.write_pin:
                try:
                    write_pin(ROOT / "upstream.pin", pin, new_tag, commit)
                except RuntimeError as exc:
                    code = 2
                    status, result = "NOT READY", f"`{new_tag}` passes our checks but the pin was NOT written: {exc}."
                    steps = ("Upstream may not have published images for this tag yet. Wait and re-run; "
                             "the pin only moves with image digests.")
        elif code == 20:
            status, result = "CONFLICT", f"`{new_tag}` is newer but at least one patch does not apply. The pin does NOT move."
            steps = "Rebase the failing patch on the new tag by hand (or drop it if upstream took the change), update patches/, re-run."
        else:
            status, result = "CONTRACT BREAK", f"`{new_tag}` is newer but the app calls something that no longer exists. The pin does NOT move."
            steps = "Update the Dart client and used-procedures.txt in the same wave, or skip this tag."
        values.update(status=status, result=result, patches=patches_txt, contract=contract_txt,
                      changelog=changelog, changes=changes, next_steps=steps)
        emit(values, args.report)
        return code
    finally:
        shutil.rmtree(work, ignore_errors=True)


def emit(values: dict[str, str], report: str | None) -> None:
    text = Template((ROOT / "templates" / "report.md").read_text()).safe_substitute(values)
    if report:
        Path(report).write_text(text)
    else:
        print(text)


if __name__ == "__main__":
    sys.exit(main())
