#!/usr/bin/env python3
"""Measure the engine: idle memory (RSS) of its process tree, run two ways, against a disposable Postgres.

Steps:
  1. build the engine (scripts/build_engine.py) into <workdir>/build;
  2. bundle the engine entry with esbuild (upstream's own dev dependency) into one file, run by plain
     node. Workspace packages are bundled; packages from node_modules stay external;
  3. start a disposable Postgres 18 with the docker CLI (the Testcontainers image, via the same
     mirror prefix CI sets for Testcontainers);
  4. run the engine twice, one after the other, on that Postgres with the benchmark settings from
     upstream's testkit (scripted model, fake sandbox): first from source under tsx, then the bundle
     under plain node. For each run: wait for GET /health, let it settle, then sum VmRSS over the
     engine's process tree (Linux /proc);
  5. run the built bundle once more with --heap-prof, outside the RSS runs, and add the 15 largest
     packages at idle (a sampling heap profile, grouped by the package of the allocating frame);
  6. write the markdown tables to --summary (CI passes $GITHUB_STEP_SUMMARY).

The numbers are only meaningful on the CI runner. This script is run by CI's Measurements job.

Exit codes: 0 measured; 1 an engine did not start or answer; 2 the build, the bundle or the
environment is not usable.

Usage:
  python scripts/measure_engine.py --workdir <empty or missing folder> --summary <file>
"""
from __future__ import annotations

import argparse
import json
import os
import secrets
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
POSTGRES_IMAGE = "postgres:18-alpine"
SETTLE_SECONDS = 10
HEALTH_TIMEOUT_SECONDS = 180
ENGINE_ENTRY = "apps/sticks-engine/src/index.ts"
BUNDLE_OUT = "apps/sticks-engine/dist/sticks-engine.mjs"

EXIT_OK, EXIT_NO_ENGINE, EXIT_ENV = 0, 1, 2

# Written into the build checkout and run with node. Workspace packages are bundled (their .ts
# sources resolve through package.json); anything resolved inside node_modules stays external and is
# imported by absolute path, so pnpm's per-package links still resolve from where the package lives.
BUNDLER_JS = """\
// Written by scripts/measure_engine.py into the build checkout. Not part of the repository.
import * as esbuild from "esbuild";
const NODE_MODULES = /[\\\\/]node_modules[\\\\/]/;
await esbuild.build({
  entryPoints: ["%(entry)s"],
  outfile: "%(out)s",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  logLevel: "warning",
  banner: {
    js: 'import { createRequire as __sticksCreateRequire } from "node:module"; const require = __sticksCreateRequire(import.meta.url);',
  },
  plugins: [
    {
      name: "external-node-modules",
      setup(build) {
        build.onResolve({ filter: /^[^./]/ }, async (args) => {
          if (args.pluginData && args.pluginData.resolving) return undefined;
          const resolved = await build.resolve(args.path, {
            resolveDir: args.resolveDir,
            kind: args.kind,
            pluginData: { resolving: true },
          });
          if (resolved.errors.length || !resolved.path) return undefined;
          if (NODE_MODULES.test(resolved.path)) return { path: resolved.path, external: true };
          return undefined;
        });
      },
    },
  ],
});
""" % {"entry": ENGINE_ENTRY, "out": BUNDLE_OUT}


# ---- pure helpers (tested in tests/test_measure_engine.py) ----------------------------------


def vmrss_kb(status_text: str) -> int:
    """VmRSS in kB from a /proc/<pid>/status text; 0 if absent (the process already exited)."""
    for line in status_text.splitlines():
        if line.startswith("VmRSS:"):
            parts = line.split()
            if len(parts) >= 2 and parts[1].isdigit():
                return int(parts[1])
    return 0


def descendants(root: int, parent_of: dict[int, int]) -> list[int]:
    """root and every process below it, given a pid -> ppid table."""
    found = [root]
    frontier = [root]
    while frontier:
        current = frontier.pop()
        for pid, ppid in parent_of.items():
            if ppid == current and pid not in found:
                found.append(pid)
                frontier.append(pid)
    return found


COLD_START_TARGET_SECONDS = 3.0


def format_summary(runs: list[tuple[str, int, int, float | None]]) -> str:
    """The markdown table for the job summary.

    runs: (label, RSS in kB, processes in the tree, cold start to the first healthy response in seconds).
    The cold start is measured from spawning the engine to its first 200 on GET /health (spec 7.6, target 3 s).
    """
    lines = [
        "## Engine idle memory and cold start (scripts/measure_engine.py)",
        "",
        "| Run | Idle RSS, engine process tree | Processes in the tree | Cold start to first response (target 3 s) |",
        "|---|---|---|---|",
    ]
    for label, rss_kb, processes, cold in runs:
        cold_text = "not measured" if cold is None else f"{cold:.2f} s"
        lines.append(f"| {label} | {rss_kb / 1024:.1f} MB | {processes} | {cold_text} |")
    lines += [
        "",
        f"Postgres: {POSTGRES_IMAGE} (disposable, docker CLI). Settle time before reading: "
        f"{SETTLE_SECONDS} s. Both runs use the same Postgres, one after the other.",
    ]
    return "\n".join(lines) + "\n"


