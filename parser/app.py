"""Persistent CPU parser for the Netcup ingest host.

The caller owns artifact identity and caching. The worker and parser share a
local spool: this service reads one source key and atomically publishes one
fingerprint-addressed zip key without a B2 round trip.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import io
import json
import os
import re
import secrets
import time
import zipfile
from collections import deque
from collections.abc import AsyncIterator
from concurrent.futures.process import BrokenProcessPool
from contextlib import asynccontextmanager
from dataclasses import dataclass
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path, PurePosixPath
from typing import Any, NoReturn

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from mineru_worker import (
    MINERU_DEFAULT_METHOD,
    MINERU_METHODS,
    OFFICE_PREVIEW_MAX_BYTES,
    NormalizedDocument,
    PageSlice,
    SliceResult,
    merge_slices,
    normalize_document,
    normalize_parse_method,
    page_slices,
    parse_slice,
    pdf_page_count,
)
from starlette.background import BackgroundTask

ARTIFACT_SCHEMA = "evo-parser-bundle-v3"
PARSER_IMPLEMENTATION = "mineru-3.4.5-pipeline-sliced-v1"
RELEASE_SHA = os.environ.get("RELEASE_SHA", "dev").strip() or "dev"
if os.environ.get("APP_ENV") == "production" and not re.fullmatch(
    r"[0-9a-f]{40}", RELEASE_SHA
):
    raise RuntimeError("production parser RELEASE_SHA must be a full lowercase Git SHA")
PARSER_VERSION = f"{PARSER_IMPLEMENTATION}+{RELEASE_SHA}"


def _dependency_versions() -> dict[str, str]:
    packages = (
        "mineru",
        "pypdfium2",
        "torch",
        "torchvision",
    )
    versions: dict[str, str] = {}
    for package in packages:
        try:
            versions[package] = version(package)
        except PackageNotFoundError:
            versions[package] = "missing"
    return versions


PARSER_DEPENDENCIES = _dependency_versions()
MAX_SOURCE_BYTES = int(os.environ.get("EVO_MAX_SOURCE_BYTES", str(100 << 20)))
MAX_ARTIFACT_BYTES = int(os.environ.get("EVO_PARSE_ARTIFACT_MAX_BYTES", str(256 << 20)))
MAX_ARTIFACT_ENTRIES = int(os.environ.get("EVO_PARSE_ARTIFACT_MAX_ENTRIES", "4096"))
MAX_ARTIFACT_ENTRY_BYTES = int(
    os.environ.get("EVO_PARSE_ARTIFACT_MAX_ENTRY_BYTES", str(128 << 20))
)
MAX_ARTIFACT_EXPANDED_BYTES = int(
    os.environ.get("EVO_PARSE_ARTIFACT_MAX_EXPANDED_BYTES", str(512 << 20))
)
MAX_CONTENT_BYTES = int(os.environ.get("EVO_PARSE_CONTENT_MAX_BYTES", str(128 << 20)))
MAX_CONTENT_BLOCKS = int(os.environ.get("EVO_PARSE_CONTENT_MAX_BLOCKS", "250000"))
MAX_IMAGE_BYTES = int(os.environ.get("EVO_PARSE_IMAGE_MAX_BYTES", str(32 << 20)))
MAX_IMAGES_BYTES = int(os.environ.get("EVO_PARSE_IMAGES_MAX_BYTES", str(256 << 20)))
SLICE_PAGES = int(os.environ.get("EVO_MINERU_SLICE_PAGES", "26"))
PARSE_CONCURRENCY = int(os.environ.get("EVO_PARSE_CONCURRENCY", "4"))
PARSE_SLICE_TIMEOUT_S = max(1, int(os.environ.get("EVO_PARSE_SLICE_TIMEOUT", "600")))
RESTART_BACKSTOP_S = 1.0
OOM_POLL_INTERVAL_S = 0.25
SHARED_DIR = Path(
    os.environ.get("EVO_PARSE_SHARED_DIR", "/tmp/evo-parse-spool")
).resolve()
if not 1 <= PARSE_CONCURRENCY <= 4:
    raise RuntimeError("EVO_PARSE_CONCURRENCY must be between 1 and 4")
if SLICE_PAGES <= 0:
    raise RuntimeError("EVO_MINERU_SLICE_PAGES must be positive")
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
    parse_method: str
    fingerprint: str = ""


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
class _QueuedSlice:
    document_id: str
    document: NormalizedDocument
    page_slice: PageSlice
    parse_method: str
    enqueued_at: float
    future: asyncio.Future[tuple[SliceResult, int]]


@dataclass
class _DocumentExecution:
    fingerprint: str
    futures: list[asyncio.Future[tuple[SliceResult, int]]]
    executed_s: float = 0.0
    active_slices: int = 0
    interval_started_at: float | None = None
    timed_out: bool = False


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


def _is_broken_process_pool(exc: BaseException) -> bool:
    current: BaseException | None = exc
    seen: set[int] = set()
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        if isinstance(current, BrokenProcessPool):
            return True
        message = str(current).lower()
        if (
            "process pool is not usable anymore" in message
            or "process pool is broken" in message
            or "child process terminated abruptly" in message
        ):
            return True
        current = current.__cause__ or current.__context__
    return False


class ParserRuntime:
    """Fair global queue over four persistent MinerU pipeline calls."""

    def __init__(self) -> None:
        self.started_at = time.monotonic()
        self.state = "starting"
        self.models_loaded = False
        self.active_jobs = 0
        self.active_slices = 0
        self.queued_slices = 0
        self._condition = asyncio.Condition()
        self._document_queues: dict[str, deque[_QueuedSlice]] = {}
        self._document_order: deque[str] = deque()
        self._workers: list[asyncio.Task[None]] = []
        self._warm_lock = asyncio.Lock()
        self._executions: dict[str, _DocumentExecution] = {}
        self._active_slice_started_at: dict[str, float] = {}
        self._active_slice_timeouts: dict[str, asyncio.TimerHandle] = {}
        self._last_slice_completed_at: float | None = None
        self._oom_kill_events = 0
        self._oom_monitor: asyncio.Task[None] | None = None

    async def start(self) -> None:
        self._oom_kill_events = _cgroup_event_value("oom_kill")
        self._workers = [
            asyncio.create_task(self._slice_worker(index), name=f"mineru-slice-{index}")
            for index in range(PARSE_CONCURRENCY)
        ]
        for worker in self._workers:
            worker.add_done_callback(self._slice_worker_done)
        self._oom_monitor = asyncio.create_task(
            self._watch_oom_kills(), name="mineru-oom-monitor"
        )
        self.state = "ready"

    async def close(self) -> None:
        self.state = "stopping"
        for timeout in self._active_slice_timeouts.values():
            timeout.cancel()
        self._active_slice_timeouts.clear()
        if self._oom_monitor is not None:
            self._oom_monitor.cancel()
            await asyncio.gather(self._oom_monitor, return_exceptions=True)
            self._oom_monitor = None
        for worker in self._workers:
            worker.cancel()
        await asyncio.gather(*self._workers, return_exceptions=True)
        self._workers.clear()

    def _slice_worker_done(self, worker: asyncio.Task[None]) -> None:
        if self.state == "stopping" or worker.cancelled():
            return
        try:
            exc = worker.exception()
        except asyncio.CancelledError:
            return
        if exc is None:
            detail = "MinerU slice worker exited unexpectedly"
        else:
            detail = f"MinerU slice worker exited: {exc}"
        self._fail_runtime(ParserRuntimeFailure(detail))

    def _fail_runtime(self, exc: Exception) -> None:
        if self.state == "stopping":
            return
        self.state = "failed"
        for execution in self._executions.values():
            for future in execution.futures:
                if not future.done():
                    future.set_exception(type(exc)(str(exc)))
        _schedule_restart_backstop()

    async def _watch_oom_kills(self) -> None:
        while True:
            await asyncio.sleep(OOM_POLL_INTERVAL_S)
            current = _cgroup_event_value("oom_kill")
            if current > self._oom_kill_events:
                self._record_oom_kill(current)

    def _record_oom_kill(self, current: int) -> None:
        if current <= self._oom_kill_events:
            return
        self._oom_kill_events = current
        self.state = "failed"
        detail = "parser cgroup killed a process because it ran out of memory"
        for execution in self._executions.values():
            active = execution.active_slices > 0
            if active and execution.fingerprint:
                try:
                    _write_quarantine(execution.fingerprint, "parse_oom", detail)
                except OSError as exc:
                    print(f"could not write parser OOM marker: {exc}", flush=True)
            error: Exception
            if active:
                error = ParseOOM(detail)
            else:
                error = ParserRuntimeFailure("parser restarted after an OOM kill")
            for future in execution.futures:
                if not future.done():
                    future.set_exception(type(error)(str(error)))
        _schedule_restart_backstop()

    async def parse(self, document: Document) -> tuple[dict[str, Any], int]:
        if self.state != "ready" or not self._workers:
            raise RuntimeError("parser is not ready")
        async with self._condition:
            if self.active_jobs >= PARSE_CONCURRENCY:
                raise ParserCapacity("parser document queue is full")
            self.active_jobs += 1
        try:
            return await self._parse_admitted(document)
        finally:
            async with self._condition:
                self.active_jobs = max(0, self.active_jobs - 1)

    async def _parse_admitted(self, document: Document) -> tuple[dict[str, Any], int]:
        method = normalize_parse_method(document.parse_method)
        normalized = await asyncio.to_thread(
            normalize_document, document.data, document.name
        )
        page_count = await asyncio.to_thread(pdf_page_count, normalized.data)
        ranges = page_slices(page_count, SLICE_PAGES)
        if not ranges:
            raise ValueError("document has no pages")
        document_id = secrets.token_hex(12)
        loop = asyncio.get_running_loop()
        works = [
            _QueuedSlice(
                document_id=document_id,
                document=normalized,
                page_slice=page_slice,
                parse_method=method,
                enqueued_at=time.perf_counter(),
                future=loop.create_future(),
            )
            for page_slice in ranges
        ]
        self._executions[document_id] = _DocumentExecution(
            fingerprint=document.fingerprint,
            futures=[work.future for work in works],
        )
        async with self._condition:
            self.queued_slices += len(works)
            self._document_queues[document_id] = deque(works)
            self._document_order.append(document_id)
            self._condition.notify_all()
        execution_ms = 0
        try:
            completed = await asyncio.gather(*(work.future for work in works))
        finally:
            async with self._condition:
                execution = self._executions.pop(document_id, None)
                if execution is not None:
                    if execution.interval_started_at is not None:
                        execution.executed_s += max(
                            0.0,
                            asyncio.get_running_loop().time()
                            - execution.interval_started_at,
                        )
                    execution_ms = round(execution.executed_s * 1000)
                pending = self._document_queues.pop(document_id, deque())
                self.queued_slices = max(0, self.queued_slices - len(pending))
                self._document_order = deque(
                    key for key in self._document_order if key != document_id
                )
                for work in pending:
                    work.future.cancel()

        results = [result for result, _queue_ms in completed]
        queue_ms = max(queue_ms for _result, queue_ms in completed)
        merged = merge_slices(results)
        merged.update(
            {
                "_page_count": page_count,
                "_worker_cpu_ms": 0,
                "_worker_wall_ms": 0,
                "_source_format": normalized.source_format,
                "_parse_lane": "ocr" if merged["_ocr_pages"] else "digital",
                "_parse_method": method,
                "_slice_count": len(ranges),
                "_execution_ms": max(0, execution_ms),
            }
        )
        if normalized.preview_pdf is not None:
            merged["_preview_pdf"] = normalized.preview_pdf
        return merged, queue_ms

    async def _next_slice(self) -> _QueuedSlice:
        async with self._condition:
            while not self._document_order:
                await self._condition.wait()
            document_id = self._document_order.popleft()
            queue = self._document_queues[document_id]
            work = queue.popleft()
            if queue:
                self._document_order.append(document_id)
            else:
                self._document_queues.pop(document_id, None)
            self.queued_slices = max(0, self.queued_slices - 1)
            self.active_slices += 1
            return work

    def _begin_execution(self, work: _QueuedSlice, worker_index: int) -> str:
        execution = self._executions.get(work.document_id)
        if execution is None:
            return ""
        loop = asyncio.get_running_loop()
        now = loop.time()
        token = f"{worker_index}:{work.document_id}:{work.page_slice.start}"
        self._active_slice_started_at[token] = now
        execution.active_slices += 1
        if execution.active_slices == 1:
            execution.interval_started_at = now
        self._active_slice_timeouts[token] = loop.call_later(
            PARSE_SLICE_TIMEOUT_S,
            self._expire_slice,
            work.document_id,
            token,
            work.page_slice,
        )
        return token

    def _finish_execution(self, work: _QueuedSlice, token: str) -> None:
        now = asyncio.get_running_loop().time()
        if token:
            self._active_slice_started_at.pop(token, None)
            timeout = self._active_slice_timeouts.pop(token, None)
            if timeout is not None:
                timeout.cancel()
        self._last_slice_completed_at = now
        execution = self._executions.get(work.document_id)
        if execution is None or execution.active_slices <= 0:
            return
        execution.active_slices -= 1
        if execution.active_slices == 0 and execution.interval_started_at is not None:
            execution.executed_s += max(0.0, now - execution.interval_started_at)
            execution.interval_started_at = None

    def _expire_slice(
        self, document_id: str, token: str, page_slice: PageSlice
    ) -> None:
        execution = self._executions.get(document_id)
        if (
            execution is None
            or execution.active_slices <= 0
            or execution.timed_out
            or token not in self._active_slice_started_at
        ):
            return
        execution.timed_out = True
        detail = (
            f"parse slice pages {page_slice.start + 1}-{page_slice.end + 1} "
            f"exceeded {PARSE_SLICE_TIMEOUT_S} seconds"
        )
        if execution.fingerprint:
            try:
                _write_quarantine(execution.fingerprint, "parse_hard_timeout", detail)
            except OSError as exc:
                print(f"could not write parser timeout marker: {exc}", flush=True)
        self.state = "failed"
        for future in execution.futures:
            if not future.done():
                future.set_exception(ParseHardTimeout(detail))
        _schedule_restart_backstop()

    async def _slice_worker(self, worker_index: int) -> None:
        while True:
            work = await self._next_slice()
            queue_ms = max(0, round((time.perf_counter() - work.enqueued_at) * 1000))
            token = self._begin_execution(work, worker_index)
            try:
                result = await self._parse_one_slice(work)
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
                elif _is_broken_process_pool(exc):
                    self._fail_runtime(
                        ParserRuntimeFailure(f"MinerU process pool failed: {exc}")
                    )
                elif not work.future.done():
                    work.future.set_exception(exc)
            finally:
                self._finish_execution(work, token)
                async with self._condition:
                    self.active_slices = max(0, self.active_slices - 1)

    async def _parse_one_slice(self, work: _QueuedSlice) -> SliceResult:
        if self.models_loaded:
            return await asyncio.to_thread(
                parse_slice,
                work.document.data,
                work.document.name,
                work.page_slice,
                work.parse_method,
            )
        async with self._warm_lock:
            if not self.models_loaded:
                result = await asyncio.to_thread(
                    parse_slice,
                    work.document.data,
                    work.document.name,
                    work.page_slice,
                    work.parse_method,
                )
                self.models_loaded = True
                print(
                    "mineru pipeline models loaded once for persistent reuse",
                    flush=True,
                )
                return result
        return await asyncio.to_thread(
            parse_slice,
            work.document.data,
            work.document.name,
            work.page_slice,
            work.parse_method,
        )


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
    ocr_pages = result.get("_ocr_pages") or []
    worker_cpu_ms = max(0, int(result.get("_worker_cpu_ms") or 0))
    worker_wall_ms = max(0, int(result.get("_worker_wall_ms") or 0))
    values = {
        "_page_count": max(0, int(result.get("_page_count") or 0)),
        "_ocr_page_count": len(ocr_pages) if isinstance(ocr_pages, list) else 0,
        "_worker_cpu_ms": worker_cpu_ms,
        "_worker_wall_ms": worker_wall_ms,
        "_worker_avg_cores": round(worker_cpu_ms / worker_wall_ms, 3)
        if worker_wall_ms
        else 0.0,
        "_worker_rss_bytes": max(0, int(result.get("_worker_rss_bytes") or 0)),
        "_worker_pss_bytes": max(0, int(result.get("_worker_pss_bytes") or 0)),
        "_worker_io_read_bytes": max(0, int(result.get("_worker_io_read_bytes") or 0)),
        "_worker_io_write_bytes": max(
            0, int(result.get("_worker_io_write_bytes") or 0)
        ),
        "_server_parse_ms": max(0, round(elapsed_s * 1000)),
        "_execution_ms": max(0, int(result.get("_execution_ms") or 0)),
        "_queue_ms": max(0, queue_ms),
        "_parse_lane": str(result.get("_parse_lane") or ""),
        "_parse_method": str(result.get("_parse_method") or ""),
        "_source_format": str(result.get("_source_format") or ""),
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
    if len(images) + 4 > MAX_ARTIFACT_ENTRIES:
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

    preview_pdf = result.get("_preview_pdf")
    preview_size = 0
    if isinstance(preview_pdf, bytes) and preview_pdf.startswith(b"%PDF"):
        preview_size = len(preview_pdf)
        if preview_size > min(OFFICE_PREVIEW_MAX_BYTES, MAX_ARTIFACT_ENTRY_BYTES):
            raise ValueError("Office preview exceeds configured byte limit")
    expanded_size = (
        len(manifest) + len(content) + len(markdown) + preview_size + image_bytes
    )
    if expanded_size > MAX_ARTIFACT_EXPANDED_BYTES:
        raise ValueError("parse artifact expands beyond configured byte limit")

    output = _BoundedBytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("manifest.json", manifest)
        archive.writestr("content_list.json", content)
        archive.writestr("document.md", markdown)
        if isinstance(preview_pdf, bytes) and preview_pdf.startswith(b"%PDF"):
            archive.writestr("preview.pdf", preview_pdf)
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
    if worker_error := str(result.get("_worker_error") or ""):
        if _is_broken_process_pool(RuntimeError(worker_error)):
            runtime._fail_runtime(
                ParserRuntimeFailure(f"MinerU process pool failed: {worker_error}")
            )
            raise ParserRuntimeFailure(worker_error)
        raise ParseFailure(worker_error, measurements)
    return result, measurements


class ParseFailure(RuntimeError):
    def __init__(self, message: str, measurements: dict[str, Any]):
        super().__init__(message)
        self.measurements = measurements


class SourceTooLargeError(RuntimeError):
    pass


@app.get("/healthz")
async def healthz() -> JSONResponse:
    ready = runtime.state == "ready" and bool(runtime._workers)
    now = asyncio.get_running_loop().time()
    oldest_active_slice_s = (
        max(0.0, now - min(runtime._active_slice_started_at.values()))
        if runtime._active_slice_started_at
        else 0.0
    )
    queued_at = [
        work.enqueued_at
        for queue in runtime._document_queues.values()
        for work in queue
    ]
    oldest_queued_slice_s = (
        max(0.0, time.perf_counter() - min(queued_at)) if queued_at else 0.0
    )
    last_slice_completed_age_s = (
        max(0.0, now - runtime._last_slice_completed_at)
        if runtime._last_slice_completed_at is not None
        else None
    )
    body = {
        "ok": ready,
        "state": runtime.state,
        "uptime_s": round(time.monotonic() - runtime.started_at, 3),
        "parser_version": PARSER_VERSION,
        "parser_implementation": PARSER_IMPLEMENTATION,
        "release_sha": RELEASE_SHA,
        "dependencies": PARSER_DEPENDENCIES,
        "backend": "pipeline",
        "supported_methods": sorted(MINERU_METHODS),
        "supported_formats": [
            "pdf",
            "doc",
            "docx",
            "ppt",
            "pptx",
            "xls",
            "xlsx",
        ],
        "slice_pages": SLICE_PAGES,
        "parse_concurrency": PARSE_CONCURRENCY,
        "models_loaded": runtime.models_loaded,
        "parse_slice_timeout_s": PARSE_SLICE_TIMEOUT_S,
        "active_jobs": runtime.active_jobs,
        "queued_jobs": len(runtime._document_queues),
        "active_slices": runtime.active_slices,
        "queued_slices": runtime.queued_slices,
        "oldest_active_slice_s": round(oldest_active_slice_s, 3),
        "oldest_queued_slice_s": round(oldest_queued_slice_s, 3),
        "last_slice_completed_age_s": (
            round(last_slice_completed_age_s, 3)
            if last_slice_completed_age_s is not None
            else None
        ),
        "cgroup_oom_kill_events": runtime._oom_kill_events,
        **_process_tree_memory(),
    }
    return JSONResponse(body, status_code=200 if ready else 503)


@app.post("/file_parse")
async def file_parse(request: Request) -> JSONResponse:
    if not _authorized(request):
        return JSONResponse({"detail": "invalid token"}, status_code=401)
    if request.headers.get("content-type", "").startswith("application/json"):
        return await _artifact_parse(await request.json())
    if runtime.active_jobs >= PARSE_CONCURRENCY:
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
    method = str(form.get("parse_method") or MINERU_DEFAULT_METHOD)
    try:
        result, measurements = await _run(Document(data, name, method))
    except SourceTooLargeError as exc:
        return {"detail": str(exc), **measurements}, 413
    except ParseHardTimeout as exc:
        _schedule_restart_backstop()
        return JSONResponse(
            {"code": "parse_hard_timeout", "detail": str(exc)},
            status_code=422,
            background=BackgroundTask(_terminate_process),
        )
    except ParseOOM as exc:
        _schedule_restart_backstop()
        return JSONResponse(
            {"code": "parse_oom", "detail": str(exc)},
            status_code=422,
            background=BackgroundTask(_terminate_process),
        )
    except ParserRuntimeFailure as exc:
        _schedule_restart_backstop()
        return JSONResponse(
            {"code": "parser_runtime_failed", "detail": str(exc)},
            status_code=503,
            background=BackgroundTask(_terminate_process),
        )
    except ParserCapacity as exc:
        return JSONResponse(
            {"code": "parser_capacity", "detail": str(exc)}, status_code=429
        )
    except ParseFailure as exc:
        return JSONResponse(
            {"detail": f"parse failed: {exc}", **exc.measurements}, status_code=500
        )
    except Exception as exc:  # noqa: BLE001 - API returns a bounded diagnostic
        return JSONResponse({"detail": f"parse failed: {exc}"}, status_code=500)
    result.update(measurements)
    # The multipart compatibility route returns JSON. Binary previews belong
    # only in the versioned artifact zip used by ingest.
    result.pop("_preview_pdf", None)
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
        if runtime.active_jobs >= PARSE_CONCURRENCY:
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
    method = str(body.get("parse_method") or MINERU_DEFAULT_METHOD)
    fingerprint = str(body["source_fingerprint"])
    request_id = str(body["request_id"])

    measurements: dict[str, Any] = {}
    write_ms = 0
    try:
        result, measurements = await _run(
            Document(source, name, method, fingerprint=fingerprint)
        )
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
        await asyncio.to_thread(
            _write_quarantine, fingerprint, "parse_hard_timeout", str(exc)
        )
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
        await asyncio.to_thread(_write_quarantine, fingerprint, "parse_oom", str(exc))
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
    except ParseFailure as exc:
        measurements = exc.measurements
        return {"detail": f"remote parse failed: {exc}", **measurements}, 500
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
