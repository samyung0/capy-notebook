from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
WATCHDOG_PATH = (
    REPO_ROOT
    / "deploy"
    / "ansible"
    / "ingest-host"
    / "files"
    / "evo_ingest_watchdog.py"
)
spec = importlib.util.spec_from_file_location("evo_ingest_watchdog", WATCHDOG_PATH)
assert spec is not None and spec.loader is not None
watchdog = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = watchdog
spec.loader.exec_module(watchdog)


def test_ready_parser_is_healthy_even_during_long_slice() -> None:
    assert watchdog.failure_reason({"ok": True, "state": "ready"}) == ""
    assert (
        watchdog.failure_reason(
            {
                "ok": True,
                "state": "ready",
                "active_slices": 4,
                "oldest_active_slice_s": 599,
            }
        )
        == ""
    )


def test_only_failed_parser_health_needs_restart() -> None:
    assert "failed" in watchdog.failure_reason({"ok": False, "state": "failed"})
    assert (
        watchdog.failure_reason(
            {
                "ok": True,
                "state": "ready",
                "active_slices": 1,
                "oldest_active_slice_s": 10_000,
            }
        )
        == ""
    )
