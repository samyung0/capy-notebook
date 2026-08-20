"""Modal app: two HTTPS parse routes, same bundle, different engines.

    Route      What runs                                      GPU   In-flight
    accurate   MinerU hybrid-engine (VLM OCR, async vLLM)     L4    2
    fast       Marker ``fast --disable_ocr`` + PP-OCRv6       L4    4 digital /
               on pages the scan probe flags                        2 OCR-heavy

Class names stay ``MineruAccurate`` / ``MineruFast`` so the existing
``*.modal.run`` URLs keep working.

Accurate is the old MinerU path on purpose: GPU memory snapshots restored
cleanly there, and cold boot was seconds, not nine minutes of a sidecar vLLM.
Two in-flight documents share one async vLLM engine.

Fast is Marker. ``fast --disable_ocr`` has no in-PDF page parallel. Marker's
CLI scales with spawned processes (PDFium is not thread-safe). This app does
the same, but RapidOCR is CPU and six OCR jobs on 8 vCPUs made lecture decks
slower than serial. So: 4 worker processes, 4 digital PDFs at once, only 2
when the probe flags any page for RapidOCR. B2 download/upload still overlap
on the loop.

Deploy:
    modal deploy modal/mineru_app.py
    modal run modal/mineru_app.py::download_models

Contract: ``pipeline/pipeline/parse/modal_parser.py``.
"""

from __future__ import annotations

import asyncio
import base64
import glob
import hashlib
import io
import json
import multiprocessing as mp
import os
import subprocess
import sys
import tempfile
import time
import uuid
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

CACHE_DIR = "/cache"
ARTIFACT_SCHEMA = "evo-mineru-bundle-v1"
MAX_SOURCE_BYTES = 100 << 20
PARSE_METHOD = "ocr"

# p_lang_list selects the per-language PP-OCR model and only affects MinerU's
# pipeline backend. Hybrid ignores it: MinerU2.5 VLM does native multilingual
# OCR. "ch" covers Chinese, Japanese and Latin — not Korean.
LANG = "ch"

ACCURATE_BACKEND = "hybrid-engine"
ACCURATE_EFFORT = "medium"
ACCURATE_PARSER_VERSION = "mineru-3.4-hybrid-v1"
ACCURATE_MAX_INPUTS = 2

FAST_PARSER_VERSION = "marker-2-hybrid-v1"
FAST_DIGITAL_SLOTS = 4
FAST_OCR_SLOTS = 2
FAST_MAX_INPUTS = FAST_DIGITAL_SLOTS

model_volume = modal.Volume.from_name("evo-mineru-models", create_if_missing=True)
token_secret = modal.Secret.from_name("evo-mineru-token")

_mineru_env = {
    "MINERU_MODEL_SOURCE": "huggingface",
    "HF_HOME": f"{CACHE_DIR}/huggingface",
    "MINERU_DEVICE_MODE": "cuda",
    "TORCHINDUCTOR_COMPILE_THREADS": "1",
    "TOKENIZERS_PARALLELISM": "false",
}

_marker_env = {
    "HF_HOME": f"{CACHE_DIR}/huggingface",
    "HF_HUB_CACHE": f"{CACHE_DIR}/huggingface",
    "MODEL_CACHE_DIR": f"{CACHE_DIR}/datalab",
    "TORCHINDUCTOR_COMPILE_THREADS": "1",
    "TOKENIZERS_PARALLELISM": "false",
    # 6 Marker workers on 8 vCPUs: keep each from grabbing every core.
    "OMP_NUM_THREADS": "2",
    "MKL_NUM_THREADS": "2",
    "SURYA_INFERENCE_AUTOSTART": "false",
    "PYTHONPATH": "/root",
}

_base_image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("libgl1", "libglib2.0-0", "libgomp1")
)


def _with_helpers(image: modal.Image) -> modal.Image:
    return image.add_local_file(
        str(_HERE / "marker_adapt.py"),
        remote_path="/root/marker_adapt.py",
        copy=True,
    ).add_local_file(
        str(_HERE / "scan_pages.py"),
        remote_path="/root/scan_pages.py",
        copy=True,
    ).add_local_file(
        str(_HERE / "marker_worker.py"),
        remote_path="/root/marker_worker.py",
        copy=True,
    )


# [all] pulls vLLM for MinerU's hybrid-engine. Pin 3.4: PP-OCRv6 + MinerU2.5-Pro.
accurate_image = _base_image.pip_install(
    "mineru[all]>=3.4.4,<3.5",
    "fastapi[standard]",
    "python-multipart",
    "requests>=2.31",
).env(_mineru_env)

