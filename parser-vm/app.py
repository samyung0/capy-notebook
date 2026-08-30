"""Persistent CPU parser for the Netcup ingest VM.

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
import multiprocessing as mp
import os
import re
import secrets
import time
import zipfile
from collections.abc import AsyncIterator
from concurrent.futures import ProcessPoolExecutor
from concurrent.futures.process import BrokenProcessPool
from contextlib import asynccontextmanager
from dataclasses import dataclass
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path, PurePosixPath
from typing import Any, NoReturn

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from marker_worker import (
    ALL_RAPIDOCR,
    MARKER_ONLY,
    OFFICE_PREVIEW_MAX_BYTES,
    OFFICE_SUFFIXES,
    SELECTIVE_RAPIDOCR,
    init_worker,
    normalize_parse_method,
    parse_document,
    ping,
)
from starlette.background import BackgroundTask

ARTIFACT_SCHEMA = "evo-parser-bundle-v3"
PARSER_IMPLEMENTATION = "marker-2-vm-hybrid-v3"
RELEASE_SHA = os.environ.get("RELEASE_SHA", "dev").strip() or "dev"
if os.environ.get("APP_ENV") == "production" and not re.fullmatch(
    r"[0-9a-f]{40}", RELEASE_SHA
):
    raise RuntimeError("production parser RELEASE_SHA must be a full lowercase Git SHA")
PARSER_VERSION = f"{PARSER_IMPLEMENTATION}+{RELEASE_SHA}"


def _dependency_versions() -> dict[str, str]:
    packages = (
        "marker-pdf",
        "rapidocr",
        "onnxruntime",
        "pypdfium2",
        "pillow",
        "torch",
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
MARKER_WORKERS = max(1, int(os.environ.get("EVO_MARKER_WORKERS", "6")))
DIGITAL_SLOTS = max(1, int(os.environ.get("EVO_DIGITAL_CONCURRENCY", "4")))
OCR_SLOTS = max(1, int(os.environ.get("EVO_OCR_CONCURRENCY", "2")))
PARSE_HARD_TIMEOUT_S = max(1, int(os.environ.get("EVO_PARSE_HARD_TIMEOUT", "2300")))
RESTART_BACKSTOP_S = 1.0
SHARED_DIR = Path(
    os.environ.get("EVO_PARSE_SHARED_DIR", "/tmp/evo-parse-spool")
).resolve()
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


class ParseHardTimeout(RuntimeError):
    pass


def _warm_layout() -> dict[str, Any]:
    from marker.models import create_model_dict
    from PIL import Image

    models = create_model_dict()
    models["fast_layout_model"]([Image.new("RGB", (64, 64), "white")])
    return models


def _terminate_process() -> NoReturn:
    """Let the container supervisor replace a process with a poisoned pool."""
    os._exit(1)


def _schedule_restart_backstop() -> None:
    """Restart even if the client disconnects before response delivery."""
    asyncio.get_running_loop().call_later(RESTART_BACKSTOP_S, _terminate_process)


class ParserRuntime:
    def __init__(self) -> None:
        self.started_at = time.monotonic()
        self.layout_models: dict[str, Any] | None = None
        self.pool: ProcessPoolExecutor | None = None
        self.state = "starting"
        self.digital_slots = asyncio.Semaphore(min(DIGITAL_SLOTS, MARKER_WORKERS))
        self.ocr_slots = asyncio.Semaphore(min(OCR_SLOTS, MARKER_WORKERS))
        self.probe_lock = asyncio.Lock()
        self.active_jobs = 0
        self.queued_jobs = 0
        self._state_lock = asyncio.Lock()

    async def start(self) -> None:
        self.layout_models = await asyncio.to_thread(_warm_layout)
        context = mp.get_context("spawn")
        self.pool = ProcessPoolExecutor(
            max_workers=MARKER_WORKERS,
            mp_context=context,
            initializer=init_worker,
        )
        loop = asyncio.get_running_loop()
        await asyncio.gather(
            *[loop.run_in_executor(self.pool, ping) for _ in range(MARKER_WORKERS)]
        )
        async with self._state_lock:
            self.state = "ready"

    async def close(self) -> None:
        async with self._state_lock:
            self.state = "stopping"
        if self.pool is not None:
            await asyncio.to_thread(self.pool.shutdown, True, True)
            self.pool = None
        if self.layout_models is not None:
            try:
                from marker.models import shutdown_models

                await asyncio.to_thread(shutdown_models, self.layout_models)
            except Exception as exc:  # noqa: BLE001 - shutdown is best effort
                print(f"parser model shutdown skipped: {exc}", flush=True)
            self.layout_models = None

    async def parse(self, document: Document) -> tuple[dict[str, Any], int]:
        if self.state != "ready" or self.pool is None:
            raise RuntimeError("parser is not ready")
        method = normalize_parse_method(document.parse_method)
        heavy = await self._is_ocr_heavy(document, method)
        lane = self.ocr_slots if heavy else self.digital_slots
        queued_at = time.perf_counter()
        async with self._state_lock:
            self.queued_jobs += 1
        async with lane:
            queue_ms = max(0, round((time.perf_counter() - queued_at) * 1000))
            async with self._state_lock:
                self.queued_jobs -= 1
                self.active_jobs += 1
                pool = self.pool
                ready = self.state == "ready" and pool is not None
            try:
                if not ready or pool is None:
                    raise RuntimeError("parser is not ready")
                loop = asyncio.get_running_loop()
                try:
                    async with asyncio.timeout(PARSE_HARD_TIMEOUT_S):
                        result = await loop.run_in_executor(
                            pool,
                            parse_document,
                            document.data,
                            document.name,
                            method,
                        )
                except TimeoutError as exc:
                    async with self._state_lock:
                        self.state = "failed"
                    raise ParseHardTimeout(
                        f"parse exceeded {PARSE_HARD_TIMEOUT_S} seconds"
                    ) from exc
                except BrokenProcessPool as exc:
                    await self._fail_broken_pool(exc)
                    raise RuntimeError("parser process pool failed") from exc
            finally:
                async with self._state_lock:
                    self.active_jobs -= 1
        result["_parse_lane"] = "ocr" if heavy else "digital"
        result["_parse_method"] = method
        return result, queue_ms

    async def _fail_broken_pool(self, exc: BrokenProcessPool) -> None:
        async with self._state_lock:
            if self.state == "failed":
                return
            self.state = "failed"
        print(f"parser process pool failed: {exc}", flush=True)
        asyncio.get_running_loop().call_soon(_terminate_process)

    async def _is_ocr_heavy(self, document: Document, method: str) -> bool:
        if method == ALL_RAPIDOCR:
            return True
        if method == MARKER_ONLY:
            return False
        suffix = os.path.splitext(document.name)[1].lower()
        if suffix in OFFICE_SUFFIXES:
            return True
        from scan_pages import job_needs_rapidocr, probe_pages

        async with self.probe_lock:
            try:
                # Waiting for the probe lane is queue time. Once admitted, the
                # same hard deadline applies: pdfium can hang on malformed
                # input just as Marker can.
                async with asyncio.timeout(PARSE_HARD_TIMEOUT_S):
                    probes = await asyncio.to_thread(probe_pages, document.data)
            except TimeoutError as exc:
                async with self._state_lock:
                    self.state = "failed"
                raise ParseHardTimeout(
                    f"parse probe exceeded {PARSE_HARD_TIMEOUT_S} seconds"
                ) from exc
        return job_needs_rapidocr(probes, method)


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
        or value.get("reason") != "parse_hard_timeout"
    ):
        return None
    return value


def _write_quarantine(fingerprint: str, detail: str) -> None:
    path = _shared_path(_quarantine_key(fingerprint), "quarantine")
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(
        {
            "reason": "parse_hard_timeout",
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
    ready = runtime.state == "ready" and runtime.pool is not None
    body = {
        "ok": ready,
        "state": runtime.state,
        "uptime_s": round(time.monotonic() - runtime.started_at, 3),
        "parser_version": PARSER_VERSION,
        "parser_implementation": PARSER_IMPLEMENTATION,
        "release_sha": RELEASE_SHA,
        "dependencies": PARSER_DEPENDENCIES,
        "supported_methods": [MARKER_ONLY, SELECTIVE_RAPIDOCR, ALL_RAPIDOCR],
        "supported_formats": [
            "pdf",
            "png",
            "jpg",
            "jpeg",
            "webp",
            "tif",
            "tiff",
            "bmp",
            "gif",
            "jp2",
            "doc",
            "docx",
            "ppt",
            "pptx",
            "xls",
            "xlsx",
        ],
        "marker_workers": MARKER_WORKERS,
        "digital_slots": min(DIGITAL_SLOTS, MARKER_WORKERS),
        "ocr_slots": min(OCR_SLOTS, MARKER_WORKERS),
        "parse_hard_timeout_s": PARSE_HARD_TIMEOUT_S,
        "active_jobs": runtime.active_jobs,
        "queued_jobs": runtime.queued_jobs,
        **_process_tree_memory(),
    }
    return JSONResponse(body, status_code=200 if ready else 503)


@app.post("/file_parse")
async def file_parse(request: Request) -> JSONResponse:
    if not _authorized(request):
        return JSONResponse({"detail": "invalid token"}, status_code=401)
    if request.headers.get("content-type", "").startswith("application/json"):
        return await _artifact_parse(await request.json())

    form = await request.form()
    upload = form.get("file")
    if upload is None or not hasattr(upload, "read"):
        return JSONResponse({"detail": "missing file field"}, status_code=400)
    data = await upload.read(MAX_SOURCE_BYTES + 1)
    if len(data) > MAX_SOURCE_BYTES:
        return JSONResponse({"detail": "source exceeds size limit"}, status_code=413)
    name = str(form.get("filename") or getattr(upload, "filename", None) or "document")
    method = str(form.get("parse_method") or SELECTIVE_RAPIDOCR)
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
        if quarantined := await asyncio.to_thread(_quarantine, fingerprint):
            return JSONResponse(
                {
                    "code": "parse_hard_timeout",
                    "detail": str(
                        quarantined.get("detail") or "parse exceeded its hard deadline"
                    ),
                    "source_fingerprint": fingerprint,
                },
                status_code=422,
            )
        if cached := await asyncio.to_thread(
            _artifact_descriptor, output_key, fingerprint
        ):
            receipt = await asyncio.to_thread(
                _artifact_receipt, output_key, fingerprint, request_id
            )
            return JSONResponse({"artifact": cached, **receipt}, status_code=200)
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
    method = str(body.get("parse_method") or SELECTIVE_RAPIDOCR)
    fingerprint = str(body["source_fingerprint"])
    request_id = str(body["request_id"])

    measurements: dict[str, Any] = {}
    write_ms = 0
    try:
        result, measurements = await _run(Document(source, name, method))
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
        await asyncio.to_thread(_write_quarantine, fingerprint, str(exc))
        return (
            {
                "code": "parse_hard_timeout",
                "detail": str(exc),
                "source_fingerprint": fingerprint,
                "_restart_parser": True,
            },
            422,
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
