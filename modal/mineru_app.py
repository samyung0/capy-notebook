"""Modal app: MineRU document parsing on a GPU, exposed as an HTTPS endpoint.

Why Modal: MineRU benefits a lot from a GPU but ingest is bursty, so a
scale-to-zero serverless GPU is far cheaper than an always-on pod. Model weights
are cached on a Modal Volume so warm starts skip the multi-GB download.

Cold-start strategy (in layers):
    1. Models load ONCE per container via ``@modal.enter`` using MineRU's
       in-process Python API (``mineru.cli.common.aio_do_parse`` + its
       ``ModelSingleton``). Warm requests skip model loading entirely — the old
       CLI-subprocess design re-imported torch and reloaded all weights on
       every single request.
    2. GPU memory snapshots (``enable_memory_snapshot=True`` +
       ``experimental_options={"enable_gpu_snapshot": True}``) checkpoint the
       process AFTER the models are loaded onto the GPU and warmed up, so cold
       boots restore straight into a ready-to-serve state instead of paying
       imports + weight loading + vLLM engine init (~minutes) on every boot.

Deploy:
    modal deploy modal/mineru_app.py
    # one-time (downloads weights onto the Volume):
    modal run modal/mineru_app.py::download_models

Then point the worker at the printed web URL:
    MODAL_PARSE_URL=https://<org>--evo-mineru-mineruparser-web.modal.run/file_parse
    MODAL_PARSE_TOKEN=<the token in the evo-mineru-token secret>

Contract (matches pipeline/pipeline/rag/modal_parser.py):
    POST /file_parse  (multipart: file=<bytes>, parse_method=auto, filename=...)
    Authorization: Bearer <MINERU_PARSE_TOKEN>
    -> {"content_list": [...], "images": {"<name>": "<base64>"}, "md": "..."}
"""

from __future__ import annotations

import base64
import glob
import json
import os
import subprocess
import tempfile
import hashlib
import io
import zipfile
from urllib.parse import urlparse

import modal

CACHE_DIR = "/cache"

# p_lang_list only affects the ``pipeline`` backend (it selects the per-language
# PP-OCR model). For ``vlm`` and ``hybrid`` backends MineRU ignores this value
# entirely — the MinerU2.5 VLM does native multilingual OCR — so with the hybrid
# backend below LANG is effectively a no-op kept only for the aio_do_parse
# contract. As of 3.4 "ch" also covers Traditional Chinese, Japanese and Latin
# (those standalone OCR options were merged into the ch model).
LANG = "ch"

# hybrid = MinerU2.5 VLM for layout/tables/formulas + native multilingual OCR
# text extraction (high accuracy, low hallucination).
# 3.x consolidated the backend names: the old engine-specific pins like
# "hybrid-vllm-async-engine" / "hybrid-auto-engine" no longer validate
# (mineru.cli.backend_options.normalize_backend would raise ValueError). The
# only public hybrid local backend is now "hybrid-engine"; routed through
# ``aio_do_parse`` it auto-selects the *async* vLLM engine (is_async=True),
# which is exactly what this event-loop-bound app needs. Only vllm is installed
# in the image, so "auto" resolves deterministically across redeploys — the GPU
# memory snapshot still captures the fully-initialized engine.
BACKEND = "hybrid-engine"
ARTIFACT_SCHEMA = "evo-mineru-bundle-v1"
PARSER_VERSION = "mineru-3.4-hybrid-v1"

# Cache MinerU/HF model weights across cold starts.
model_volume = modal.Volume.from_name("evo-mineru-models", create_if_missing=True)

