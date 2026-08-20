"""Shared Modal parse runtime: image, HTTP contract, Marker engine, shutdown.

    modal deploy modal/mineru_fast.py
    modal run modal/mineru_fast.py::download_fast_models

Contract: ``pipeline/pipeline/parse/modal_parser.py``.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import io
import json
import multiprocessing as mp
import os
import signal
import sys
import time
import zipfile
from concurrent.futures import ProcessPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import modal

_HERE = Path(__file__).resolve().parent
for _path in (_HERE, Path("/root")):
    if _path.is_dir() and str(_path) not in sys.path:
        sys.path.insert(0, str(_path))

from pool_shutdown import close_process_pool

CACHE_DIR = "/cache"
ARTIFACT_SCHEMA = "evo-mineru-bundle-v1"
MAX_SOURCE_BYTES = 100 << 20
PARSE_METHOD = "ocr"

FAST_PARSER_VERSION = "marker-2-hybrid-v1"
# CPU only. 8-wide digital only added tail latency; 6-wide was the knee.
# RapidOCR stays at 2 — more OCR workers on the same cores was slower.
FAST_DIGITAL_SLOTS = 6
FAST_OCR_SLOTS = 2
FAST_MAX_INPUTS = FAST_DIGITAL_SLOTS
FAST_MAX_CONTAINERS = 12
FAST_SCALEDOWN_S = 30
FAST_APP_NAME = "evo-mineru-fast"
# Digital-only cgroup was ~8 GiB; two lazy RapidOCR engines pushed ~10 GiB.
# 12 GiB leaves a little room. 8 GiB would clip the OCR peak.
FAST_MEMORY_MB = 12288
FAST_CPU = 6.0

model_volume = modal.Volume.from_name("evo-mineru-models", create_if_missing=True)
token_secret = modal.Secret.from_name("evo-mineru-token")

_marker_env = {
    "HF_HOME": f"{CACHE_DIR}/huggingface",
    "HF_HUB_CACHE": f"{CACHE_DIR}/huggingface",
    "MODEL_CACHE_DIR": f"{CACHE_DIR}/datalab",
    "TORCHINDUCTOR_COMPILE_THREADS": "1",
    "TOKENIZERS_PARALLELISM": "false",
    # 6 Marker workers on 6 cores: keep each from grabbing every core.
    "OMP_NUM_THREADS": "2",
    "MKL_NUM_THREADS": "2",
    "SURYA_INFERENCE_AUTOSTART": "false",
    "CUDA_VISIBLE_DEVICES": "",
    "PYTHONPATH": "/root",
}

_base_image = modal.Image.debian_slim(python_version="3.11").apt_install(
    "libgl1", "libglib2.0-0", "libgomp1"
)


def _add_local(image: modal.Image, name: str) -> modal.Image:
    return image.add_local_file(
        str(_HERE / name),
        remote_path=f"/root/{name}",
        copy=True,
    )


def _with_parse_common(image: modal.Image) -> modal.Image:
    image = _add_local(image, "parse_common.py")
    return _add_local(image, "pool_shutdown.py")


def _with_fast_helpers(image: modal.Image) -> modal.Image:
    image = _with_parse_common(image)
    for name in ("marker_adapt.py", "scan_pages.py", "marker_worker.py"):
        image = _add_local(image, name)
    return image


# Marker may pull a CUDA torch wheel. CUDA_VISIBLE_DEVICES="" keeps layout
# and RapidOCR on CPU. No GPU is requested on the function.
fast_image = _with_fast_helpers(
    _base_image.pip_install(
        "marker-pdf>=2.0,<3",
        "rapidocr>=3.9",
        "fastapi[standard]",
        "python-multipart",
        "requests>=2.31",
        "pypdfium2",
        "pillow",
        "onnxruntime>=1.19,<2",
    ).env(_marker_env)
)


def run_download_fast_models() -> None:
    """Pull RapidOCR ONNX + Marker fast-layout weights onto the Volume."""
    from marker.models import create_model_dict
    from rapidocr import RapidOCR

    create_model_dict()
    RapidOCR()
    model_volume.commit()


# ------------------------------------------------------------------ outputs


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


def _bundle_bytes(result: dict, source_fingerprint: str, parser_version: str) -> bytes:
    content_list = result.get("content_list") or []
    images = result.get("images") or {}
    written: set[str] = set()
    for name in images:
        safe = os.path.basename(name)
        if safe:
            written.add(safe)
    for item in content_list:
        if isinstance(item, dict) and item.get("type") == "image":
            basename = os.path.basename(str(item.get("img_path") or ""))
            if basename in written:
                item["img_path"] = f"images/{basename}"

    manifest = {
        "schema": ARTIFACT_SCHEMA,
        "parser_version": parser_version,
        "source_fingerprint": source_fingerprint,
    }
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("manifest.json", json.dumps(manifest, separators=(",", ":")))
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


# ------------------------------------------------------------------- parsing


@dataclass
class _Document:
    data: bytes
    name: str
    parse_method: str


class _ParallelFastParser:
    """One Marker parse per spawned process. PDFium cannot share a process."""

    def __init__(self, init_fn: Any, parse_fn: Any, workers: int) -> None:
        self._parse_fn = parse_fn
        ctx = mp.get_context("spawn")
        self._pool = ProcessPoolExecutor(
            max_workers=workers,
            mp_context=ctx,
            initializer=init_fn,
        )
        self._slots = asyncio.Semaphore(workers)

    async def warm(self, ping_fn: Any, n: int) -> None:
        loop = asyncio.get_running_loop()
        await asyncio.gather(
            *[loop.run_in_executor(self._pool, ping_fn) for _ in range(n)]
        )

    async def submit(self, document: _Document) -> dict:
        loop = asyncio.get_running_loop()
        async with self._slots:
            return await loop.run_in_executor(
                self._pool,
                self._parse_fn,
                document.data,
                document.name,
                document.parse_method,
            )

    def close(self) -> None:
        t0 = time.perf_counter()
        status = close_process_pool(self._pool)
        print(
            f"[exit] pool closed in {time.perf_counter() - t0:.2f}s ({status})",
            flush=True,
        )


def _warm_fast_layout() -> dict:
    """Load Marker layout weights and ping the rf-detr server in this process."""
    from marker.models import create_model_dict
    from PIL import Image as PILImage

    models = create_model_dict()
    models["fast_layout_model"]([PILImage.new("RGB", (64, 64), "white")])
    return models


def rss_tree_mb() -> dict[str, float | int]:
    """Parent + descendant memory.

    RSS sums over-count shared model mappings (8 workers × the same
    weights). PSS splits those pages and is closer to what Modal bills
    as 'used'.
    """

    def _status_map(pid: int) -> dict[str, str]:
        try:
            with open(f"/proc/{pid}/status", encoding="ascii") as fh:
                return {
                    line.split(":", 1)[0]: line.split(":", 1)[1].strip()
                    for line in fh
                    if ":" in line
                }
        except OSError:
            return {}

    def _kb_field(raw: str) -> float:
        try:
            return int(raw.split()[0]) / 1024
        except (TypeError, ValueError, IndexError):
            return 0.0

    def _smaps(pid: int) -> tuple[float, float]:
        try:
            with open(f"/proc/{pid}/smaps_rollup", encoding="ascii") as fh:
                rss = pss = 0.0
                for line in fh:
                    if line.startswith("Rss:"):
                        rss = _kb_field(line.split(":", 1)[1])
                    elif line.startswith("Pss:"):
                        pss = _kb_field(line.split(":", 1)[1])
                return rss, pss
        except OSError:
            raw = _status_map(pid).get("VmRSS", "0 kB")
            return _kb_field(raw), 0.0

    def _children(pid: int) -> list[int]:
        kids: list[int] = []
        try:
            entries = os.listdir("/proc")
        except OSError:
            return kids
        for entry in entries:
            if not entry.isdigit():
                continue
            other = int(entry)
            status = _status_map(other)
            try:
                if int(status.get("PPid", "0")) == pid:
                    kids.append(other)
            except ValueError:
                continue
        return kids

    root = os.getpid()
    seen = {root}
    stack = [root]
    while stack:
        pid = stack.pop()
        for child in _children(pid):
            if child not in seen:
                seen.add(child)
                stack.append(child)
    parent_rss = parent_pss = 0.0
    kids_rss = kids_pss = 0.0
    for pid in seen:
        rss, pss = _smaps(pid)
        if pid == root:
            parent_rss, parent_pss = rss, pss
        else:
            kids_rss += rss
            kids_pss += pss
    cgroup = None
    for path in (
        "/sys/fs/cgroup/memory.current",
        "/sys/fs/cgroup/memory/memory.usage_in_bytes",
    ):
        try:
            with open(path, encoding="ascii") as fh:
                cgroup = round(int(fh.read().strip()) / (1024 * 1024), 1)
                break
        except (OSError, ValueError):
            continue
    out: dict[str, float | int] = {
        "parent_rss_mb": round(parent_rss, 1),
        "children_rss_mb": round(kids_rss, 1),
        "total_rss_mb": round(parent_rss + kids_rss, 1),
        "parent_pss_mb": round(parent_pss, 1),
        "children_pss_mb": round(kids_pss, 1),
        "total_pss_mb": round(parent_pss + kids_pss, 1),
        "n_procs": len(seen),
    }
    if cgroup is not None:
        out["cgroup_mb"] = cgroup
    return out


def _warmup_png() -> bytes:
    from PIL import Image as PILImage
    from PIL import ImageDraw

    img = PILImage.new("RGB", (800, 600), "white")
    ImageDraw.Draw(img).text((100, 100), "Metabolic Pathways warmup", fill="black")
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


# ----------------------------------------------------------------- shutdown


def _kill_matching_procs(needles: tuple[str, ...]) -> None:
    """SIGTERM helper processes that would otherwise outlive graceful exit.

    Surya's fast-layout server is spawned with start_new_session=True and
    keep_alive, so atexit will not reap it.
    """
    my_pid = os.getpid()
    try:
        entries = os.listdir("/proc")
    except OSError:
        return
    for entry in entries:
        if not entry.isdigit():
            continue
        pid = int(entry)
        if pid == my_pid:
            continue
        try:
            with open(f"/proc/{pid}/cmdline", "rb") as fh:
                cmd = fh.read().replace(b"\x00", b" ").decode("utf-8", "replace")
        except OSError:
            continue
        if not any(needle in cmd for needle in needles):
            continue
        try:
            os.kill(pid, signal.SIGTERM)
            print(f"[exit] killed pid={pid} {cmd[:80]!r}", flush=True)
        except OSError:
            pass


def shutdown_fast(
    parser: _ParallelFastParser | None,
    layout_models: dict | None,
) -> None:
    """Stop Marker workers + layout server when the 30s idle window ends."""
    print("[exit] fast: stop workers + layout server", flush=True)
    if parser is not None:
        try:
            parser.close()
        except Exception as e:  # noqa: BLE001
            print(f"[exit] fast pool stop skipped: {e}", flush=True)
    for child in mp.active_children():
        try:
            child.terminate()
        except OSError:
            pass
    if layout_models is not None:
        try:
            from marker.models import shutdown_models

            shutdown_models(layout_models)
        except Exception as e:  # noqa: BLE001
            print(f"[exit] fast marker shutdown skipped: {e}", flush=True)
    _kill_matching_procs(
        (
            "surya.fast_layout.server",
            "surya.ocr_error.server",
            "surya.detection.server",
        )
    )


# ----------------------------------------------------------------- web layer


def _build_asgi(service: Any, parser_version: str):
    import requests
    from starlette.applications import Starlette
    from starlette.requests import Request
    from starlette.responses import JSONResponse
    from starlette.routing import Route

    def _authorized(request: Request) -> bool:
        expected = os.environ.get("MINERU_PARSE_TOKEN", "")
        if not expected:
            return True
        auth = request.headers.get("authorization", "")
        return auth.startswith("Bearer ") and auth[7:] == expected

    def _uptime() -> float | None:
        restored = getattr(service, "_restored_monotonic", None)
        return None if restored is None else round(time.perf_counter() - restored, 3)

    async def healthz(_request: Request) -> JSONResponse:
        payload: dict[str, Any] = {
            "ok": True,
            "uptime_s": _uptime(),
            "parser_version": parser_version,
        }
        try:
            payload.update(rss_tree_mb())
        except Exception as e:  # noqa: BLE001
            payload["rss_error"] = str(e)
        device = getattr(service, "_device", None)
        if device:
            payload["device"] = device
        return JSONResponse(payload)

    async def _artifact_parse(request: Request, body: dict) -> JSONResponse:
        source_url = str(body.get("source_url") or "")
        output_url = str(body.get("output_url") or "")
        output_key = str(body.get("output_key") or "")
        name = str(body.get("filename") or "document")
        parse_method = str(body.get("parse_method") or PARSE_METHOD)
        fingerprint = str(body.get("source_fingerprint") or "")
        if (
            body.get("artifact_schema") != ARTIFACT_SCHEMA
            or body.get("parser_version") != parser_version
            or not source_url
            or not output_url
            or not output_key
            or not fingerprint
        ):
            return JSONResponse({"detail": "invalid artifact request"}, status_code=400)
        try:
            _validate_b2_url(source_url)
            _validate_b2_url(output_url)
            source = await asyncio.to_thread(
                lambda: requests.get(source_url, timeout=(30, 300))
            )
            source.raise_for_status()
            if len(source.content) > MAX_SOURCE_BYTES:
                return JSONResponse(
                    {"detail": "source exceeds 100 MB"}, status_code=413
                )

            t0 = time.perf_counter()
            result = await service.parse(_Document(source.content, name, parse_method))
            parse_s = round(time.perf_counter() - t0, 3)

            bundle = await asyncio.to_thread(
                _bundle_bytes, result, fingerprint, parser_version
            )
            digest = hashlib.sha256(bundle).hexdigest()
            uploaded = await asyncio.to_thread(
                lambda: requests.put(
                    output_url,
                    data=bundle,
                    headers={"Content-Type": "application/zip"},
                    timeout=(30, 300),
                )
            )
            uploaded.raise_for_status()
        except Exception as e:  # noqa: BLE001
            return JSONResponse(
                {"detail": f"remote parse failed: {e}"}, status_code=500
            )
        return JSONResponse(
            {
                "artifact": {
                    "key": output_key,
                    "size": len(bundle),
                    "sha256": digest,
                    "etag": uploaded.headers.get("etag", "").strip('"'),
                    "parser_version": parser_version,
                    "source_fingerprint": fingerprint,
                },
                "_server_parse_s": parse_s,
                "_uptime_s": _uptime(),
            }
        )

    async def file_parse(request: Request) -> JSONResponse:
        if not _authorized(request):
            return JSONResponse({"detail": "invalid token"}, status_code=401)

        if request.headers.get("content-type", "").startswith("application/json"):
            return await _artifact_parse(request, await request.json())

        form = await request.form()
        upload = form.get("file")
        if upload is None:
            return JSONResponse({"detail": "missing file field"}, status_code=400)
        parse_method = str(form.get("parse_method") or PARSE_METHOD)
        name = str(
            form.get("filename") or getattr(upload, "filename", "") or "document"
        )
        data = await upload.read()

        t0 = time.perf_counter()
        try:
            result = await service.parse(_Document(data, name, parse_method))
        except Exception as e:  # noqa: BLE001
            return JSONResponse({"detail": f"parse failed: {e}"}, status_code=500)
        result["_server_parse_s"] = round(time.perf_counter() - t0, 3)
        result["_uptime_s"] = _uptime()
        return JSONResponse(result)

    return Starlette(
        routes=[
            Route("/healthz", healthz, methods=["GET"]),
            Route("/file_parse", file_parse, methods=["POST"]),
        ]
    )
