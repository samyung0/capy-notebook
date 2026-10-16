"""Persistent CPU parser for the Netcup ingest host.

The caller owns artifact identity and caching. The worker and parser share a
local spool: this service reads one source key and atomically publishes one
fingerprint-addressed zip key without a B2 round trip.

CAPY_PARSE_WORKERS persistent parse children each run one document at a time
through OpenDataLoader plus the native repairs in ``odl/``, waiting documents
in one FIFO; CAPY_PARSE_QUEUE_DEPTH bounds the documents in the children plus
the FIFO, and CAPY_PARSE_MAX_PAGES refuses a longer document outright. Pages
without a text layer go into the bundle as grey JPEG renders
(``vlm/<page>.jpg``), at most CAPY_PARSE_OCR_PAGE_CAP per document, and the
ingest worker reads them with the VLM. A document past its parse deadline or
OOM-killed is quarantined by fingerprint and only its parse child is replaced.

The API process opens no source with MuPDF: the parse children count a
document's pages and parse it. Children answer in JSON and plain files,
never pickle. The API serves a cached bundle only as
it wrote it, and no other process of the parser user can read its memory.
"""

from __future__ import annotations

import asyncio
import ctypes
import errno
import gc
import hashlib
import hmac
import io
import json
import math
import multiprocessing
import os
import re
import secrets
import shutil
import signal
import tempfile
import time
import zipfile
from collections import deque
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass
from importlib.metadata import PackageNotFoundError, version
from multiprocessing.connection import Connection
from pathlib import Path, PurePosixPath
from stat import S_ISREG
from typing import Any, BinaryIO, NoReturn

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from odl.document import (
    OfficeConversionFailed,
    OfficeConversionTimeout,
    OfficeFormatMismatch,
    SourceUnreadable,
)
from odl.java import JavaKilled, JavaTimeout

try:
    import resource
except ImportError:  # Not POSIX.
    resource = None

ARTIFACT_SCHEMA = "capy-parser-bundle-v6"
# Bump when parse output changes: it names the output in the ingest donor key.
PARSER_IMPLEMENTATION = "odl-2.5.7-refined-vlm-v16"
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
        "pillow",
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
MAX_ARTIFACT_ENTRY_BYTES = int(
    os.environ.get("CAPY_PARSE_ARTIFACT_MAX_ENTRY_BYTES", str(128 << 20))
)
MAX_ARTIFACT_EXPANDED_BYTES = int(
    os.environ.get("CAPY_PARSE_ARTIFACT_MAX_EXPANDED_BYTES", str(512 << 20))
)
MAX_CONTENT_BYTES = int(os.environ.get("CAPY_PARSE_CONTENT_MAX_BYTES", str(128 << 20)))
MAX_CONTENT_BLOCKS = int(os.environ.get("CAPY_PARSE_CONTENT_MAX_BLOCKS", "250000"))
# Documents admitted: in a parse child or waiting for one.
# One request more is answered 429.
QUEUE_DEPTH = int(os.environ.get("CAPY_PARSE_QUEUE_DEPTH", "8"))
# Persistent parse children, one document each. The compose files set it; there
# is no default here because the capacity test picks the production value.
PARSE_WORKERS = int(os.environ.get("CAPY_PARSE_WORKERS") or 0)
# Wall clock for one document in its parse child, started when it leaves the
# queue. The Java step gets the remaining budget as its own subprocess timeout.
PARSE_DOCUMENT_TIMEOUT_S = max(
    1, int(os.environ.get("CAPY_PARSE_DOCUMENT_TIMEOUT", "900"))
)
# Text-less pages one document may hand the ingest worker's VLM; a document
# with more is refused. The API serves the same value in the upload policy.
SCANNED_PAGE_CAP = int(os.environ.get("CAPY_PARSE_OCR_PAGE_CAP", "500"))
# One page render; ingest's parser_client._entry_limit refuses a larger
# ``vlm/<page>.jpg``. A 1,280 px grey page at quality 80 is well under it.
VLM_PAGE_MAX_BYTES = 4 << 20
# Pages in one document. The API serves the same value in the upload policy,
# so there is no default here: the compose files pass the shared env value.
MAX_PAGES = int(os.environ.get("CAPY_PARSE_MAX_PAGES") or 0)
RESTART_BACKSTOP_S = 1.0
# The kernel OOM-kills the highest oom_score first: a parse child (one document)
# before the API.
PARSE_OOM_SCORE_ADJ = 1000
# Address space (a soft RLIMIT_AS) of a parse child and the LibreOffice it
# starts; Java lifts it (odl/java.py), its heap bounded by -Xmx. A document
# that needs more fails as parse_oom instead of crowding the other children.
PARSE_CHILD_MAX_BYTES = 2 << 30
# MuPDF's failed allocation as PyMuPDF raises it: its message starts with
# MuPDF's error code (text inside another error, such as Java's output, is
# not one).
_ALLOCATION_FAILED = re.compile(r"code=\d+: (?:m|c|re)alloc \([^)]*\) failed")
# A child's answer on its pipe: a status and small payloads.
# A longer one ends that child.
MESSAGE_MAX_BYTES = 1 << 24
PR_SET_DUMPABLE = 4
SHARED_DIR = Path(
    os.environ.get("CAPY_PARSE_SHARED_DIR", "/tmp/capy-parse-spool")
).resolve()
WORK_DIR = Path(os.environ.get("CAPY_PARSE_WORK_DIR", "/run/capy-parser/work"))
if not 1 <= QUEUE_DEPTH <= 16:
    raise RuntimeError("CAPY_PARSE_QUEUE_DEPTH must be between 1 and 16")
