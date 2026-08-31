"""Host telemetry parsing without a live ingest host or database."""

from __future__ import annotations

from pathlib import Path

import pytest

from pipeline.ingest import host_sampler


def _proc_fixture(root: Path) -> None:
    (root / "net").mkdir(parents=True)
    (root / "stat").write_text("cpu  100 0 50 850 0 0 0 0\n", encoding="ascii")
    (root / "loadavg").write_text("1.25 0.50 0.25 1/100 1\n", encoding="ascii")
    (root / "meminfo").write_text(
        "MemTotal: 16000 kB\nMemAvailable: 12000 kB\n"
        "SwapTotal: 1000 kB\nSwapFree: 750 kB\n",
        encoding="ascii",
    )
    (root / "diskstats").write_text(
        "254 0 vda 1 0 10 0 1 0 20 0 0 0 0 0 0 0 0\n"
        "259 0 nvme0n1 1 0 30 0 1 0 40 0 0 0 0 0 0 0 0\n"
        "259 1 nvme0n1p1 1 0 300 0 1 0 400 0 0 0 0 0 0 0 0\n"
        "7 0 loop0 1 0 999 0 1 0 999 0 0 0 0 0 0 0 0\n",
        encoding="ascii",
    )
    (root / "net/dev").write_text(
        "Inter-| Receive | Transmit\n face |bytes |bytes\n"
        "lo: 99 0 0 0 0 0 0 0 99 0 0 0 0 0 0 0\n"
        "eth0: 123 0 0 0 0 0 0 0 456 0 0 0 0 0 0 0\n",
        encoding="ascii",
    )


def test_collects_compact_host_values(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    _proc_fixture(tmp_path)
    monkeypatch.setattr(host_sampler, "PROC_ROOT", tmp_path)
    monkeypatch.setattr(host_sampler, "SHARED_DIR", tmp_path)
    monkeypatch.setattr(
        host_sampler,
        "parser_health",
        lambda: {
            "active_jobs": 2,
            "queued_jobs": 3,
            "active_slices": 4,
            "queued_slices": 5,
            "oldest_active_slice_s": 12.5,
            "oldest_queued_slice_s": 3,
            "last_slice_completed_age_s": 2.25,
            "cgroup_oom_kill_events": 1,
            "cgroup_memory_bytes": 500,
            "cgroup_memory_peak_bytes": 700,
            "pss_bytes": 400,
        },
    )

    values = host_sampler.sample(
        host_sampler.CpuCounters(total=900, idle=800),
        host_sampler.CpuCounters(total=1000, idle=850),
    )

    assert values["cpu_percent"] == 50.0
    assert values["active_jobs"] == 2
    assert values["active_slices"] == 4
    assert values["queued_slices"] == 5
    assert values["oldest_active_slice_ms"] == 12500
    assert values["oldest_queued_slice_ms"] == 3000
    assert values["last_slice_completed_age_ms"] == 2250
    assert values["parser_oom_kill_events"] == 1
    assert values["memory_used_bytes"] == 4000 * 1024
    assert values["swap_used_bytes"] == 250 * 1024
    assert values["disk_read_bytes"] == 40 * 512
    assert values["disk_write_bytes"] == 60 * 512
    assert values["network_rx_bytes"] == 123
    assert values["network_tx_bytes"] == 456
    assert values["parser_pss_bytes"] == 400
    assert values["parser_memory_peak_bytes"] == 700
    assert values["host_metrics_available"]


def test_zero_cpu_delta_is_safe() -> None:
    counters = host_sampler.CpuCounters(total=100, idle=50)
    assert host_sampler.cpu_percent(counters, counters) == 0.0
