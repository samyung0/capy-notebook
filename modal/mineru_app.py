"""Modal app: MineRU document parsing on GPUs, exposed as two HTTPS endpoints.

Both parse routes run here. The MinerU cloud "Agent lightweight" API used to
serve the cheap route, but it polls, returns markdown only, and carries neither
bounding boxes nor extracted images — so the cheap route could never produce
page-accurate citations or captionable figures. Running both routes on Modal
means one output shape (``content_list.json`` + images) for every parse.

    Route      Backend          GPU   In-flight/container   Produces
    accurate   hybrid-engine    L4    2                     content_list + images
    fast       pipeline         L4    6                     content_list + images

Why Modal: MineRU benefits a lot from a GPU but ingest is bursty, so a
scale-to-zero serverless GPU is far cheaper than an always-on pod. Model weights
are cached on a Modal Volume so warm starts skip the multi-GB download.

Concurrency is deliberately different per route because MinerU's two backends
have opposite execution models:

* ``hybrid-engine`` runs through ``aio_do_parse``, which is genuinely async — it
  drives vLLM's async engine, so two in-flight documents interleave on one event
  loop and vLLM's continuous batching packs their pages into shared forward
  passes. ``@modal.concurrent`` is all that is needed.
* ``pipeline`` is synchronous. ``aio_do_parse`` dispatches straight to the
  blocking implementation ("pipeline模式暂不支持异步" upstream), so N concurrent
  asyncio tasks would serialize *and* wedge the event loop, taking /healthz down
  with them. :class:`_ParsePump` is the answer: every request's B2 download and
  upload stay on the loop and overlap freely, while exactly one thread ever
  drives MinerU. Whatever piled up while that thread was busy is handed over as
  one multi-document call, which is the shape MinerU's cross-document page
  batching is built for. Nothing waits on a timer, so a lone request is never
  delayed to fill a batch.

Cold-start strategy (in layers):
    1. Models load ONCE per container via ``@modal.enter`` using MineRU's
       in-process Python API (``mineru.cli.common.aio_do_parse`` + its
       ``ModelSingleton``). Warm requests skip model loading entirely.
    2. GPU memory snapshots (``enable_memory_snapshot=True`` +
       ``experimental_options={"enable_gpu_snapshot": True}``) checkpoint the
       process AFTER the models are loaded onto the GPU and warmed up, so cold
       boots restore straight into a ready-to-serve state instead of paying
       imports + weight loading + engine init (~minutes) on every boot.

Deploy:
    modal deploy modal/mineru_app.py
    # one-time (downloads weights onto the Volume):
    modal run modal/mineru_app.py::download_models

Then point the worker at both printed web URLs:
    MODAL_PARSE_URL=https://<org>--evo-mineru-mineruaccurate-web.modal.run/file_parse
    MODAL_FAST_PARSE_URL=https://<org>--evo-mineru-minerufast-web.modal.run/file_parse
    MODAL_PARSE_TOKEN=<the token in the evo-mineru-token secret>

Contract (matches pipeline/pipeline/parse/modal_parser.py):
    POST /file_parse  (JSON: source_url, output_url, output_key, filename,
                       parse_method, artifact_schema, parser_version,
                       source_fingerprint)
    Authorization: Bearer <MINERU_PARSE_TOKEN>
    -> {"artifact": {"key", "size", "sha256", "etag", "parser_version",
                     "source_fingerprint"}}

    POST /file_parse  (multipart: file=<bytes>, parse_method=auto, filename=...)
    -> {"content_list": [...], "images": {"<name>": "<base64>"}, "md": "..."}
       Used only by modal/test_snapshot.py; the ingest worker always uses JSON.
"""

from __future__ import annotations

import asyncio
import base64
import glob
import hashlib
import io
import json
import os
import subprocess
import tempfile
import time
import uuid
import zipfile
from collections import deque
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlparse

import modal

CACHE_DIR = "/cache"

# p_lang_list selects the per-language PP-OCR model and only affects the
# ``pipeline`` backend; ``hybrid`` ignores it entirely because the MinerU2.5 VLM
# does native multilingual OCR. MinerU 3.x language codes are script/model
# families, not ISO codes: ch, ch_server, korean, ta, te, ka, th, el, arabic,
# east_slavic, cyrillic, devanagari. "ch" covers Chinese (both scripts),
# Japanese and Latin — but NOT Korean, which needs its own pack. Korean sources
# should therefore use the accurate route until this becomes a per-file choice.
LANG = "ch"