if MAX_PAGES < 1:
    raise RuntimeError("CAPY_PARSE_MAX_PAGES must be set to a positive page count")
if not 1 <= PARSE_WORKERS <= QUEUE_DEPTH:
    raise RuntimeError(
        "CAPY_PARSE_WORKERS must be set between 1 and CAPY_PARSE_QUEUE_DEPTH"
    )
if any(
    value <= 0
    for value in (
        MAX_SOURCE_BYTES,
        MAX_ARTIFACT_BYTES,
        MAX_ARTIFACT_ENTRY_BYTES,
        MAX_ARTIFACT_EXPANDED_BYTES,
        MAX_CONTENT_BYTES,
        MAX_CONTENT_BLOCKS,
        SCANNED_PAGE_CAP,
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


class ParseTooManyScannedPages(RuntimeError):
    pass


class ParseTooManyPages(RuntimeError):
    pass


def _check_page_count(pages: int) -> None:
    if pages > MAX_PAGES:
        raise ParseTooManyPages(
            f"{pages} pages; the parser reads at most {MAX_PAGES} pages per file"
        )


def _terminate_process() -> NoReturn:
    """Let the container supervisor replace a parser that failed as a whole."""
    os._exit(1)


def _schedule_restart_backstop() -> None:
    """Restart even if the client disconnects before response delivery."""
    asyncio.get_running_loop().call_later(RESTART_BACKSTOP_S, _terminate_process)


class _ChildExited(ParserRuntimeFailure):
    """A child's pipe closed: it died. ``exitcode`` is -9 for SIGKILL."""

    def __init__(self, message: str, exitcode: int | None = None) -> None:
        super().__init__(message)
        self.exitcode = exitcode


@dataclass
class _QueuedDocument:
    document: Document
    enqueued_at: float
    future: asyncio.Future[tuple[dict[str, Any], int]]
    started_at: float | None = None
    # The cgroup's oom_kill count when the document started executing.
    oom_kills: int = 0


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
    from odl.document import normalize_document, pdf_page_count

    WORK_DIR.mkdir(parents=True, exist_ok=True)
    normalized = normalize_document(document.data, document.name, WORK_DIR)
    if document.capture is not None:
        from odl.capture import capture_page

        return capture_page(normalized.data, **document.capture)
    # The only page count: every document, before the parse (an Office
    # document's pages exist only after LibreOffice).
    _check_page_count(pdf_page_count(normalized.data))
    from odl.refine import parse_pdf

    work = Path(tempfile.mkdtemp(prefix="doc-", dir=WORK_DIR))
    try:
        output = parse_pdf(
            normalized.data, work, java_timeout_s=PARSE_DOCUMENT_TIMEOUT_S
        )
    finally:
        shutil.rmtree(work, ignore_errors=True)
    textless = output.textless_pages
    if len(textless) > SCANNED_PAGE_CAP:
        raise ParseTooManyScannedPages(
            f"{len(textless)} pages have no text layer; "
            f"the parser reads at most {SCANNED_PAGE_CAP}"
        )
    parsed = output.parsed_pdf or normalized.data
    result: dict[str, Any] = {
        "content_list": output.content_list,
        "_vlm_pages": textless,
        "_page_count": output.page_count,
        "_source_format": normalized.source_format,
        "_parse_lane": "vlm" if textless else "digital",
        "_phases": output.phases,
        "_stages": output.stages,
        "_repaired_fonts": output.repaired_fonts,
        "_furniture": output.furniture,
        "_drawing_steps": output.drawing_steps,
    }
    if output.drawings_stopped_at is not None:
        print(
            f"drawing clusters stopped on page {output.drawings_stopped_at} after "
            f"{output.drawing_steps} steps: {document.fingerprint or '-'}",
            flush=True,
        )
    # The list-card thumbnail comes from the PDF this parse holds (an Office
    # file's conversion, or the repaired bytes), inside this bounded child, so
    # ingest neither converts nor renders anything for it. Optional: it never
    # fails the parse.
    from odl.capture import page_thumbnail

    started = time.perf_counter()
    try:
        result["_page_image"] = page_thumbnail(parsed)
    except Exception as exc:  # noqa: BLE001 - a missing thumbnail is fine
        print(f"page thumbnail skipped: {type(exc).__name__}: {exc}", flush=True)
    result["_phases"] = {**output.phases, "thumbnail": time.perf_counter() - started}
    if textless:
        import pymupdf
        from odl.textless import render_jpeg

        started = time.perf_counter()
        with pymupdf.open(stream=parsed, filetype="pdf") as pdf:
            result["_vlm_images"] = [render_jpeg(pdf[page]) for page in textless]
        result["_phases"]["vlm_render"] = time.perf_counter() - started
    if normalized.preview_pdf is not None:
        from odl.evidence import page_evidence

        # From the parsed blocks alone: the VLM's page text comes later, in
        # ingest, and carries no evidence.
        result["_page_evidence"] = page_evidence(parsed, output.content_list)
    elif output.parsed_pdf is not None:
        result["_parsed_pdf"] = output.parsed_pdf
    return result


def _release_memory() -> None:
    """Hand the heap a finished unit of work freed back to the kernel.

    glibc keeps freed arenas (about 0.8 GiB after a large document) otherwise,
    and MuPDF's store keeps decoded images and fonts (up to 256 MiB) of
    documents already closed.
    """
    import pymupdf

    pymupdf.TOOLS.store_shrink(100)
    gc.collect()
    try:
        ctypes.CDLL("libc.so.6").malloc_trim(0)
    except (OSError, AttributeError):
        pass  # Not glibc (macOS development).


def _make_undumpable() -> None:
    """No other process of the parser user may trace the API or read its
    memory and environment (children start dumpable again on exec)."""
    try:
        libc = ctypes.CDLL("libc.so.6", use_errno=True)
    except OSError:
        return  # Not glibc (macOS development).
    if libc.prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) != 0:
        raise OSError(ctypes.get_errno(), "prctl(PR_SET_DUMPABLE) failed")


def _set_oom_score_adj(value: int) -> None:
    try:
        Path("/proc/self/oom_score_adj").write_text(str(value), encoding="ascii")
    except OSError:
        pass


def _send(connection: Connection, status: str, payload: Any) -> None:
    """A child's answer to the API is JSON: nothing a child sends is unpickled."""
    connection.send_bytes(json.dumps([status, payload]).encode())


def _send_error(connection: Connection, exc: Exception) -> None:
    _send(connection, "error", [type(exc).__name__, str(exc)])


def _kill_session(sid: int) -> None:
    """SIGKILL what is left of a parse child's session, where LibreOffice runs
    in a group of its own (Linux /proc; elsewhere a no-op)."""
    for stat in Path("/proc").glob("[0-9]*/stat"):
        try:
            if int(stat.read_text().rsplit(")", 1)[1].split()[3]) == sid:
                os.kill(int(stat.parent.name), signal.SIGKILL)
        except (OSError, ValueError, IndexError):
            continue


def _limit_address_space(limit: int) -> None:
    """A soft limit, so a subprocess may lift it to the hard one."""
    if resource is None:
        return
    _, hard = resource.getrlimit(resource.RLIMIT_AS)
    soft = limit if hard == resource.RLIM_INFINITY else min(limit, hard)
    resource.setrlimit(resource.RLIMIT_AS, (soft, hard))


def _out_of_memory(exc: Exception) -> bool:
    """Past the child's address-space limit: Python's MemoryError, an OS call
    refused with ENOMEM, or MuPDF's failed allocation."""
    return (
        isinstance(exc, MemoryError)
        or (isinstance(exc, OSError) and exc.errno == errno.ENOMEM)
        or bool(_ALLOCATION_FAILED.match(str(exc)))
    )


def _parse_worker_main(
    requests: Connection, responses: Connection, work_dir: str
) -> None:
    """One parse slot: documents in, file-backed results out."""
    global WORK_DIR
    try:
        os.setsid()
    except OSError:
        pass
    _set_oom_score_adj(PARSE_OOM_SCORE_ADJ)
    _limit_address_space(PARSE_CHILD_MAX_BYTES)
    WORK_DIR = Path(work_dir)

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
            _write_worker_result(Path(result_path), result)
            _send(responses, "ok", None)
        except Exception as exc:  # noqa: BLE001 - returned to API supervisor
            if _out_of_memory(exc):
                exc = ParseOOM(
                    f"the parse needed more than {PARSE_CHILD_MAX_BYTES >> 30} GiB "
                    f"of address space: {exc}"
                )
            _send_error(responses, exc)
        finally:
            document = result = None
            _release_memory()


# Child errors the API acts on, by name; any other arrives as a RuntimeError
# that names its type.
_CHILD_ERRORS: dict[str, type[Exception]] = {
    error.__name__: error
    for error in (
        JavaTimeout,
        JavaKilled,
        OfficeConversionFailed,
        OfficeConversionTimeout,
        OfficeFormatMismatch,
        ParseTooManyPages,
        ParseTooManyScannedPages,
        SourceUnreadable,
        ParseOOM,
    )
}


def _unwrap(message: Any) -> Any:
    if isinstance(message, list) and len(message) == 2:
        status, payload = message
        if status == "ok":
            return payload
        if status == "error" and isinstance(payload, list) and len(payload) == 2:
            name, detail = (str(part) for part in payload)
            error = _CHILD_ERRORS.get(name)
            raise error(detail) if error else RuntimeError(f"{name}: {detail}")
    raise RuntimeError("parser child returned an invalid response")


def _temporary_file(suffix: str) -> Path:
    WORK_DIR.mkdir(parents=True, exist_ok=True)
    descriptor, name = tempfile.mkstemp(prefix="transfer-", suffix=suffix, dir=WORK_DIR)
    os.close(descriptor)
    return Path(name)


class _Child:
    """A persistent spawned child with one request and one response pipe.
    Requests are the API's own values; responses are JSON (``_send``)."""

    def __init__(self, target: Callable[..., None], *args: str, name: str) -> None:
        self._target = target
        self._args = args
        self._name = name
        self._process: multiprocessing.Process | None = None
        self._requests: Connection | None = None
        self._responses: Connection | None = None

    def start(self) -> None:
        context = multiprocessing.get_context("spawn")
        child_requests, self._requests = context.Pipe(duplex=False)
        self._responses, child_responses = context.Pipe(duplex=False)
        self._process = context.Process(
            target=self._target,
            args=(child_requests, child_responses, *self._args),
            name=self._name,
        )
        self._process.start()
        child_requests.close()
        child_responses.close()

    @property
    def alive(self) -> bool:
        """Running, with its answer pipe open: an answer over the limit closes
        the pipe before the SIGKILL lands, and that child is replaced."""
        return (
            self._process is not None
            and self._process.is_alive()
            and self._responses is not None
            and not self._responses.closed
        )

    def _exit_code(self) -> int | None:
        if self._process is None:
            return None
        self._process.join(timeout=5)
        return self._process.exitcode

    async def _exited(self) -> _ChildExited:
        code = await asyncio.to_thread(self._exit_code)
        return _ChildExited(f"{self._name} exited unexpectedly (code {code})", code)

    async def send(self, message: object) -> None:
        if self._requests is None:
            raise ParserRuntimeFailure(f"{self._name} is not running")
        try:
            await asyncio.to_thread(self._requests.send, message)
        except (BrokenPipeError, EOFError, OSError) as exc:
            raise await self._exited() from exc

    async def recv(self) -> Any:
        if self._responses is None:
            raise ParserRuntimeFailure(f"{self._name} is not running")
        try:
            message = await asyncio.to_thread(
                self._responses.recv_bytes, MESSAGE_MAX_BYTES
            )
        except EOFError as exc:
            raise await self._exited() from exc
        except OSError as exc:
            # An answer over the limit leaves the pipe mid-message: end the
            # child, which is replaced before its next use.
            self.terminate()
            raise ParserRuntimeFailure(f"{self._name} sent an invalid answer") from exc
        return json.loads(message)

    def terminate(self) -> None:
        """SIGKILL the child and everything left in its session."""
        process = self._process
        if process is None or process.pid is None:
            return
        if process.is_alive():
            process.kill()
        try:
            os.killpg(process.pid, signal.SIGKILL)  # Java runs in its group.
        except OSError:
            pass
        _kill_session(process.pid)

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
        self.terminate()  # Also ends Java or LibreOffice a dead child left.
        process.join(timeout=1)
        for connection in (self._requests, self._responses):
            if connection is not None:
                connection.close()
        self._process = self._requests = self._responses = None


class _ParseWorkerProcess(_Child):
    """One parse slot's child with file-backed messages for large results."""

    def __init__(self, slot: int) -> None:
        self.work_dir = WORK_DIR / f"slot-{slot}"
        super().__init__(
            _parse_worker_main, str(self.work_dir), name=f"parse child {slot}"
        )

    def start(self) -> None:
        # A killed child leaves its document directory behind.
        shutil.rmtree(self.work_dir, ignore_errors=True)
        self.work_dir.mkdir(parents=True, exist_ok=True)
        super().start()

    async def run(self, document: Document, result_path: Path) -> None:
        """Parse into ``result_path``."""
        if not self.alive:
            raise ParserRuntimeFailure(f"{self._name} is not running")
        source_path = _temporary_file(".source")  # sync: see _run_slot
        try:
            await asyncio.to_thread(source_path.write_bytes, document.data)
            await self.send(
                (
                    str(source_path),
                    str(result_path),
                    document.name,
                    document.fingerprint,
                    document.capture,
                )
            )
            _unwrap(await self.recv())
        finally:
            _unlink(source_path)

    async def parse(self, document: Document) -> tuple[dict[str, Any], int]:
        """Admit a document; its parse child counts its pages."""


def _unlink(*paths: Path) -> None:
    for path in paths:
        try:
            path.unlink()
        except FileNotFoundError:
            pass


# A parse child's result file: the result as JSON, then these byte values
# (empty when absent), then one JPEG per ``_vlm_pages`` entry, each part
# preceded by its 8-byte length.
_RESULT_BYTES = ("_parsed_pdf", "_page_image")


def _write_worker_result(path: Path, result: dict[str, Any]) -> None:
    binary = {*_RESULT_BYTES, "_vlm_images"}
    parts = [
        json.dumps({k: v for k, v in result.items() if k not in binary}).encode(),
        *(result.get(key) or b"" for key in _RESULT_BYTES),
        *result.get("_vlm_images", ()),
    ]
    with path.open("wb") as output:
        for part in parts:
            output.write(len(part).to_bytes(8, "big"))
            output.write(part)


def _read_worker_result(path: Path) -> dict[str, Any]:
    with path.open("rb") as result_file:
        left = os.fstat(result_file.fileno()).st_size
        # A larger result could not become a bundle anyway.
        if left > MAX_ARTIFACT_EXPANDED_BYTES:
            raise ValueError("parser child returned an oversized result file")

        def part() -> bytes:
            nonlocal left
            size = int.from_bytes(result_file.read(8), "big")
            left -= 8 + size
            if left < 0:
                raise ValueError("parser child returned an invalid result file")
            return result_file.read(size)

        result = json.loads(part())
        if not isinstance(result, dict):
            raise TypeError("parser child returned an invalid result")
        values = [part() for _ in _RESULT_BYTES]
        pages = result.get("_vlm_pages") or []
        if not isinstance(pages, list) or len(pages) > SCANNED_PAGE_CAP:
            raise TypeError("parser child returned an invalid result")
        images = [part() for _ in pages]
    result.update({k: v for k, v in zip(_RESULT_BYTES, values) if v})
    if images:
        result["_vlm_images"] = images
    return result


def _clear_work_dir() -> None:
    """Startup empties the work dir (no child runs yet): what an earlier parser
    process abandoned, and the temporary files of anything using TMPDIR."""
    WORK_DIR.mkdir(parents=True, exist_ok=True)
    for path in WORK_DIR.iterdir():
        if path.is_dir() and not path.is_symlink():
            shutil.rmtree(path, ignore_errors=True)
        else:
            _unlink(path)


@dataclass
class _Slot:
    index: int
    process: _ParseWorkerProcess
    work: _QueuedDocument | None = None
    deadline: asyncio.TimerHandle | None = None
    # Set when the slot's document was ended; the child is replaced before the
    # next document.
    restart: bool = False
    task: asyncio.Task[None] | None = None


class ParserRuntime:
    """PARSE_WORKERS parse children over one bounded FIFO."""

    def __init__(
        self,
        parse_process: Callable[[int], _ParseWorkerProcess] = _ParseWorkerProcess,
    ) -> None:
        self.started_at = time.monotonic()
        self.state = "starting"
        self.active_jobs = 0
        self._new_parse_process = parse_process
        self._queue: deque[_QueuedDocument] = deque()
        self._condition = asyncio.Condition()
        self._slots: list[_Slot] = []
        self._last_completed_at: float | None = None
        self.documents_completed = 0

    async def start(self) -> None:
        await asyncio.to_thread(_clear_work_dir)
        for index in range(PARSE_WORKERS):
            slot = _Slot(index, self._new_parse_process(index))
            slot.process.start()
            slot.task = asyncio.create_task(
                self._run_slot(slot), name=f"parse slot {index}"
            )
            slot.task.add_done_callback(self._task_done)
            self._slots.append(slot)
        self.state = "ready"

    async def close(self) -> None:
        self.state = "stopping"
        tasks = [slot.task for slot in self._slots]
        for slot in self._slots:
            if slot.deadline is not None:
                slot.deadline.cancel()
        for task in tasks:
            if task is not None:
                task.cancel()
        await asyncio.gather(
            *(t for t in tasks if t is not None), return_exceptions=True
        )
        for waiting in self._queue:
            waiting.future.cancel()
        self._queue.clear()
        for slot in self._slots:
            await asyncio.to_thread(slot.process.stop)
        self._slots = []

    @property
    def ready(self) -> bool:
        tasks = [slot.task for slot in self._slots]
        return self.state == "ready" and all(
            task is not None and not task.done() for task in tasks
        )

    def _task_done(self, task: asyncio.Task[None]) -> None:
        if self.state == "stopping" or task.cancelled():
            return
        exc = task.exception()
        self._fail_runtime(
            ParserRuntimeFailure(
                f"{task.get_name()} exited"
                + (f": {exc}" if exc is not None else " unexpectedly")
            )
        )

    def _finished(self, work: _QueuedDocument) -> None:
        """A document's answer is set: it leaves admission."""
        if not work.future.cancelled():
            work.future.exception()  # Retrieved: the request may be gone.
        self.active_jobs -= 1
        if work.started_at is not None:
            self.documents_completed += 1
            self._last_completed_at = asyncio.get_running_loop().time()

    def _fail_runtime(self, exc: ParserRuntimeFailure) -> None:
        """A process-wide failure: fail everything and let Docker restart us."""
        if self.state in {"stopping", "failed"}:
            return
        self.state = "failed"
        detail = str(exc)
        for slot in self._slots:
            slot.process.terminate()
            if slot.work is not None and not slot.work.future.done():
                slot.work.future.set_exception(ParserRuntimeFailure(detail))
        for waiting in self._queue:
            if not waiting.future.done():
                waiting.future.set_exception(ParserRuntimeFailure(detail))
        self._queue.clear()
        _schedule_restart_backstop()

    async def parse(self, document: Document) -> tuple[dict[str, Any], int]:
        """Admit a document; its parse child counts its pages."""
        if not self.ready:
            raise RuntimeError("parser is not ready")
        loop = asyncio.get_running_loop()
        async with self._condition:
            if self.active_jobs >= QUEUE_DEPTH:
                raise ParserCapacity("parser document queue is full")
            self.active_jobs += 1
            work = _QueuedDocument(document, time.perf_counter(), loop.create_future())
            work.future.add_done_callback(lambda _: self._finished(work))
            self._queue.append(work)
            self._condition.notify_all()
        try:
            return await asyncio.shield(work.future)
        except asyncio.CancelledError:
            async with self._condition:
                if work in self._queue:
                    self._queue.remove(work)
                    work.future.cancel()
            raise

    async def _next(self) -> _QueuedDocument:
        async with self._condition:
            while not self._queue:
                await self._condition.wait()
            return self._queue.popleft()

    async def _run_slot(self, slot: _Slot) -> None:
        loop = asyncio.get_running_loop()
        while True:
            # Made before taking a document, so documents start in FIFO order.
            # Synchronous on purpose: a cancel landing on a to_thread await
            # would leave the thread's file behind with no path to unlink.
            result_path = _temporary_file(".result")
            try:
                work = await self._next()
                while work.future.done():
                    work = await self._next()
            except asyncio.CancelledError:
                _unlink(result_path)
                raise
            queue_ms = max(0, round((time.perf_counter() - work.enqueued_at) * 1000))
            slot.work = work
            work.started_at = loop.time()
            work.oom_kills = _cgroup_event_value("oom_kill")
            slot.deadline = loop.call_later(
                PARSE_DOCUMENT_TIMEOUT_S, self._expire, slot, work
            )
            try:
                if slot.restart or not slot.process.alive:
                    slot.restart = False
                    await asyncio.to_thread(slot.process.stop)
                    slot.process.start()
                await slot.process.run(work.document, result_path)
                if not work.future.done():
                    result = await asyncio.to_thread(_read_worker_result, result_path)
                    if not work.future.done():
                        work.future.set_result((result, queue_ms))
            except asyncio.CancelledError:
                if not work.future.done():
                    work.future.cancel()
                raise
            except Exception as exc:  # noqa: BLE001 - returned to owning request
                self._fail_document(slot, work, exc)
            finally:
                if slot.deadline is not None:
                    slot.deadline.cancel()
                    slot.deadline = None
                slot.work = None
                # Synchronous like its creation: the owner's future is
                # already set, so a close() cancelling this await would
                # return before a to_thread unlink ran.
                _unlink(result_path)
                result = None
                work = None

    def _fail_document(
        self, slot: _Slot, work: _QueuedDocument, exc: Exception
    ) -> None:
        if work.future.done():
            return  # The deadline already answered and stopped this document.
        if isinstance(exc, JavaTimeout):
            self._expire(slot, work)
            return
        # Past the child's own address-space limit: this document asked for
        # the memory. The child answered, so it is replaced, not killed.
        if isinstance(exc, ParseOOM):
            slot.restart = True
            _quarantine_and_fail(work, "parse_oom", exc)
            return
        # The kernel kills the process with the highest oom_score, so a
        # document whose child, or Java inside it, died by SIGKILL while the
        # cgroup's oom_kill count rose is the one that was using the memory.
        # LibreOffice's launcher hides the signal its soffice.bin died by, so
        # any failed or timed-out conversion counts the same way.
        killed = isinstance(
            exc, (JavaKilled, OfficeConversionFailed, OfficeConversionTimeout)
        ) or (isinstance(exc, _ChildExited) and exc.exitcode == -signal.SIGKILL)
        if killed and _cgroup_event_value("oom_kill") > work.oom_kills:
            slot.restart = True
            slot.process.terminate()
            _quarantine_and_fail(
                work,
                "parse_oom",
                ParseOOM("parser cgroup killed a process because it ran out of memory"),
            )
            return
        if isinstance(exc, OfficeConversionTimeout):
            # Final like the parse deadline.
            self._expire(slot, work, str(exc))
            return
        work.future.set_exception(exc)

    def _expire(self, slot: _Slot, work: _QueuedDocument, detail: str = "") -> None:
        """The parse-stage deadline: stop only this slot's child."""
        if slot.work is not work or work.future.done():
            return
        slot.restart = True
        slot.process.terminate()
        _quarantine_and_fail(
            work,
            "parse_hard_timeout",
            ParseHardTimeout(
                detail or f"parse exceeded {PARSE_DOCUMENT_TIMEOUT_S} seconds"
            ),
        )

    def health(self) -> dict[str, Any]:
        now = asyncio.get_running_loop().time()
        executing = [
            slot.work.started_at
            for slot in self._slots
            if slot.work is not None and slot.work.started_at is not None
        ]
        oldest_active_s = max((now - started for started in executing), default=0.0)
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
            "executing_jobs": len(executing),
            "oldest_active_job_s": round(max(0.0, oldest_active_s), 3),
            "oldest_queued_job_s": round(oldest_queued_s, 3),
            "last_job_completed_age_s": last_completed_age_s,
            "active_slices": 0,
            "queued_slices": 0,
            "oldest_active_slice_s": 0.0,
            "oldest_queued_slice_s": 0.0,
            "last_slice_completed_age_s": last_completed_age_s,
            "cgroup_oom_kill_events": _cgroup_event_value("oom_kill"),
            "documents_completed": self.documents_completed,
        }


