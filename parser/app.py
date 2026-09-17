"""Persistent CPU parser for the Netcup ingest host.

The caller owns artifact identity and caching. The worker and parser share a
local spool: this service reads one source key and atomically publishes one
fingerprint-addressed zip key without a B2 round trip.

Documents run one at a time through OpenDataLoader plus the native repairs in
``odl/`` (and RapidOCR on pages without a text layer); up to four documents wait
in a FIFO queue. A document that exceeds its hard deadline is quarantined by
fingerprint and the process exits so Docker replaces it.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import io
import json
import math
import multiprocessing
import os
import pickle
import re
import secrets
import shutil
import signal
import tempfile
import time
import zipfile
from collections import deque
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass
from importlib.metadata import PackageNotFoundError, version
from multiprocessing.connection import Connection
from pathlib import Path, PurePosixPath
from typing import Any, NoReturn

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from odl.java import JavaTimeout
from starlette.background import BackgroundTask

ARTIFACT_SCHEMA = "capy-parser-bundle-v4"
PARSER_IMPLEMENTATION = "odl-2.5.7-refined-rapidocr-v4"
RELEASE_SHA = os.environ.get("RELEASE_SHA", "dev").strip() or "dev"
if os.environ.get("APP_ENV") == "production" and not re.fullmatch(
    r"[0-9a-f]{40}", RELEASE_SHA
):
    raise RuntimeError("production parser RELEASE_SHA must be a full lowercase Git SHA")
PARSER_VERSION = f"{PARSER_IMPLEMENTATION}+{RELEASE_SHA}"


def _dependency_versions() -> dict[str, str]:
    packages = (
        "opendataloader-pdf",
        "pymupdf",
        "pypdf",
        "rapidocr",
        "rapid-layout",
        "onnxruntime",
    )
    versions: dict[str, str] = {}
    for package in packages:
        try:
            versions[package] = version(package)
        except PackageNotFoundError:
            versions[package] = "missing"
    return versions


PARSER_DEPENDENCIES = _dependency_versions()
MAX_SOURCE_BYTES = int(os.environ.get("CAPY_MAX_SOURCE_BYTES", str(100 << 20)))
MAX_ARTIFACT_BYTES = int(
    os.environ.get("CAPY_PARSE_ARTIFACT_MAX_BYTES", str(256 << 20))
)
MAX_ARTIFACT_ENTRIES = int(os.environ.get("CAPY_PARSE_ARTIFACT_MAX_ENTRIES", "4096"))
MAX_ARTIFACT_ENTRY_BYTES = int(
    os.environ.get("CAPY_PARSE_ARTIFACT_MAX_ENTRY_BYTES", str(128 << 20))
)
MAX_ARTIFACT_EXPANDED_BYTES = int(
    os.environ.get("CAPY_PARSE_ARTIFACT_MAX_EXPANDED_BYTES", str(512 << 20))
)
MAX_CONTENT_BYTES = int(os.environ.get("CAPY_PARSE_CONTENT_MAX_BYTES", str(128 << 20)))
MAX_CONTENT_BLOCKS = int(os.environ.get("CAPY_PARSE_CONTENT_MAX_BLOCKS", "250000"))
MAX_IMAGE_BYTES = int(os.environ.get("CAPY_PARSE_IMAGE_MAX_BYTES", str(32 << 20)))
MAX_IMAGES_BYTES = int(os.environ.get("CAPY_PARSE_IMAGES_MAX_BYTES", str(256 << 20)))
# Documents waiting plus the one executing. Matches the four parse coordinator
# processes an ingest host runs; a fifth request is answered 429.
QUEUE_DEPTH = int(os.environ.get("CAPY_PARSE_QUEUE_DEPTH", "4"))
# Wall clock for one document's parse, started when it leaves the queue. The
# Java step gets the remaining budget as its own subprocess timeout; the Python
# repairs are bounded by the same timer and end in a process restart.
PARSE_DOCUMENT_TIMEOUT_S = max(
    1, int(os.environ.get("CAPY_PARSE_DOCUMENT_TIMEOUT", "600"))
)
RESTART_BACKSTOP_S = 1.0
OOM_POLL_INTERVAL_S = 0.25
SHARED_DIR = Path(
    os.environ.get("CAPY_PARSE_SHARED_DIR", "/tmp/capy-parse-spool")
).resolve()
WORK_DIR = Path(os.environ.get("CAPY_PARSE_WORK_DIR", "/run/capy-parser/work"))
if not 1 <= QUEUE_DEPTH <= 16:
    raise RuntimeError("CAPY_PARSE_QUEUE_DEPTH must be between 1 and 16")
if any(
    value <= 0
    for value in (
        MAX_SOURCE_BYTES,
        MAX_ARTIFACT_BYTES,
        MAX_ARTIFACT_ENTRIES,
        MAX_ARTIFACT_ENTRY_BYTES,
        MAX_ARTIFACT_EXPANDED_BYTES,
        MAX_CONTENT_BYTES,
        MAX_CONTENT_BLOCKS,
        MAX_IMAGE_BYTES,
        MAX_IMAGES_BYTES,
    )
):
    raise RuntimeError("parser byte/count limits must be positive")


@dataclass(frozen=True)
class Document:
    data: bytes
    name: str
    fingerprint: str = ""
    capture: dict | None = None


class ParseHardTimeout(RuntimeError):
    pass


class ParseOOM(RuntimeError):
    pass


class ParserRuntimeFailure(RuntimeError):
    pass


class ParserCapacity(RuntimeError):
    pass


def _terminate_process() -> NoReturn:
    """Let the container supervisor replace a timed-out parser process."""
    os._exit(1)


def _schedule_restart_backstop() -> None:
    """Restart even if the client disconnects before response delivery."""
    asyncio.get_running_loop().call_later(RESTART_BACKSTOP_S, _terminate_process)


@dataclass
class _QueuedDocument:
    document: Document
    enqueued_at: float
    future: asyncio.Future[tuple[dict[str, Any], int]]
    started_at: float | None = None
    timed_out: bool = False
    released: bool = False


def _cgroup_event_value(name: str) -> int:
    try:
        values = {
            key: int(value)
            for key, value in (
                line.split(maxsplit=1)
                for line in Path("/sys/fs/cgroup/memory.events")
                .read_text(encoding="ascii")
                .splitlines()
            )
        }
    except (OSError, ValueError):
        return 0
    return max(0, values.get(name, 0))


def run_document(document: Document) -> dict[str, Any]:
    """Normalise, parse and shape one document inside the parse child."""
    from odl.document import normalize_document

    normalized = normalize_document(document.data, document.name)
    if document.capture is not None:
        from odl.capture import capture_page

        return capture_page(normalized.data, **document.capture)
    from odl.refine import parse_pdf

    WORK_DIR.mkdir(parents=True, exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix="doc-", dir=WORK_DIR))
    try:
        output = parse_pdf(
            normalized.data, work, java_timeout_s=PARSE_DOCUMENT_TIMEOUT_S
        )
    finally:
        shutil.rmtree(work, ignore_errors=True)
    result: dict[str, Any] = {
        "content_list": output.content_list,
        "md": output.markdown,
        "images": {
            name: base64.b64encode(body).decode("ascii")
            for name, body in output.images.items()
        },
        "_ocr_pages": output.ocr_pages,
        "_page_count": output.page_count,
        "_source_format": normalized.source_format,
        "_parse_lane": "ocr" if output.ocr_pages else "digital",
        "_phases": output.phases,
        "_repaired_fonts": output.repaired_fonts,
        "_furniture": output.furniture,
    }
    if normalized.preview_pdf is not None:
        from odl.evidence import page_evidence

        result["_page_evidence"] = page_evidence(
            output.parsed_pdf or normalized.data, output.content_list
        )
    elif output.parsed_pdf is not None:
        result["_parsed_pdf"] = output.parsed_pdf
    return result


def _parse_worker_main(requests: Connection, responses: Connection) -> None:
    """Keep parser models in one disposable child while the API stays alive."""
    try:
        os.setsid()
    except OSError:
        pass
    try:
        Path("/proc/self/oom_score_adj").write_text("1000", encoding="ascii")
    except OSError:
        pass

    while True:
        try:
            request = requests.recv()
        except EOFError:
            return
        if request is None:
            return
        source_path, result_path, name, fingerprint, capture = request
        document = None
        result = None
        try:
            document = Document(
                Path(source_path).read_bytes(), name, fingerprint, capture
            )
            result = run_document(document)
            with Path(result_path).open("wb") as output:
                pickle.dump(result, output, protocol=pickle.HIGHEST_PROTOCOL)
            responses.send(("ok", None))
        except Exception as exc:  # noqa: BLE001 - returned to API supervisor
            try:
                responses.send(("error", exc))
            except Exception:  # noqa: BLE001 - replace an unpicklable exception
                responses.send(("error", RuntimeError(f"{type(exc).__name__}: {exc}")))
        finally:
            document = result = None


def _temporary_file(suffix: str) -> Path:
    WORK_DIR.mkdir(parents=True, exist_ok=True)
    descriptor, name = tempfile.mkstemp(prefix="transfer-", suffix=suffix, dir=WORK_DIR)
    os.close(descriptor)
    return Path(name)


class _ParseWorkerProcess:
    """Persistent spawned child with file-backed messages for large results."""

    def __init__(self) -> None:
        self._process: multiprocessing.Process | None = None
        self._requests: Connection | None = None
        self._responses: Connection | None = None

    def start(self) -> None:
        WORK_DIR.mkdir(parents=True, exist_ok=True)
        for path in (*WORK_DIR.glob("doc-*"), *WORK_DIR.glob("transfer-*")):
            if path.is_dir():
                shutil.rmtree(path, ignore_errors=True)
            else:
                try:
                    path.unlink()
                except FileNotFoundError:
                    pass
        context = multiprocessing.get_context("spawn")
        child_requests, self._requests = context.Pipe(duplex=False)
        self._responses, child_responses = context.Pipe(duplex=False)
        self._process = context.Process(
            target=_parse_worker_main,
            args=(child_requests, child_responses),
            name="parser-document-worker",
        )
        self._process.start()
        child_requests.close()
        child_responses.close()

    @property
    def alive(self) -> bool:
        return self._process is not None and self._process.is_alive()

    async def run(self, document: Document) -> dict[str, Any]:
        if not self.alive:
            raise ParserRuntimeFailure("parser child process is not running")
        source_path = await asyncio.to_thread(_temporary_file, ".source")
        result_path = await asyncio.to_thread(_temporary_file, ".result")
        try:
            await asyncio.to_thread(source_path.write_bytes, document.data)
            if self._requests is None or self._responses is None:
                raise ParserRuntimeFailure("parser child connections are unavailable")
            try:
                await asyncio.to_thread(
                    self._requests.send,
                    (
                        str(source_path),
                        str(result_path),
                        document.name,
                        document.fingerprint,
                        document.capture,
                    ),
                )
            except (BrokenPipeError, EOFError, OSError) as exc:
                raise ParserRuntimeFailure(
                    "parser child process exited before accepting the document"
                ) from exc
            try:
                status, payload = await asyncio.to_thread(self._responses.recv)
            except (EOFError, OSError) as exc:
                code = self._process.exitcode if self._process is not None else None
                raise ParserRuntimeFailure(
                    f"parser child process exited unexpectedly (code {code})"
                ) from exc
            if status == "error":
                if isinstance(payload, BaseException):
                    raise payload
                raise RuntimeError("parser child returned an invalid error")
            if status != "ok":
                raise RuntimeError("parser child returned an invalid response")
            return await asyncio.to_thread(_read_worker_result, result_path)
        finally:
            for path in (source_path, result_path):
                try:
                    path.unlink()
                except FileNotFoundError:
                    pass

    def terminate(self) -> None:
        process = self._process
        if process is None or not process.is_alive():
            return
        try:
            if os.getpgid(process.pid) == process.pid:
                os.killpg(process.pid, signal.SIGTERM)
                return
        except (OSError, TypeError):
            pass
        process.terminate()

    def stop(self) -> None:
        process = self._process
        if process is None:
            return
        if process.is_alive():
            try:
                if self._requests is not None:
                    self._requests.send(None)
            except (BrokenPipeError, EOFError, OSError):
                pass
            process.join(timeout=1)
        if process.is_alive():
            self.terminate()
            process.join(timeout=1)
        if process.is_alive():
            process.kill()
            process.join(timeout=1)
        for connection in (self._requests, self._responses):
            if connection is not None:
                connection.close()
        self._process = None


def _read_worker_result(path: Path) -> dict[str, Any]:
    with path.open("rb") as result_file:
        result = pickle.load(result_file)
    if not isinstance(result, dict):
        raise TypeError("parser child returned an invalid result")
    return result


class ParserRuntime:
    """One worker over a bounded FIFO of documents."""

    def __init__(
        self,
        runner: Callable[[Document], Awaitable[dict[str, Any]]] | None = None,
    ) -> None:
        self.started_at = time.monotonic()
        self.state = "starting"
        self.active_jobs = 0
        self._runner = runner
        self._parse_process: _ParseWorkerProcess | None = None
        self._queue: deque[_QueuedDocument] = deque()
        self._current: _QueuedDocument | None = None
        self._condition = asyncio.Condition()
        self._worker: asyncio.Task[None] | None = None
        self._oom_monitor: asyncio.Task[None] | None = None
        self._deadline: asyncio.TimerHandle | None = None
        self._last_completed_at: float | None = None
        self._oom_kill_events = 0
        self.documents_completed = 0

    async def start(self) -> None:
        self._oom_kill_events = _cgroup_event_value("oom_kill")
        if self._runner is None:
            self._parse_process = _ParseWorkerProcess()
            self._parse_process.start()
        self._worker = asyncio.create_task(self._run(), name="parser-worker")
        self._worker.add_done_callback(self._worker_done)
        self._oom_monitor = asyncio.create_task(
            self._watch_oom_kills(), name="parser-oom-monitor"
        )
        self.state = "ready"

    async def close(self) -> None:
        self.state = "stopping"
        if self._deadline is not None:
            self._deadline.cancel()
            self._deadline = None
        for task in (self._oom_monitor, self._worker):
            if task is not None:
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
        for waiting in self._queue:
            if not waiting.future.done():
                waiting.future.cancel()
            self._release(waiting)
        self._queue.clear()
        if self._parse_process is not None:
            await asyncio.to_thread(self._parse_process.stop)
            self._parse_process = None
        self._oom_monitor = self._worker = None

    @property
    def ready(self) -> bool:
        child_ready = self._runner is not None or (
            self._parse_process is not None and self._parse_process.alive
        )
        return self.state == "ready" and self._worker is not None and child_ready

    def _worker_done(self, worker: asyncio.Task[None]) -> None:
        if self.state == "stopping" or worker.cancelled():
            return
        try:
            exc = worker.exception()
        except asyncio.CancelledError:
            return
        detail = (
            "parser worker exited unexpectedly"
            if exc is None
            else f"parser worker exited: {exc}"
        )
        self._fail_runtime(ParserRuntimeFailure(detail))

    def _pending(self) -> list[_QueuedDocument]:
        pending = list(self._queue)
        if self._current is not None:
            pending.insert(0, self._current)
        return pending

    def _release(self, work: _QueuedDocument) -> None:
        if work.released:
            return
        work.released = True
        self.active_jobs = max(0, self.active_jobs - 1)

    @staticmethod
    def _consume_future(future: asyncio.Future[tuple[dict[str, Any], int]]) -> None:
        if not future.cancelled():
            future.exception()

    def _fail_runtime(self, exc: Exception) -> None:
        if self.state == "stopping":
            return
        self.state = "failed"
        if self._parse_process is not None:
            self._parse_process.terminate()
        current = self._current
        if current is not None and not current.future.done():
            current.future.set_exception(type(exc)(str(exc)))
        for waiting in self._queue:
            if not waiting.future.done():
                waiting.future.set_exception(type(exc)(str(exc)))
            self._release(waiting)
        self._queue.clear()
        _schedule_restart_backstop()

    async def _watch_oom_kills(self) -> None:
        while True:
            await asyncio.sleep(OOM_POLL_INTERVAL_S)
            current = _cgroup_event_value("oom_kill")
            if current > self._oom_kill_events:
                self._record_oom_kill(current)
            elif (
                self._parse_process is not None
                and not self._parse_process.alive
                and self.state == "ready"
            ):
                self._fail_runtime(
                    ParserRuntimeFailure("parser child process exited unexpectedly")
                )

    def _record_oom_kill(self, current: int) -> None:
        if current <= self._oom_kill_events:
            return
        self._oom_kill_events = current
        self.state = "failed"
        if self._parse_process is not None:
            self._parse_process.terminate()
        detail = "parser cgroup killed a process because it ran out of memory"
        pending = self._pending()
        for work in pending:
            active = work is self._current and not work.future.done()
            if active and work.document.fingerprint:
                try:
                    _write_quarantine(work.document.fingerprint, "parse_oom", detail)
                except OSError as exc:
                    print(f"could not write parser OOM marker: {exc}", flush=True)
            error: Exception = (
                ParseOOM(detail)
                if active
                else ParserRuntimeFailure("parser restarted after an OOM kill")
            )
            if not work.future.done():
                work.future.set_exception(type(error)(str(error)))
            if work is not self._current:
                self._release(work)
        self._queue.clear()
        _schedule_restart_backstop()

    async def parse(self, document: Document) -> tuple[dict[str, Any], int]:
        if not self.ready:
            raise RuntimeError("parser is not ready")
        loop = asyncio.get_running_loop()
        async with self._condition:
            if self.active_jobs >= QUEUE_DEPTH:
                raise ParserCapacity("parser document queue is full")
            self.active_jobs += 1
            work = _QueuedDocument(document, time.perf_counter(), loop.create_future())
            work.future.add_done_callback(self._consume_future)
            self._queue.append(work)
            self._condition.notify_all()
        try:
            return await asyncio.shield(work.future)
        except asyncio.CancelledError:
            async with self._condition:
                if work in self._queue:
                    self._queue.remove(work)
                    work.future.cancel()
                    self._release(work)
            raise

    async def _next(self) -> _QueuedDocument:
        async with self._condition:
            while not self._queue:
                await self._condition.wait()
            return self._queue.popleft()

    def _expire(self, work: _QueuedDocument) -> None:
        if work is not self._current or work.timed_out or work.future.done():
            return
        work.timed_out = True
        detail = f"parse exceeded {PARSE_DOCUMENT_TIMEOUT_S} seconds"
        if self._parse_process is not None:
            self._parse_process.terminate()
        if work.document.fingerprint:
            try:
                _write_quarantine(
                    work.document.fingerprint, "parse_hard_timeout", detail
                )
            except OSError as exc:
                print(f"could not write parser timeout marker: {exc}", flush=True)
        self.state = "failed"
        work.future.set_exception(ParseHardTimeout(detail))
        for waiting in self._queue:
            if not waiting.future.done():
                waiting.future.set_exception(
                    ParserRuntimeFailure("parser restarted after a hard timeout")
                )
            self._release(waiting)
        self._queue.clear()
        _schedule_restart_backstop()

    async def _run(self) -> None:
        loop = asyncio.get_running_loop()
        while True:
            work = await self._next()
            if work.future.done():
                self._release(work)
                continue
            queue_ms = max(0, round((time.perf_counter() - work.enqueued_at) * 1000))
            self._current = work
            work.started_at = loop.time()
            self._deadline = loop.call_later(
                PARSE_DOCUMENT_TIMEOUT_S, self._expire, work
            )
            try:
                if self._runner is not None:
                    result = await self._runner(work.document)
                elif self._parse_process is not None:
                    result = await self._parse_process.run(work.document)
                else:
                    raise ParserRuntimeFailure("parser child process is unavailable")
                if not work.future.done():
                    work.future.set_result((result, queue_ms))
            except asyncio.CancelledError:
                if not work.future.done():
                    work.future.cancel()
                raise
            except Exception as exc:  # noqa: BLE001 - returned to owning request
                current_oom_kills = _cgroup_event_value("oom_kill")
                if current_oom_kills > self._oom_kill_events:
                    self._record_oom_kill(current_oom_kills)
                elif isinstance(exc, JavaTimeout) and not work.future.done():
                    self._expire(work)
                elif isinstance(exc, ParserRuntimeFailure) and self.state == "ready":
                    self._fail_runtime(exc)
                elif not work.future.done():
                    work.future.set_exception(exc)
            finally:
                if self._deadline is not None:
                    self._deadline.cancel()
                    self._deadline = None
                self._last_completed_at = loop.time()
                self.documents_completed += 1
                self._current = None
                self._release(work)
                result = None
                work = None

    def health(self) -> dict[str, Any]:
        now = asyncio.get_running_loop().time()
        current = self._current
        oldest_active_s = (
            max(0.0, now - current.started_at)
            if current is not None and current.started_at is not None
            else 0.0
        )
        oldest_queued_s = (
            max(0.0, time.perf_counter() - min(w.enqueued_at for w in self._queue))
            if self._queue
            else 0.0
        )
        last_completed_age_s = (
            round(max(0.0, now - self._last_completed_at), 3)
            if self._last_completed_at is not None
            else None
        )
        # The slice keys stay for the host sampler and Ops schema; documents
        # are no longer sliced, so the slice counters read zero.
        return {
            "active_jobs": self.active_jobs,
            "queued_jobs": len(self._queue),
            "executing_jobs": 1 if current is not None else 0,
            "oldest_active_job_s": round(oldest_active_s, 3),
            "oldest_queued_job_s": round(oldest_queued_s, 3),
            "last_job_completed_age_s": last_completed_age_s,
            "active_slices": 0,
            "queued_slices": 0,
            "oldest_active_slice_s": 0.0,
            "oldest_queued_slice_s": 0.0,
            "last_slice_completed_age_s": last_completed_age_s,
            "cgroup_oom_kill_events": self._oom_kill_events,
            "documents_completed": self.documents_completed,
        }


runtime = ParserRuntime()
_artifact_tasks: dict[str, asyncio.Task[tuple[dict[str, Any], int]]] = {}
_artifact_tasks_lock = asyncio.Lock()


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    (SHARED_DIR / "sources").mkdir(parents=True, exist_ok=True)
    (SHARED_DIR / "artifacts").mkdir(parents=True, exist_ok=True)
    (SHARED_DIR / "quarantine").mkdir(parents=True, exist_ok=True)
    await runtime.start()
    yield
    await runtime.close()


app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None)


def _authorized(request: Request) -> bool:
    expected = os.environ.get("PARSER_TOKEN", "")
    if not expected:
        return True
    supplied = request.headers.get("authorization", "")
    return supplied.startswith("Bearer ") and hmac.compare_digest(
        supplied[7:], expected
    )


def _shared_path(key: str, expected_dir: str) -> Path:
    relative = PurePosixPath(key)
    if (
        relative.is_absolute()
        or len(relative.parts) != 2
        or relative.parts[0] != expected_dir
        or relative.parts[1] in {"", ".", ".."}
    ):
        raise ValueError("invalid shared spool key")
    path = SHARED_DIR.joinpath(*relative.parts).resolve()
    if SHARED_DIR not in path.parents:
        raise ValueError("invalid shared spool key")
    return path


def _cgroup_value(name: str) -> int:
    try:
        return max(0, int(open(f"/sys/fs/cgroup/{name}", encoding="ascii").read()))
    except (OSError, ValueError):
        return 0


def _process_tree_memory() -> dict[str, int]:
    try:
        import psutil

        root = psutil.Process()
        processes = [root, *root.children(recursive=True)]
        rss = pss = 0
        for process in processes:
            try:
                info = process.memory_full_info()
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                continue
            rss += int(info.rss)
            pss += int(getattr(info, "pss", 0))
        return {
            "process_count": len(processes),
            "rss_bytes": rss,
            "pss_bytes": pss,
            "cgroup_memory_bytes": _cgroup_value("memory.current"),
            "cgroup_memory_peak_bytes": _cgroup_value("memory.peak"),
        }
    except ImportError:
        return {}


def _measurements(
    result: dict[str, Any], elapsed_s: float, queue_ms: int
) -> dict[str, Any]:
    """The receipt the worker bills from. Page counts drive the charge; the
    other keys keep their historical names for ``usage_events`` and Ops."""
    ocr_pages = result.get("_ocr_pages") or []
    phases = result.get("_phases") or {}
    execution_ms = round(sum(float(v) for v in phases.values()) * 1000)
    values = {
        "_page_count": max(0, int(result.get("_page_count") or 0)),
        "_ocr_page_count": len(ocr_pages) if isinstance(ocr_pages, list) else 0,
        "_worker_cpu_ms": 0,
        "_worker_wall_ms": 0,
        "_worker_avg_cores": 0.0,
        "_worker_rss_bytes": 0,
        "_worker_pss_bytes": 0,
        "_worker_io_read_bytes": 0,
        "_worker_io_write_bytes": 0,
        "_server_parse_ms": max(0, round(elapsed_s * 1000)),
        "_execution_ms": max(0, execution_ms),
        "_queue_ms": max(0, queue_ms),
        # One document is one execution unit now; the column stays for Ops.
        "_slice_count": 1,
        "_parse_lane": str(result.get("_parse_lane") or ""),
        "_parse_method": "odl-refined",
        "_source_format": str(result.get("_source_format") or ""),
        "_phases": {k: round(float(v), 3) for k, v in phases.items()},
    }
    values.update(
        {f"_parser_{key}": value for key, value in _process_tree_memory().items()}
    )
    return values


class _BoundedBytesIO(io.BytesIO):
    def write(self, data: bytes) -> int:
        if self.tell() + len(data) > MAX_ARTIFACT_BYTES:
            raise ValueError("parse artifact exceeds configured byte limit")
        return super().write(data)


def _bounded_utf8(value: object, limit: int, label: str) -> bytes:
    encoded = str(value or "").encode("utf-8")
    if len(encoded) > limit:
        raise ValueError(f"{label} exceeds configured byte limit")
    return encoded


def _bundle_bytes(
    result: dict[str, Any],
    fingerprint: str,
    request_id: str,
    measurements: dict[str, Any],
) -> bytes:
    content_list = result.get("content_list") or []
    images = result.get("images") or {}
    if not isinstance(content_list, list):
        raise TypeError("parser content list is invalid")
    if len(content_list) > MAX_CONTENT_BLOCKS:
        raise ValueError("parser content list contains too many blocks")
    if not isinstance(images, dict):
        raise TypeError("parser image map is invalid")
    if len(images) + 6 > MAX_ARTIFACT_ENTRIES:
        raise ValueError("parse artifact contains too many entries")
    written = {os.path.basename(name) for name in images if os.path.basename(name)}
    for item in content_list:
        if isinstance(item, dict) and item.get("type") == "image":
            basename = os.path.basename(str(item.get("img_path") or ""))
            if basename in written:
                item["img_path"] = f"images/{basename}"
    manifest = json.dumps(
        {
            "schema": ARTIFACT_SCHEMA,
            "parser_version": PARSER_VERSION,
            "source_fingerprint": fingerprint,
            "source_format": result.get("_source_format"),
            "parse_receipt": {
                "id": fingerprint,
                "request_id": request_id,
                "measurements": measurements,
            },
        },
        separators=(",", ":"),
    ).encode()
    content = json.dumps(
        content_list, ensure_ascii=False, separators=(",", ":")
    ).encode("utf-8")
    if len(content) > min(MAX_CONTENT_BYTES, MAX_ARTIFACT_ENTRY_BYTES):
        raise ValueError("parser content list exceeds configured byte limit")
    markdown = _bounded_utf8(
        result.get("md"), MAX_ARTIFACT_ENTRY_BYTES, "parser markdown"
    )
    furniture = result.get("_furniture") or []
    if not isinstance(furniture, list) or not all(
        isinstance(t, str) for t in furniture
    ):
        raise TypeError("parser furniture list is invalid")
    refinement = _bounded_utf8(
        json.dumps(
            {"furniture": furniture, "page_evidence": result.get("_page_evidence")},
            ensure_ascii=False,
            separators=(",", ":"),
        ),
        MAX_ARTIFACT_ENTRY_BYTES,
        "parser refinement",
    )
    decoded_images: list[tuple[str, bytes]] = []
    image_bytes = 0
    for name, encoded in images.items():
        safe = os.path.basename(name)
        if not safe:
            continue
        if not isinstance(encoded, (str, bytes)):
            raise TypeError("parser image payload is invalid")
        if len(encoded) > ((MAX_IMAGE_BYTES + 2) // 3) * 4 + 4:
            raise ValueError("parser image exceeds configured byte limit")
        decoded = base64.b64decode(encoded, validate=True)
        if len(decoded) > min(MAX_IMAGE_BYTES, MAX_ARTIFACT_ENTRY_BYTES):
            raise ValueError("parser image exceeds configured byte limit")
        image_bytes += len(decoded)
        if image_bytes > MAX_IMAGES_BYTES:
            raise ValueError("parser images exceed configured byte limit")
        decoded_images.append((safe, decoded))

    parsed_pdf = result.get("_parsed_pdf")
    parsed_size = 0
    if isinstance(parsed_pdf, bytes) and parsed_pdf.startswith(b"%PDF"):
        parsed_size = len(parsed_pdf)
        if parsed_size > MAX_ARTIFACT_ENTRY_BYTES:
            raise ValueError("repaired PDF exceeds configured byte limit")
    expanded_size = (
        len(manifest)
        + len(content)
        + len(markdown)
        + len(refinement)
        + parsed_size
        + image_bytes
    )
    if expanded_size > MAX_ARTIFACT_EXPANDED_BYTES:
        raise ValueError("parse artifact expands beyond configured byte limit")

    output = _BoundedBytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("manifest.json", manifest)
        archive.writestr("content_list.json", content)
        archive.writestr("document.md", markdown)
        archive.writestr("refinement.json", refinement)
        if parsed_size:
            archive.writestr("parsed.pdf", parsed_pdf)
        for safe, decoded in decoded_images:
            archive.writestr(f"images/{safe}", decoded)
    return output.getvalue()


def _read_source(key: str, expected_sha256: str) -> bytes:
    path = _shared_path(key, "sources")
    body = bytearray()
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            body.extend(chunk)
            digest.update(chunk)
            if len(body) > MAX_SOURCE_BYTES:
                raise SourceTooLargeError("source exceeds size limit")
    if not re.fullmatch(r"[0-9a-f]{64}", expected_sha256):
        raise ValueError("invalid source checksum")
    if not hmac.compare_digest(digest.hexdigest(), expected_sha256):
        raise ValueError("source checksum mismatch")
    return bytes(body)


def _artifact_descriptor(key: str, fingerprint: str) -> dict[str, Any] | None:
    path = _shared_path(key, "artifacts")
    try:
        size = path.stat().st_size
    except FileNotFoundError:
        return None
    if size <= 0 or size > MAX_ARTIFACT_BYTES:
        try:
            path.unlink()
        except FileNotFoundError:
            pass
        return None
    digest = hashlib.sha256()
    with path.open("rb") as artifact:
        while chunk := artifact.read(1024 * 1024):
            digest.update(chunk)
    path.touch()
    return {
        "key": key,
        "size": size,
        "sha256": digest.hexdigest(),
        "parser_version": PARSER_VERSION,
        "source_fingerprint": fingerprint,
        "cached": True,
    }


def _artifact_receipt(key: str, fingerprint: str, request_id: str) -> dict[str, Any]:
    """Recover the creating job's receipt from an atomically published bundle."""
    if not request_id:
        return {}
    path = _shared_path(key, "artifacts")
    try:
        with zipfile.ZipFile(path) as archive:
            info = archive.getinfo("manifest.json")
            if info.file_size <= 0 or info.file_size > 64 << 10:
                return {}
            manifest = json.loads(archive.read(info))
    except (FileNotFoundError, KeyError, OSError, ValueError, zipfile.BadZipFile):
        return {}
    if (
        not isinstance(manifest, dict)
        or manifest.get("schema") != ARTIFACT_SCHEMA
        or manifest.get("source_fingerprint") != fingerprint
    ):
        return {}
    receipt = manifest.get("parse_receipt")
    if (
        not isinstance(receipt, dict)
        or receipt.get("id") != fingerprint
        or receipt.get("request_id") != request_id
        or not isinstance(receipt.get("measurements"), dict)
    ):
        return {}
    return {"_receipt_id": fingerprint, **receipt["measurements"]}


