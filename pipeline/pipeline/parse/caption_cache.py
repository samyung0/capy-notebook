"""Shared image-only payloads with live containing-resource reuse permissions."""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import secrets
from collections.abc import Awaitable, Callable
from contextlib import asynccontextmanager, contextmanager
from dataclasses import dataclass

from ..jobs import TerminalError
from ..retrieval import models, store
from ..store import blobstore
from ..store import db as sync_db

log = logging.getLogger("capy.parse.caption_cache")


@dataclass(frozen=True)
class SourceChange:
    workspace_id: str
    user_id: str
    epoch: int
    checkpoint: int
    change_id: str


class SourceChangeUnavailable(ValueError):
    """The captured image is no longer an authorized attachment target."""


async def _lock_source_refresh(conn, file_id: str, job_id: str):
    refresh = sync_db.source_refresh_for(file_id)
    if refresh is None or refresh.get("_jobId") != job_id:
        raise sync_db.SourceSupersededError("source candidate context is unavailable")
    await store._lock_source_candidate(conn, refresh)


async def _lock_source_change(conn, file_id: str, digest: str, source: SourceChange):
    def unavailable():
        return SourceChangeUnavailable(
            "The source image changed or is no longer accessible."
        )

    await conn.execute(
        "SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", (file_id,)
    )
    workspace = await (
        await conn.execute(
            "SELECT user_id,privacy FROM workspaces WHERE id=%s FOR SHARE",
            (source.workspace_id,),
        )
    ).fetchone()
    if workspace is None or not source.user_id:
        raise unavailable()
    owner = workspace["user_id"]
    actors = sorted({owner, source.user_id})
    accounts = await (
        await conn.execute(
            "SELECT id,deleted_at,deletion_requested_at,suspended_at FROM users WHERE id=ANY(%s) ORDER BY id FOR SHARE",
            (actors,),
        )
    ).fetchall()
    if len(accounts) != len(actors) or any(
        row["deleted_at"] or row["deletion_requested_at"] or row["suspended_at"]
        for row in accounts
    ):
        raise unavailable()
    if source.user_id != owner and workspace["privacy"] not in {"link", "public"}:
        member = await (
            await conn.execute(
                "SELECT 1 FROM workspace_members WHERE workspace_id=%s AND user_id=%s FOR SHARE",
                (source.workspace_id, source.user_id),
            )
        ).fetchone()
        if member is None:
            raise unavailable()
    row = await (
        await conn.execute(
            """SELECT d.pending_effects FROM source_documents d JOIN files f ON f.id=d.file_id
        WHERE f.id=%s AND f.workspace_id=%s AND f.user_id=%s
          AND d.epoch=%s AND d.checkpoint=%s AND d.base_revision=f.revision
        FOR SHARE OF f,d""",
            (file_id, source.workspace_id, owner, source.epoch, source.checkpoint),
        )
    ).fetchone()
    if row is None:
        raise unavailable()
    effects = [
        effect
        for effect in row["pending_effects"]
        if isinstance(effect, dict) and effect.get("id") == source.change_id
    ]
    if (
        len(effects) != 1
        or effects[0].get("imageSHA256") != digest
        or not effects[0].get("assetRef")
    ):
        raise unavailable()


_RESOURCES = """
WITH resources AS (
    SELECT f.id AS file_id, NULL::text AS asset_id, w.id AS workspace_id,
           w.user_id AS owner_id, w.privacy
    FROM files f JOIN workspaces w ON w.id = f.workspace_id
    JOIN users owner ON owner.id = w.user_id
    WHERE owner.deleted_at IS NULL AND owner.deletion_requested_at IS NULL
    UNION ALL
    SELECT NULL, a.id, w.id, COALESCE(w.user_id, m.owner_user_id),
           COALESCE(w.privacy, m.privacy)
    FROM editor_assets a
    LEFT JOIN materials m ON m.id = a.material_id
    LEFT JOIN workspaces w ON w.id = COALESCE(a.workspace_id, m.workspace_id)
    JOIN users owner ON owner.id = COALESCE(w.user_id, m.owner_user_id)
    WHERE a.status = 'ready'
      AND owner.deleted_at IS NULL AND owner.deletion_requested_at IS NULL
), target AS (
    SELECT * FROM resources WHERE file_id = %s OR asset_id = %s
), eligible AS (
    SELECT c.caption_blob_path, c.size_bytes
    FROM image_caption_associations c
    JOIN resources donor ON donor.file_id = c.file_id OR donor.asset_id = c.editor_asset_id
    CROSS JOIN target t
    WHERE c.image_sha256 = %s AND (
        donor.privacy IN ('link','public')
        OR (t.workspace_id IS NOT NULL AND donor.workspace_id = t.workspace_id)
        OR (t.workspace_id IS NULL AND donor.workspace_id IS NULL AND donor.owner_id = t.owner_id)
    )
    ORDER BY (c.file_id = t.file_id OR c.editor_asset_id = t.asset_id) DESC NULLS LAST, c.id
    LIMIT 1
)
"""