# A Modal Secret named "evo-mineru-token" must define MINERU_PARSE_TOKEN.
token_secret = modal.Secret.from_name("evo-mineru-token")

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("libgl1", "libglib2.0-0", "libgomp1")
    # [all] (vs the old [core]) pulls in vllm, required by the hybrid backend's
    # local inference engine. Pinned to the 3.4.x line: 3.4 upgrades pipeline OCR
    # to PP-OCRv6 and the hybrid VLM to MinerU2.5-Pro with native multilingual
    # OCR. Capped below 3.5 so a redeploy can't silently pull a new major that
    # changes backend names or the aio_do_parse contract this app depends on.
    .pip_install(
        "mineru[all]>=3.4.4,<3.5",
        "fastapi[standard]",
        "python-multipart",
        "requests>=2.31",
    )
    .env(
        {
            "MINERU_MODEL_SOURCE": "huggingface",
            "HF_HOME": f"{CACHE_DIR}/huggingface",
            "MINERU_DEVICE_MODE": "cuda",
            # torch.compile with parallel inductor threads is a known cause of
            # GPU-memory-snapshot capture failures (see Modal snapshot docs).
            "TORCHINDUCTOR_COMPILE_THREADS": "1",
        }
    )
)

app = modal.App("evo-mineru")


@app.function(image=image, gpu="L4", volumes={CACHE_DIR: model_volume}, timeout=1800)
def download_models() -> None:
    """Warm the Volume with MineRU's model weights (run once after deploy)."""
    # `mineru-models-download` ships with the package; fall back to a tiny parse
    # that triggers the lazy download if the CLI name changes between versions.
    try:
        subprocess.run(
            ["mineru-models-download", "-s", "huggingface", "-m", "all"], check=True
        )
    except Exception:
        with tempfile.TemporaryDirectory() as d:
            sample = os.path.join(d, "warm.txt")
            with open(sample, "w") as f:
                f.write("warm up")
            subprocess.run(["mineru", "-p", sample, "-o", d, "-m", "auto"], check=False)
    model_volume.commit()


def _collect_outputs(out_dir: str) -> dict:
    """Collect MineRU's normalized outputs from its output directory tree."""
    matches = glob.glob(
        os.path.join(out_dir, "**", "*_content_list.json"), recursive=True
    )
    if not matches:
        raise RuntimeError("mineru produced no *_content_list.json")
    content_path = matches[0]
    base = os.path.dirname(content_path)

    with open(content_path, "r", encoding="utf-8") as f:
        content_list = json.load(f)

    md = ""
    md_matches = glob.glob(os.path.join(base, "*.md"))
    if md_matches:
        with open(md_matches[0], "r", encoding="utf-8") as f:
            md = f.read()

    images: dict[str, str] = {}
    for img in glob.glob(os.path.join(base, "images", "*")):
        try:
            with open(img, "rb") as f:
                images[os.path.basename(img)] = base64.b64encode(f.read()).decode()
        except Exception:
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


def _bundle_bytes(result: dict, source_fingerprint: str) -> bytes:
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
        "parser_version": PARSER_VERSION,
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


async def _parse_document(data: bytes, name: str, parse_method: str) -> dict:
    """Parse one document in-process (models come from the warm ModelSingleton).

    Must always run on the container's main event loop: vLLM's async engine
    binds its background tasks to the loop it was created on (during the
    warmup parse), and using it from another loop breaks it.
    """
    from pathlib import Path

    from mineru.cli.common import aio_do_parse, read_fn

    stem = Path(os.path.basename(name)).stem or "document"

    with tempfile.TemporaryDirectory() as work:
        # read_fn handles suffix sniffing and image->PDF conversion exactly
        # like the CLI did; office formats pass through as raw bytes.
        input_path = os.path.join(work, os.path.basename(name))
        with open(input_path, "wb") as f:
            f.write(data)
        pdf_bytes = read_fn(input_path)

        out_dir = os.path.join(work, "out")
        os.makedirs(out_dir, exist_ok=True)
        await aio_do_parse(
            output_dir=out_dir,
            pdf_file_names=[stem],
            pdf_bytes_list=[pdf_bytes],
            p_lang_list=[LANG],
            backend=BACKEND,
            parse_method=parse_method or "auto",
            # Skip artifacts nobody downloads: debug PDFs and raw model dumps.
            f_draw_layout_bbox=False,
            f_draw_span_bbox=False,
            f_dump_middle_json=False,
            f_dump_model_output=False,
            f_dump_orig_pdf=False,
        )
        return _collect_outputs(out_dir)