def _quarantine_key(fingerprint: str) -> str:
    return f"quarantine/{fingerprint}.json"


def _quarantine(fingerprint: str) -> dict[str, Any] | None:
    path = _shared_path(_quarantine_key(fingerprint), "quarantine")
    try:
        value = json.loads(path.read_bytes())
    except (FileNotFoundError, OSError, ValueError):
        return None
    if (
        not isinstance(value, dict)
        or value.get("source_fingerprint") != fingerprint
        or value.get("parser_version") != PARSER_VERSION
        or value.get("reason") not in {"parse_hard_timeout", "parse_oom"}
    ):
        return None
    return value


def _write_quarantine(fingerprint: str, reason: str, detail: str) -> None:
    if reason not in {"parse_hard_timeout", "parse_oom"}:
        raise ValueError("invalid parser quarantine reason")
    path = _shared_path(_quarantine_key(fingerprint), "quarantine")
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(
        {
            "reason": reason,
            "detail": detail,
            "source_fingerprint": fingerprint,
            "parser_version": PARSER_VERSION,
            "created_at_unix": int(time.time()),
        },
        separators=(",", ":"),
    ).encode()
    temporary = path.with_name(f".{path.name}.{secrets.token_hex(8)}.tmp")
    try:
        with temporary.open("xb") as marker:
            marker.write(payload)
            marker.flush()
            os.fsync(marker.fileno())
        os.replace(temporary, path)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def _write_artifact(key: str, data: bytes) -> None:
    path = _shared_path(key, "artifacts")
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{secrets.token_hex(8)}.tmp")
    try:
        with temporary.open("xb") as artifact:
            artifact.write(data)
            artifact.flush()
            os.fsync(artifact.fileno())
        os.replace(temporary, path)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


