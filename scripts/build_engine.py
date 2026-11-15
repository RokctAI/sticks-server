#!/usr/bin/env python3
"""Build the engine: upstream at the pinned tag, plus our patches, plus our overlay.

Steps (spec 11.4):
  1. clone the pinned tag (upstream.pin) into <workdir>/up;
  2. apply patches/series in order;
  3. copy overlay/ on top at the same relative paths. Refuse (exit 2) if any overlay file would
     overwrite a file that already exists in upstream;
  4. pnpm install --frozen-lockfile, then upstream's typecheck (`pnpm run check`). pnpm comes from
     corepack, which reads the version upstream pins in its packageManager field;
  4b. `tsc --noEmit` on each overlay tsconfig.json under apps/ (task 5b): a type error fails the build;
  5. vitest run on our overlay test files only (a temporary config outside this repo).

CI runs this in the Engine job (.github/workflows/ci.yml), after `corepack enable` on Node 24.

Exit codes:
  0   built, typechecked, overlay tests pass (or there are no overlay tests yet)
  1   typecheck or overlay tests failed (our engine code breaks)
  2   refused (overlay collides with upstream, workdir not empty), or the environment is not usable
  3   a patch in patches/series does not apply

Usage:
  python scripts/build_engine.py --workdir <empty or missing folder> [--tag vX.Y.Z]

--tag builds a different release tag than upstream.pin (the weekly sync uses it to test a newer tag
before the pin moves). The pin file itself is never changed here.
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import sync_upstream as up  # noqa: E402  (clone, patch and pin helpers are shared with the weekly sync)

ROOT = Path(__file__).resolve().parent.parent
OVERLAY = ROOT / "overlay"
OVERLAY_DOC = "README.md"  # overlay/README.md documents the folder; it is not copied onto upstream
TEST_GLOBS = ("*.test.ts", "*.test.tsx")

EXIT_OK, EXIT_BROKEN, EXIT_REFUSED, EXIT_PATCH = 0, 1, 2, 3


# ---- pure helpers (tested in tests/test_build_engine.py) ------------------------------------


def overlay_files(overlay_root: Path) -> list[str]:
    """Relative POSIX paths of every file to copy, sorted. The folder's own README is skipped."""
    out = []
    for p in sorted(overlay_root.rglob("*")):
        if not p.is_file():
            continue
        rel = p.relative_to(overlay_root).as_posix()
        if rel == OVERLAY_DOC:
            continue
        out.append(rel)
    return out


def collisions(files: list[str], upstream_root: Path) -> list[str]:
    """Overlay files that would overwrite something already in the upstream checkout."""
    return [f for f in files if (upstream_root / f).exists()]


def chosen_tag(pin_tag: str, override: str | None) -> str:
    """The tag to build: the --tag override when given, otherwise the one in upstream.pin."""
    return override or pin_tag


def overlay_typecheck_projects(files: list[str]) -> list[str]:
    """Overlay tsconfig.json files under apps/. Each is typechecked with `tsc --noEmit` (task 5b)."""
    return [f for f in files if f.startswith("apps/") and f.endswith("/tsconfig.json")]


def unexplained_tsc_failure(returncode: int, output: str) -> bool:
    """tsc failed but said nothing we can attribute: no `error TS` line at all (a crash, or a changed format)."""
    return returncode != 0 and "error TS" not in output


def overlay_type_errors(output: str, project_dir: str) -> list[str]:
    """The tsc lines that are ours to fix: errors in files under project_dir, and config-level errors.

    Our overlay imports upstream packages by relative path, and tsc then reports errors inside those
    packages (their own jsx and path settings are not ours). Upstream's `pnpm run check` already covers
    them, so those lines are left out here. Lines are `path(line,col): error TSnnnn: ...` with pretty off.
    """
    prefix = project_dir.replace("\\", "/").rstrip("/") + "/"
    out: list[str] = []
    for line in output.splitlines():
        if "error TS" not in line:
            continue
        m = re.match(r"^(.+?)\(\d+,\d+\): error TS", line)
        if m is None or m.group(1).replace("\\", "/").startswith(prefix):
            out.append(line)
    return out


def overlay_test_files(files: list[str]) -> list[str]:
    return [f for f in files if any(Path(f).match(g) for g in TEST_GLOBS)]


def workdir_ok(path: Path) -> bool:
    """The build works in a folder that does not exist yet, or one that is empty."""
    return not path.exists() or (path.is_dir() and not any(path.iterdir()))


def node_satisfies(version: str, engines: str) -> bool:
    """Check a `vX.Y.Z` node version against a simple engines range: '^24.15.0 || >=26.0.0'."""
    m = re.match(r"v?(\d+)\.(\d+)\.(\d+)", version.strip())
    if not m:
        return False
    cur = (int(m.group(1)), int(m.group(2)), int(m.group(3)))
    for alt in (a.strip() for a in engines.split("||")):
        mm = re.match(r"^(\^|>=)\s*(\d+)\.(\d+)\.(\d+)$", alt)
        if not mm:
            continue
        base = (int(mm.group(2)), int(mm.group(3)), int(mm.group(4)))
        if mm.group(1) == ">=" and cur >= base:
            return True
        if mm.group(1) == "^" and cur >= base and cur[0] == base[0]:
            return True
    return False


def upstream_engines_node(package_json_text: str) -> str:
    return json.loads(package_json_text).get("engines", {}).get("node", "")


