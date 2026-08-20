"""Modal parse app: Marker + lazy RapidOCR on CPU.

    modal deploy modal/mineru_fast.py
    modal run modal/mineru_fast.py::download_fast_models

URL: https://<workspace>--evo-mineru-fast.modal.run
Idle: 30s. CPU memory snapshot. Child processes (Marker workers, layout
server) start after restore — they do not survive a snapshot.

RapidOCR loads in a worker only when a scan page needs it.

Contract: ``pipeline/pipeline/parse/modal_parser.py``.
"""

from __future__ import annotations

import asyncio
import os
import sys
import time
from pathlib import Path

_HERE = Path(__file__).resolve().parent
for _path in (_HERE, Path("/root")):
    if _path.is_dir() and str(_path) not in sys.path:
        sys.path.insert(0, str(_path))

from parse_common import (
    CACHE_DIR,
    FAST_APP_NAME,
    FAST_CPU,
    FAST_DIGITAL_SLOTS,
    FAST_MAX_CONTAINERS,
    FAST_MAX_INPUTS,
    FAST_MEMORY_MB,
    FAST_OCR_SLOTS,
    FAST_PARSER_VERSION,
    FAST_SCALEDOWN_S,
    _build_asgi,
    _Document,
    _ParallelFastParser,
    _warm_fast_layout,
    _warmup_png,
    fast_image,
    model_volume,
    rss_tree_mb,
    run_download_fast_models,
    shutdown_fast,
    token_secret,
)

import modal

app = modal.App(FAST_APP_NAME)


def _device_info() -> dict[str, object]:
    import torch

    return {
        "cuda_available": bool(torch.cuda.is_available()),
        "cuda_visible": os.environ.get("CUDA_VISIBLE_DEVICES", ""),
        "torch": torch.__version__,
    }


@app.function(
    image=fast_image,
    volumes={CACHE_DIR: model_volume},
    timeout=3600,
    memory=8192,
    cpu=2.0,
)
def download_fast_models() -> None:
    """Pull RapidOCR ONNX + Marker fast-layout weights onto the Volume."""
    run_download_fast_models()


@app.cls(
    image=fast_image,
    volumes={CACHE_DIR: model_volume},
    secrets=[token_secret],
    timeout=1800,
    scaledown_window=FAST_SCALEDOWN_S,
    max_containers=FAST_MAX_CONTAINERS,
    memory=FAST_MEMORY_MB,
    cpu=FAST_CPU,
    enable_memory_snapshot=True,
)
@modal.concurrent(max_inputs=FAST_MAX_INPUTS)
class MineruFast:
    @modal.enter(snap=True)
    async def load_models(self) -> None:
        # Captured in the CPU memory snapshot. Layout weights live in this
        # parent. Workers start after restore.
        #
        # Runs on snapshot *build*, and again if restore fails. A successful
        # restore skips this hook and jumps to enter(snap=False).
        from marker_worker import init_worker

        t0 = time.perf_counter()
        self._device = _device_info()
        print(
            "[enter snap=True] layout + marker weights "
            "(snapshot build or no-snapshot fallback — not a restore)",
            flush=True,
        )
        await asyncio.to_thread(_warm_fast_layout)
        await asyncio.to_thread(init_worker)
        print(
            f"[enter snap=True] warmup done in {time.perf_counter() - t0:.1f}s "
            f"rss={rss_tree_mb()}",
            flush=True,
        )

    @modal.enter(snap=False)
    async def after_restore(self) -> None:
        from marker_worker import init_worker, parse_document, ping

        t0 = time.perf_counter()
        print(
            "[enter snap=False] layout server + marker workers (RapidOCR lazy)",
            flush=True,
        )
        self._device = _device_info()
        self._layout_models = await asyncio.to_thread(_warm_fast_layout)
        self._parser = _ParallelFastParser(init_worker, parse_document, FAST_MAX_INPUTS)
        self._digital_slots = asyncio.Semaphore(FAST_DIGITAL_SLOTS)
        self._ocr_slots = asyncio.Semaphore(FAST_OCR_SLOTS)
        self._probe_lock = asyncio.Lock()
        await self._parser.warm(ping, FAST_MAX_INPUTS)
        await self._parser.submit(_Document(_warmup_png(), "warmup.png", "txt"))
        self._restored_monotonic = time.perf_counter()
        print(
            f"[enter snap=False] workers up in {time.perf_counter() - t0:.1f}s "
            f"rss={rss_tree_mb()} "
            "(restore worked only if this container has no [enter snap=True] line)",
            flush=True,
        )

    @modal.exit()
    def stop(self) -> None:
        shutdown_fast(
            getattr(self, "_parser", None),
            getattr(self, "_layout_models", None),
        )

    async def parse(self, document: _Document) -> dict:
        heavy = await self._ocr_heavy(document)
        lane = self._ocr_slots if heavy else self._digital_slots
        async with lane:
            result = await self._parser.submit(document)
        result["_fast_lane"] = "ocr" if heavy else "digital"
        result["_rss"] = rss_tree_mb()
        return result

    async def _ocr_heavy(self, document: _Document) -> bool:
        from scan_pages import job_needs_rapidocr, probe_pages

        async with self._probe_lock:
            probes = await asyncio.to_thread(probe_pages, document.data)
        return job_needs_rapidocr(probes, document.parse_method)

    @modal.asgi_app(label=FAST_APP_NAME)
    def web(self):
        return _build_asgi(self, FAST_PARSER_VERSION)
