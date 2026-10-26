"""capture_page: render a cited source page, or a box on it, for the chat model.

The pixels have to be inside the provider request the agent builds mid-turn,
so the retrieval host keeps a size-bounded copy of each source PDF (keyed by
the stored object's path) and renders with PyMuPDF. An uploaded image is its
own one page, oriented and flattened with Pillow as captioning does (first
frame only). Word, Excel and PowerPoint files have no page view (Epo
2026-10-24, Q283): inspect_office_document reads them, and their pictures come
back through it as images ``picture_jpeg`` shrinks. Text and store-only
sources have no page model and refuse. The JPEG rides in a user message placed
after the tool results of its step, because chat-completions tool messages
carry text only.
Images live on the turn's ``ToolContext`` and are never persisted.

``capture_knowledge_page`` renders a library book the same way, from the
knowledge-base bucket and keyed in the same cache by its object key.
"""

from __future__ import annotations

import base64
import hashlib
import io
import logging
import math
import os
import tempfile
import time
import warnings
from pathlib import Path
from typing import IO, Any

from ..config import cfg
from ..elitellm.client import RawJson
from ..generated.limits import IMAGE_MAX_SIDE
from ..store import blobstore
from . import accounting, limits, store

log = logging.getLogger("capy.retrieval.capture")

JPEG_QUALITY = 80
OFFICE_NO_PAGES = (
    "a Word, Excel or PowerPoint file has no page view: inspect_office_document "
    "reads its text, tables, equations and charts, and its pictures by their ids"
)
# The Word, Excel and PowerPoint files inspect_office_document reads: their
# stored kind, and the name's suffix Go's SourceEditFormat goes by (Q396).
# CSV and TSV (kind sheet) and legacy .doc, .xls and .ppt keep the refusal
# they had before (a page-less source has no retained PDF).
OFFICE_KINDS = ("doc", "sheet", "slides")
OFFICE_SUFFIXES = (".docx", ".xlsx", ".pptx")


def is_office(row: dict[str, Any]) -> bool:
    return (
        row.get("kind") in OFFICE_KINDS
        and Path(str(row.get("name") or "")).suffix.lower() in OFFICE_SUFFIXES
    )


class CaptureUnavailable(Exception):
    """The file has no page-addressable PDF or its bytes cannot be read."""

    def __init__(self, message: str, code: str = "unsupported_format") -> None:
        super().__init__(message)
        self.code = code


