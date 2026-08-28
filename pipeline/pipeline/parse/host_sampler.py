"""Persist compact parser-host samples without document identifiers."""

from __future__ import annotations

import logging
import os
import re
import socket
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import psycopg
import requests

from .. import obs
from ..config import cfg

log = logging.getLogger("evo.parse.host_sampler")


def _env_float(name: str, default: float) -> float:
    try:
        return max(1.0, float(os.environ.get(name, str(default))))
    except ValueError:
        return default


PROC_ROOT = Path(os.environ.get("EVO_HOST_PROC", "/host/proc"))
HOST_ID = os.environ.get("EVO_PARSE_HOST_ID", socket.gethostname())
ACTIVE_INTERVAL = _env_float("EVO_HOST_SAMPLE_ACTIVE_SECONDS", 5.0)
IDLE_INTERVAL = _env_float("EVO_HOST_SAMPLE_IDLE_SECONDS", 60.0)
HEALTH_URL = os.environ.get("PARSER_HEALTH_URL", "http://127.0.0.1:8090/healthz")
PARTITION_NAME = re.compile(
    r"^(?:sd[a-z]+|vd[a-z]+|xvd[a-z]+)\d+$|^(?:nvme\d+n\d+|mmcblk\d+)p\d+$"
)


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
    disk_read, disk_write = disk_values()
    network_rx, network_tx = network_values()
    health = parser_health()
    try:
        load_1 = float(_read("loadavg").split()[0])
    except (ValueError, IndexError):
        load_1 = 0.0
    return {
        "host_id": HOST_ID,
        "active_jobs": max(0, int(health.get("active_jobs") or 0)),
        "queued_jobs": max(0, int(health.get("queued_jobs") or 0)),
        "cpu_percent": cpu_percent(before, after),
        "load_1": max(0.0, load_1),
        **memory_values(),
        "disk_read_bytes": max(0, disk_read),
        "disk_write_bytes": max(0, disk_write),
        "network_rx_bytes": max(0, network_rx),
        "network_tx_bytes": max(0, network_tx),
        "parser_memory_bytes": max(0, int(health.get("cgroup_memory_bytes") or 0)),
        "parser_pss_bytes": max(0, int(health.get("pss_bytes") or 0)),
    }


def insert(conn: psycopg.Connection, values: dict[str, Any]) -> None:
    conn.execute(
        """
        INSERT INTO parse_host_samples
            (host_id, active_jobs, queued_jobs, cpu_percent, load_1,
             memory_total_bytes, memory_used_bytes, memory_available_bytes,
             swap_used_bytes, disk_read_bytes, disk_write_bytes,
             network_rx_bytes, network_tx_bytes, parser_memory_bytes,
             parser_pss_bytes)
        VALUES (%(host_id)s, %(active_jobs)s, %(queued_jobs)s, %(cpu_percent)s,
                %(load_1)s, %(memory_total_bytes)s, %(memory_used_bytes)s,
                %(memory_available_bytes)s, %(swap_used_bytes)s,
                %(disk_read_bytes)s, %(disk_write_bytes)s,
                %(network_rx_bytes)s, %(network_tx_bytes)s,
                %(parser_memory_bytes)s, %(parser_pss_bytes)s)
        """,
        values,
    )
    conn.commit()


def main() -> None:
    obs.init_logging("parse-host-sampler")
    previous = cpu_counters()
    delay = 1.0
    connection: psycopg.Connection | None = None
    while True:
        time.sleep(delay)
        current = cpu_counters()
        values = sample(previous, current)
        previous = current
        try:
            if connection is None or connection.closed:
                connection = psycopg.connect(cfg.dsn, autocommit=False)
            insert(connection, values)
        except Exception:
            log.warning("could not persist parser host sample", exc_info=True)
            if connection is not None:
                connection.close()
                connection = None
        delay = (
            ACTIVE_INTERVAL
            if values["active_jobs"] or values["queued_jobs"]
            else IDLE_INTERVAL
        )


if __name__ == "__main__":
    main()
