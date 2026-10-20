"""Page-1 thumbnail, or the opening text, of a source for its list card.

A successful ingest ends here, before the local source is cleaned up. PDF and
Office files use the ``page1.png`` the parser rendered during the parse, in
its bounded child, from the PDF it held (the repaired bytes, or an Office
file's conversion), as the bundle's extraction wrote it: the worker never
renders or converts a document itself. Without that image (a reused donor or
identical indexed bytes, which build or extract no bundle, an older parser, a
failed render) the file shares the key of a file with the same bytes in the
same workspace only, if one has a thumbnail. Uploaded images go through
Pillow in the sandboxed decode helper (ingest/decode.py), as does the
bundle's page image. The 200 px wide WebP
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
import logging
import time
from pathlib import Path

from ..config import cfg
from ..store import blobstore, db
from . import decode
from . import plan as ingest_plan

log = logging.getLogger("capy.thumbnail")

TEXT_PREVIEW_CHARS = 600
CACHE_CONTROL = "public, max-age=31536000, immutable"


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
        return None if page_image is None else decode.page_webp(page_image)
    if plan.route == ingest_plan.IMAGE_CAPTION:
        return decode.thumbnail_webp(
            source, plan.format, max_pixels=cfg.image_max_pixels
        )
    return None


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