async def _run(document: Document) -> tuple[dict[str, Any], dict[str, Any]]:
    started = time.perf_counter()
    result, queue_ms = await runtime.parse(document)
    measurements = _measurements(result, time.perf_counter() - started, queue_ms)
    return result, measurements


class SourceTooLargeError(RuntimeError):
    pass


@app.get("/healthz")
async def healthz() -> JSONResponse:
    ready = runtime.ready
    body = {
        "ok": ready,
        "state": runtime.state,
        "uptime_s": round(time.monotonic() - runtime.started_at, 3),
        "parser_version": PARSER_VERSION,
        "parser_implementation": PARSER_IMPLEMENTATION,
        "release_sha": RELEASE_SHA,
        "dependencies": PARSER_DEPENDENCIES,
        "backend": "opendataloader",
        "supported_formats": [
            "pdf",
            "doc",
            "docx",
            "ppt",
            "pptx",
            "xls",
            "xlsx",
        ],
        "queue_depth": QUEUE_DEPTH,
        "parse_document_timeout_s": PARSE_DOCUMENT_TIMEOUT_S,
        **runtime.health(),
        **_process_tree_memory(),
    }
    return JSONResponse(body, status_code=200 if ready else 503)


def _failure_response(
    exc: Exception, measurements: dict[str, Any] | None = None
) -> JSONResponse:
    if isinstance(exc, ParseHardTimeout):
        code, status = "parse_hard_timeout", 422
    elif isinstance(exc, ParseOOM):
        code, status = "parse_oom", 422
    elif isinstance(exc, ParserRuntimeFailure):
        code, status = "parser_runtime_failed", 503
    else:
        return JSONResponse(
            {"detail": f"parse failed: {exc}", **(measurements or {})},
            status_code=500,
        )
    _schedule_restart_backstop()
    return JSONResponse(
        {"code": code, "detail": str(exc)},
        status_code=status,
        background=BackgroundTask(_terminate_process),
    )