ARTIFACT_SCHEMA = "evo-mineru-bundle-v1"
MAX_SOURCE_BYTES = 100 << 20

# --- accurate route ---------------------------------------------------------
# 3.x consolidated the backend names: engine-specific pins like
# "hybrid-vllm-async-engine" / "hybrid-auto-engine" no longer validate
# (normalize_backend raises, or silently aliases). The only public hybrid local
# backend is "hybrid-engine"; routed through ``aio_do_parse`` it auto-selects
# the *async* vLLM engine, which is what this event-loop-bound app needs.
ACCURATE_BACKEND = "hybrid-engine"
# medium (MinerU's own default) trades some accuracy for a large speed-up, and
# notably turns MinerU's built-in image/chart analysis OFF. That is deliberate:
# figures are described by our own captioning pass in the ingest worker, which
# can see neighbouring text and is far cheaper than GPU seconds here.
ACCURATE_EFFORT = "medium"
ACCURATE_PARSER_VERSION = "mineru-3.4-hybrid-v1"
ACCURATE_MAX_INPUTS = 2

# --- fast route -------------------------------------------------------------
FAST_BACKEND = "pipeline"
FAST_PARSER_VERSION = "mineru-3.4-pipeline-v1"
FAST_MAX_INPUTS = 6

# Cache MinerU/HF model weights across cold starts (shared by both routes).
model_volume = modal.Volume.from_name("evo-mineru-models", create_if_missing=True)

# A Modal Secret named "evo-mineru-token" must define MINERU_PARSE_TOKEN.
token_secret = modal.Secret.from_name("evo-mineru-token")

_shared_env = {
    "MINERU_MODEL_SOURCE": "huggingface",
    "HF_HOME": f"{CACHE_DIR}/huggingface",
    "MINERU_DEVICE_MODE": "cuda",
    # torch.compile with parallel inductor threads is a known cause of
    # GPU-memory-snapshot capture failures (see Modal snapshot docs).
    "TORCHINDUCTOR_COMPILE_THREADS": "1",
}

_base_image = modal.Image.debian_slim(python_version="3.11").apt_install(
    "libgl1", "libglib2.0-0", "libgomp1"
)

# [all] pulls in vllm, required by the hybrid backend's local inference engine.
# Pinned to the 3.4.x line: 3.4 upgrades pipeline OCR to PP-OCRv6 and the hybrid
# VLM to MinerU2.5-Pro with native multilingual OCR. Capped below 3.5 so a
# redeploy can't silently pull a new major that changes backend names or the
# aio_do_parse contract this app depends on.
accurate_image = _base_image.pip_install(
    "mineru[all]>=3.4.4,<3.5",
    "fastapi[standard]",
    "python-multipart",
    "requests>=2.31",
).env(_shared_env)

# The fast route never touches vLLM, so [pipeline] instead of [all] keeps the
# image (and therefore the cold boot) much smaller: torch + torchvision +
# onnxruntime rather than the whole inference-engine stack.
fast_image = _base_image.pip_install(
    "mineru[pipeline]>=3.4.4,<3.5",
    "fastapi[standard]",
    "python-multipart",
    "requests>=2.31",
).env(_shared_env)

app = modal.App("evo-mineru")


@app.function(image=accurate_image, gpu="L4", volumes={CACHE_DIR: model_volume}, timeout=3600)
def download_models() -> None:
    """Warm the Volume with MineRU's model weights (run once after deploy).

    Downloads both routes' weights: the Volume is shared, and the pipeline OCR
    models are small next to the VLM.
    """
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


# ------------------------------------------------------------------ outputs


def _collect_outputs(out_dir: str, stem: str) -> dict:
    """Collect one document's normalized outputs, addressed by its unique stem.

    MineRU writes each document under a directory named after the stem it was
    given, which is why :func:`_parse_documents` assigns synthetic unique stems:
    two uploads both called "lecture.pdf" in one batch would otherwise land in
    the same output directory and clobber each other.
    """
    matches = glob.glob(
        os.path.join(out_dir, "**", f"{stem}_content_list.json"), recursive=True
    )
    if not matches:
        raise RuntimeError(f"mineru produced no content list for {stem}")
    content_path = matches[0]
    base = os.path.dirname(content_path)

    with open(content_path, "r", encoding="utf-8") as f:
        content_list = json.load(f)

    md = ""
    md_matches = glob.glob(os.path.join(base, f"{stem}.md"))
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