@app.cls(
    image=image,
    gpu="L4",
    volumes={CACHE_DIR: model_volume},
    secrets=[token_secret],
    timeout=900,
    scaledown_window=60,  # keep the container ~5 min after the last request
    enable_memory_snapshot=True,
    # GPU memory snapshots (alpha): the checkpoint also captures GPU state, so
    # the loaded VLM + warm vLLM engine restore directly instead of being
    # rebuilt after every cold boot.
    experimental_options={"enable_gpu_snapshot": True},
)
# No @modal.concurrent: one input per container. The VLM's KV cache plus the
# pipeline OCR models already budget most of the L4's 24 GB VRAM; a second
# in-flight document risks OOM for little gain, so overflow requests scale out
# to a fresh container (restored from snapshot) instead.
class MineruParser:
    @modal.enter(snap=True)
    async def load_models(self) -> None:
        # Everything here is captured in the GPU memory snapshot (with
        # enable_gpu_snapshot the GPU *is* attached during the snap phase, and
        # the weights Volume is readable). Parse a tiny synthetic page through
        # the real request path so the full hybrid stack — the MinerU2.5 VLM
        # inside its async vLLM engine plus the per-language OCR models —
        # lands in the process-wide ModelSingleton under exactly the keys
        # aio_do_parse will use; restored containers then serve their first
        # request with zero lazy loading. Async on purpose: Modal runs async
        # hooks on the same event loop that serves the ASGI app, so the vLLM
        # engine is created on the loop it will be used from.
        #
        # This method runs ONLY when Modal builds the snapshot (snap=True). If
        # you see the "[snapshot-build] warmup" logs below on an ordinary cold
        # boot, the snapshot is NOT being restored — that's the exact failure
        # this whole design guards against, so it's logged loudly on purpose.
        import io
        import time

        from PIL import Image as PILImage
        from PIL import ImageDraw

        t0 = time.perf_counter()
        print(
            "[snapshot-build] warmup: loading models + engine init (this is the slow path)",
            flush=True,
        )

        img = PILImage.new("RGB", (800, 600), "white")
        ImageDraw.Draw(img).text((100, 100), "warm up", fill="black")
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        await _parse_document(buf.getvalue(), "warmup.png", "auto")

        print(
            f"[snapshot-build] warmup done in {time.perf_counter() - t0:.1f}s",
            flush=True,
        )

    @modal.enter(snap=False)
    def after_restore(self) -> None:
        # Runs on EVERY container start AFTER a snapshot restore (snap=False).
        # If the GPU snapshot works, reaching this point means the VLM + vLLM
        # engine are already live in this process — the first /file_parse should
        # then be ~parse-time only, with no minutes-long engine init. The
        # timestamp gives a client-visible anchor for the cold-boot moment.
        import time

        self._restored_monotonic = time.perf_counter()
        print("[cold-boot] container ready (restored from snapshot)", flush=True)

    @modal.asgi_app()
    def web(self):
        # Parse the multipart form off the raw Starlette Request instead of via
        # FastAPI's ``UploadFile = File(...)`` parameter. FastAPI builds a Pydantic
        # TypeAdapter for ``UploadFile``, which blows up ("class not fully defined")
        # whenever the pinned fastapi / pydantic / starlette trio drifts out of sync
        # in the image — exactly the kind of transitive-version breakage a
        # long-lived serverless endpoint should not be fragile to. Reading the form
        # directly keeps this endpoint working regardless of those versions.
        import time

        from starlette.applications import Starlette
        from starlette.requests import Request
        from starlette.responses import JSONResponse
        from starlette.routing import Route

        def _authorized(request: Request) -> bool:
            expected = os.environ.get("MINERU_PARSE_TOKEN", "")
            if not expected:
                return True  # no token configured -> open (dev only)
            auth = request.headers.get("authorization", "")
            return auth.startswith("Bearer ") and auth[7:] == expected

        async def healthz(_request: Request) -> JSONResponse:
            # ``uptime_s`` = seconds this container has served since the snapshot
            # restore finished. A cold /healthz round-trip therefore measures
            # restore-to-ready overhead with no parse cost mixed in.
            restored = getattr(self, "_restored_monotonic", None)
            uptime = (
                None if restored is None else round(time.perf_counter() - restored, 3)
            )
            return JSONResponse({"ok": True, "uptime_s": uptime})

        async def file_parse(request: Request) -> JSONResponse:
            if not _authorized(request):
                return JSONResponse({"detail": "invalid token"}, status_code=401)

            if request.headers.get("content-type", "").startswith("application/json"):
                import requests

                body = await request.json()
                source_url = str(body.get("source_url") or "")
                output_url = str(body.get("output_url") or "")
                output_key = str(body.get("output_key") or "")
                name = str(body.get("filename") or "document")
                parse_method = str(body.get("parse_method") or "auto")
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
                try:
                    _validate_b2_url(source_url)
                    _validate_b2_url(output_url)
                    source = requests.get(source_url, timeout=(30, 300))
                    source.raise_for_status()
                    if len(source.content) > 100 << 20:
                        return JSONResponse({"detail": "source exceeds 100 MB"}, status_code=413)
                    t0 = time.perf_counter()
                    result = await _parse_document(source.content, name, parse_method)
                    parse_s = round(time.perf_counter() - t0, 3)
                    bundle = _bundle_bytes(result, fingerprint)
                    digest = hashlib.sha256(bundle).hexdigest()
                    uploaded = requests.put(
                        output_url,
                        data=bundle,
                        headers={"Content-Type": "application/zip"},
                        timeout=(30, 300),
                    )
                    uploaded.raise_for_status()
                except Exception as e:  # noqa: BLE001
                    return JSONResponse({"detail": f"remote parse failed: {e}"}, status_code=500)
                restored = getattr(self, "_restored_monotonic", None)
                return JSONResponse(
                    {
                        "artifact": {
                            "key": output_key,
                            "size": len(bundle),
                            "sha256": digest,
                            "etag": uploaded.headers.get("etag", "").strip('"'),
                            "parser_version": PARSER_VERSION,
                            "source_fingerprint": fingerprint,
                        },
                        "_server_parse_s": parse_s,
                        "_uptime_s": (
                            None
                            if restored is None
                            else round(time.perf_counter() - restored, 3)
                        ),
                    }
                )

            form = await request.form()
            upload = form.get("file")
            if upload is None:
                return JSONResponse({"detail": "missing file field"}, status_code=400)
            parse_method = str(form.get("parse_method") or "auto")
            name = str(
                form.get("filename") or getattr(upload, "filename", "") or "document"
            )
            data = await upload.read()

            t0 = time.perf_counter()
            try:
                result = await _parse_document(data, name, parse_method)
            except Exception as e:  # noqa: BLE001 — surface parse failures as 500 JSON
                return JSONResponse({"detail": f"parse failed: {e}"}, status_code=500)
            # Extra keys the RAG worker ignores; the snapshot test script reads
            # them to split server parse time from cold-boot + network latency.
            result["_server_parse_s"] = round(time.perf_counter() - t0, 3)
            restored = getattr(self, "_restored_monotonic", None)
            result["_uptime_s"] = (
                None if restored is None else round(time.perf_counter() - restored, 3)
            )
            return JSONResponse(result)

        return Starlette(
            routes=[
                Route("/healthz", healthz, methods=["GET"]),
                Route("/file_parse", file_parse, methods=["POST"]),
            ]
        )