@app.post("/capture_page")
async def office_capture(request: Request) -> JSONResponse:
    if not _authorized(request):
        return JSONResponse({"detail": "invalid token"}, status_code=401)
    if runtime.active_jobs >= QUEUE_DEPTH:
        return JSONResponse(
            {"detail": "parser document queue is full"}, status_code=429
        )
    form = await request.form()
    upload = form.get("file")
    if upload is None or not hasattr(upload, "read"):
        return JSONResponse({"detail": "missing file field"}, status_code=400)
    name = str(form.get("filename") or "")
    if Path(name).suffix.lower() not in {".docx", ".xlsx", ".pptx"}:
        return JSONResponse(
            {"detail": "capture requires an Office source"}, status_code=400
        )
    try:
        page, max_edge = int(str(form.get("page"))), int(str(form.get("max_edge")))
        box = json.loads(str(form.get("bbox") or "null"))
        if page < 1 or not 1 <= max_edge <= 2048:
            raise ValueError("invalid page or render size")
        if box is not None and (
            not isinstance(box, list)
            or len(box) != 4
            or any(
                type(v) not in (float, int)
                or not math.isfinite(v)
                or not 0 <= v <= 1000
                for v in box
            )
            or box[0] >= box[2]
            or box[1] >= box[3]
        ):
            raise ValueError("invalid capture box")
    except (TypeError, ValueError):
        return JSONResponse({"detail": "invalid capture parameters"}, status_code=400)
    data = await upload.read(MAX_SOURCE_BYTES + 1)
    if len(data) > MAX_SOURCE_BYTES:
        return JSONResponse({"detail": "source exceeds size limit"}, status_code=413)
    try:
        result, _ = await runtime.parse(
            Document(
                data, name, capture={"page": page, "bbox": box, "max_edge": max_edge}
            )
        )
        return JSONResponse(result)
    except ParserCapacity as exc:
        return JSONResponse({"detail": str(exc)}, status_code=429)
    except Exception as exc:  # noqa: BLE001 - bounded worker diagnostics
        return _failure_response(exc)


