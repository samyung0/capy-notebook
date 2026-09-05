from __future__ import annotations

import fcntl
import importlib.util
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
WATCHDOG_PATH = REPO_ROOT / "deploy/ansible/ingest-host/files/capy_ingest_watchdog.py"
spec = importlib.util.spec_from_file_location("capy_ingest_watchdog", WATCHDOG_PATH)
assert spec is not None and spec.loader is not None
watchdog = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = watchdog
spec.loader.exec_module(watchdog)


def test_watchdog_respects_release_lock_and_pending_state(tmp_path, monkeypatch):
    sha = "a" * 40
    (tmp_path / "active").write_text(sha)
    monkeypatch.setattr(
        watchdog, "parser_state", lambda _: ("parser-id", sha, "unhealthy")
    )
    commands = []
    monkeypatch.setattr(watchdog, "_run", lambda args: commands.append(args))
    with (tmp_path / "operation.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        assert not watchdog.restart_unhealthy_parser(tmp_path, "capy-ingest-nonprod")
    (tmp_path / "pending").mkdir()
    assert not watchdog.restart_unhealthy_parser(tmp_path, "capy-ingest-nonprod")
    (tmp_path / "pending").rmdir()
    assert watchdog.restart_unhealthy_parser(tmp_path, "capy-ingest-nonprod")
    assert commands == [["/usr/bin/docker", "restart", "parser-id"]]


def test_watchdog_only_restarts_unhealthy_active_parser(tmp_path, monkeypatch):
    sha = "a" * 40
    (tmp_path / "active").write_text(sha)

    def unexpected_command(_):
        raise AssertionError("must not restart parser")

    monkeypatch.setattr(watchdog, "_run", unexpected_command)
    for state in (
        ("", "", ""),
        ("parser-id", sha, "healthy"),
        ("parser-id", sha, "starting"),
        ("parser-id", "b" * 40, "unhealthy"),
    ):
        monkeypatch.setattr(watchdog, "parser_state", lambda _, state=state: state)
        assert not watchdog.restart_unhealthy_parser(tmp_path, "capy-ingest-nonprod")


def test_watchdog_selects_only_the_requested_stack(monkeypatch):
    calls = []

    def run(args):
        calls.append(args)
        output = "parser-id\n" if "ps" in args else "a" * 40 + " unhealthy\n"
        return subprocess.CompletedProcess(args, 0, stdout=output)

    monkeypatch.setattr(watchdog, "_run", run)
    assert watchdog.parser_state("capy-ingest-nonprod") == (
        "parser-id",
        "a" * 40,
        "unhealthy",
    )
    assert "label=com.docker.compose.project=capy-ingest-nonprod" in calls[0]
    assert "label=com.docker.compose.service=parser" in calls[0]
