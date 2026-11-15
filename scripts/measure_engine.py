#!/usr/bin/env python3
"""Measure the built engine: idle memory (RSS) of its process tree, against a disposable Postgres.

Steps:
  1. build the engine (scripts/build_engine.py) into <workdir>/build;
  2. start a disposable Postgres 18 with the docker CLI (the Testcontainers image, via the same
     mirror prefix CI sets for Testcontainers);
  3. write the two secrets to a temp folder and start the built engine (overlay index.ts) with
     the benchmark settings from upstream's testkit (scripted model, fake sandbox);
  4. wait for GET /health, let it settle, then sum VmRSS over the engine's process tree (Linux /proc);
  5. write a small markdown table to --summary (CI passes $GITHUB_STEP_SUMMARY) and clean up.

The numbers are only meaningful on the CI runner. This script is run by CI's Measurements job.

Exit codes: 0 measured; 1 the engine did not start or answer; 2 the build failed or the environment
is not usable.

Usage:
  python scripts/measure_engine.py --workdir <empty or missing folder> --summary <file>
"""
from __future__ import annotations

import argparse
import json
import os
import secrets
import shutil
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

EXIT_OK, EXIT_NO_ENGINE, EXIT_ENV = 0, 1, 2


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


def format_summary(rss_kb: int, processes: int, cold_start_note: str = "") -> str:
    """The markdown table written to the job summary."""
    lines = [
        "## Engine idle memory (scripts/measure_engine.py)",
        "",
        "| Measure | Value |",
        "|---|---|",
        f"| Idle RSS, engine process tree | {rss_kb / 1024:.1f} MB |",
        f"| Processes in the tree | {processes} |",
        "| Postgres | " + POSTGRES_IMAGE + " (disposable, docker CLI) |",
        "| Settle time before reading | " + str(SETTLE_SECONDS) + " s |",
    ]
    if cold_start_note:
        lines.append(f"| Note | {cold_start_note} |")
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


def engine_env(port: str, db_port: str, secrets_dir: Path, data_dir: Path, api_port: int) -> dict[str, str]:
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
    import socket

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

    tmp = Path(tempfile.mkdtemp(prefix="sticks-measure-"))
    cid = None
    proc = None
    try:
        cid, db_port, db_password = start_postgres()
        secrets_dir = tmp / "secrets"
        write_secrets(secrets_dir, db_password)
        api_port = free_port()
        step(f"start the built engine on 127.0.0.1:{api_port}")
        tsx = checkout / "node_modules" / ".bin" / "tsx"
        proc = subprocess.Popen(
            [str(tsx), "apps/sticks-engine/src/index.ts"],
            cwd=checkout,
            env=engine_env(str(api_port), db_port, secrets_dir, tmp / "data", api_port),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
        )
        if not wait_for_health(api_port, proc):
            err = proc.stderr.read() if proc.stderr and proc.poll() is not None else ""
            print("the engine did not answer GET /health", file=sys.stderr)
            print(err[-3000:], file=sys.stderr)
            return EXIT_NO_ENGINE
        step(f"settle {SETTLE_SECONDS} s, then read RSS")
        time.sleep(SETTLE_SECONDS)
        rss, count = tree_rss_kb(proc.pid)
        table = format_summary(rss, count)
        with open(args.summary, "a", encoding="utf-8", newline="\n") as summary:
            summary.write(table)
        print(table)
        return EXIT_OK
    finally:
        if proc is not None and proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=20)
            except subprocess.TimeoutExpired:
                proc.kill()
        if cid:
            subprocess.run(["docker", "rm", "-f", cid], capture_output=True, check=False)
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
