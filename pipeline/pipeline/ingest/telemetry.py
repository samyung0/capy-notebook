"""Durable ingest attempts and per-worker cgroup telemetry."""

from __future__ import annotations

import contextvars
import logging
import os
import re
import socket
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from ..store import db

_SAFE_CODE = re.compile(r"[^a-z0-9]+")
_CGROUP_ROOT = Path(os.environ.get("CAPY_WORKER_CGROUP_ROOT", "/sys/fs/cgroup"))
log = logging.getLogger("capy.ingest.telemetry")


def environment() -> str:
    value = os.environ.get("CAPY_INGEST_ENVIRONMENT", "").strip().lower()
    if value:
        return value
    return (
        "local"
        if os.environ.get("APP_ENV", "development") == "development"
        else "production"
    )


def host_id() -> str:
    return os.environ.get("CAPY_INGEST_HOST_ID", "netcup-ingest-1").strip()


def _instance_id(role: str) -> str:
    configured = os.environ.get("CAPY_WORKER_INSTANCE_ID", "").strip()
    if configured:
        return configured
    # A parse-coordinator container supervises several child processes that
    # share one cgroup. Give them one container identity so Ops averages that
    # cgroup once instead of multiplying its CPU and memory by the child count.
    return f"{role}:{socket.gethostname()}"


def _safe_code(value: str, fallback: str) -> str:
    code = _SAFE_CODE.sub("_", value.lower()).strip("_")
    return (code or fallback)[:80]


def classify_error(exc: BaseException) -> tuple[str, str, int | None]:
    """Return a stable category, code, and provider status for Ops grouping."""
    name = type(exc).__name__
    lowered = f"{name} {exc}".lower()
    raw_status = getattr(exc, "status_code", None)
    status = (
        raw_status if isinstance(raw_status, int) and 100 <= raw_status <= 599 else None
    )
    if isinstance(exc, TimeoutError):
        return "timeout", "job_timeout", status
    if "hardtimeout" in name.lower() or "hard timeout" in lowered:
        return "timeout", "parse_hard_timeout", status
    if "oom" in name.lower() or "out of memory" in lowered:
        return "oom", "parse_oom", status
    if "superseded" in name.lower() or "superseded" in lowered:
        return "superseded", "source_superseded", status
    if "capacity" in name.lower():
        return "capacity", "capacity_wait", status
    if "accounting" in name.lower() or "reservation" in lowered:
        return "accounting", _safe_code(name, "accounting_error"), status
    if "parser" in name.lower():
        return "parser", _safe_code(name, "parser_error"), status
    if status is not None:
        return "provider", f"provider_http_{status}", status
    if any(token in lowered for token in ("provider", "rate limit", "api key")):
        return "provider", _safe_code(name, "provider_error"), status
    if any(token in lowered for token in ("connection", "network", "dns", "socket")):
        return "network", _safe_code(name, "network_error"), status
    module = type(exc).__module__.lower()
    if "psycopg" in module or "database" in lowered:
        return "database", _safe_code(name, "database_error"), status
    if any(token in lowered for token in ("artifact", "bundle", "zip")):
        return "artifact", _safe_code(name, "artifact_error"), status
    if "terminal" in name.lower() or any(
        token in lowered
        for token in ("missing", "invalid", "unsupported", "does not match")
    ):
        return "input", _safe_code(name, "invalid_input"), status
    return "unknown", _safe_code(name, "unknown_error"), status


@dataclass
class JobRun:
    attempt_id: int
    job_id: str
    attempt: int
    stage: str = "claimed"
    stage_started: float = field(default_factory=time.monotonic)
    stage_timings: dict[str, int] = field(default_factory=dict)
    stats: dict[str, int | bool | str] = field(default_factory=dict)

    def set_stage(self, name: str) -> None:
        now = time.monotonic()
        elapsed = max(0, round((now - self.stage_started) * 1000))
        self.stage_timings[self.stage] = self.stage_timings.get(self.stage, 0) + elapsed
        self.stage = name
        self.stage_started = now

    def snapshot(self) -> dict[str, Any]:
        timings = dict(self.stage_timings)
        timings[self.stage] = timings.get(self.stage, 0) + max(
            0, round((time.monotonic() - self.stage_started) * 1000)
        )
        return {
            "attempt_id": self.attempt_id,
            "stage": self.stage,
            "stage_timings": timings,
            "stats": dict(self.stats),
        }


_job_run: contextvars.ContextVar[JobRun | None] = contextvars.ContextVar(
    "ingest_job_run", default=None
)


def begin_job(job: dict[str, Any]) -> contextvars.Token[JobRun | None]:
    run = JobRun(
        attempt_id=int(job["attemptId"]),
        job_id=str(job["id"]),
        attempt=int(job.get("attempts") or 1),
    )
    if _reporter is not None:
        _reporter.set_job(run.attempt_id, run.stage)
    return _job_run.set(run)


def reset_job(token: contextvars.Token[JobRun | None]) -> None:
    _job_run.reset(token)
    if _reporter is not None:
        _reporter.clear_job()


