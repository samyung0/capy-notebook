"""Shared image-only payloads with live containing-resource reuse permissions."""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import secrets
from collections.abc import Awaitable, Callable
from contextlib import asynccontextmanager, contextmanager

from ..jobs import TerminalError
from ..retrieval import models, store
from ..store import blobstore
from ..store import db as sync_db

log = logging.getLogger("capy.parse.caption_cache")


_RESOURCES = """
WITH resources AS (
    SELECT f.id AS file_id, w.id AS workspace_id, w.privacy
    FROM files f JOIN workspaces w ON w.id = f.workspace_id
    JOIN users owner ON owner.id = w.user_id
    WHERE owner.deleted_at IS NULL AND owner.deletion_requested_at IS NULL
      AND f.trashed_at IS NULL
), target AS (
    SELECT * FROM resources WHERE file_id = %s
), eligible AS (
    SELECT c.caption_blob_path, c.size_bytes
    FROM image_caption_associations c
    JOIN resources donor ON donor.file_id = c.file_id
    CROSS JOIN target t
    WHERE c.image_sha256 = %s
      AND (donor.privacy IN ('link','public') OR donor.workspace_id = t.workspace_id)
    ORDER BY c.file_id = t.file_id DESC, c.id
    LIMIT 1
)
"""

_LOOKUP_INSERT = (
    _RESOURCES
    + """
INSERT INTO image_caption_associations
    (id,file_id,image_sha256,caption_blob_path,size_bytes,published)
SELECT %s,%s,%s,caption_blob_path,size_bytes,true FROM eligible
ON CONFLICT DO NOTHING RETURNING caption_blob_path,size_bytes
"""
)
_LOOKUP_OWN = "SELECT caption_blob_path,size_bytes FROM image_caption_associations WHERE file_id=%s AND image_sha256=%s"
_PROMOTE = "UPDATE image_caption_associations SET published=true WHERE file_id=%s AND image_sha256=%s"
_INSERT = """INSERT INTO image_caption_associations
    (id,file_id,image_sha256,caption_blob_path,size_bytes,published)
VALUES (%s,%s,%s,%s,%s,true) ON CONFLICT DO NOTHING"""


@contextmanager
def _ingest_cursor(file_id: str):
    source = sync_db.pipeline_source_for(file_id)
    if source is None or source.get("sourceRefresh") is True:
        raise sync_db.SourceSupersededError(
            "ordinary ingest source context is unavailable"
        )
    # Use the worker's existing lock order and commit cancellation even when a
    # completed upload is rejected. Caption attachment uses this same transaction.
    with sync_db.connect() as conn, conn.transaction(), conn.cursor() as cur:
        state = sync_db.lock_pipeline_claim_boundary(
            cur, job_id=source["_jobId"], attempt=source["_attempt"], payload=source
        )
        if state == "current":
            sync_db.require_current_file_source(
                cur,
                file_id,
                source["sourceRevision"],
                str(source.get("sourceETag") or ""),
            )
            yield cur
            return
    raise sync_db.SourceSupersededError(
        "ordinary ingest source or attempt was superseded"
    )


def _lookup_ingest(file_id: str, digest: str):
    with _ingest_cursor(file_id) as cur:
        # Grant a reference only while a readable containing file permits
        # reuse. A hash or an object-store cache hit alone grants nothing.
        cur.execute(
            _LOOKUP_INSERT,
            (file_id, digest, secrets.token_hex(16), file_id, digest),
        )
        row = cur.fetchone()
        if row is None:
            cur.execute(_LOOKUP_OWN, (file_id, digest))
            row = cur.fetchone()
        if row is not None:
            cur.execute(_PROMOTE, (file_id, digest))
            return {"caption_blob_path": row[0], "size_bytes": row[1]}
        return None


