from __future__ import annotations

from pathlib import Path

import pytest

from pipeline.ingest import telemetry


def test_job_run_tracks_stage_timings_and_numeric_stats(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    times = iter((10.25, 10.75))
    monkeypatch.setattr(telemetry.time, "monotonic", lambda: next(times))

    token = telemetry.begin_job({"attemptId": 42, "id": "job-1", "attempts": 2})
    try:
        run = telemetry._job_run.get()
        assert run is not None
        run.stage_started = 10.0
        telemetry.stage("source_download")
        telemetry.record(source_bytes=1024, donor_reused=False)
        snapshot = telemetry.snapshot()
    finally:
        telemetry.reset_job(token)

    assert snapshot["attempt_id"] == 42
    assert snapshot["stage"] == "source_download"
    assert snapshot["stage_timings"] == {"claimed": 250, "source_download": 500}
    assert snapshot["stats"] == {"source_bytes": 1024, "donor_reused": False}
    assert telemetry.current_attempt_id() is None


def test_cgroup_values_reports_delta_cores_and_limits(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    (tmp_path / "cpu.stat").write_text(
        "usage_usec 2500000\nuser_usec 2000000\nsystem_usec 500000\n",
        encoding="ascii",
    )
    (tmp_path / "memory.current").write_text("1048576\n", encoding="ascii")
    (tmp_path / "memory.peak").write_text("2097152\n", encoding="ascii")
    (tmp_path / "memory.max").write_text("4194304\n", encoding="ascii")
    (tmp_path / "pids.current").write_text("8\n", encoding="ascii")
    (tmp_path / "pids.max").write_text("64\n", encoding="ascii")
    (tmp_path / "memory.events").write_text(
        "low 0\nhigh 0\noom 2\noom_kill 1\n", encoding="ascii"
    )
    (tmp_path / "io.stat").write_text(
        "8:0 rbytes=1000 wbytes=2000 rios=2 wios=3\n"
        "8:1 rbytes=500 wbytes=750 rios=1 wios=1\n",
        encoding="ascii",
    )
    monkeypatch.setattr(telemetry, "_CGROUP_ROOT", tmp_path)

    values = telemetry.cgroup_values(previous_usage=500_000, elapsed_s=2.0)

    assert values["cpu_cores"] == 1.0
    assert values["memory_bytes"] == 1_048_576
    assert values["memory_peak_bytes"] == 2_097_152
    assert values["memory_limit_bytes"] == 4_194_304
    assert values["io_read_bytes"] == 1500
    assert values["io_write_bytes"] == 2750
    assert values["oom_events"] == 2
    assert values["oom_kill_events"] == 1


@pytest.mark.parametrize(
    ("exc", "category", "code"),
    (
        (TimeoutError("late"), "timeout", "job_timeout"),
        (MemoryError("out of memory"), "oom", "parse_oom"),
        (ConnectionError("network unavailable"), "network", "connectionerror"),
        (ValueError("invalid artifact bundle"), "artifact", "valueerror"),
    ),
)
def test_error_classification_is_stable(
    exc: BaseException, category: str, code: str
) -> None:
    assert telemetry.classify_error(exc)[:2] == (category, code)
