"""Persist compact parser-host samples without document identifiers."""

from __future__ import annotations

import logging
import os
import re
import shutil
import socket
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import psycopg
import requests

from .. import obs
from ..config import cfg

log = logging.getLogger("evo.ingest.host_sampler")


def _env_float(name: str, default: float) -> float:
    try:
        return max(1.0, float(os.environ.get(name, str(default))))
    except ValueError:
        return default


PROC_ROOT = Path(os.environ.get("EVO_HOST_PROC", "/host/proc"))
HOST_ID = os.environ.get("EVO_INGEST_HOST_ID", socket.gethostname())
ENVIRONMENT = os.environ.get("EVO_INGEST_ENVIRONMENT", "").strip().lower() or (
    "local"
    if os.environ.get("APP_ENV", "development") == "development"
    else "production"
)
RELEASE_SHA = os.environ.get("RELEASE_SHA", "").strip()
HOST_METRICS_ENABLED = os.environ.get("EVO_HOST_METRICS_ENABLED", "true") == "true"
ACTIVE_INTERVAL = _env_float("EVO_HOST_SAMPLE_ACTIVE_SECONDS", 5.0)
IDLE_INTERVAL = _env_float("EVO_HOST_SAMPLE_IDLE_SECONDS", 60.0)
SPOOL_INTERVAL = _env_float("EVO_HOST_SPOOL_SAMPLE_SECONDS", 60.0)
HEALTH_URL = os.environ.get("PARSER_HEALTH_URL", "http://127.0.0.1:8090/healthz")
SHARED_DIR = Path(os.environ.get("EVO_PARSE_SHARED_DIR", "/var/lib/evo-parse"))
PARTITION_NAME = re.compile(
    r"^(?:sd[a-z]+|vd[a-z]+|xvd[a-z]+)\d+$|^(?:nvme\d+n\d+|mmcblk\d+)p\d+$"
)
_spool_cache: dict[str, int] = {}
_spool_sampled_at = 0.0


@dataclass(frozen=True)
class CpuCounters:
    total: int
    idle: int


def _read(path: str) -> str:
    return (PROC_ROOT / path).read_text(encoding="ascii", errors="replace")


def cpu_counters() -> CpuCounters:
    fields = _read("stat").splitlines()[0].split()[1:]
    values = [int(value) for value in fields]
    return CpuCounters(sum(values), sum(values[3:5]))


def cpu_percent(before: CpuCounters, after: CpuCounters) -> float:
    total = max(0, after.total - before.total)
    idle = max(0, after.idle - before.idle)
    if total == 0:
        return 0.0
    return round(min(100.0, max(0.0, 100.0 * (total - idle) / total)), 2)


def memory_values() -> dict[str, int]:
    values: dict[str, int] = {}
    for line in _read("meminfo").splitlines():
        if ":" not in line:
            continue
        key, raw = line.split(":", 1)
        try:
            values[key] = int(raw.strip().split()[0]) * 1024
        except (ValueError, IndexError):
            continue
    total = values.get("MemTotal", 0)
    available = values.get("MemAvailable", values.get("MemFree", 0))
    swap_total = values.get("SwapTotal", 0)
    swap_free = values.get("SwapFree", 0)
    return {
        "memory_total_bytes": total,
        "memory_available_bytes": available,
        "memory_used_bytes": max(0, total - available),
        "swap_used_bytes": max(0, swap_total - swap_free),
    }


def disk_values() -> tuple[int, int]:
    read_bytes = write_bytes = 0
    for line in _read("diskstats").splitlines():
        fields = line.split()
        if len(fields) < 14:
            continue
        name = fields[2]
        if name.startswith(("loop", "ram", "sr", "dm-")) or PARTITION_NAME.match(name):
            continue
        try:
            read_bytes += int(fields[5]) * 512
            write_bytes += int(fields[9]) * 512
        except ValueError:
            continue
    return read_bytes, write_bytes


def network_values() -> tuple[int, int]:
    received = sent = 0
    for line in _read("net/dev").splitlines()[2:]:
        if ":" not in line:
            continue
        name, raw = line.split(":", 1)
        if name.strip() == "lo":
            continue
        fields = raw.split()
        try:
            received += int(fields[0])
            sent += int(fields[8])
        except (ValueError, IndexError):
            continue
    return received, sent