def _persist_ingest(file_id: str, digest: str, path: str, raw: bytes):
    with _ingest_cursor(file_id) as cur:
        cur.execute(_INSERT, (secrets.token_hex(16), file_id, digest, path, len(raw)))
        # The association owns the completed caption; this temporary upload
        # reference is needed only until the file is attached.
        cur.execute("DELETE FROM artifact_cache WHERE object_path=%s", (path,))
        cur.execute(_PROMOTE, (file_id, digest))


async def lookup(file_id: str, digest: str) -> tuple[str, str, int] | None:
    """A caption this ingest job's file may reuse, attached to it."""
    row = await asyncio.to_thread(_lookup_ingest, file_id, digest)
    return await _read_caption(row)


async def _read_caption(row):
    if row is None:
        return None
    path, size = str(row["caption_blob_path"]), int(row["size_bytes"])
    raw = await asyncio.to_thread(blobstore.read_bytes, path)
    if not raw:
        return None
    payload = json.loads(raw)
    text = str(payload.get("text") or "").strip()
    return (text, path, size) if text else None


@asynccontextmanager
async def _lock(file_id: str, digest: str):
    connection = None
    identity = f"image-caption:{file_id}:{digest}"
    try:
        db = await store.pool()
        async with db.connection() as conn:
            row = await (
                await conn.execute(
                    "SELECT 'workspace:' || workspace_id AS scope FROM files WHERE id=%s",
                    (file_id,),
                )
            ).fetchone()
            if row:
                identity = f"image-caption:{row['scope']}:{digest}"
        while connection is None:
            connection = await sync_db.try_source_artifact_lock_async(identity)
            if connection is None:
                await asyncio.sleep(0.1)
    except Exception:
        log.warning("caption cache lock unavailable", exc_info=True)
    try:
        yield
    finally:
        if connection is not None:
            try:
                await asyncio.to_thread(
                    sync_db.release_source_artifact_lock, connection, identity
                )
            except Exception:
                log.warning("could not release caption cache lock", exc_info=True)


async def _persist(file_id: str, digest: str, path: str, raw: bytes):
    db = await store.pool()
    # Record cleanup ownership before upload. A crash after the PUT must still
    # leave a reclaimable object even if its containing source was deleted.
    async with db.connection() as conn, conn.transaction():
        await conn.execute(
            """INSERT INTO artifact_cache(object_path,kind,source_sha256,size_bytes)
               VALUES(%s,'captions',%s,%s) ON CONFLICT(object_path)
               DO UPDATE SET last_used_at=now()""",
            (path, digest, len(raw)),
        )
    await asyncio.to_thread(blobstore.write_bytes, path, raw, "application/json")
    await asyncio.to_thread(_persist_ingest, file_id, digest, path, raw)


async def caption(
    *,
    file_id: str,
    image_sha256: str,
    data_url: str | Callable[[], Awaitable[str | None]],
    prompt: str,
) -> tuple[str, str, int, bool]:
    """Caption the image a standalone image file's ingest job holds, reusing an
    eligible caption first. Runs in the file's ordinary ingest job (bound by
    ``db.bind_source_refresh``)."""
    async with _lock(file_id, image_sha256):
        try:
            cached = await lookup(file_id, image_sha256)
        except TerminalError:
            raise
        except Exception:
            # Permission lookup failure is a miss, never a global object fallback.
            log.warning("caption reuse unavailable", exc_info=True)
            cached = None
        if cached:
            return *cached, True
        url = await data_url() if callable(data_url) else data_url
        if not url:
            return "", "", 0, False
        text = (await models.caption_image(url, prompt)).strip()
        if not text:
            return "", "", 0, False
        raw = json.dumps(
            {"text": text}, ensure_ascii=False, separators=(",", ":")
        ).encode()
        # Distinct private generations never overwrite one another. Equal payload
        # bytes still share physical storage, independently of their access grants.
        path = f"image-captions/{image_sha256}/{hashlib.sha256(raw).hexdigest()}.json"
        try:
            await _persist(file_id, image_sha256, path, raw)
        except TerminalError:
            raise
        except Exception:
            log.warning("could not retain image caption", exc_info=True)
            return text, "", 0, False
        return text, path, len(raw), False