def vitest_config_text(files: list[str]) -> str:
    """A temporary vitest config that runs only the overlay test files."""
    include = json.dumps(files)
    return (
        'import { defineConfig } from "vitest/config";\n'
        "export default defineConfig({\n"
        '  test: { environment: "node", include: ' + include + ", testTimeout: 30000 },\n"
        "});\n"
    )


# ---- steps ----------------------------------------------------------------------------------


def node_version() -> str:
    r = up.run(["node", "--version"], check=False)
    return r.stdout.strip() if r.returncode == 0 else ""


def step(msg: str) -> None:
    print(f"== {msg}", flush=True)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--workdir", required=True, help="folder to build in (missing or empty)")
    ap.add_argument("--tag", help="build this release tag instead of upstream.pin's TAG")
    args = ap.parse_args()

    pin = up.read_pin(ROOT / "upstream.pin")
    tag = chosen_tag(pin.get("TAG", ""), args.tag)
    if not up.tag_key(tag):
        print(f"no valid release tag (got {tag!r}; upstream.pin TAG or --tag)", file=sys.stderr)
        return EXIT_REFUSED

    work = Path(args.workdir).resolve()
    if not workdir_ok(work):
        print(f"REFUSED: workdir {work} exists and is not empty", file=sys.stderr)
        return EXIT_REFUSED
    work.mkdir(parents=True, exist_ok=True)

    checkout = work / "up"
    step(f"clone upstream {tag}")
    try:
        up.clone_tag(pin, tag, checkout)
    except RuntimeError as exc:
        print(f"REFUSED: {exc}", file=sys.stderr)
        return EXIT_REFUSED

    step("apply patches/series")
    series = up.parse_series((ROOT / "patches" / "series").read_text(encoding="utf-8"))
    applied, problems = up.apply_patches(checkout, ROOT / "patches", series)
    if problems:
        print("\n".join(problems), file=sys.stderr)
        return EXIT_PATCH
    print(f"applied: {', '.join(applied) or 'none'}")

    overlay_list = overlay_files(OVERLAY) if OVERLAY.is_dir() else []
    step(f"copy overlay ({len(overlay_list)} files)")
    clash = collisions(overlay_list, checkout)
    if clash:
        print("REFUSED: overlay files would overwrite upstream files:", file=sys.stderr)
        print("\n".join(f"  {c}" for c in clash), file=sys.stderr)
        return EXIT_REFUSED
    for rel in overlay_list:
        dest = checkout / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(OVERLAY / rel, dest)
    # The procedures our app calls, for the overlay routing test (task 6). Test input only, not code.
    contracts = ROOT / "contracts" / "used-procedures.txt"
    if contracts.is_file():
        (checkout / "sticks-contracts").mkdir(exist_ok=True)
        shutil.copyfile(contracts, checkout / "sticks-contracts" / "used-procedures.txt")

    engines = upstream_engines_node((checkout / "package.json").read_text(encoding="utf-8"))
    node_v = node_version()
    if engines and not node_satisfies(node_v, engines):
        print(f"node {node_v or 'not found'} does not satisfy upstream engines '{engines}'", file=sys.stderr)
        return EXIT_REFUSED

    pnpm = shutil.which("pnpm")
    if not pnpm:
        print("pnpm not found; run `corepack enable` first (CI does this)", file=sys.stderr)
        return EXIT_REFUSED

    step("pnpm install --frozen-lockfile")
    r = up.run([pnpm, "install", "--frozen-lockfile"], cwd=checkout, check=False)
    if r.returncode != 0:
        print(r.stdout[-3000:], r.stderr[-3000:], sep="\n", file=sys.stderr)
        return EXIT_BROKEN

    step("upstream typecheck: pnpm run check")
    r = up.run([pnpm, "run", "check"], cwd=checkout, check=False)
    print(r.stdout[-1500:])
    if r.returncode != 0:
        print(r.stderr[-3000:], file=sys.stderr)
        return EXIT_BROKEN

    for project in overlay_typecheck_projects(overlay_list):
        step(f"overlay typecheck: tsc --noEmit -p {project}")
        r = up.run([pnpm, "exec", "tsc", "--noEmit", "--pretty", "false", "-p", project], cwd=checkout, check=False)
        output = r.stdout + "\n" + r.stderr
        ours = overlay_type_errors(output, str(Path(project).parent))
        if ours:
            print("type errors in our overlay code:", file=sys.stderr)
            print("\n".join(ours[:200]), file=sys.stderr)
            return EXIT_BROKEN
        if unexplained_tsc_failure(r.returncode, output):
            print("tsc exited non-zero but printed no `error TS` line; failing rather than guessing",
                  file=sys.stderr)
            print(output[-3000:], file=sys.stderr)
            return EXIT_BROKEN
        if r.returncode != 0:
            print("tsc reports errors only inside upstream packages our code imports; upstream's check covers them")

    tests = overlay_test_files(overlay_list)
    if not tests:
        step("overlay tests: none yet, nothing to run")
        return EXIT_OK
    step(f"vitest run on {len(tests)} overlay test file(s)")
    (checkout / "vitest.overlay.config.mjs").write_text(vitest_config_text(tests), encoding="utf-8", newline="\n")
    r = up.run([pnpm, "exec", "vitest", "run", "--config", "vitest.overlay.config.mjs"], cwd=checkout, check=False)
    print(r.stdout[-3000:])
    if r.returncode != 0:
        print(r.stderr[-3000:], file=sys.stderr)
        return EXIT_BROKEN
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