def spool_values() -> dict[str, int]:
    global _spool_cache, _spool_sampled_at
    now = time.monotonic()
    if _spool_cache and now - _spool_sampled_at < SPOOL_INTERVAL:
        return dict(_spool_cache)
    try:
        disk_free = shutil.disk_usage(SHARED_DIR).free
    except OSError:
        disk_free = 0
    total = files = 0
    try:
        for path in SHARED_DIR.rglob("*"):
            if not path.is_file():
                continue
            files += 1
            try:
                total += path.stat().st_size
            except OSError:
                continue
    except OSError:
        pass
    _spool_cache = {
        "disk_free_bytes": max(0, disk_free),
        "spool_bytes": max(0, total),
        "spool_files": max(0, files),
    }
    _spool_sampled_at = now
    return dict(_spool_cache)


def parser_health() -> dict[str, Any]:
    try:
        response = requests.get(HEALTH_URL, timeout=2)
        response.raise_for_status()
        body = response.json()
        return body if isinstance(body, dict) else {}
    except Exception:
        log.warning("parser health unavailable", exc_info=True)
        return {}


def sample(before: CpuCounters, after: CpuCounters) -> dict[str, Any]:
    disk_read, disk_write = disk_values() if HOST_METRICS_ENABLED else (0, 0)
    network_rx, network_tx = network_values() if HOST_METRICS_ENABLED else (0, 0)
    health = parser_health()
    try:
        load_1 = float(_read("loadavg").split()[0]) if HOST_METRICS_ENABLED else 0.0
    except (OSError, ValueError, IndexError):
        load_1 = 0.0

    def health_milliseconds(name: str) -> int:
        try:
            return max(0, round(float(health.get(name) or 0) * 1000))
        except (TypeError, ValueError):
            return 0

    return {
        "environment": ENVIRONMENT,
        "host_id": HOST_ID,
        "release_sha": RELEASE_SHA,
        "host_metrics_available": HOST_METRICS_ENABLED,
        "active_jobs": max(0, int(health.get("active_jobs") or 0)),
        "queued_jobs": max(0, int(health.get("queued_jobs") or 0)),
        "active_slices": max(0, int(health.get("active_slices") or 0)),
        "queued_slices": max(0, int(health.get("queued_slices") or 0)),
        "oldest_active_slice_ms": health_milliseconds("oldest_active_slice_s"),
        "oldest_queued_slice_ms": health_milliseconds("oldest_queued_slice_s"),
        "last_slice_completed_age_ms": health_milliseconds(
            "last_slice_completed_age_s"
        ),
        "parser_oom_kill_events": max(
            0, int(health.get("cgroup_oom_kill_events") or 0)
        ),
        "cpu_percent": cpu_percent(before, after) if HOST_METRICS_ENABLED else 0.0,
        "load_1": max(0.0, load_1),
        **(
            memory_values()
            if HOST_METRICS_ENABLED
            else {
                "memory_total_bytes": 0,
                "memory_available_bytes": 0,
                "memory_used_bytes": 0,
                "swap_used_bytes": 0,
            }
        ),
        "disk_read_bytes": max(0, disk_read),
        "disk_write_bytes": max(0, disk_write),
        "network_rx_bytes": max(0, network_rx),
        "network_tx_bytes": max(0, network_tx),
        "parser_memory_bytes": max(0, int(health.get("cgroup_memory_bytes") or 0)),
        "parser_pss_bytes": max(0, int(health.get("pss_bytes") or 0)),
        "parser_memory_peak_bytes": max(
            0, int(health.get("cgroup_memory_peak_bytes") or 0)
        ),
        **spool_values(),
    }


def queue_values(conn: psycopg.Connection) -> dict[str, int]:
    row = conn.execute(
        """
        SELECT
          count(*) FILTER (WHERE type='parse' AND status='pending'
            AND (not_before IS NULL OR not_before <= now())),
          count(*) FILTER (WHERE type='parse' AND status='pending'
            AND not_before > now()),
          count(*) FILTER (WHERE type='parse' AND status='running'),
          count(*) FILTER (WHERE type='ingest' AND status='pending'
            AND (not_before IS NULL OR not_before <= now())),
          count(*) FILTER (WHERE type='ingest' AND status='pending'
            AND not_before > now()),
          count(*) FILTER (WHERE type='ingest' AND status='running'),
          count(*) FILTER (WHERE status='running' AND lease_expires_at < now()),
          COALESCE(round(extract(epoch FROM (
            now() - min(queued_at) FILTER (WHERE status='pending')
          )) * 1000), 0)
        FROM jobs WHERE type IN ('parse', 'ingest')
        """
    ).fetchone()
    if row is None:
        return {}
    keys = (
        "parse_ready_jobs",
        "parse_delayed_jobs",
        "parse_running_jobs",
        "ingest_ready_jobs",
        "ingest_delayed_jobs",
        "ingest_running_jobs",
        "expired_leases",
        "oldest_queued_job_ms",
    )
    return {key: max(0, int(value or 0)) for key, value in zip(keys, row)}