def current_attempt_id() -> int | None:
    run = _job_run.get()
    return run.attempt_id if run is not None else None


def current_stage() -> str:
    run = _job_run.get()
    return run.stage if run is not None else ""


def stage(name: str) -> None:
    run = _job_run.get()
    if run is None or not name or name == run.stage:
        return
    run.set_stage(name)
    if _reporter is not None:
        _reporter.set_job(run.attempt_id, name)


def record(**values: int | bool | str) -> None:
    run = _job_run.get()
    if run is None:
        return
    for key, value in values.items():
        run.stats[key] = value


def snapshot() -> dict[str, Any]:
    run = _job_run.get()
    return run.snapshot() if run is not None else {}


def claim_metadata(role: str) -> dict[str, str]:
    reporter = _reporter
    return {
        "environment": environment(),
        "host_id": host_id(),
        "worker_instance_id": reporter.instance_id if reporter else _instance_id(role),
        "release_sha": os.environ.get("RELEASE_SHA", "").strip(),
    }


def _read_int(path: str) -> int:
    try:
        raw = (_CGROUP_ROOT / path).read_text(encoding="ascii").strip()
        return 0 if raw == "max" else max(0, int(raw))
    except (OSError, ValueError):
        return 0


def _key_values(path: str) -> dict[str, int]:
    values: dict[str, int] = {}
    try:
        lines = (_CGROUP_ROOT / path).read_text(encoding="ascii").splitlines()
    except OSError:
        return values
    for line in lines:
        fields = line.split()
        if not fields:
            continue
        if len(fields) == 2 and "=" not in fields[1]:
            try:
                values[fields[0]] = max(0, int(fields[1]))
            except ValueError:
                pass
            continue
        for item in fields[1:]:
            key, separator, raw = item.partition("=")
            if not separator:
                continue
            try:
                values[key] = values.get(key, 0) + max(0, int(raw))
            except ValueError:
                continue
    return values


def cgroup_values(previous_usage: int, elapsed_s: float) -> dict[str, int | float]:
    cpu = _key_values("cpu.stat")
    usage = cpu.get("usage_usec", 0)
    io = _key_values("io.stat")
    events = _key_values("memory.events")
    delta = max(0, usage - previous_usage)
    return {
        "cpu_cores": round(delta / max(elapsed_s * 1_000_000, 1), 3),
        "cpu_usage_usec": usage,
        "memory_bytes": _read_int("memory.current"),
        "memory_peak_bytes": _read_int("memory.peak"),
        "memory_limit_bytes": _read_int("memory.max"),
        "io_read_bytes": io.get("rbytes", 0),
        "io_write_bytes": io.get("wbytes", 0),
        "pids_current": _read_int("pids.current"),
        "pids_limit": _read_int("pids.max"),
        "oom_events": events.get("oom", 0),
        "oom_kill_events": events.get("oom_kill", 0),
    }


class RuntimeReporter:
    def __init__(self, role: str) -> None:
        self.role = role
        self.environment = environment()
        self.host_id = host_id()
        self.instance_id = _instance_id(role)
        self.release_sha = os.environ.get("RELEASE_SHA", "").strip()
        self._lock = threading.Lock()
        self._attempt_id: int | None = None
        self._stage = ""
        self._last_error_at = 0.0
        self._stop = threading.Event()
        self._thread = threading.Thread(
            target=self._run, name=f"{role}-runtime-telemetry", daemon=True
        )

    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        self._thread.join(timeout=5)

    def set_job(self, attempt_id: int, stage_name: str) -> None:
        with self._lock:
            self._attempt_id = attempt_id
            self._stage = stage_name

    def clear_job(self) -> None:
        with self._lock:
            self._attempt_id = None
            self._stage = ""

    def _state(self) -> tuple[int | None, str]:
        with self._lock:
            return self._attempt_id, self._stage

    def _run(self) -> None:
        previous_usage = _key_values("cpu.stat").get("usage_usec", 0)
        previous_at = time.monotonic()
        while not self._stop.is_set():
            attempt_id, stage_name = self._state()
            now = time.monotonic()
            values = cgroup_values(previous_usage, max(now - previous_at, 0.001))
            previous_usage = int(values["cpu_usage_usec"])
            previous_at = now
            try:
                db.record_worker_sample(
                    environment=self.environment,
                    host_id=self.host_id,
                    worker_instance_id=self.instance_id,
                    role=self.role,
                    release_sha=self.release_sha,
                    state="busy" if attempt_id is not None else "idle",
                    stage=stage_name,
                    job_attempt_id=attempt_id,
                    values=values,
                )
            except Exception:
                if now - self._last_error_at >= 60:
                    log.warning("could not persist worker telemetry", exc_info=True)
                    self._last_error_at = now
            delay = 5.0 if attempt_id is not None else 60.0
            if self._stop.wait(delay):
                return


_reporter: RuntimeReporter | None = None


def start_runtime_reporter(role: str) -> RuntimeReporter:
    global _reporter
    reporter = RuntimeReporter(role)
    _reporter = reporter
    reporter.start()
    return reporter