def process_table() -> dict[int, int]:
    """pid -> ppid for every process, from /proc (Linux only)."""
    table: dict[int, int] = {}
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        try:
            stat = (entry / "stat").read_text()
        except OSError:
            continue
        # The command name can contain spaces; the fields after the last ')' are fixed.
        after = stat.rsplit(")", 1)[1].split()
        table[int(entry.name)] = int(after[1])
    return table


def tree_rss_kb(root: int) -> tuple[int, int]:
    """(RSS in kB, process count) for root and its descendants."""
    pids = descendants(root, process_table())
    total = 0
    for pid in pids:
        try:
            total += vmrss_kb(Path(f"/proc/{pid}/status").read_text())
        except OSError:
            continue
    return total, len(pids)


PROFILE_TOP = 15
BUNDLED_LABEL = "engine + workspace packages (bundled)"


def package_of(url: str) -> str:
    """The package that owns a profile frame, from its script URL.

    Anything under node_modules is grouped by its package (scoped names keep both parts). The bundled
    engine file holds the engine and every workspace package. A frame with no URL is node's own code.
    """
    if not url:
        return "node internals"
    if url.startswith("node:"):
        return "node: builtins"
    if url in ("eval", "<anonymous>") or url.startswith("eval") or url.startswith("<"):
        return "eval / anonymous"
    path = url.replace("\\", "/")
    if path.startswith("file://"):
        path = path[len("file://"):]
    if path.endswith("/" + Path(BUNDLE_OUT).name):
        return BUNDLED_LABEL
    if "/node_modules/" in path:
        parts = path.rsplit("/node_modules/", 1)[1].split("/")
        if parts[0].startswith("@") and len(parts) > 1:
            return f"{parts[0]}/{parts[1]}"
        return parts[0]
    if path.startswith("/") or (len(path) > 2 and path[1] == ":"):
        return "file: outside node_modules"
    return "other (no file path)"


def aggregate_profile(root: dict) -> tuple[dict[str, int], int]:
    """Bytes per package across a sampling heap profile tree (selfSize of every node), and the total."""
    totals: dict[str, int] = {}
    total = 0
    stack = [root]
    while stack:
        node = stack.pop()
        size = int(node.get("selfSize", 0))
        package = package_of(node.get("callFrame", {}).get("url", ""))
        totals[package] = totals.get(package, 0) + size
        total += size
        stack.extend(node.get("children", []))
    return totals, total


def format_profile_table(totals: dict[str, int], total: int) -> str:
    """The job-summary table of the largest packages at idle."""
    ranked = sorted(totals.items(), key=lambda item: item[1], reverse=True)[:PROFILE_TOP]
    lines = [
        "## Engine memory by package at idle (scripts/measure_engine.py, sampling heap profile)",
        "",
        "Live allocations at shutdown, grouped by the package of the frame that allocated them. This is "
        "allocation-site attribution from the sampling profiler, not dominator-tree retained size.",
        "",
        "| Rank | Package | Live bytes | Share of sampled |",
        "|---|---|---|---|",
    ]
    for rank, (package, size) in enumerate(ranked, start=1):
        share = (size / total * 100) if total else 0.0
        lines.append(f"| {rank} | {package} | {size / (1024 * 1024):.1f} MB | {share:.1f}% |")
    lines.append("")
    lines.append(f"Total sampled: {total / (1024 * 1024):.1f} MB. Taken from the built run, after the same "
                 f"{SETTLE_SECONDS} s settle, with a separate run so the profiler does not change the RSS numbers.")
    return "\n".join(lines) + "\n"


# ---- steps ----------------------------------------------------------------------------------


def step(message: str) -> None:
    print(f"== {message}", flush=True)


def build(workdir: Path) -> Path | None:
    """Build the engine into <workdir>/build. Returns the checkout folder, or None on failure."""
    target = workdir / "build"
    step(f"build the engine into {target}")
    r = subprocess.run(
        [sys.executable, str(ROOT / "scripts" / "build_engine.py"), "--workdir", str(target)],
        text=True,
        capture_output=True,
        check=False,
    )
    print(r.stdout[-2000:])
    if r.returncode != 0:
        print(r.stderr[-3000:], file=sys.stderr)
        return None
    return target / "up"


