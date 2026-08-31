"""Restart the ingest parser when its health endpoint reports failure."""

from __future__ import annotations

import json
import os
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

POLL_SECONDS = 15
HEALTH_TIMEOUT_SECONDS = 5
FAILURES_BEFORE_RESTART = 3


def _log(event: str, **values: object) -> None:
    print(
        json.dumps(
            {"event": event, "service": "evo-ingest-watchdog", **values},
            separators=(",", ":"),
        ),
        flush=True,
    )


def failure_reason(payload: object) -> str:
    if not isinstance(payload, dict):
        return "health response is not a JSON object"
    if payload.get("ok") is not True or payload.get("state") != "ready":
        return f"parser state is {payload.get('state') or 'unknown'}"
    return ""


def _run(command: list[str], *, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command,
        check=check,
        capture_output=True,
        text=True,
        timeout=60,
    )


def _compose_command(*arguments: str) -> list[str]:
    return [
        "/usr/bin/docker",
        "compose",
        "--env-file",
        os.environ["EVO_WATCHDOG_ENV_FILE"],
        "--env-file",
        os.environ["EVO_WATCHDOG_RELEASE_ENV_FILE"],
        "-f",
        os.environ["EVO_WATCHDOG_COMPOSE_FILE"],
        *arguments,
    ]


def _parser_container_id() -> str:
    result = _run(_compose_command("ps", "-q", "parser"), check=False)
    if result.returncode != 0:
        _log("compose_ps_failed", detail=result.stderr.strip()[:500])
        return ""
    return result.stdout.strip()


def _docker_state(container_id: str) -> tuple[str, str]:
    result = _run(
        [
            "/usr/bin/docker",
            "inspect",
            "--format",
            "{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}",
            container_id,
        ],
        check=False,
    )
    if result.returncode != 0:
        return "missing", ""
    status, _, health = result.stdout.strip().partition(" ")
    return status, health


def _health_url() -> str:
    explicit = os.environ.get("EVO_WATCHDOG_PARSER_URL", "").strip()
    if explicit:
        return explicit
    bind_address = os.environ.get("PARSER_BIND_ADDRESS", "").strip()
    if not bind_address:
        raise RuntimeError("PARSER_BIND_ADDRESS is not configured")
    return f"http://{bind_address}:8090/healthz"


def _health() -> dict[str, Any]:
    with urllib.request.urlopen(
        _health_url(), timeout=HEALTH_TIMEOUT_SECONDS
    ) as response:
        return json.loads(response.read(256 << 10))


def _restart_parser(reason: str) -> None:
    result = _run(_compose_command("restart", "parser"), check=False)
    if result.returncode != 0:
        _log(
            "parser_restart_failed",
            reason=reason,
            detail=result.stderr.strip()[:500],
        )
        return
    _log("parser_restarted", reason=reason)


def main() -> None:
    os.chdir(os.environ["EVO_WATCHDOG_REPO_DIR"])
    pending_release = Path(os.environ["EVO_WATCHDOG_PENDING_RELEASE"])
    failures = 0
    last_reason = ""
    while True:
        try:
            if pending_release.exists():
                failures = 0
                time.sleep(POLL_SECONDS)
                continue
            container_id = _parser_container_id()
            if not container_id:
                failures = 0
                time.sleep(POLL_SECONDS)
                continue
            status, docker_health = _docker_state(container_id)
            if status != "running":
                reason = f"Docker parser state is {status}"
            else:
                try:
                    reason = failure_reason(_health())
                except (
                    OSError,
                    RuntimeError,
                    ValueError,
                    urllib.error.URLError,
                ) as exc:
                    reason = f"parser health request failed: {exc}"
                if not reason and docker_health == "unhealthy":
                    reason = "Docker health status is unhealthy"
            if reason:
                failures += 1
                last_reason = reason
                _log(
                    "parser_health_failed",
                    failures=failures,
                    reason=reason,
                )
            else:
                failures = 0
                last_reason = ""
            if failures >= FAILURES_BEFORE_RESTART:
                _restart_parser(last_reason)
                failures = 0
                last_reason = ""
        except Exception as exc:  # noqa: BLE001 - systemd restarts a crashed watchdog
            _log("watchdog_iteration_failed", detail=str(exc)[:500])
        time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    main()