def _quarantine_and_fail(
    work: _QueuedDocument, reason: str, error: ParseHardTimeout | ParseOOM
) -> None:
    """Quarantine a runaway document's fingerprint and answer it."""
    if work.document.fingerprint:
        try:
            _write_quarantine(work.document.fingerprint, reason, str(error))
        except OSError as exc:
            print(f"could not write parser {reason} marker: {exc}", flush=True)
    if not work.future.done():
        work.future.set_exception(error)


runtime = ParserRuntime()
_artifact_tasks: dict[str, asyncio.Task[tuple[dict[str, Any], int]]] = {}
_artifact_tasks_lock = asyncio.Lock()


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    _make_undumpable()
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
    """A spool file's path. The directory must be the spool's own; the file
    itself is not resolved, so a link there is refused when opened
    (``_open_spool_file``) and unlinked as the link it is."""
    relative = PurePosixPath(key)
    if (
        relative.is_absolute()
        or len(relative.parts) != 2
        or relative.parts[0] != expected_dir
        or relative.parts[1] in {"", ".", ".."}
    ):
        raise ValueError("invalid shared spool key")
    directory = SHARED_DIR / expected_dir
    if directory.resolve() != directory:
        raise ValueError("invalid shared spool key")
    return directory / relative.parts[1]