@app.post("/file_parse")
async def file_parse(request: Request) -> JSONResponse:
    if not _authorized(request):
        return JSONResponse({"detail": "invalid token"}, status_code=401)
    if request.headers.get("content-type", "").startswith("application/json"):
        return await _artifact_parse(await request.json())
    if runtime.active_jobs >= QUEUE_DEPTH:
        return JSONResponse(
            {"code": "parser_capacity", "detail": "parser document queue is full"},
            status_code=429,
        )

    form = await request.form()
    upload = form.get("file")
    if upload is None or not hasattr(upload, "read"):
        return JSONResponse({"detail": "missing file field"}, status_code=400)
    data = await upload.read(MAX_SOURCE_BYTES + 1)
    if len(data) > MAX_SOURCE_BYTES:
        return JSONResponse({"detail": "source exceeds size limit"}, status_code=413)
    name = str(form.get("filename") or getattr(upload, "filename", None) or "document")
    try:
        result, measurements = await _run(Document(data, name))
    except SourceTooLargeError as exc:
        return JSONResponse({"detail": str(exc)}, status_code=413)
    except ParserCapacity as exc:
        return JSONResponse(
            {"code": "parser_capacity", "detail": str(exc)}, status_code=429
        )
    except Exception as exc:  # noqa: BLE001 - API returns a bounded diagnostic
        return _failure_response(exc)
    result.update(measurements)
    # The multipart compatibility route returns JSON. Repaired PDFs belong
    # only in the versioned artifact zip used by ingest.
    result.pop("_parsed_pdf", None)
    result.pop("_phases", None)
    result["_server_parse_s"] = round(measurements["_server_parse_ms"] / 1000, 3)
    return JSONResponse(result)