_LOOKUP_INSERT = (
    _RESOURCES
    + """
INSERT INTO image_caption_associations
    (id,file_id,editor_asset_id,image_sha256,caption_blob_path,size_bytes,published)
SELECT %s,%s,%s,%s,caption_blob_path,size_bytes,%s FROM eligible
ON CONFLICT DO NOTHING RETURNING caption_blob_path,size_bytes
"""
)
_LOOKUP_OWN = "SELECT caption_blob_path,size_bytes FROM image_caption_associations WHERE (file_id=%s OR editor_asset_id=%s) AND image_sha256=%s"
_PROMOTE = "UPDATE image_caption_associations SET published=true WHERE (file_id=%s OR editor_asset_id=%s) AND image_sha256=%s"
_INSERT = """INSERT INTO image_caption_associations
    (id,file_id,editor_asset_id,image_sha256,caption_blob_path,size_bytes,published)
VALUES (%s,%s,%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING"""


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
        cur.execute(
            _LOOKUP_INSERT,
            (file_id, None, digest, secrets.token_hex(16), file_id, None, digest, True),
        )
        row = cur.fetchone()
        if row is None:
            cur.execute(_LOOKUP_OWN, (file_id, None, digest))
            row = cur.fetchone()
        if row is not None:
            cur.execute(_PROMOTE, (file_id, None, digest))
            return {"caption_blob_path": row[0], "size_bytes": row[1]}
        return None


def _persist_ingest(file_id: str, digest: str, path: str, raw: bytes):
    with _ingest_cursor(file_id) as cur:
        cur.execute(
            _INSERT,
            (secrets.token_hex(16), file_id, None, digest, path, len(raw), True),
        )
        cur.execute("DELETE FROM artifact_cache WHERE object_path=%s", (path,))
        cur.execute(_PROMOTE, (file_id, None, digest))