def _parse_documents_sync(
    documents: list[_Document], backend: str, **parse_kwargs: Any
) -> list[dict | Exception]:
    """Parse a batch of documents in one blocking MineRU call.

    Blocking on purpose: this is the pipeline backend's only execution mode, and
    the caller guarantees exactly one thread is inside it at a time.

    A batch is all-or-nothing to MineRU, so a single malformed PDF would fail
    its neighbours. When the batch call raises, each document is retried alone
    and only the genuinely broken ones end up with an exception.
    """
    from mineru.cli.common import do_parse, read_fn

    if not documents:
        return []

    with tempfile.TemporaryDirectory() as work:
        out_dir = os.path.join(work, "out")
        os.makedirs(out_dir, exist_ok=True)

        stems: list[str] = []
        payloads: list[bytes] = []
        for index, document in enumerate(documents):
            # read_fn handles suffix sniffing and image->PDF conversion exactly
            # like the CLI does; office formats pass through as raw bytes.
            input_path = os.path.join(work, f"{index}_{os.path.basename(document.name)}")
            with open(input_path, "wb") as fh:
                fh.write(document.data)
            stems.append(f"doc{index}_{uuid.uuid4().hex[:8]}")
            payloads.append(read_fn(input_path))

        def run(indices: list[int]) -> None:
            do_parse(
                output_dir=out_dir,
                # do_parse mutates the lists it is handed (office documents are
                # removed in place after conversion), so pass throwaway copies.
                pdf_file_names=[stems[i] for i in indices],
                pdf_bytes_list=[payloads[i] for i in indices],
                p_lang_list=[LANG for _ in indices],
                backend=backend,
                parse_method=documents[indices[0]].parse_method or "auto",
                # Skip artifacts nobody downloads: debug PDFs and raw model dumps.
                f_draw_layout_bbox=False,
                f_draw_span_bbox=False,
                f_dump_middle_json=False,
                f_dump_model_output=False,
                f_dump_orig_pdf=False,
                **parse_kwargs,
            )

        everything = list(range(len(documents)))
        try:
            run(everything)
        except Exception:
            if len(documents) == 1:
                raise
            for index in everything:
                try:
                    run([index])
                except Exception:
                    pass

        results: list[dict | Exception] = []
        for index in everything:
            try:
                results.append(_collect_outputs(out_dir, stems[index]))
            except Exception as exc:  # noqa: BLE001 — reported per document
                results.append(exc)
        return results


@dataclass
class _PumpItem:
    document: _Document
    future: asyncio.Future


@dataclass
class _ParsePump:
    """Serializes synchronous MineRU calls onto one thread, batching the queue.

    One consumer task owns the only thread that ever enters MineRU, so there is
    no question of the pipeline backend's shared ``ModelSingleton`` being
    thread-safe and no GIL contention between parses. Requests still arrive
    concurrently, and their B2 download/upload phases overlap with somebody
    else's GPU time — which is where most of the win is, because MineRU's
    pipeline backend already batches pages within a document.

    Coalescing is opportunistic: the pump takes whatever is *already* waiting
    when it wakes, up to ``max_batch``. It never sleeps to fill a batch, so a
    single request is served with no added latency, while a burst gets MineRU's
    cross-document batching (worth the most on short documents) for free.
    """

    backend: str
    max_batch: int
    parse_kwargs: dict[str, Any] = field(default_factory=dict)
    _pending: deque[_PumpItem] = field(default_factory=deque, init=False)
    _wake: asyncio.Event = field(default_factory=asyncio.Event, init=False)
    _task: asyncio.Task | None = field(default=None, init=False)

    def ensure_running(self) -> None:
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(self._run())

    async def submit(self, document: _Document) -> dict:
        self.ensure_running()
        item = _PumpItem(document, asyncio.get_running_loop().create_future())
        self._pending.append(item)
        self._wake.set()
        return await item.future

    def _take_batch(self) -> list[_PumpItem]:
        batch = [self._pending.popleft()]
        # do_parse takes one parse_method for the whole call, so only documents
        # asking for the same one may share a batch. In practice the worker
        # sends a single configured value, making this a no-op.
        method = batch[0].document.parse_method
        deferred: list[_PumpItem] = []
        while self._pending and len(batch) < self.max_batch:
            item = self._pending.popleft()
            target = batch if item.document.parse_method == method else deferred
            target.append(item)
        self._pending.extendleft(reversed(deferred))
        return batch

    async def _run(self) -> None:
        while True:
            if not self._pending:
                self._wake.clear()
                await self._wake.wait()
                continue
            batch = self._take_batch()
            try:
                results: list[dict | Exception] = await asyncio.to_thread(
                    _parse_documents_sync,
                    [item.document for item in batch],
                    self.backend,
                    **self.parse_kwargs,
                )
            except Exception as exc:  # noqa: BLE001 — one failure, every waiter
                for item in batch:
                    if not item.future.done():
                        item.future.set_exception(exc)
                continue
            for item, result in zip(batch, results):
                if item.future.done():
                    continue
                if isinstance(result, Exception):
                    item.future.set_exception(result)
                else:
                    item.future.set_result(result)


