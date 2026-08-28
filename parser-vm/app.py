"""Persistent CPU parser for the Netcup ingest VM.

The HTTP and B2 artifact contract intentionally matches the previous Modal
service. The caller owns artifact identity and caching; this service downloads
one presigned source, parses it, and uploads one versioned zip.
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
import time
import zipfile
from collections.abc import AsyncIterator
from concurrent.futures import ProcessPoolExecutor
from contextlib import asynccontextmanager
from dataclasses import dataclass
from importlib.metadata import PackageNotFoundError, version
from typing import Any
from urllib.parse import urlparse

import requests
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from marker_worker import (
    ALL_RAPIDOCR,
    MARKER_ONLY,
    OFFICE_SUFFIXES,
    SELECTIVE_RAPIDOCR,
    init_worker,
    normalize_parse_method,
    parse_document,
    ping,
)

ARTIFACT_SCHEMA = "evo-mineru-bundle-v1"
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
MARKER_WORKERS = max(1, int(os.environ.get("EVO_MARKER_WORKERS", "6")))
DIGITAL_SLOTS = max(1, int(os.environ.get("EVO_DIGITAL_CONCURRENCY", "4")))
OCR_SLOTS = max(1, int(os.environ.get("EVO_OCR_CONCURRENCY", "2")))
HTTP_TIMEOUT = (
    max(1, int(os.environ.get("EVO_B2_CONNECT_TIMEOUT", "30"))),
    max(30, int(os.environ.get("EVO_B2_TRANSFER_TIMEOUT", "300"))),
)


@dataclass(frozen=True)
class Document:
    data: bytes
    name: str
    parse_method: str


def _warm_layout() -> dict[str, Any]:
    from marker.models import create_model_dict
    from PIL import Image

    models = create_model_dict()
    models["fast_layout_model"]([Image.new("RGB", (64, 64), "white")])
    return models


class ParserRuntime:
    def __init__(self) -> None:
        self.started_at = time.monotonic()
        self.layout_models: dict[str, Any] | None = None
        self.pool: ProcessPoolExecutor | None = None
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

    async def close(self) -> None:
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
        if self.pool is None:
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
            try:
                loop = asyncio.get_running_loop()
                result = await loop.run_in_executor(
                    self.pool,
                    parse_document,
                    document.data,
                    document.name,
                    method,
                )
            finally:
                async with self._state_lock:
                    self.active_jobs -= 1
        result["_parse_lane"] = "ocr" if heavy else "digital"
        result["_parse_method"] = method
        return result, queue_ms

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
            probes = await asyncio.to_thread(probe_pages, document.data)
        return job_needs_rapidocr(probes, method)


runtime = ParserRuntime()
_artifact_tasks: dict[str, asyncio.Task[tuple[dict[str, Any], int]]] = {}
_artifact_tasks_lock = asyncio.Lock()


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
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


def _validate_b2_url(value: str) -> None:
    parsed = urlparse(value)
    host = (parsed.hostname or "").lower()
    if (
        parsed.scheme != "https"
        or not host.endswith(".backblazeb2.com")
        or parsed.username
        or parsed.password
    ):
        raise ValueError("source/output URL must be a Backblaze B2 HTTPS URL")


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


def _bundle_bytes(result: dict[str, Any], fingerprint: str) -> bytes:
    content_list = result.get("content_list") or []
    images = result.get("images") or {}
    written = {os.path.basename(name) for name in images if os.path.basename(name)}
    for item in content_list:
        if isinstance(item, dict) and item.get("type") == "image":
            basename = os.path.basename(str(item.get("img_path") or ""))
            if basename in written:
                item["img_path"] = f"images/{basename}"
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(
            "manifest.json",
            json.dumps(
                {
                    "schema": ARTIFACT_SCHEMA,
                    "parser_version": PARSER_VERSION,
                    "source_fingerprint": fingerprint,
                },
                separators=(",", ":"),
            ),
        )
        archive.writestr(
            "content_list.json",
            json.dumps(content_list, ensure_ascii=False, separators=(",", ":")),
        )
        archive.writestr("document.md", str(result.get("md") or ""))
        for name, encoded in images.items():
            safe = os.path.basename(name)
            if safe:
                archive.writestr(f"images/{safe}", base64.b64decode(encoded))
    return output.getvalue()


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


@app.get("/healthz")
async def healthz() -> dict[str, Any]:
    return {
        "ok": runtime.pool is not None,
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
        "active_jobs": runtime.active_jobs,
        "queued_jobs": runtime.queued_jobs,
        **_process_tree_memory(),
    }


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
    except ParseFailure as exc:
        return JSONResponse(
            {"detail": f"parse failed: {exc}", **exc.measurements}, status_code=500
        )
    except Exception as exc:  # noqa: BLE001 - API returns a bounded diagnostic
        return JSONResponse({"detail": f"parse failed: {exc}"}, status_code=500)
    result.update(measurements)
    result["_server_parse_s"] = round(measurements["_server_parse_ms"] / 1000, 3)
    return JSONResponse(result)


async def _artifact_parse(body: dict[str, Any]) -> JSONResponse:
    source_url = str(body.get("source_url") or "")
    output_url = str(body.get("output_url") or "")
    output_key = str(body.get("output_key") or "")
    fingerprint = str(body.get("source_fingerprint") or "")
    if (
        body.get("artifact_schema") != ARTIFACT_SCHEMA
        or body.get("parser_version") != PARSER_VERSION
        or not source_url
        or not output_url
        or not output_key
        or not fingerprint
    ):
        return JSONResponse({"detail": "invalid artifact request"}, status_code=400)

    task = await _artifact_task(fingerprint, body)
    payload, status_code = await asyncio.shield(task)
    return JSONResponse(payload, status_code=status_code)


async def _artifact_task(
    fingerprint: str, body: dict[str, Any]
) -> asyncio.Task[tuple[dict[str, Any], int]]:
    """Share one parse/upload across client timeouts and their retries."""
    async with _artifact_tasks_lock:
        task = _artifact_tasks.get(fingerprint)
        if task is None:
            task = asyncio.create_task(_produce_artifact(dict(body)))
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


async def _produce_artifact(body: dict[str, Any]) -> tuple[dict[str, Any], int]:
    source_url = str(body["source_url"])
    output_url = str(body["output_url"])
    output_key = str(body["output_key"])
    name = str(body.get("filename") or "document")
    method = str(body.get("parse_method") or SELECTIVE_RAPIDOCR)
    fingerprint = str(body["source_fingerprint"])

    measurements: dict[str, Any] = {}
    download_ms = upload_ms = 0
    try:
        _validate_b2_url(source_url)
        _validate_b2_url(output_url)
        started = time.perf_counter()
        source = await asyncio.to_thread(requests.get, source_url, timeout=HTTP_TIMEOUT)
        source.raise_for_status()
        download_ms = round((time.perf_counter() - started) * 1000)
        if len(source.content) > MAX_SOURCE_BYTES:
            return {"detail": "source exceeds size limit"}, 413
        result, measurements = await _run(Document(source.content, name, method))
        bundle = await asyncio.to_thread(_bundle_bytes, result, fingerprint)
        digest = hashlib.sha256(bundle).hexdigest()
        started = time.perf_counter()
        uploaded = await asyncio.to_thread(
            requests.put,
            output_url,
            data=bundle,
            headers={"Content-Type": "application/zip"},
            timeout=HTTP_TIMEOUT,
        )
        uploaded.raise_for_status()
        upload_ms = round((time.perf_counter() - started) * 1000)
    except ParseFailure as exc:
        measurements = exc.measurements
        return {"detail": f"remote parse failed: {exc}", **measurements}, 500
    except Exception as exc:  # noqa: BLE001 - API returns a bounded diagnostic
        return {"detail": f"remote parse failed: {exc}", **measurements}, 500
    measurements["_download_ms"] = max(0, download_ms)
    measurements["_upload_ms"] = max(0, upload_ms)
    return (
        {
            "artifact": {
                "key": output_key,
                "size": len(bundle),
                "sha256": digest,
                "etag": uploaded.headers.get("etag", "").strip('"'),
                "parser_version": PARSER_VERSION,
                "source_fingerprint": fingerprint,
            },
            "_server_parse_s": round(measurements["_server_parse_ms"] / 1000, 3),
            **measurements,
        },
        200,
    )