def insert(conn: psycopg.Connection, values: dict[str, Any]) -> None:
    conn.execute(
        """
        INSERT INTO ingest_host_samples
            (environment, host_id, release_sha, host_metrics_available,
             active_jobs, queued_jobs, active_slices, queued_slices,
             oldest_active_slice_ms, oldest_queued_slice_ms,
             last_slice_completed_age_ms, parser_oom_kill_events,
             cpu_percent, load_1,
             memory_total_bytes, memory_used_bytes, memory_available_bytes,
             swap_used_bytes, disk_read_bytes, disk_write_bytes,
             network_rx_bytes, network_tx_bytes, parser_memory_bytes,
             parser_pss_bytes, parser_memory_peak_bytes,
             parse_ready_jobs, parse_delayed_jobs, parse_running_jobs,
             ingest_ready_jobs, ingest_delayed_jobs, ingest_running_jobs,
             expired_leases, oldest_queued_job_ms, disk_free_bytes,
             spool_bytes, spool_files)
        VALUES (%(environment)s, %(host_id)s, %(release_sha)s,
                %(host_metrics_available)s, %(active_jobs)s, %(queued_jobs)s,
                %(active_slices)s, %(queued_slices)s,
                %(oldest_active_slice_ms)s, %(oldest_queued_slice_ms)s,
                %(last_slice_completed_age_ms)s, %(parser_oom_kill_events)s,
                %(cpu_percent)s,
                %(load_1)s, %(memory_total_bytes)s, %(memory_used_bytes)s,
                %(memory_available_bytes)s, %(swap_used_bytes)s,
                %(disk_read_bytes)s, %(disk_write_bytes)s,
                %(network_rx_bytes)s, %(network_tx_bytes)s,
                %(parser_memory_bytes)s, %(parser_pss_bytes)s,
                %(parser_memory_peak_bytes)s, %(parse_ready_jobs)s,
                %(parse_delayed_jobs)s, %(parse_running_jobs)s,
                %(ingest_ready_jobs)s, %(ingest_delayed_jobs)s,
                %(ingest_running_jobs)s, %(expired_leases)s,
                %(oldest_queued_job_ms)s, %(disk_free_bytes)s,
                %(spool_bytes)s, %(spool_files)s)
        """,
        values,
    )
    conn.execute(
        """
        INSERT INTO ingest_host_sample_rollups
          (bucket, environment, host_id, release_sha, host_metrics_available,
           samples, active_jobs_max, queued_jobs_max, active_slices_max,
           queued_slices_max, oldest_active_slice_ms_max,
           oldest_queued_slice_ms_max, parser_oom_kill_events_max,
           cpu_percent_avg, cpu_percent_max, load_1_avg,
           memory_used_bytes_avg, memory_used_bytes_max,
           memory_total_bytes_max, swap_used_bytes_max,
           parser_memory_bytes_avg, parser_memory_bytes_max,
           parser_pss_bytes_max, parser_memory_peak_bytes_max,
           parse_ready_jobs_max, parse_delayed_jobs_max,
           parse_running_jobs_max, ingest_ready_jobs_max,
           ingest_delayed_jobs_max, ingest_running_jobs_max,
           expired_leases_max, oldest_queued_job_ms_max,
           disk_free_bytes_min, spool_bytes_max, spool_files_max)
        SELECT date_bin('1 minute', sampled_at, timestamptz '1970-01-01'),
               environment, host_id, max(release_sha),
               bool_or(host_metrics_available), count(*)::int,
               max(active_jobs)::int, max(queued_jobs)::int,
               max(active_slices)::int, max(queued_slices)::int,
               max(oldest_active_slice_ms)::bigint,
               max(oldest_queued_slice_ms)::bigint,
               max(parser_oom_kill_events)::bigint,
               avg(cpu_percent)::real, max(cpu_percent)::real,
               avg(load_1)::real, avg(memory_used_bytes)::bigint,
               max(memory_used_bytes)::bigint, max(memory_total_bytes)::bigint,
               max(swap_used_bytes)::bigint, avg(parser_memory_bytes)::bigint,
               max(parser_memory_bytes)::bigint, max(parser_pss_bytes)::bigint,
               max(parser_memory_peak_bytes)::bigint,
               max(parse_ready_jobs)::int, max(parse_delayed_jobs)::int,
               max(parse_running_jobs)::int, max(ingest_ready_jobs)::int,
               max(ingest_delayed_jobs)::int, max(ingest_running_jobs)::int,
               max(expired_leases)::int, max(oldest_queued_job_ms)::bigint,
               min(disk_free_bytes)::bigint, max(spool_bytes)::bigint,
               max(spool_files)::int
        FROM ingest_host_samples
        WHERE environment=%(environment)s AND host_id=%(host_id)s
          AND sampled_at >= date_bin(
            '1 minute', now(), timestamptz '1970-01-01'
          )
        GROUP BY 1, environment, host_id
        ON CONFLICT (bucket, environment, host_id) DO UPDATE SET
          release_sha=EXCLUDED.release_sha,
          host_metrics_available=EXCLUDED.host_metrics_available,
          samples=EXCLUDED.samples, active_jobs_max=EXCLUDED.active_jobs_max,
          queued_jobs_max=EXCLUDED.queued_jobs_max,
          active_slices_max=EXCLUDED.active_slices_max,
          queued_slices_max=EXCLUDED.queued_slices_max,
          oldest_active_slice_ms_max=EXCLUDED.oldest_active_slice_ms_max,
          oldest_queued_slice_ms_max=EXCLUDED.oldest_queued_slice_ms_max,
          parser_oom_kill_events_max=EXCLUDED.parser_oom_kill_events_max,
          cpu_percent_avg=EXCLUDED.cpu_percent_avg,
          cpu_percent_max=EXCLUDED.cpu_percent_max,
          load_1_avg=EXCLUDED.load_1_avg,
          memory_used_bytes_avg=EXCLUDED.memory_used_bytes_avg,
          memory_used_bytes_max=EXCLUDED.memory_used_bytes_max,
          memory_total_bytes_max=EXCLUDED.memory_total_bytes_max,
          swap_used_bytes_max=EXCLUDED.swap_used_bytes_max,
          parser_memory_bytes_avg=EXCLUDED.parser_memory_bytes_avg,
          parser_memory_bytes_max=EXCLUDED.parser_memory_bytes_max,
          parser_pss_bytes_max=EXCLUDED.parser_pss_bytes_max,
          parser_memory_peak_bytes_max=EXCLUDED.parser_memory_peak_bytes_max,
          parse_ready_jobs_max=EXCLUDED.parse_ready_jobs_max,
          parse_delayed_jobs_max=EXCLUDED.parse_delayed_jobs_max,
          parse_running_jobs_max=EXCLUDED.parse_running_jobs_max,
          ingest_ready_jobs_max=EXCLUDED.ingest_ready_jobs_max,
          ingest_delayed_jobs_max=EXCLUDED.ingest_delayed_jobs_max,
          ingest_running_jobs_max=EXCLUDED.ingest_running_jobs_max,
          expired_leases_max=EXCLUDED.expired_leases_max,
          oldest_queued_job_ms_max=EXCLUDED.oldest_queued_job_ms_max,
          disk_free_bytes_min=EXCLUDED.disk_free_bytes_min,
          spool_bytes_max=EXCLUDED.spool_bytes_max,
          spool_files_max=EXCLUDED.spool_files_max
        """,
        values,
    )
    conn.commit()