async def _parse_accurate(document: _Document) -> dict:
    """Parse one document on the hybrid backend, on the container's event loop.

    Must always run on the container's main event loop: vLLM's async engine
    binds its background tasks to the loop it was created on (during the warmup
    parse), and using it from another loop breaks it.
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
            parse_method=document.parse_method or "auto",
            f_draw_layout_bbox=False,
            f_draw_span_bbox=False,
            f_dump_middle_json=False,
            f_dump_model_output=False,
            f_dump_orig_pdf=False,
        )
        return await asyncio.to_thread(_collect_outputs, out_dir, stem)


# ----------------------------------------------------------------- web layer


def _build_asgi(service: Any, parser_version: str):
    """Build the Starlette app both routes serve.

    Parse the multipart form off the raw Starlette Request instead of via
    FastAPI's ``UploadFile = File(...)`` parameter. FastAPI builds a Pydantic
    TypeAdapter for ``UploadFile``, which blows up ("class not fully defined")
    whenever the pinned fastapi / pydantic / starlette trio drifts out of sync
    in the image — exactly the kind of transitive-version breakage a long-lived
    serverless endpoint should not be fragile to.
    """
    import requests
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

    def _uptime() -> float | None:
        restored = getattr(service, "_restored_monotonic", None)
        return None if restored is None else round(time.perf_counter() - restored, 3)

    async def healthz(_request: Request) -> JSONResponse:
        # ``uptime_s`` = seconds this container has served since the snapshot
        # restore finished. A cold /healthz round-trip therefore measures
        # restore-to-ready overhead with no parse cost mixed in. It stays
        # responsive under load because no route ever blocks the event loop.
        return JSONResponse(
            {"ok": True, "uptime_s": _uptime(), "parser_version": parser_version}
        )

    async def _artifact_parse(request: Request, body: dict) -> JSONResponse:
        source_url = str(body.get("source_url") or "")
        output_url = str(body.get("output_url") or "")
        output_key = str(body.get("output_key") or "")
        name = str(body.get("filename") or "document")
        parse_method = str(body.get("parse_method") or "auto")
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
            # Every blocking call goes through a thread. Under input concurrency
            # a bare requests.get here would stall every other in-flight parse
            # and the health check with it.
            source = await asyncio.to_thread(
                lambda: requests.get(source_url, timeout=(30, 300))
            )
            source.raise_for_status()
            if len(source.content) > MAX_SOURCE_BYTES:
                return JSONResponse({"detail": "source exceeds 100 MB"}, status_code=413)

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
            return JSONResponse({"detail": f"remote parse failed: {e}"}, status_code=500)
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
        parse_method = str(form.get("parse_method") or "auto")
        name = str(
            form.get("filename") or getattr(upload, "filename", "") or "document"
        )
        data = await upload.read()

        t0 = time.perf_counter()
        try:
            result = await service.parse(_Document(data, name, parse_method))
        except Exception as e:  # noqa: BLE001 — surface parse failures as 500 JSON
            return JSONResponse({"detail": f"parse failed: {e}"}, status_code=500)
        # Extra keys the RAG worker ignores; the snapshot test script reads them
        # to split server parse time from cold-boot + network latency.
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
    # GPU memory snapshots (alpha): the checkpoint also captures GPU state, so
    # the loaded VLM + warm vLLM engine restore directly instead of being
    # rebuilt after every cold boot.
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
        # Everything here is captured in the GPU memory snapshot (with
        # enable_gpu_snapshot the GPU *is* attached during the snap phase, and
        # the weights Volume is readable). Parse a tiny synthetic page through
        # the real request path so the full hybrid stack — the MinerU2.5 VLM
        # inside its async vLLM engine plus the per-language OCR models — lands
        # in the process-wide ModelSingleton under exactly the keys
        # aio_do_parse will use; restored containers then serve their first
        # request with zero lazy loading. Async on purpose: Modal runs async
        # hooks on the same event loop that serves the ASGI app, so the vLLM
        # engine is created on the loop it will be used from.
        #
        # This method runs ONLY when Modal builds the snapshot (snap=True). If
        # you see the "[snapshot-build] warmup" logs below on an ordinary cold
        # boot, the snapshot is NOT being restored — that's the exact failure
        # this whole design guards against, so it's logged loudly on purpose.
        t0 = time.perf_counter()
        print(
            "[snapshot-build] warmup: loading models + engine init (this is the slow path)",
            flush=True,
        )
        await _parse_accurate(_Document(_warmup_png(), "warmup.png", "auto"))
        print(
            f"[snapshot-build] warmup done in {time.perf_counter() - t0:.1f}s",
            flush=True,
        )

    @modal.enter(snap=False)
    def after_restore(self) -> None:
        # Runs on EVERY container start AFTER a snapshot restore (snap=False).
        # If the GPU snapshot works, reaching this point means the VLM + vLLM
        # engine are already live in this process — the first /file_parse should
        # then be ~parse-time only, with no minutes-long engine init.
        self._restored_monotonic = time.perf_counter()
        print("[cold-boot] accurate container ready (restored from snapshot)", flush=True)

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
    enable_memory_snapshot=True,
    experimental_options={"enable_gpu_snapshot": True},
)
# Six in-flight documents per container. The pipeline backend has no vLLM KV
# cache and streams page by page at roughly 4 GB, so VRAM is nowhere near the
# limit on an L4 — the binding constraint is that only one of the six may be
# inside MineRU at a time (see _ParsePump). The other five overlap their B2
# download/upload with that parse, and any that queue up get folded into the
# next batched call.
@modal.concurrent(max_inputs=FAST_MAX_INPUTS)
class MineruFast:
    @modal.enter(snap=True)
    def load_models(self) -> None:
        # Sync on purpose, unlike the accurate route: the pipeline backend is
        # synchronous and holds no event-loop-bound state, so there is nothing
        # to bind to the serving loop and no reason to build one here.
        t0 = time.perf_counter()
        print("[snapshot-build] warmup: loading pipeline OCR/layout models", flush=True)
        _parse_documents_sync(
            [_Document(_warmup_png(), "warmup.png", "auto")], FAST_BACKEND
        )
        print(
            f"[snapshot-build] warmup done in {time.perf_counter() - t0:.1f}s",
            flush=True,
        )

    @modal.enter(snap=False)
    async def after_restore(self) -> None:
        # Async so the pump's consumer task is created on the same event loop
        # that will serve the ASGI app. ensure_running() in submit() covers the
        # case where Modal ever changes that.
        self._restored_monotonic = time.perf_counter()
        self._pump = _ParsePump(backend=FAST_BACKEND, max_batch=FAST_MAX_INPUTS)
        self._pump.ensure_running()
        print("[cold-boot] fast container ready (restored from snapshot)", flush=True)

    async def parse(self, document: _Document) -> dict:
        return await self._pump.submit(document)

    @modal.asgi_app()
    def web(self):
        return _build_asgi(self, FAST_PARSER_VERSION)


def _warmup_png() -> bytes:
    from PIL import Image as PILImage
    from PIL import ImageDraw

    img = PILImage.new("RGB", (800, 600), "white")
    ImageDraw.Draw(img).text((100, 100), "warm up", fill="black")
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()