def bundle(checkout: Path) -> Path | None:
    """Bundle the engine entry into one ESM file with esbuild, run by node. None on failure."""
    step("bundle the engine with esbuild (workspace packages in, node_modules external)")
    node = shutil.which("node")
    if not node:
        print("node not found; CI sets it up with setup-node", file=sys.stderr)
        return None
    (checkout / "bundle-engine.mjs").write_text(BUNDLER_JS, encoding="utf-8", newline="\n")
    r = subprocess.run([node, "bundle-engine.mjs"], cwd=checkout, text=True, capture_output=True, check=False)
    if r.returncode != 0 or not (checkout / BUNDLE_OUT).is_file():
        print(r.stdout[-2000:], r.stderr[-3000:], sep="\n", file=sys.stderr)
        return None
    size_mb = (checkout / BUNDLE_OUT).stat().st_size / (1024 * 1024)
    print(f"bundle: {BUNDLE_OUT} ({size_mb:.1f} MB)")
    return checkout / BUNDLE_OUT


def start_postgres() -> tuple[str, str, str]:
    """(container id, host port, password). The image comes through the Testcontainers mirror if set."""
    image = POSTGRES_IMAGE
    prefix = os.environ.get("TESTCONTAINERS_HUB_IMAGE_NAME_PREFIX", "")
    if prefix:
        image = prefix + image
    password = secrets.token_urlsafe(24)
    step(f"start Postgres ({image})")
    cid = subprocess.run(
        ["docker", "run", "-d", "--rm", "-e", f"POSTGRES_PASSWORD={password}", "-p", "127.0.0.1::5432",
         image, "postgres", "-c", "fsync=off", "-c", "synchronous_commit=off", "-c", "full_page_writes=off"],
        text=True, capture_output=True, check=True,
    ).stdout.strip()
    port_line = subprocess.run(["docker", "port", cid, "5432/tcp"], text=True, capture_output=True,
                               check=True).stdout.strip().splitlines()[0]
    port = port_line.rsplit(":", 1)[1]
    deadline = time.monotonic() + 120
    while time.monotonic() < deadline:
        ready = subprocess.run(["docker", "exec", cid, "pg_isready", "-U", "postgres"],
                               capture_output=True, check=False)
        if ready.returncode == 0:
            return cid, port, password
        time.sleep(1)
    raise RuntimeError("Postgres did not become ready")


def write_secrets(folder: Path, db_password: str) -> None:
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "db_password").write_text(db_password, encoding="utf-8", newline="\n")
    (folder / "content_key").write_text(secrets.token_urlsafe(32), encoding="utf-8", newline="\n")


def engine_env(db_port: str, secrets_dir: Path, data_dir: Path, api_port: int) -> dict[str, str]:
    """The benchmark settings from upstream's testkit (performance-stack.ts), plus our database URL."""
    origin = f"http://127.0.0.1:{api_port}"
    env = dict(os.environ)
    env.update({
        "NODE_ENV": "production",
        "WAKEUP_DRIVER": "memory",
        "SANDBOX_PROVIDER": "fake",
        "AGENT_RUNTIME": "scripted",
        "CLOUD_AGENT_PROVIDER": "emulator",
        "RAKAZO_LIVE_MODEL_CATALOG": "off",
        "ANALYTICS_PROVIDER": "none",
        "LOG_LEVEL": "off",
        "COMPOSIO_API_KEY": "",
        "OPENROUTER_API_KEY": "",
        "BETTER_AUTH_SECRET": "sticks-measure-auth-secret-over-32-characters",
        "ENCRYPTION_KEY": "sticks-measure-encryption-key-over-32-characters",
        "SANDBOX_SUPERVISOR_TOKEN": "sticks-measure-supervisor-token-over-32-characters",
        "SCREEN_PROXY_SECRET": "sticks-measure-screen-proxy-secret-over-32-characters",
        "BETTER_AUTH_URL": origin,
        "WEB_ORIGIN": origin,
        "API_HOST": "127.0.0.1",
        "API_PORT": str(api_port),
        "DATA_DIR": str(data_dir),
        "SIGNUPS_ENABLED": "true",
        "STICKS_DATABASE_URL": f"postgresql://postgres@127.0.0.1:{db_port}/postgres",
        "STICKS_SECRETS_DIR": str(secrets_dir),
    })
    return env


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def wait_for_health(api_port: int, proc: subprocess.Popen) -> bool:
    deadline = time.monotonic() + HEALTH_TIMEOUT_SECONDS
    url = f"http://127.0.0.1:{api_port}/health"
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            return False
        try:
            with urllib.request.urlopen(url, timeout=2) as response:
                if response.status == 200 and json.load(response).get("ok") is True:
                    return True
        except Exception:
            pass
        time.sleep(1)
    return False