# Fast never starts a VLM. onnxruntime-gpu last so it wins over a CPU wheel.
# CUDA EP still cannot load libcublasLt in this image; RapidOCR stays on CPU.
fast_image = _with_helpers(
    _base_image.pip_install(
        "marker-pdf>=2.0,<3",
        "rapidocr>=3.9",
        "fastapi[standard]",
        "python-multipart",
        "requests>=2.31",
        "pypdfium2",
        "pillow",
    )
    .run_commands("pip uninstall -y onnxruntime onnxruntime-gpu || true")
    .pip_install("onnxruntime-gpu==1.19.2")
    .env(_marker_env)
)

app = modal.App("evo-mineru")


@app.function(image=accurate_image, gpu="L4", volumes={CACHE_DIR: model_volume}, timeout=3600)
def download_models() -> None:
    """Warm the Volume with MinerU weights (run once after deploy)."""
    try:
        subprocess.run(
            ["mineru-models-download", "-s", "huggingface", "-m", "all"], check=True
        )
    except Exception:
        with tempfile.TemporaryDirectory() as d:
            sample = os.path.join(d, "warm.txt")
            with open(sample, "w") as f:
                f.write("warm up")
            subprocess.run(
                ["mineru", "-p", sample, "-o", d, "-m", PARSE_METHOD], check=False
            )
    model_volume.commit()


@app.function(
    image=fast_image,
    gpu="L4",
    volumes={CACHE_DIR: model_volume},
    timeout=3600,
    memory=16384,
)
def download_fast_models() -> None:
    """Pull RapidOCR ONNX + Marker fast-layout weights onto the Volume."""
    from marker.models import create_model_dict
    from rapidocr import RapidOCR

    create_model_dict()
    RapidOCR()
    model_volume.commit()


# ------------------------------------------------------------------ outputs


def _collect_outputs(out_dir: str, stem: str) -> dict:
    """Collect one document's MinerU files, addressed by the unique stem."""
    matches = glob.glob(
        os.path.join(out_dir, "**", f"{stem}_content_list.json"), recursive=True
    )
    if not matches:
        raise RuntimeError(f"mineru produced no content list for {stem}")
    content_path = matches[0]
    base = os.path.dirname(content_path)

    with open(content_path, encoding="utf-8") as f:
        content_list = json.load(f)

    md = ""
    md_matches = glob.glob(os.path.join(base, f"{stem}.md"))
    if md_matches:
        with open(md_matches[0], encoding="utf-8") as f:
            md = f.read()

    images: dict[str, str] = {}
    for img in glob.glob(os.path.join(base, "images", "*")):
        try:
            with open(img, "rb") as f:
                images[os.path.basename(img)] = base64.b64encode(f.read()).decode()
        except OSError:
            pass

    return {"content_list": content_list, "images": images, "md": md}


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


async def _parse_accurate(document: _Document) -> dict:
    """Parse one document on MinerU hybrid, on the container's event loop.

    Must always run on the container's main event loop: vLLM's async engine
    binds its background tasks to the loop it was created on (during warmup),
    and using it from another loop breaks it. Two in-flight docs share that
    engine — no serial lock.
    """
    from mineru.cli.common import aio_do_parse, read_fn

    with tempfile.TemporaryDirectory() as work:
        input_path = os.path.join(work, os.path.basename(document.name))
        with open(input_path, "wb") as fh:
            fh.write(document.data)
        pdf_bytes = read_fn(input_path)

        out_dir = os.path.join(work, "out")
        os.makedirs(out_dir, exist_ok=True)
        stem = f"doc_{uuid.uuid4().hex[:8]}"
        await aio_do_parse(
            output_dir=out_dir,
            pdf_file_names=[stem],
            pdf_bytes_list=[pdf_bytes],
            p_lang_list=[LANG],
            backend=ACCURATE_BACKEND,
            effort=ACCURATE_EFFORT,
            parse_method=document.parse_method or PARSE_METHOD,
            f_draw_layout_bbox=False,
            f_draw_span_bbox=False,
            f_dump_middle_json=False,
            f_dump_model_output=False,
            f_dump_orig_pdf=False,
        )
        return await asyncio.to_thread(_collect_outputs, out_dir, stem)


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
        return JSONResponse(
            {"ok": True, "uptime_s": _uptime(), "parser_version": parser_version}
        )

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


# --------------------------------------------------------------- accurate route