def _open_spool_file(path: Path) -> tuple[BinaryIO, int]:
    """Open a spool file as a child may have left it: never through a link,
    never waiting on a FIFO, only a regular file. Returns it and its size;
    the caller bounds the size."""
    descriptor = os.open(
        path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
    )
    try:
        info = os.fstat(descriptor)
        if not S_ISREG(info.st_mode):
            raise OSError(f"{path.name} is not a regular file")
        return os.fdopen(descriptor, "rb"), info.st_size
    except BaseException:
        os.close(descriptor)
        raise


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
    vlm_pages = result.get("_vlm_pages") or []
    phases = result.get("_phases") or {}
    execution_ms = round(sum(float(v) for v in phases.values()) * 1000)
    values = {
        "_page_count": max(0, int(result.get("_page_count") or 0)),
        "_ocr_page_count": len(vlm_pages) if isinstance(vlm_pages, list) else 0,
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
        # Seconds per refinement stage, for profiles; not part of the bill.
        "_stages": {
            k: round(float(v), 3) for k, v in (result.get("_stages") or {}).items()
        },
        # Steps the drawing clusters took (pictures.VECTOR_MAX_STEPS bounds them).
        "_drawing_steps": max(0, int(result.get("_drawing_steps") or 0)),
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


_PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
# A 200 x 400 page is under 240 KB even uncompressed; ingest's
# parser_client._entry_limit refuses a page1.png over the same bound.
PAGE_IMAGE_MAX_BYTES = 1 << 20


def _bundle_bytes(
    result: dict[str, Any],
    fingerprint: str,
    source_sha256: str,
    request_id: str,
    measurements: dict[str, Any],
) -> bytes:
    """Only what ingest reads: the receipt, blocks, refinement, a repaired PDF,
    the document's page-1 thumbnail (``page1.png``) and one render per page
    without a text layer for the VLM (``vlm/<page>.jpg``). The manifest names
    the SHA-256 of the source bytes parsed; the coordinator uses a bundle only
    for those bytes.

    Figures are reached at question time by rendering the source page; ODL
    writes neither image files nor Markdown.
    """
    content_list = result.get("content_list") or []
    if not isinstance(content_list, list):
        raise TypeError("parser content list is invalid")
    if len(content_list) > MAX_CONTENT_BLOCKS:
        raise ValueError("parser content list contains too many blocks")
    manifest = json.dumps(
        {
            "schema": ARTIFACT_SCHEMA,
            "parser_version": PARSER_VERSION,
            "source_fingerprint": fingerprint,
            "source_sha256": source_sha256,
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

    parsed_pdf = result.get("_parsed_pdf")
    parsed_size = 0
    if isinstance(parsed_pdf, bytes) and parsed_pdf.startswith(b"%PDF"):
        parsed_size = len(parsed_pdf)
        if parsed_size > MAX_ARTIFACT_ENTRY_BYTES:
            raise ValueError("repaired PDF exceeds configured byte limit")
    # Optional, like the render: anything but a bounded PNG is left out.
    page_image = result.get("_page_image")
    if not (
        isinstance(page_image, bytes)
        and page_image.startswith(_PNG_SIGNATURE)
        and len(page_image) <= PAGE_IMAGE_MAX_BYTES
    ):
        page_image = b""
    vlm_pages = result.get("_vlm_pages") or []
    vlm_images = result.get("_vlm_images") or []
    page_count = int(result.get("_page_count") or 0)
    if (
        len(vlm_pages) != len(vlm_images)
        or len(vlm_pages) > SCANNED_PAGE_CAP
        or not all(type(page) is int and 0 <= page < page_count for page in vlm_pages)
        or not all(
            isinstance(image, bytes)
            and image.startswith(b"\xff\xd8\xff")
            and len(image) <= VLM_PAGE_MAX_BYTES
            for image in vlm_images
        )
    ):
        raise ValueError("parser page renders are invalid")
    expanded_size = (
        len(manifest)
        + len(content)
        + len(refinement)
        + parsed_size
        + len(page_image)
        + sum(len(image) for image in vlm_images)
    )
    if expanded_size > MAX_ARTIFACT_EXPANDED_BYTES:
        raise ValueError("parse artifact expands beyond configured byte limit")

    output = _BoundedBytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("manifest.json", manifest)
        archive.writestr("content_list.json", content)
        archive.writestr("refinement.json", refinement)
        if parsed_size:
            archive.writestr("parsed.pdf", parsed_pdf)
        if page_image:
            archive.writestr("page1.png", page_image)
        for page, image in zip(vlm_pages, vlm_images):
            # JPEG is compressed already.
            archive.writestr(f"vlm/{page}.jpg", image, compress_type=zipfile.ZIP_STORED)
    return output.getvalue()


def _read_source(key: str, expected_sha256: str) -> bytes:
    source, size = _open_spool_file(_shared_path(key, "sources"))
    if size > MAX_SOURCE_BYTES:
        source.close()
        raise SourceTooLargeError("source exceeds size limit")
    body = bytearray()
    digest = hashlib.sha256()
    with source:
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


# Each bundle this process published, by fingerprint: its digest and its
# creator's receipt. The spool is served only as this process wrote it; any
# other file there (after a restart, every one) is deleted and parsed again.
_published: dict[str, tuple[str, str, dict[str, Any]]] = {}


def _record_bundle(
    fingerprint: str, digest: str, request_id: str, measurements: dict[str, Any]
) -> None:
    for known in list(_published):
        # Entries leave with their files; one still being written stays.
        if known in _artifact_tasks:
            continue
        if not _shared_path(f"artifacts/{known}.zip", "artifacts").exists():
            _published.pop(known, None)
    _published[fingerprint] = (digest, request_id, dict(measurements))


def _artifact_descriptor(key: str, fingerprint: str) -> dict[str, Any] | None:
    path = _shared_path(key, "artifacts")
    digest = hashlib.sha256()
    try:
        artifact, size = _open_spool_file(path)
        with artifact:
            seen = os.fstat(artifact.fileno())
            if 0 < size <= MAX_ARTIFACT_BYTES:
                while chunk := artifact.read(1024 * 1024):
                    digest.update(chunk)
        ours = 0 < size <= MAX_ARTIFACT_BYTES
    except FileNotFoundError:
        return None
    except OSError:  # A link or a FIFO is no bundle this process wrote.
        try:
            seen = os.lstat(path)
        except FileNotFoundError:
            return None
        ours = False
    # Read after the hash; a bundle's record is made before the bundle is
    # written, so a request that saw the file sees its record too.
    published = _published.get(fingerprint)
    if not ours or published is None or published[0] != digest.hexdigest():
        # Remove only the file looked at: one written meanwhile stays, with
        # its record.
        if _same_file(path, seen):
            if _published.get(fingerprint) is published:
                _published.pop(fingerprint, None)
            _unlink(path)
        return None
    path.touch()
    return {
        "key": key,
        "size": size,
        "sha256": digest.hexdigest(),
        "parser_version": PARSER_VERSION,
        "source_fingerprint": fingerprint,
        "cached": True,
    }


def _same_file(path: Path, seen: os.stat_result) -> bool:
    try:
        now = os.lstat(path)
    except FileNotFoundError:
        return False
    return (now.st_dev, now.st_ino) == (seen.st_dev, seen.st_ino)


def _artifact_receipt(fingerprint: str, request_id: str) -> dict[str, Any]:
    """The creating job's receipt for a bundle this process published."""
    published = _published.get(fingerprint)
    if not request_id or published is None or published[1] != request_id:
        return {}
    return {"_receipt_id": fingerprint, **published[2]}


# A quarantine marker is a few hundred bytes of JSON.
MARKER_MAX_BYTES = 64 << 10


def _quarantine_key(fingerprint: str) -> str:
    return f"quarantine/{fingerprint}.json"


def _quarantine(fingerprint: str) -> dict[str, Any] | None:
    path = _shared_path(_quarantine_key(fingerprint), "quarantine")
    try:
        marker, size = _open_spool_file(path)
        with marker:
            if size > MARKER_MAX_BYTES:
                return None
            value = json.loads(marker.read(MARKER_MAX_BYTES))
    except (OSError, ValueError):
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
        "parse_workers": PARSE_WORKERS,
        "scanned_page_cap": SCANNED_PAGE_CAP,
        "max_pages": MAX_PAGES,
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
    elif isinstance(exc, ParseTooManyScannedPages):
        code, status = "parse_too_many_scanned_pages", 422
    elif isinstance(exc, ParseTooManyPages):
        code, status = "parse_too_many_pages", 422
    elif isinstance(exc, ParseOOM):
        code, status = "parse_oom", 422
    elif isinstance(exc, OfficeFormatMismatch):
        code, status = "parse_format_mismatch", 422
    elif isinstance(exc, SourceUnreadable):
        code, status = "parse_unreadable", 422
    elif isinstance(exc, ParserRuntimeFailure):
        code, status = "parser_runtime_failed", 503
    else:
        return JSONResponse(
            {"detail": f"parse failed: {exc}", **(measurements or {})},
            status_code=500,
        )
    return JSONResponse({"code": code, "detail": str(exc)}, status_code=status)


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
    result.pop("_page_image", None)
    result.pop("_vlm_images", None)
    result.pop("_phases", None)
    result.pop("_stages", None)
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
            receipt = _artifact_receipt(fingerprint, request_id)
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
        # Answered before the source is read.
        if runtime.active_jobs >= QUEUE_DEPTH:
            return JSONResponse(
                {"code": "parser_capacity", "detail": "parser document queue is full"},
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
    if status_code < 300 and receipt_request_id != request_id:
        payload = {"artifact": payload["artifact"]}
    return JSONResponse(payload, status_code=status_code)


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
            _bundle_bytes,
            result,
            fingerprint,
            str(body["source_sha256"]),
            request_id,
            measurements,
        )
        digest = hashlib.sha256(bundle).hexdigest()
        # Recorded first: a request seeing the file sees its record too.
        _record_bundle(fingerprint, digest, request_id, measurements)
        started = time.perf_counter()
        await asyncio.to_thread(_write_artifact, output_key, bundle)
        write_ms = round((time.perf_counter() - started) * 1000)
    except ParseHardTimeout as exc:
        return (
            {
                "code": "parse_hard_timeout",
                "detail": str(exc),
                "source_fingerprint": fingerprint,
            },
            422,
        )
    except ParseOOM as exc:
        return (
            {
                "code": "parse_oom",
                "detail": str(exc),
                "source_fingerprint": fingerprint,
            },
            422,
        )
    except ParseTooManyScannedPages as exc:
        return (
            {
                "code": "parse_too_many_scanned_pages",
                "detail": str(exc),
                "source_fingerprint": fingerprint,
            },
            422,
        )
    except ParseTooManyPages as exc:
        return (
            {
                "code": "parse_too_many_pages",
                "detail": str(exc),
                "source_fingerprint": fingerprint,
            },
            422,
        )
    except OfficeFormatMismatch as exc:
        return (
            {
                "code": "parse_format_mismatch",
                "detail": str(exc),
                "source_fingerprint": fingerprint,
            },
            422,
        )
    except SourceUnreadable as exc:
        return (
            {
                "code": "parse_unreadable",
                "detail": str(exc),
                "source_fingerprint": fingerprint,
            },
            422,
        )
    except ParserRuntimeFailure as exc:
        return (
            {
                "code": "parser_runtime_failed",
                "detail": str(exc),
                "source_fingerprint": fingerprint,
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
