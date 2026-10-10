"""Page-1 thumbnail, or the opening text, of a source for its list card.

A successful ingest ends here, before the local source is cleaned up: PDFs
render page 1 with PyMuPDF (the bundle's font-repaired ``parsed.pdf`` when
there is one), Office files through the parser's ``/capture_page``, uploaded
images with Pillow. The 200 px wide WebP is stored content-addressed at
``thumbs/{file id}/{sha256}.webp`` and ``files.thumbnail_key`` points at it;
the blob triggers release the key it replaces. Text sources store their first
600 characters in ``files.preview`` instead. A source refresh publishes and
ingests again, so an edit replaces both.

Thumbnails are a platform cost outside the storage quota. A capture is best
effort: any failure is logged and dropped, never retried, and never fails the
ingest; the card keeps its icon or its previous thumbnail. See
openwiki/thumbnails.md.
"""

from __future__ import annotations

import hashlib
import io
import logging
import time
import warnings
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from ..config import cfg
from ..parse import parser_client
from ..retrieval import capture
from ..store import blobstore, db
from . import plan as ingest_plan

log = logging.getLogger("capy.thumbnail")

WIDTH = 200
WEBP_QUALITY = 60
TEXT_PREVIEW_CHARS = 600
CACHE_CONTROL = "public, max-age=31536000, immutable"
# Cards crop pages from the top; a page taller than this is cut there.
_MAX_HEIGHT = 2 * WIDTH
# The parser scales the longer edge to this; a portrait page comes back about
# 280 px wide and is reduced to WIDTH here.
_OFFICE_MAX_EDGE = 400
_OFFICE_FORMATS = frozenset({"docx", "pptx", "xlsx"})


def capture_source(
    *,
    file_id: str,
    plan: ingest_plan.ProcessingPlan,
    local_path: str | None,
    source_sha256: str,
    artifact: Mapping[str, Any] | None,
) -> None:
    """Store the thumbnail or text preview of the ingested bytes."""
    if not local_path:
        return
    started = time.monotonic()
    try:
        if plan.route == ingest_plan.RAW_TEXT:
            _store_text_preview(file_id, source_sha256, Path(local_path))
            return
        data = render(plan, Path(local_path), artifact)
        if data is None:
            return
        _store_thumbnail(file_id, source_sha256, data)
        log.info(
            "thumbnail captured",
            extra={
                "file_id": file_id,
                "format": plan.format,
                "bytes": len(data),
                "ms": round((time.monotonic() - started) * 1000),
            },
        )
    except Exception:
        log.warning(
            "thumbnail capture failed",
            extra={"file_id": file_id, "route": plan.route, "format": plan.format},
            exc_info=True,
        )


def render(
    plan: ingest_plan.ProcessingPlan,
    source: Path,
    artifact: Mapping[str, Any] | None,
) -> bytes | None:
    """The WebP of page 1, or None for a route without one (store-only, audio,
    delimited text) or an image format this Pillow cannot decode."""
    if plan.route == ingest_plan.DOCUMENT_PARSE:
        if plan.format in _OFFICE_FORMATS:
            jpeg, _box, _size = capture.office_capture_file(
                source, f"source.{plan.format}", 1, None, _OFFICE_MAX_EDGE
            )
            from PIL import Image

            with Image.open(io.BytesIO(jpeg)) as page:
                return _webp(page.convert("RGB"))
        repaired = parser_client.repaired_pdf(artifact) if artifact else None
        return render_pdf(repaired if repaired is not None else source)
    if plan.route == ingest_plan.IMAGE_CAPTION:
        return render_image(source, plan.format)
    return None


def render_pdf(pdf: bytes | Path) -> bytes:
    import pymupdf
    from PIL import Image

    if isinstance(pdf, bytes):
        doc = pymupdf.open(stream=pdf, filetype="pdf")
    else:
        doc = pymupdf.open(pdf, filetype="pdf")
    with doc:
        page = doc[0]
        rect = page.rect
        scale = WIDTH / rect.width
        clip = pymupdf.Rect(
            rect.x0, rect.y0, rect.x1, rect.y0 + min(rect.height, _MAX_HEIGHT / scale)
        )
        pix = page.get_pixmap(
            matrix=pymupdf.Matrix(scale, scale), clip=clip, alpha=False
        )
        image = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
    return _webp(image)


def render_image(source: Path, format_name: str) -> bytes | None:
    """The first frame, oriented and flattened like captioning does."""
    from PIL import Image, ImageOps

    # SVG has no rasterizer here, and HEIC only with a Pillow plugin.
    if f".{format_name}" not in Image.registered_extensions():
        return None
    with warnings.catch_warnings():
        warnings.simplefilter("error", Image.DecompressionBombWarning)
        with Image.open(source) as opened:
            width, height = opened.size
            if width * height <= 0 or width * height > cfg.image_max_pixels:
                raise ValueError("image exceeds the decoded-pixel limit")
            # JPEG decodes at a reduced scale straight away.
            opened.draft("RGB", (2 * WIDTH, 2 * WIDTH))
            frame = ImageOps.exif_transpose(opened).convert("RGBA")
    flat = Image.new("RGB", frame.size, "white")
    flat.paste(frame, mask=frame.getchannel("A"))
    return _webp(flat)


def _webp(image) -> bytes:
    from PIL import Image

    if image.width > WIDTH:
        height = max(1, round(image.height * WIDTH / image.width))
        image = image.resize((WIDTH, height), Image.Resampling.LANCZOS)
    if image.height > _MAX_HEIGHT:
        image = image.crop((0, 0, image.width, _MAX_HEIGHT))
    buffer = io.BytesIO()
    image.save(buffer, "WEBP", quality=WEBP_QUALITY)
    return buffer.getvalue()


def key_for(file_id: str, data: bytes) -> str:
    return f"thumbs/{file_id}/{hashlib.sha256(data).hexdigest()}.webp"


def _store_thumbnail(file_id: str, source_sha256: str, data: bytes) -> None:
    key = key_for(file_id, data)
    with db.connect() as conn, conn.cursor() as cur:
        if db.file_thumbnail_key(cur, file_id) == key:
            return
    blobstore.put_object(key, data, "image/webp", CACHE_CONTROL)
    try:
        with db.connect() as conn, conn.cursor() as cur:
            stored = db.set_file_thumbnail(cur, file_id, source_sha256, key)
            conn.commit()
    except Exception:
        _release(key)
        raise
    if not stored:
        # The file was replaced, trashed or deleted meanwhile.
        _release(key)


def _release(key: str) -> None:
    with db.connect() as conn, conn.cursor() as cur:
        db.enqueue_blob_deletion(cur, key)
        conn.commit()


def _store_text_preview(file_id: str, source_sha256: str, source: Path) -> None:
    # A text-mode read counts characters, so the cut is never mid-character.
    with source.open(encoding="utf-8-sig", errors="replace") as handle:
        text = handle.read(TEXT_PREVIEW_CHARS)
    with db.connect() as conn, conn.cursor() as cur:
        # jsonb holds no NUL characters.
        db.set_file_text_preview(cur, file_id, source_sha256, text.replace("\x00", ""))
        conn.commit()