@app.cls(
    image=accurate_image,
    gpu="L4",
    volumes={CACHE_DIR: model_volume},
    secrets=[token_secret],
    timeout=1800,
    scaledown_window=300,
    enable_memory_snapshot=True,
    experimental_options={"enable_gpu_snapshot": True},
)
# Two in-flight documents share one async vLLM engine and one KV cache. The
# published VRAM measurements for MinerU2.5 put a single sequential parse near
# 13 GiB of a 24 GB card and light async batching at 14-18 GiB, so 2 fits an L4
# with headroom while 4+ would not. Overflow scales out to a fresh container
# (restored from snapshot) rather than risking OOM here.
@modal.concurrent(max_inputs=ACCURATE_MAX_INPUTS)
class MineruAccurate:
    @modal.enter(snap=True)
    async def load_models(self) -> None:
        # Captured in the GPU memory snapshot. Parse a tiny page through the
        # real request path so MinerU2.5 + async vLLM + OCR sidecars land in
        # ModelSingleton under the keys aio_do_parse will use.
        #
        # Async on purpose: Modal runs async hooks on the same event loop that
        # serves ASGI, so the vLLM engine is created on the loop it will be
        # used from. Warmup uses PARSE_METHOD (ocr) so the first live ocr
        # request is not a lazy-load that blows past the HTTP gateway.
        #
        # This method runs ONLY when Modal builds the snapshot. If you see the
        # "[snapshot-build] warmup" logs on an ordinary cold boot, the snapshot
        # is NOT being restored.
        t0 = time.perf_counter()
        print(
            "[snapshot-build] warmup: loading models + engine init (this is the slow path)",
            flush=True,
        )
        await _parse_accurate(_Document(_warmup_png(), "warmup.png", PARSE_METHOD))
        print(
            f"[snapshot-build] warmup done in {time.perf_counter() - t0:.1f}s",
            flush=True,
        )

    @modal.enter(snap=False)
    def after_restore(self) -> None:
        self._restored_monotonic = time.perf_counter()
        print(
            "[cold-boot] accurate container ready (restored from snapshot)",
            flush=True,
        )

    async def parse(self, document: _Document) -> dict:
        return await _parse_accurate(document)

    @modal.asgi_app()
    def web(self):
        return _build_asgi(self, ACCURATE_PARSER_VERSION)


# ------------------------------------------------------------------ fast route


@app.cls(
    image=fast_image,
    gpu="L4",
    volumes={CACHE_DIR: model_volume},
    secrets=[token_secret],
    timeout=1800,
    scaledown_window=300,
    memory=32768,
    cpu=8.0,
    enable_memory_snapshot=False,
)
# Four spawned Marker processes. Digital PDFs may use all four. RapidOCR is
# CPU, so jobs the probe flags for OCR share a second lane of two. GPU
# snapshots stay off: restore died with SIGSEGV (exit 139) once CUDA
# RapidOCR/ort touched this image.
@modal.concurrent(max_inputs=FAST_MAX_INPUTS)
class MineruFast:
    @modal.enter()
    async def load_models(self) -> None:
        t0 = time.perf_counter()
        print("[cold-boot] fast: marker worker processes + rapidocr", flush=True)
        from PIL import Image as PILImage
        from marker.models import create_model_dict
        from marker_worker import init_worker, parse_document, ping

        def _start_layout_server() -> None:
            models = create_model_dict()
            models["fast_layout_model"]([PILImage.new("RGB", (64, 64), "white")])

        await asyncio.to_thread(_start_layout_server)
        self._parser = _ParallelFastParser(
            init_worker, parse_document, FAST_MAX_INPUTS
        )
        self._digital_slots = asyncio.Semaphore(FAST_DIGITAL_SLOTS)
        self._ocr_slots = asyncio.Semaphore(FAST_OCR_SLOTS)
        self._probe_lock = asyncio.Lock()
        await self._parser.warm(ping, FAST_MAX_INPUTS)
        await self._parser.submit(
            _Document(_warmup_png(), "warmup.png", PARSE_METHOD)
        )
        self._restored_monotonic = time.perf_counter()
        print(
            f"[cold-boot] fast ready in {time.perf_counter() - t0:.1f}s",
            flush=True,
        )

    async def parse(self, document: _Document) -> dict:
        heavy = await self._ocr_heavy(document)
        lane = self._ocr_slots if heavy else self._digital_slots
        async with lane:
            result = await self._parser.submit(document)
        result["_fast_lane"] = "ocr" if heavy else "digital"
        return result

    async def _ocr_heavy(self, document: _Document) -> bool:
        from scan_pages import job_needs_rapidocr, probe_pages

        # PDFium is not thread-safe. One probe at a time in this process.
        async with self._probe_lock:
            probes = await asyncio.to_thread(probe_pages, document.data)
        return job_needs_rapidocr(probes, document.parse_method)

    @modal.asgi_app()
    def web(self):
        return _build_asgi(self, FAST_PARSER_VERSION)


def _warmup_png() -> bytes:
    from PIL import Image as PILImage
    from PIL import ImageDraw

    img = PILImage.new("RGB", (800, 600), "white")
    ImageDraw.Draw(img).text((100, 100), "Metabolic Pathways warmup", fill="black")
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()