async def _artifact_parse(body: dict[str, Any]) -> JSONResponse:
    source_key = str(body.get("source_key") or "")
    source_sha256 = str(body.get("source_sha256") or "")
    output_key = str(body.get("output_key") or "")
    fingerprint = str(body.get("source_fingerprint") or "")
    request_id = str(body.get("request_id") or "")
    if (
        body.get("artifact_schema") != ARTIFACT_SCHEMA
        or body.get("parser_version") != PARSER_VERSION
        or not source_key
        or not source_sha256
        or not output_key
        or not fingerprint
        or not request_id
        or output_key != f"artifacts/{fingerprint}.zip"
    ):
        return JSONResponse({"detail": "invalid artifact request"}, status_code=400)

    try:
        if cached := await asyncio.to_thread(
            _artifact_descriptor, output_key, fingerprint
        ):
            receipt = await asyncio.to_thread(
                _artifact_receipt, output_key, fingerprint, request_id
            )
            return JSONResponse({"artifact": cached, **receipt}, status_code=200)
        if quarantined := await asyncio.to_thread(_quarantine, fingerprint):
            reason = str(quarantined.get("reason") or "parse_hard_timeout")
            return JSONResponse(
                {
                    "code": reason,
                    "detail": str(
                        quarantined.get("detail")
                        or (
                            "parser ran out of memory"
                            if reason == "parse_oom"
                            else "parse exceeded its hard deadline"
                        )
                    ),
                    "source_fingerprint": fingerprint,
                },
                status_code=422,
            )
        if runtime.active_jobs >= QUEUE_DEPTH:
            return JSONResponse(
                {
                    "code": "parser_capacity",
                    "detail": "parser document queue is full",
                },
                status_code=429,
            )
        started = time.perf_counter()
        source = await asyncio.to_thread(_read_source, source_key, source_sha256)
        source_read_ms = round((time.perf_counter() - started) * 1000)
    except FileNotFoundError:
        return JSONResponse({"detail": "shared source is missing"}, status_code=404)
    except SourceTooLargeError as exc:
        return JSONResponse({"detail": str(exc)}, status_code=413)
    except Exception as exc:  # noqa: BLE001 - API returns a bounded diagnostic
        return JSONResponse(
            {"detail": f"invalid shared source: {exc}"}, status_code=400
        )

    task = await _artifact_task(fingerprint, body, source, source_read_ms)
    task_payload, status_code = await asyncio.shield(task)
    # Every waiter receives the immutable artifact, but only the job that
    # created it receives the parse receipt. Otherwise a concurrent cache
    # waiter could win the billing transaction for somebody else's parse.
    payload = dict(task_payload)
    receipt_request_id = str(payload.pop("_receipt_request_id", ""))
    restart_parser = bool(payload.pop("_restart_parser", False))
    if status_code < 300 and receipt_request_id != request_id:
        payload = {"artifact": payload["artifact"]}
    if restart_parser:
        _schedule_restart_backstop()
    return JSONResponse(
        payload,
        status_code=status_code,
        background=BackgroundTask(_terminate_process) if restart_parser else None,
    )


