"""Restart an unhealthy deployed parser without interfering with releases."""

from __future__ import annotations

import argparse
import fcntl
import json
import re
import subprocess
import time
from pathlib import Path

POLL_SECONDS = 15
FAILURES_BEFORE_RESTART = 3


def _log(event: str, **values: object) -> None:
    print(
        json.dumps({"event": event, "service": "capy-ingest-watchdog", **values}),
        flush=True,
    )


def _run(command: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command, check=True, capture_output=True, text=True, timeout=60
    )


def parser_state(project: str) -> tuple[str, str, str]:
    # Stopped containers stay stopped. Docker's healthcheck calls parser /healthz.
    ids = _run(
        [
            "/usr/bin/docker",
            "ps",
            "-q",
            "--filter",
            f"label=com.docker.compose.project={project}",
            "--filter",
            "label=com.docker.compose.service=parser",
        ]
    ).stdout.split()
    if not ids:
        return "", "", ""
    if len(ids) != 1:
        raise RuntimeError("expected exactly one parser container")
    state = (
        _run(
            [
                "/usr/bin/docker",
                "inspect",
                "--format",
                '{{index .Config.Labels "org.opencontainers.image.revision"}} {{if .State.Health}}{{.State.Health.Status}}{{end}}',
                ids[0],
            ]
        )
        .stdout.strip()
        .split()
    )
    if len(state) != 2:
        raise RuntimeError("parser revision or Docker healthcheck is missing")
    return ids[0], state[0], state[1]


def active_revision(state: Path) -> str:
    if (state / "pending").exists() or not (state / "active").is_file():
        return ""
    revision = (state / "active").read_text().strip()
    if not re.fullmatch(r"[0-9a-f]{40}", revision):
        raise RuntimeError("invalid active release identity")
    return revision


def restart_unhealthy_parser(state: Path, project: str) -> bool:
    with (state / "operation.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return False
        revision = active_revision(state)
        if not revision:
            return False
        container, deployed, health = parser_state(project)
        if not container or deployed != revision or health != "unhealthy":
            return False
        _run(["/usr/bin/docker", "restart", container])
        _log("parser_restarted", project=project, release=revision)
        return True


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stack", required=True, choices=("production", "nonprod"))
    args = parser.parse_args()
    state = Path("/opt/capy-ingest/releases") / args.stack
    project = "capy-ingest" if args.stack == "production" else "capy-ingest-nonprod"
    failures = 0
    while True:
        try:
            revision = active_revision(state)
            if revision:
                container, deployed, health = parser_state(project)
                unhealthy = (
                    bool(container) and deployed == revision and health == "unhealthy"
                )
                failures = failures + 1 if unhealthy else 0
                if failures >= FAILURES_BEFORE_RESTART:
                    restart_unhealthy_parser(state, project)
                    failures = 0
            else:
                failures = 0
        except Exception as exc:  # noqa: BLE001 - keep monitoring after transient Docker failures
            failures = 0
            # Docker/Compose errors can contain config values. Log only the error type.
            _log("watchdog_iteration_failed", error=type(exc).__name__, project=project)
        time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    main()