def measure_run(label: str, argv: list[str], checkout: Path, db_port: str, tmp: Path) -> tuple[int, int, float]:
    """Start the engine with argv, wait for /health, settle, read the tree's RSS, stop it.

    Returns (RSS in kB, processes in the tree, cold start in seconds: spawn to the first healthy response).
    Raises RuntimeError with the engine's stderr tail if it does not answer.
    """
    api_port = free_port()
    step(f"{label}: start on 127.0.0.1:{api_port}")
    stderr_path = tmp / f"{label.split()[0]}.err"
    data_dir = tmp / f"data-{label.split()[0]}"
    proc = None
    with open(stderr_path, "w", encoding="utf-8") as stderr_file:
        try:
            spawned = time.monotonic()
            proc = subprocess.Popen(
                argv,
                cwd=checkout,
                env=engine_env(db_port, tmp / "secrets", data_dir, api_port),
                stdout=subprocess.DEVNULL,
                stderr=stderr_file,
            )
            if not wait_for_health(api_port, proc):
                raise RuntimeError(f"{label}: the engine did not answer GET /health\n"
                                   + stderr_path.read_text(encoding="utf-8")[-3000:])
            cold_seconds = time.monotonic() - spawned
            step(f"{label}: first healthy response in {cold_seconds:.2f} s; settle {SETTLE_SECONDS} s, then read RSS")
            time.sleep(SETTLE_SECONDS)
            rss, count = tree_rss_kb(proc.pid)
            return rss, count, cold_seconds
        finally:
            if proc is not None and proc.poll() is None:
                proc.terminate()
                try:
                    proc.wait(timeout=20)
                except subprocess.TimeoutExpired:
                    proc.kill()


def profile_run(checkout: Path, node: str, db_port: str, tmp: Path) -> str:
    """One more built run with --heap-prof; node writes the profile when it exits. Returns the table."""
    prof_dir = tmp / "heap-prof"
    prof_dir.mkdir(parents=True, exist_ok=True)
    measure_run("profile (built, heap-prof)", [node, "--heap-prof", f"--heap-prof-dir={prof_dir}", BUNDLE_OUT],
                checkout, db_port, tmp)
    profiles = sorted(prof_dir.glob("*.heapprofile"), key=lambda path: path.stat().st_mtime)
    if not profiles:
        return ("## Engine memory by package at idle (scripts/measure_engine.py)\n\n"
                "No heap profile was written: the engine did not exit through its shutdown path within 20 s.\n")
    root = json.loads(profiles[-1].read_text(encoding="utf-8"))["head"]
    totals, total = aggregate_profile(root)
    return format_profile_table(totals, total)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--workdir", required=True, help="folder for the build (missing or empty)")
    ap.add_argument("--summary", required=True, help="markdown file to write (CI passes $GITHUB_STEP_SUMMARY)")
    args = ap.parse_args()

    if sys.platform != "linux":
        print("measure_engine.py reads /proc and runs on the Linux CI runner only", file=sys.stderr)
        return EXIT_ENV
    workdir = Path(args.workdir).resolve()
    if workdir.exists() and any(workdir.iterdir()):
        print(f"REFUSED: workdir {workdir} exists and is not empty", file=sys.stderr)
        return EXIT_ENV
    workdir.mkdir(parents=True, exist_ok=True)

    checkout = build(workdir)
    if checkout is None:
        return EXIT_ENV
    bundle_path = bundle(checkout)
    if bundle_path is None:
        return EXIT_ENV
    node = shutil.which("node")
    tsx = checkout / "node_modules" / ".bin" / "tsx"

    tmp = Path(tempfile.mkdtemp(prefix="sticks-measure-"))
    cid = None
    try:
        cid, db_port, db_password = start_postgres()
        write_secrets(tmp / "secrets", db_password)
        try:
            tsx_rss, tsx_count, tsx_cold = measure_run("tsx (source)", [str(tsx), ENGINE_ENTRY], checkout, db_port, tmp)
            built_rss, built_count, built_cold = measure_run("built (plain node)", [node, BUNDLE_OUT], checkout, db_port, tmp)
            profile_table = profile_run(checkout, node, db_port, tmp)
        except RuntimeError as exc:
            print(str(exc), file=sys.stderr)
            return EXIT_NO_ENGINE
        table = format_summary([
            ("tsx (source, as before)", tsx_rss, tsx_count, tsx_cold),
            ("built (esbuild bundle, plain node)", built_rss, built_count, built_cold),
        ])
        with open(args.summary, "a", encoding="utf-8", newline="\n") as summary:
            summary.write(table + "\n" + profile_table)
        print(table + "\n" + profile_table)
        return EXIT_OK
    finally:
        if cid:
            subprocess.run(["docker", "rm", "-f", cid], capture_output=True, check=False)
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
