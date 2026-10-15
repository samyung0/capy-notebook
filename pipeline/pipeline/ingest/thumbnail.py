"""Page-1 thumbnail, or the opening text, of a source for its list card.

A successful ingest ends here, before the local source is cleaned up. PDF and
Office files use the ``page1.png`` the parser rendered during the parse, in
its bounded child, from the PDF it held (the repaired bytes, or an Office
file's conversion), as the bundle's extraction wrote it: the worker never
renders or converts a document itself. Without that image (a reused donor or
identical indexed bytes, which build or extract no bundle, an older parser, a
failed render) the file shares the key of a file with the same bytes in the
same workspace only, if one has a thumbnail. Uploaded images go through Pillow. The 200 px wide WebP
is stored content-addressed at ``thumbs/{file id}/{sha256}.webp`` and
``files.thumbnail_key`` points at it; the blob triggers release the key it
replaces. Text sources store their first 600 characters in ``files.preview``
instead, while the upload is untouched: once the file has saved edits, every
save writes its preview. A source refresh publishes and ingests again, so an
edit replaces the page image.

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
from pathlib import Path

from ..config import cfg
from ..store import blobstore, db
from . import plan as ingest_plan

log = logging.getLogger("capy.thumbnail")

WIDTH = 200
WEBP_QUALITY = 60
TEXT_PREVIEW_CHARS = 600
CACHE_CONTROL = "public, max-age=31536000, immutable"
# Cards crop pages from the top; a page taller than this is cut there (the
# parser's page1.png follows the same rule, parser/odl/capture.py).
_MAX_HEIGHT = 2 * WIDTH


def capture_source(
    *,
    file_id: str,
    workspace_id: str,
    plan: ingest_plan.ProcessingPlan,
    local_path: str | None,
    source_sha256: str,
    page_image: bytes | None,
) -> None:
    """Store the thumbnail or text preview of the ingested bytes."""
    if not local_path:
        return
    started = time.monotonic()
    try:
        # Text and CSV/TSV: the opening characters, drawn as text or a table.
        if plan.route in (ingest_plan.RAW_TEXT, ingest_plan.DELIMITED_TEXT):
            _store_text_preview(file_id, source_sha256, Path(local_path))
            return
        if page_image is None and plan.route == ingest_plan.DOCUMENT_PARSE:
            # No page from the parse (reused bytes, or none rendered): the file
            # shares the key of a file with the same bytes.
            with db.connect() as conn, conn.cursor() as cur:
                db.share_file_thumbnail(cur, file_id, workspace_id, source_sha256)
                conn.commit()
            return
        data = render(plan, Path(local_path), page_image)
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
    page_image: bytes | None,
) -> bytes | None:
    """The WebP of page 1, or None for a route without one (store-only, raw or
    delimited text), a parse without a page image, or an image format this
    Pillow cannot decode."""
    if plan.route == ingest_plan.DOCUMENT_PARSE:
        return None if page_image is None else bundled_page(page_image)
    if plan.route == ingest_plan.IMAGE_CAPTION:
        return render_image(source, plan.format)
    return None


def bundled_page(png: bytes) -> bytes:
    """The parser's page image as the stored WebP. Its header is checked
    before any pixel is decoded: a PNG within the thumbnail's own size."""
    from PIL import Image

    with Image.open(io.BytesIO(png)) as image:
        if image.format != "PNG" or image.width > WIDTH or image.height > _MAX_HEIGHT:
            raise ValueError(f"bundled page image is {image.format} {image.size}")
        return _webp(image.convert("RGB"))


def render_image(source: Path, format_name: str) -> bytes | None:
    """The first frame, oriented, shrunk, then flattened on white like
    captioning does."""
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
            frame = ImageOps.exif_transpose(opened)
    # Shrink first, so the colour conversion and flattening work on the
    # thumbnail rather than the full image.
    frame.thumbnail((WIDTH, frame.height), Image.Resampling.LANCZOS)
    frame = frame.crop((0, 0, frame.width, min(frame.height, _MAX_HEIGHT)))
    rgba = frame.convert("RGBA")
    flat = Image.new("RGB", rgba.size, "white")
    flat.paste(rgba, mask=rgba.getchannel("A"))
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
