"""Page layout regions for Make a quiz: a small stateless service on the ingest
host, one pool serving UAT and production together (Epo 2026-11-04).

``POST /regions`` takes one page as a JPEG and answers the regions
PP-DocLayout_plus-L finds on it, on the page's 0-1000 grid, under a bearer
token. The retrieval service makes one request a page before the page windows
(``pipeline/retrieval/layout.py``). Past LAYOUT_QUEUE_DEPTH requests in the
service, one more is answered 429 and the client waits and tries again, a
bounded number of times, before that page uses the box call. Nothing is
stored, and only counts and timings are logged. ``GET /healthz`` is open and
answers the counts.

The pre- and post-processing follow the model's own ``inference.yml`` at the
revision the Dockerfile pins: bench/extraction/reports/2026-11-04-layout-models.md.
"""

from __future__ import annotations

import asyncio
import hmac
import io
import logging
import os
import time
from collections import Counter
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from typing import Any

from PIL import Image
from starlette.applications import Starlette
from starlette.requests import ClientDisconnect, Request
from starlette.responses import JSONResponse
from starlette.routing import Route

log = logging.getLogger("capy.layout")

# Held here and taken out of the environment at import, as the parser's token.
TOKEN = os.environ.pop("CAPY_LAYOUT_TOKEN", "")
if not TOKEN:
    raise RuntimeError("set CAPY_LAYOUT_TOKEN")
if len(TOKEN) < 32 and os.environ.get("APP_ENV") not in ("development", "e2e"):
    raise RuntimeError("CAPY_LAYOUT_TOKEN must be at least 32 characters")

# All set by the compose file; the module refuses to load without them.
MODEL_PATH = os.environ["LAYOUT_MODEL_PATH"]
# Threads one inference uses, and inferences at once.
THREADS = int(os.environ["LAYOUT_THREADS"])
WORKERS = int(os.environ["LAYOUT_WORKERS"])
# Requests in the service, running or waiting; one more is answered 429.
DEPTH = int(os.environ["LAYOUT_QUEUE_DEPTH"])
MAX_BYTES = int(os.environ["LAYOUT_MAX_BYTES"])
MAX_PIXELS = int(os.environ["LAYOUT_MAX_PIXELS"])
# A client that does not finish sending its page gives its place back.
READ_TIMEOUT_S = 10.0

# The label list of the pinned model's inference.yml, in its order.
LABELS = (
    "paragraph_title",
    "image",
    "text",
    "number",
    "abstract",
    "content",
    "figure_title",
    "formula",
    "table",
    "reference",
    "doc_title",
    "footnote",
    "header",
    "algorithm",
    "footer",
    "seal",
    "chart",
    "formula_number",
    "aside_text",
    "reference_content",
)
# The model's square input.
INPUT_SIZE = 800
# Regions under this score stay here; the client's rules read 0.5 and up.
SCORE_FLOOR = 0.3


class TooManyPixels(Exception):
    pass


class NotAJpeg(Exception):
    pass


class TooLarge(Exception):
    pass


def load_model() -> Callable[[Image.Image], list[dict[str, Any]]]:
    """The model as a function from an RGB page to its regions."""
    import numpy as np
    import onnxruntime as ort

    options = ort.SessionOptions()
    options.intra_op_num_threads = THREADS
    options.inter_op_num_threads = 1
    session = ort.InferenceSession(
        MODEL_PATH, options, providers=["CPUExecutionProvider"]
    )
    names = [node.name for node in session.get_inputs()]

    def run(image: Image.Image) -> list[dict[str, Any]]:
        width, height = image.size
        resized = image.resize((INPUT_SIZE, INPUT_SIZE), Image.Resampling.BICUBIC)
        pixels = np.asarray(resized, dtype=np.float32) / 255.0
        feed = {
            "image": pixels.transpose(2, 0, 1)[None],
            "im_shape": np.array([[INPUT_SIZE, INPUT_SIZE]], np.float32),
            "scale_factor": np.array(
                [[INPUT_SIZE / height, INPUT_SIZE / width]], np.float32
            ),
        }
        rows = session.run(None, {name: feed[name] for name in names})[0]
        return [
            {
                "label": LABELS[int(row[0])],
                "score": round(float(row[1]), 4),
                "box": [
                    round(float(row[2]) / width * 1000, 1),
                    round(float(row[3]) / height * 1000, 1),
                    round(float(row[4]) / width * 1000, 1),
                    round(float(row[5]) / height * 1000, 1),
                ],
            }
            for row in rows
            if row[1] >= SCORE_FLOOR and int(row[0]) >= 0
        ]

    return run


model: Callable[[Image.Image], list[dict[str, Any]]] | None = None
pool: ThreadPoolExecutor | None = None
counts: Counter[str] = Counter()
in_service = 0


def decoded(body: bytes) -> Image.Image:
    """The JPEG as RGB. Its size is read before its pixels are decoded."""
    try:
        with Image.open(io.BytesIO(body), formats=["JPEG"]) as opened:
            width, height = opened.size
            if width * height > MAX_PIXELS:
                raise TooManyPixels
            return opened.convert("RGB")
    except Image.DecompressionBombError as exc:
        raise TooManyPixels from exc
    except (OSError, SyntaxError, ValueError) as exc:
        raise NotAJpeg from exc


def page_regions(body: bytes, arrived: float) -> dict[str, Any]:
    """One page, on a pool thread, with its timings."""
    assert model is not None
    started = time.perf_counter()
    image = decoded(body)
    ready = time.perf_counter()
    found = model(image)
    done = time.perf_counter()
    log.info(
        "regions=%d wait_ms=%d decode_ms=%d infer_ms=%d",
        len(found),
        (started - arrived) * 1000,
        (ready - started) * 1000,
        (done - ready) * 1000,
    )
    return {"regions": found}


async def read_body(request: Request) -> bytes:
    chunks: list[bytes] = []
    size = 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > MAX_BYTES:
            raise TooLarge
        chunks.append(chunk)
    return b"".join(chunks)


def refused(status: int, code: str) -> JSONResponse:
    counts[code] += 1
    return JSONResponse({"error": code}, status_code=status)


async def regions(request: Request) -> JSONResponse:
    global in_service
    sent = request.headers.get("authorization", "").encode()
    if not hmac.compare_digest(sent, f"Bearer {TOKEN}".encode()):
        return refused(401, "unauthorized")
    if in_service >= DEPTH:
        return refused(429, "busy")
    in_service += 1
    try:
        arrived = time.perf_counter()
        async with asyncio.timeout(READ_TIMEOUT_S):
            body = await read_body(request)
        answer = await asyncio.get_running_loop().run_in_executor(
            pool, page_regions, body, arrived
        )
    except TooLarge:
        return refused(413, "too_many_bytes")
    except TooManyPixels:
        return refused(413, "too_many_pixels")
    except NotAJpeg:
        return refused(400, "not_a_jpeg")
    except (TimeoutError, ClientDisconnect):
        return refused(408, "not_sent")
    finally:
        in_service -= 1
    counts["served"] += 1
    return JSONResponse(answer)


async def healthz(_: Request) -> JSONResponse:
    return JSONResponse({"ok": True, "inService": in_service, **counts})


@asynccontextmanager
async def lifespan(_: Starlette):
    global model, pool
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    model = load_model()
    pool = ThreadPoolExecutor(WORKERS, thread_name_prefix="layout")
    yield
    pool.shutdown(wait=False, cancel_futures=True)


app = Starlette(
    routes=[
        Route("/regions", regions, methods=["POST"]),
        Route("/healthz", healthz, methods=["GET"]),
    ],
    lifespan=lifespan,
)