def patch_tokens(width: int, height: int) -> int:
    """Image tokens on a 28-pixel patch grid (GLM, Qwen); shown in telemetry."""
    return -(-width // 28) * -(-height // 28)


# ------------------------------------------------------------------ PDF cache


def _cache_dir() -> Path:
    path = Path(cfg.capture_cache_dir)
    path.mkdir(parents=True, exist_ok=True)
    return path


def _evict(cache: Path, budget: int) -> None:
    """Least recently used first, until the directory fits the byte budget."""
    files = [p for p in cache.glob("*.pdf") if p.is_file()]
    total = sum(p.stat().st_size for p in files)
    for path in sorted(files, key=lambda p: p.stat().st_atime):
        if total <= budget:
            break
        try:
            total -= path.stat().st_size
            path.unlink()
        except OSError:
            log.debug("could not evict capture cache file %s", path, exc_info=True)


def _download(blob_path: str, target: Path, max_bytes: int, download=None) -> None:
    cache = target.parent
    fd, temporary = tempfile.mkstemp(prefix=".", suffix=".part", dir=cache)
    os.close(fd)
    try:
        downloaded = (download or blobstore.download_file)(
            blob_path, temporary, max_bytes
        )
        if downloaded is None:
            raise CaptureUnavailable(
                "the source object is missing", "unavailable_target"
            )
        os.replace(temporary, target)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
    _evict(cache, cfg.capture_cache_max_bytes)


def cache_name(blob_path: str) -> str:
    """Cache file for one stored object. Keyed by the blob path, not the source
    SHA, so a replaced source cannot reuse a stale rendering."""
    return hashlib.sha256(blob_path.encode("utf-8")).hexdigest() + ".pdf"


async def pdf_path(workspace_id: str, file_id: str) -> Path:
    """The local PDF for ``file_id``, downloaded once per stored object."""
    row = await store.file_page_source(workspace_id, file_id)
    if row is None:
        raise CaptureUnavailable("the file is not available", "unavailable_target")
    if row.get("kind") != "pdf" or row.get("parse_mode") == "none":
        raise CaptureUnavailable("this source has no retained PDF")
    blob = str(row.get("blob_path") or "")
    if not blob:
        raise CaptureUnavailable("the source has no stored bytes", "unavailable_target")
    target = _cache_dir() / cache_name(blob)
    if target.is_file():
        os.utime(target)
        return target
    max_bytes = int(row.get("size_bytes") or 0)
    await limits.render_thread(_download, blob, target, max_bytes)
    return target


async def knowledge_pdf_path(object_key: str, max_bytes: int) -> Path:
    """The local copy of a library book, downloaded once per object key."""
    if not object_key:
        raise CaptureUnavailable(
            "this book has no stored PDF in the knowledge-base bucket",
            "unavailable_target",
        )
    target = _cache_dir() / cache_name(object_key)
    if target.is_file():
        os.utime(target)
        return target
    await limits.render_thread(
        _download, object_key, target, max_bytes, blobstore.library_download_file
    )
    return target


async def render_knowledge(
    object_key: str, max_bytes: int, page: int, bbox: list[float] | None, max_edge: int
) -> tuple[bytes, list[float], tuple[int, int]]:
    pdf = await knowledge_pdf_path(object_key, max_bytes)
    return await limits.render_thread(render, pdf, page, bbox, max_edge)


def _image_capture(
    row: dict, page: int, bbox: list[float] | None, max_edge: int
) -> tuple[bytes, list[float], tuple[int, int]]:
    """An uploaded image is one page: its own bytes, rendered by ``image_jpeg``."""
    if page != 1:
        raise ValueError("an image has one page")
    with tempfile.TemporaryDirectory(prefix="capy-image-capture-") as directory:
        source = Path(directory) / "source"
        downloaded = blobstore.download_file(
            str(row["blob_path"]), str(source), int(row["size_bytes"])
        )
        if (
            downloaded is None
            or downloaded[0] != int(row["size_bytes"])
            or (row.get("source_sha256") and downloaded[1] != row["source_sha256"])
        ):
            raise CaptureUnavailable(
                "the source bytes are unavailable", "unavailable_target"
            )
        return image_jpeg(source, bbox, max_edge)


def _decoded(image: Any, bbox: list[float], max_edge: int) -> Any:
    """The first frame decoded no larger than the box needs (Epo 2026-10-24,
    Q239): a JPEG at a reduced DCT scale while it decodes, any other format
    reduced by a whole factor once it loads, before a full-size copy or colour
    conversion is made, as ingest's decoder does (ingest/decode.py). The box
    keeps more than ``max_edge`` pixels on its long side whichever way the
    image's orientation turns it."""
    width, height = image.size
    span_x, span_y = (bbox[2] - bbox[0]) / 1000, (bbox[3] - bbox[1]) / 1000
    long_side = min(
        max(width * span_x, height * span_y), max(height * span_x, width * span_y)
    )
    # One pixel over, for the crop's rounding.
    scale = min(1.0, (max_edge + 1) / long_side)
    need = (max(1, math.ceil(width * scale)), max(1, math.ceil(height * scale)))
    image.draft("RGB", need)  # JPEG only; before the pixels load.
    factor = min(image.width // need[0], image.height // need[1])
    if factor < 2:
        return image.copy()
    if image.mode in ("1", "P", "PA") or image.mode.startswith("I;16"):
        # Modes reduce refuses, or would average palette indices.
        image = image.convert("RGBA" if image.has_transparency_data else "RGB")
    return image.reduce(factor)


def _thumbnail_size(width: int, height: int, edge: int) -> tuple[int, int]:
    """The size ``Image.thumbnail((edge, edge))`` gives a ``width`` x
    ``height`` image, with its rounding."""
    if width <= edge and height <= edge:
        return width, height
    aspect = width / height
    if aspect <= 1:
        n = edge * aspect
        side = min(math.floor(n), math.ceil(n), key=lambda v: abs(aspect - v / edge))
        return max(side, 1), edge
    n = edge / aspect
    side = min(
        math.floor(n), math.ceil(n), key=lambda v: abs(aspect - edge / v) if v else 0
    )
    return edge, max(side, 1)


def image_jpeg(
    source: Path | IO[bytes],
    bbox: list[float] | None,
    max_edge: int,
    max_side: int | None = None,
) -> tuple[bytes, list[float], tuple[int, int]]:
    """An image oriented and flattened like captioning does, cropped to the
    box and shrunk to ``max_edge``. With ``max_side``, an image whose header
    names a longer side is refused before any pixel is decoded."""
    if bbox:
        x0, y0, x1, y1 = bbox
        if not (x0 < x1 and y0 < y1):
            raise ValueError("bbox must be [x0, y0, x1, y1] with x0 < x1 and y0 < y1")
    else:
        bbox = [0, 0, 1000, 1000]
    from PIL import ExifTags, Image, ImageOps, UnidentifiedImageError

    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(source) as opened:
                # ponytail: first frame only; later GIF frames are not captured
                size = opened.size
                if max_side is not None and max(size) > max_side:
                    raise CaptureUnavailable(
                        f"this picture is {size[0]} by {size[1]} pixels, over "
                        f"the {max_side} pixels a side the app takes"
                    )
                frame = _decoded(opened, bbox, max_edge)
                # Pillow turns a TIFF upright as it loads; exif_transpose the rest.
                orientation = frame.getexif().get(ExifTags.Base.Orientation)
                full = size[::-1] if orientation in (5, 6, 7, 8) else size
                frame = ImageOps.exif_transpose(frame).convert("RGBA")
    except (Image.DecompressionBombWarning, Image.DecompressionBombError) as exc:
        raise CaptureUnavailable("this image is too large to render") from exc
    except (OSError, ValueError, UnidentifiedImageError) as exc:
        # SVG and formats this Pillow build lacks (an upload's caption covers them).
        raise CaptureUnavailable("this image format cannot be rendered") from exc
    # The box and the capture's size come from the full-size image, so a
    # reduced decode changes neither; the reduced frame only supplies pixels.
    box = [round(full[i % 2] * bbox[i] / 1000) for i in range(4)]
    width, height = box[2] - box[0], box[3] - box[1]
    if width == 0 or height == 0:
        raise ValueError("bbox selects an empty region")
    scale_x, scale_y = frame.width / full[0], frame.height / full[1]
    clip = frame.resize(
        _thumbnail_size(width, height, max_edge),
        Image.Resampling.LANCZOS,
        box=(box[0] * scale_x, box[1] * scale_y, box[2] * scale_x, box[3] * scale_y),
        reducing_gap=2.0,
    )
    flat = Image.new("RGB", clip.size, "white")
    flat.paste(clip, mask=clip.getchannel("A"))
    buffer = io.BytesIO()
    flat.save(buffer, "JPEG", quality=JPEG_QUALITY)
    return buffer.getvalue(), [float(v) for v in bbox], flat.size


def crop_box(crop: object) -> list[float]:
    """An Office picture's crop as the box it leaves on the 0-1000 grid
    (review r1 L1): a side that is missing or not a finite number reads as 0,
    and a negative one (a frame padding the picture) also as 0, since only
    the picture's own pixels are sent; each side is at most 1, and a pair of
    sides that would leave nothing (left plus right, or top plus bottom, 1 or
    more) leaves that axis whole. The box never leaves the image or turns
    empty, whatever the file says."""
    sides = []
    for key in ("left", "top", "right", "bottom"):
        value = crop.get(key) if isinstance(crop, dict) else None
        finite = type(value) in (int, float) and math.isfinite(value)
        sides.append(min(1.0, max(0.0, float(value))) if finite else 0.0)
    left, top, right, bottom = sides
    if left + right >= 1:
        left = right = 0.0
    if top + bottom >= 1:
        top = bottom = 0.0
    return [left * 1000, top * 1000, (1 - right) * 1000, (1 - bottom) * 1000]


def picture_jpeg(
    data: bytes, crop: object, max_edge: int
) -> tuple[bytes, list[float], tuple[int, int]]:
    """An Office picture's stored bytes (inspect_office_document's by-id read)
    as the JPEG the model reads: its crop applied (``crop_box``), decoded at
    the reduced size (Q239, Q279), and refused before decoding when Pillow
    finds a side past the app's image limit (``IMAGE_MAX_SIDE``, the upload
    check's and the engine's; review r1 L3): the engine lists pictures from
    their headers alone, so a file whose header it misreads still reaches
    here."""
    return image_jpeg(io.BytesIO(data), crop_box(crop), max_edge, IMAGE_MAX_SIDE)


async def office_file(workspace_id: str, file_id: str) -> bool:
    """Whether the file is a Word, Excel or PowerPoint file (no page view)."""
    row = await store.file_page_source(workspace_id, file_id)
    return row is not None and is_office(row)


async def render_file(
    workspace_id: str, file_id: str, page: int, bbox: list[float] | None, max_edge: int
) -> tuple[bytes, list[float], tuple[int, int]]:
    row = await store.file_page_source(workspace_id, file_id)
    if row is None:
        raise CaptureUnavailable("the file is not available", "unavailable_target")
    if row.get("kind") == "image":
        if not row.get("blob_path"):
            raise CaptureUnavailable(
                "the source has no stored bytes", "unavailable_target"
            )
        return await limits.render_thread(_image_capture, row, page, bbox, max_edge)
    if is_office(row):
        raise CaptureUnavailable(OFFICE_NO_PAGES)
    pdf = await pdf_path(workspace_id, file_id)
    return await limits.render_thread(render, pdf, page, bbox, max_edge)


# --------------------------------------------------------------------- render


def render(
    pdf: Path, page: int, bbox: list[float] | None, max_edge: int
) -> tuple[bytes, list[float], tuple[int, int]]:
    """JPEG of the page or box, the box actually rendered on the 0-1000 grid,
    and the pixel size."""
    import pymupdf

    with pymupdf.open(pdf) as doc:
        if not 1 <= page <= len(doc):
            raise ValueError(f"page must be between 1 and {len(doc)}")
        pg = doc[page - 1]
        rect = pg.rect
        if bbox:
            x0, y0, x1, y1 = bbox
            if not (x0 < x1 and y0 < y1):
                raise ValueError(
                    "bbox must be [x0, y0, x1, y1] with x0 < x1 and y0 < y1"
                )
            clip = pymupdf.Rect(
                rect.x0 + rect.width * x0 / 1000,
                rect.y0 + rect.height * y0 / 1000,
                rect.x0 + rect.width * x1 / 1000,
                rect.y0 + rect.height * y1 / 1000,
            )
        else:
            clip, bbox = rect, [0, 0, 1000, 1000]
        scale = max_edge / max(clip.width, clip.height)
        pix = pg.get_pixmap(matrix=pymupdf.Matrix(scale, scale), clip=clip, alpha=False)
    from PIL import Image

    image = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
    buffer = io.BytesIO()
    image.save(buffer, "JPEG", quality=JPEG_QUALITY)
    return buffer.getvalue(), [float(v) for v in bbox], (pix.width, pix.height)


def data_url(jpeg: bytes) -> str:
    """A capture's image as it rides in requests, encoded once when the capture
    is taken: no later model call of its turn encodes it again (Q299)."""
    return RawJson("data:image/jpeg;base64," + base64.b64encode(jpeg).decode())


# ------------------------------------------------------------- image transport


def image_part(url: str, provider_slug: str) -> dict[str, Any]:
    if provider_slug == "anthropic":
        header = url[: url.index(",")]
        return {
            "type": "image",
            "source": {
                "type": "base64",
                "media_type": header[5:].split(";")[0],
                "data": _base64_data(url),
            },
        }
    return {"type": "image_url", "image_url": {"url": url}}


def _base64_data(url: str) -> str:
    """The data URL's base64 part; for a capture's, made on its first request
    and kept on the URL for the rest of the turn."""
    if not isinstance(url, RawJson):
        return url.split(",", 1)[1]
    kept = vars(url)
    if "data" not in kept:
        kept["data"] = RawJson(url.split(",", 1)[1])
    return kept["data"]


def inject_images(
    messages: list[dict[str, Any]],
    images: dict[str, tuple[str, str]],
    provider_slug: str = "",
    tokens: dict[str, int] | None = None,
) -> list[dict[str, Any]]:
    """Attach captured images after the tool-result block that produced them.

    Every tool result of one assistant step must stay contiguous, so the images
    ride in one user message placed after the last tool message of that step.
    Each image is a page of a source, so it sits in a <source> block
    (prompts/sources.py) after its label. Live compaction only folds exchanges
    into the turn note, so the captures of folded exchanges ride right after
    the note: live compaction drops none (Epo 2026-10-21). An image the turn's
    image budget dropped is no longer in ``images``: nothing takes its place,
    and its tool result keeps its ordinary text (Q349, Q370).

    ``images`` is keyed by image id: a capture's is its tool call id, and the
    pictures one inspect_office_document call attaches are ``<call id>#<n>``
    (``picture_id``), so they follow that call's result in order.

    ``tokens`` (image id -> the capture's pixel estimate) keeps each built
    message's estimate on it, so a request built for every model call does not
    decode its images again to measure them (Q238).
    """
    if not images:
        return messages
    live = {m.get("tool_call_id") for m in messages if m.get("role") == "tool"}
    calls = {image_id: _call_of(image_id, live) for image_id in images}
    folded = [image_id for image_id, call in calls.items() if call not in live]
    out: list[dict[str, Any]] = []
    pending: list[str] = []
    for i, message in enumerate(messages):
        out.append(message)
        if message.get("_kind") == "turn_note" and folded:
            out.append(
                _images_message(
                    "the tool calls this note folded",
                    folded,
                    images,
                    tokens,
                    provider_slug,
                )
            )
        if message.get("role") == "tool":
            pending += [
                image_id
                for image_id, call in calls.items()
                if call == message.get("tool_call_id")
            ]
        following = messages[i + 1] if i + 1 < len(messages) else None
        if pending and (following is None or following.get("role") != "tool"):
            out.append(
                _images_message(
                    "the tool calls above", pending, images, tokens, provider_slug
                )
            )
            pending = []
    return out


def picture_id(call_id: str, n: int) -> str:
    """The image id of the ``n``-th picture (from 1) one call attaches."""
    return f"{call_id}#{n}"


def _call_of(image_id: str, live: set[Any]) -> str:
    """The tool call an image belongs to: a capture's id is its call's; a
    picture's drops its ``#<n>``, so a call id holding ``#`` still matches."""
    if image_id in live or "#" not in image_id:
        return image_id
    return image_id.rpartition("#")[0]


def _images_message(
    source: str,
    call_ids: list[str],
    images: dict[str, tuple[str, str]],
    tokens: dict[str, int] | None,
    provider_slug: str,
) -> dict[str, Any]:
    text: list[dict[str, Any]] = [{"type": "text", "text": f"Images from {source}:"}]
    content = list(text)
    for call_id in call_ids:
        label, url = images[call_id]
        labelled = {"type": "text", "text": f"{label}\n<source>"}
        closing = {"type": "text", "text": "</source>"}
        content += [labelled, image_part(url, provider_slug), closing]
        text += [labelled, closing]
    message = {"role": "user", "content": content}
    if tokens is not None and all(call_id in tokens for call_id in call_ids):
        accounting.keep_tokens(
            message,
            accounting.estimate_context_value({**message, "content": text})
            + sum(tokens[call_id] for call_id in call_ids),
        )
    return message


def _image_bytes(part: dict[str, Any]) -> bytes | None:
    """The encoded image of an ``image_url`` (data URL) or Anthropic ``image`` part."""
    if part.get("type") == "image_url":
        url = str((part.get("image_url") or {}).get("url") or "")
        if url.startswith("data:") and "," in url:
            return base64.b64decode(url.split(",", 1)[1], validate=False)
        return None
    if part.get("type") == "image":
        data = (part.get("source") or {}).get("data")
        return base64.b64decode(data, validate=False) if isinstance(data, str) else None
    return None


def split_images(messages: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], int]:
    """Messages without their image parts, plus the images' token estimate.

    Context telemetry and the compaction budget count tokens from the JSON
    text; a base64 JPEG would count as ~100k of them. Images are measured as
    :func:`patch_tokens` of their pixel size instead.
    """
    from PIL import Image

    out: list[dict[str, Any]] = []
    tokens = 0
    for message in messages:
        content = message.get("content")
        if not isinstance(content, list) or not any(
            isinstance(p, dict) and p.get("type") in ("image_url", "image")
            for p in content
        ):
            out.append(message)
            continue
        kept = []
        for part in content:
            data = _image_bytes(part) if isinstance(part, dict) else None
            if data is None:
                kept.append(part)
                continue
            try:
                with Image.open(io.BytesIO(data)) as image:
                    width, height = image.size
            except (OSError, ValueError):
                # Not an image PIL can read: measured as the text it is.
                kept.append(part)
                continue
            tokens += patch_tokens(width, height)
        out.append({**message, "content": kept})
    return out, tokens


def image_tokens(
    captures: list[dict[str, Any]], images: dict[str, tuple[str, str]]
) -> int:
    """Tokens the turn's attached captures add to every later request of the
    turn: all of them, since a folded exchange's capture rides after the turn
    note, but none the image budget dropped (Q349)."""
    return sum(
        int(record["estimatedImageTokens"])
        for record in captures
        if record["callId"] in images
    )


def record(
    *,
    call_id: str,
    file_id: str,
    page: int | None,
    box: list[float],
    jpeg: bytes,
    size: tuple[int, int],
    started: float,
) -> dict[str, Any]:
    """One attached image's record; ``call_id`` is its image id (an Office
    picture's carries ``picture`` and no page)."""
    width, height = size
    return {
        "callId": call_id,
        "fileId": file_id,
        "page": page,
        "bbox": [int(v) for v in box],
        "bytes": len(jpeg),
        "pixels": [width, height],
        "estimatedImageTokens": patch_tokens(width, height),
        "elapsedMs": round((time.perf_counter() - started) * 1000),
    }