def main() -> None:
    obs.init_logging("ingest-host-sampler")
    previous = cpu_counters()
    delay = 1.0
    connection: psycopg.Connection | None = None
    last_maintenance = 0.0
    while True:
        time.sleep(delay)
        current = cpu_counters()
        values = sample(previous, current)
        previous = current
        try:
            if connection is None or connection.closed:
                connection = psycopg.connect(cfg.dsn, autocommit=False)
            values.update(queue_values(connection))
            insert(connection, values)
            now = time.monotonic()
            if now - last_maintenance >= 3600:
                connection.execute(
                    "DELETE FROM ingest_host_samples WHERE sampled_at < now() - interval '30 days'"
                )
                connection.execute(
                    "DELETE FROM ingest_host_sample_rollups WHERE bucket < now() - interval '1 year'"
                )
                connection.commit()
                last_maintenance = now
        except Exception:
            log.warning("could not persist ingest host sample", exc_info=True)
            if connection is not None:
                connection.close()
                connection = None
        delay = (
            ACTIVE_INTERVAL
            if any(
                values.get(key, 0)
                for key in (
                    "active_jobs",
                    "queued_jobs",
                    "parse_ready_jobs",
                    "parse_delayed_jobs",
                    "parse_running_jobs",
                    "ingest_ready_jobs",
                    "ingest_delayed_jobs",
                    "ingest_running_jobs",
                )
            )
            else IDLE_INTERVAL
        )


if __name__ == "__main__":
    main()