async def _artifact_task(
    fingerprint: str,
    body: dict[str, Any],
    source: bytes,
    source_read_ms: int,
) -> asyncio.Task[tuple[dict[str, Any], int]]:
    """Share one parse/write across client timeouts and their retries."""
    async with _artifact_tasks_lock:
        task = _artifact_tasks.get(fingerprint)
        if task is None:
            task = asyncio.create_task(
                _produce_artifact(dict(body), source, source_read_ms)
            )
            _artifact_tasks[fingerprint] = task
            task.add_done_callback(
                lambda finished: asyncio.create_task(
                    _forget_artifact_task(fingerprint, finished)
                )
            )
        return task


async def _forget_artifact_task(
    fingerprint: str, task: asyncio.Task[tuple[dict[str, Any], int]]
) -> None:
    async with _artifact_tasks_lock:
        if _artifact_tasks.get(fingerprint) is task:
            _artifact_tasks.pop(fingerprint, None)


async def _produce_artifact(
    body: dict[str, Any], source: bytes, source_read_ms: int
) -> tuple[dict[str, Any], int]:
    output_key = str(body["output_key"])
    name = str(body.get("filename") or "document")
    fingerprint = str(body["source_fingerprint"])
    request_id = str(body["request_id"])

    measurements: dict[str, Any] = {}
    write_ms = 0
    try:
        result, measurements = await _run(Document(source, name, fingerprint))
        measurements["_download_ms"] = max(0, source_read_ms)
        # The bundle must carry the receipt before its atomic publication.
        # Bundle-write time is response-only telemetry because it is not known
        # until after the immutable ZIP has been written.
        measurements["_upload_ms"] = 0
        bundle = await asyncio.to_thread(
            _bundle_bytes, result, fingerprint, request_id, measurements
        )
        digest = hashlib.sha256(bundle).hexdigest()
        started = time.perf_counter()
        await asyncio.to_thread(_write_artifact, output_key, bundle)
        write_ms = round((time.perf_counter() - started) * 1000)
    except ParseHardTimeout as exc:
        return (
            {
                "code": "parse_hard_timeout",
                "detail": str(exc),
                "source_fingerprint": fingerprint,
                "_restart_parser": True,
            },
            422,
        )
    except ParseOOM as exc:
        return (
            {
                "code": "parse_oom",
                "detail": str(exc),
                "source_fingerprint": fingerprint,
                "_restart_parser": True,
            },
            422,
        )
    except ParserRuntimeFailure as exc:
        return (
            {
                "code": "parser_runtime_failed",
                "detail": str(exc),
                "source_fingerprint": fingerprint,
                "_restart_parser": True,
            },
            503,
        )
    except ParserCapacity as exc:
        return (
            {"code": "parser_capacity", "detail": str(exc)},
            429,
        )
    except Exception as exc:  # noqa: BLE001 - API returns a bounded diagnostic
        return {"detail": f"remote parse failed: {exc}", **measurements}, 500
    # Keep the existing metering field names until the usage-event schema is
    # renamed. They now measure local spool read/write time, not B2 transfers.
    measurements["_upload_ms"] = max(0, write_ms)
    return (
        {
            "artifact": {
                "key": output_key,
                "size": len(bundle),
                "sha256": digest,
                "parser_version": PARSER_VERSION,
                "source_fingerprint": fingerprint,
                "cached": False,
            },
            "_receipt_request_id": request_id,
            "_receipt_id": fingerprint,
            "_server_parse_s": round(measurements["_server_parse_ms"] / 1000, 3),
            **measurements,
        },
        200,
    )