async def lookup(
    file_id: str | None,
    asset_id: str | None,
    digest: str,
    published: bool,
    *,
    source_change: SourceChange | None = None,
    source_refresh_job_id: str | None = None,
    require_source_job: bool = False,
) -> tuple[str, str, int] | None:
    if require_source_job:
        if (
            not file_id
            or asset_id is not None
            or not published
            or source_change
            or source_refresh_job_id
        ):
            raise ValueError(
                "An ordinary ingest caption needs a published file source."
            )
        row = await asyncio.to_thread(_lookup_ingest, file_id, digest)
        return await _read_caption(row)
    db = await store.pool()
    async with db.connection() as conn, conn.transaction():
        if source_change is not None:
            if not file_id or asset_id is not None:
                raise ValueError("A source change must belong to a file.")
            await _lock_source_change(conn, file_id, digest, source_change)
        if source_refresh_job_id is not None:
            await _lock_source_refresh(conn, file_id, source_refresh_job_id)
        # Grant a reference only while a readable containing resource permits
        # reuse. A hash or an object-store cache hit alone grants nothing.
        cur = await conn.execute(
            _LOOKUP_INSERT,
            (
                file_id,
                asset_id,
                digest,
                secrets.token_hex(16),
                file_id,
                asset_id,
                digest,
                published,
            ),
        )
        row = await cur.fetchone()
        if row is None:
            cur = await conn.execute(
                _LOOKUP_OWN,
                (file_id, asset_id, digest),
            )
            row = await cur.fetchone()
        if row is None:
            return None
        if published:
            await conn.execute(
                _PROMOTE,
                (file_id, asset_id, digest),
            )

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
async def _lock(file_id: str | None, asset_id: str | None, digest: str):
    connection = None
    identity = f"image-caption:{file_id or asset_id}:{digest}"
    try:
        db = await store.pool()
        async with db.connection() as conn:
            row = await (
                await conn.execute(
                    """
                SELECT 'workspace:' || workspace_id AS scope FROM files WHERE id=%s
                UNION ALL
                SELECT CASE WHEN COALESCE(a.workspace_id,m.workspace_id) IS NOT NULL
                    THEN 'workspace:' || COALESCE(a.workspace_id,m.workspace_id)
                    ELSE 'owner:' || m.owner_user_id END
                FROM editor_assets a LEFT JOIN materials m ON m.id=a.material_id WHERE a.id=%s
                """,
                    (file_id, asset_id),
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


async def _persist(
    file_id: str | None,
    asset_id: str | None,
    digest: str,
    path: str,
    raw: bytes,
    published: bool,
    *,
    source_change: SourceChange | None = None,
    source_refresh_job_id: str | None = None,
    require_source_job: bool = False,
):
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
    if require_source_job:
        await asyncio.to_thread(_persist_ingest, file_id, digest, path, raw)
        return
    async with db.connection() as conn, conn.transaction():
        if source_change is not None:
            await _lock_source_change(conn, file_id, digest, source_change)
        if source_refresh_job_id is not None:
            await _lock_source_refresh(conn, file_id, source_refresh_job_id)
        await conn.execute(
            _INSERT,
            (
                secrets.token_hex(16),
                file_id,
                asset_id,
                digest,
                path,
                len(raw),
                published,
            ),
        )
        # Resource associations own completed captions; this temporary upload
        # reference is needed only until the containing resource is attached.
        await conn.execute("DELETE FROM artifact_cache WHERE object_path=%s", (path,))
        if published:
            await conn.execute(
                "UPDATE image_caption_associations SET published=true WHERE (file_id=%s OR editor_asset_id=%s) AND image_sha256=%s",
                (file_id, asset_id, digest),
            )


async def _consume(file_id: str, job_id: str, digest: str):
    db = await store.pool()
    async with db.connection() as conn, conn.transaction():
        await _lock_source_refresh(conn, file_id, job_id)
        await conn.execute(
            """UPDATE source_refresh_candidates
               SET image_sha256s=array_append(image_sha256s,%s)
               WHERE file_id=%s AND job_id=%s AND NOT (%s=ANY(image_sha256s))""",
            (digest, file_id, job_id, digest),
        )


async def caption(
    *,
    file_id: str | None = None,
    editor_asset_id: str | None = None,
    image_sha256: str,
    data_url: str | Callable[[], Awaitable[str | None]],
    prompt: str,
    best_effort: bool = True,
    published: bool = True,
    source_refresh_job_id: str | None = None,
    source_change: SourceChange | None = None,
    require_source_job: bool = False,
) -> tuple[str, str, int, bool]:
    if bool(file_id) == bool(editor_asset_id):
        raise ValueError("A caption needs exactly one containing resource.")
    if source_refresh_job_id and (not file_id or published):
        raise ValueError(
            "A refresh caption must belong to an unpublished file candidate."
        )
    if source_change is not None and (
        not file_id or published or source_refresh_job_id
    ):
        raise ValueError(
            "A pending source caption needs its own unpublished file identity."
        )
    if not published and not source_refresh_job_id and source_change is None:
        raise ValueError("An unpublished caption needs a source change or refresh job.")
    async with _lock(file_id, editor_asset_id, image_sha256):
        result = await _caption(
            file_id=file_id,
            editor_asset_id=editor_asset_id,
            image_sha256=image_sha256,
            data_url=data_url,
            prompt=prompt,
            best_effort=best_effort,
            published=published,
            source_change=source_change,
            source_refresh_job_id=source_refresh_job_id,
            require_source_job=require_source_job,
        )
        if result[0] and source_refresh_job_id and file_id:
            # Cache hits also belong to the candidate. Publication promotes
            # exactly this set and releases captions for the retired source.
            await _consume(file_id, source_refresh_job_id, image_sha256)
        return result


async def _caption(
    *,
    file_id: str | None,
    editor_asset_id: str | None,
    image_sha256: str,
    data_url: str | Callable[[], Awaitable[str | None]],
    prompt: str,
    best_effort: bool,
    published: bool,
    source_change: SourceChange | None,
    source_refresh_job_id: str | None,
    require_source_job: bool,
) -> tuple[str, str, int, bool]:
    try:
        cached = await lookup(
            file_id,
            editor_asset_id,
            image_sha256,
            published,
            source_change=source_change,
            source_refresh_job_id=source_refresh_job_id,
            require_source_job=require_source_job,
        )
    except (SourceChangeUnavailable, TerminalError):
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
    text = (await models.caption_image(url, prompt, best_effort=best_effort)).strip()
    if not text:
        return "", "", 0, False
    raw = json.dumps({"text": text}, ensure_ascii=False, separators=(",", ":")).encode()
    # Distinct private generations never overwrite one another. Equal payload
    # bytes still share physical storage, independently of their access grants.
    path = f"image-captions/{image_sha256}/{hashlib.sha256(raw).hexdigest()}.json"
    try:
        await _persist(
            file_id,
            editor_asset_id,
            image_sha256,
            path,
            raw,
            published,
            source_change=source_change,
            source_refresh_job_id=source_refresh_job_id,
            require_source_job=require_source_job,
        )
    except (SourceChangeUnavailable, TerminalError):
        raise
    except Exception:
        log.warning("could not retain image caption", exc_info=True)
        return text, "", 0, False
    return text, path, len(raw), False
