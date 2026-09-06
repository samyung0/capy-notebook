"""Async Postgres access for the retrieval index.

The schema is owned by ``server/migrations/0001_init.sql``; nothing here creates
tables. Both processes run on an event loop, so one async pool serves the ingest
worker and the retrieval service alike.
"""

from __future__ import annotations

import json
import logging
import secrets
import time
from typing import Any

from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from psycopg_pool import AsyncConnectionPool

from ..config import cfg
from ..jobs import RetryableError, TerminalError
from ..store import db as jobdb
from ..store.db import SourceSupersededError
from .chunking import QueryTerms
from .lang import TS_CONFIG

log = logging.getLogger("capy.retrieval.store")

_pool: AsyncConnectionPool | None = None


async def pool() -> AsyncConnectionPool:
    global _pool
    if _pool is None:
        _pool = AsyncConnectionPool(
            cfg.dsn,
            min_size=1,
            max_size=cfg.db_async_pool_max_size,
            open=False,
            kwargs={
                "row_factory": dict_row,
                "connect_timeout": 5,
                "options": "-c statement_timeout=60000",
            },
        )
        await _pool.open()
    return _pool


async def close_pool() -> None:
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None


def vector_literal(values: list[float]) -> str:
    """pgvector's text input format, cast to halfvec at the call site."""
    return "[" + ",".join(f"{v:.6g}" for v in values) + "]"


# Per pin, not per width. rag_chunk_vectors_2560 is the historical name for
# qwen-embed v1. A later model, including another 2560-d one, gets its own
# table and a new entry here.
_VECTOR_TABLES = {("deepinfra", "Qwen/Qwen3-Embedding-4B", 1): "rag_chunk_vectors_2560"}


def vector_table(provider_slug: str, model_slug: str, version: int) -> str:
    """The vector table for one embedding pin.

    Interpolated into SQL, so it is looked up rather than formatted: only pins
    that exist in the schema can ever reach a statement.
    """
    table = _VECTOR_TABLES.get((provider_slug, model_slug, int(version)))
    if table is None:
        raise RuntimeError(
            f"no vector table for {provider_slug}/{model_slug} v{version}; add one to "
            "0001_init.sql and _VECTOR_TABLES together"
        )
    return table


def vector_table_for_pin(pin: dict[str, Any]) -> str:
    return vector_table(
        pin["embedding_provider_slug"],
        pin["embedding_model_slug"],
        int(pin["embedding_model_version"]),
    )


async def workspace_embedding_pin(workspace_id: str) -> dict[str, Any]:
    """The embedding model this workspace's index lives in.

    Fixed at workspace creation and never updated, so ingest and query resolve
    the same space no matter when either process last restarted or what the
    registry default has moved to since. There is no reindex job, so this is the
    only answer either side is allowed to use.
    """
    db = await pool()
    async with db.connection() as conn:
        cur = await conn.execute(
            """
            SELECT embedding_provider_slug, embedding_model_slug,
                   embedding_model_version, embedding_dim
            FROM workspaces WHERE id = %s
            """,
            (workspace_id,),
        )
        row = await cur.fetchone()
    if row is None:
        raise TerminalError(f"workspace {workspace_id} has no embedding pin")
    return dict(row)


# --------------------------------------------------------------- chunk writes


async def existing_file_vectors(
    *, workspace_id: str, file_id: str, spec, inputs: list[str]
) -> dict[str, list[float]]:
    """Reuse only exact embedding input in this file's immutable model space."""
    table = vector_table(spec.provider_slug, spec.model_slug, spec.version)
    db = await pool()
    async with db.connection() as conn:
        cur = await conn.execute(
            f"""
            SELECT c.indexed_text, v.embedding::text AS embedding
            FROM rag_file_contents fc
            JOIN rag_contents rc ON rc.id = fc.content_id AND rc.status = 'ready'
            JOIN rag_chunks c ON c.content_id = rc.id
            JOIN {table} v ON v.chunk_id = c.id
            WHERE fc.file_id = %s AND fc.workspace_id = %s
              AND rc.embedding_provider_slug = %s AND rc.embedding_model_slug = %s
              AND rc.embedding_model_version = %s
              AND c.indexed_text = ANY(%s::text[])
            """,
            (
                file_id,
                workspace_id,
                spec.provider_slug,
                spec.model_slug,
                spec.version,
                inputs,
            ),
        )
        return {
            row["indexed_text"]: json.loads(row["embedding"])
            for row in await cur.fetchall()
        }


async def _lock_source_candidate(conn, refresh: dict[str, Any]) -> None:
    file_id = refresh["fileId"]
    await conn.execute(
        "SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", (file_id,)
    )
    cur = await conn.execute(
        "SELECT user_id FROM workspaces WHERE id=%s FOR SHARE",
        (refresh["workspaceId"],),
    )
    workspace = await cur.fetchone()
    if workspace is None:
        raise SourceSupersededError("source workspace was deleted")
    owner = str(workspace["user_id"])
    actors = sorted({owner, str(refresh["actorUserId"])})
    cur = await conn.execute(
        "SELECT id,deleted_at,suspended_at,deletion_requested_at FROM users WHERE id=ANY(%s) ORDER BY id FOR SHARE",
        (actors,),
    )
    accounts = await cur.fetchall()
    if len(accounts) != len(actors) or any(
        row["deleted_at"] or row["suspended_at"] or row["deletion_requested_at"]
        for row in accounts
    ):
        raise TerminalError("source account is unavailable")
    cur = await conn.execute(
        """SELECT 1 FROM workspaces w WHERE w.id=%s AND (w.user_id=%s OR
        EXISTS(SELECT 1 FROM workspace_members m WHERE m.workspace_id=w.id AND m.user_id=%s AND m.role='editor')
        OR(w.privacy IN ('link','public') AND w.share_role='editor'))""",
        (refresh["workspaceId"], refresh["actorUserId"], refresh["actorUserId"]),
    )
    if await cur.fetchone() is None:
        raise TerminalError("source editing access was revoked")
    cur = await conn.execute(
        """SELECT c.file_id FROM source_refresh_candidates c
        JOIN source_documents d ON d.file_id=c.file_id JOIN files f ON f.id=c.file_id
        JOIN jobs j ON j.id=c.job_id
        WHERE c.file_id=%s AND c.job_id=%s AND c.epoch=%s AND c.checkpoint=%s AND c.lease_token=%s
          AND d.epoch=c.epoch AND d.running_job_id=c.job_id AND d.base_revision=f.revision AND f.revision=%s
          AND f.workspace_id=%s AND f.user_id=%s AND j.payload->>'sourceETag'=%s
          AND (d.format='text' OR d.checkpoint=c.checkpoint)
          AND j.status='running' AND j.attempts=%s AND j.lease_expires_at>now()
        FOR UPDATE OF f,c,d,j""",
        (
            file_id,
            refresh["_jobId"],
            refresh["sourceEpoch"],
            refresh["sourceCheckpoint"],
            refresh["sourceLeaseToken"],
            refresh["sourceRevision"],
            refresh["workspaceId"],
            owner,
            refresh["sourceETag"],
            refresh["_attempt"],
        ),
    )
    if await cur.fetchone() is None:
        raise SourceSupersededError("source candidate was superseded")


async def attach_file_content(
    *,
    workspace_id: str,
    file_id: str,
    content_hash: str,
    source_sha256: str | None = None,
    pipeline_identity: str | None = None,
    claim_job_id: str | None = None,
    source_revision: int | None = None,
    source_etag: str = "",
) -> dict[str, Any]:
    """Attach a logical file to canonical workspace content.

    ``claim_job_id`` records who owns the claim when this call creates it. On
    conflict the existing owner is left alone: the caller is a waiter, and
    ``created=False`` is what tells it so.
    """
    content_id = f"rgc_{secrets.token_hex(8)}"
    refresh = jobdb.source_refresh_for(file_id)
    db = await pool()
    async with db.connection() as conn, conn.transaction():
        if refresh is not None:
            await _lock_source_candidate(conn, refresh)
        elif source_revision is not None:
            current = await conn.execute(
                """
                SELECT revision, COALESCE(source_etag, '') AS source_etag
                FROM files WHERE id = %s FOR UPDATE
                """,
                (file_id,),
            )
            source = await current.fetchone()
            if source is None:
                raise SourceSupersededError("ingest source no longer exists")
            if (
                int(source["revision"]) != int(source_revision)
                or str(source["source_etag"] or "") != source_etag
            ):
                raise SourceSupersededError(
                    "ingest source was superseded by a newer revision"
                )
        cur = await conn.execute(
            """
            INSERT INTO rag_contents
                (id, workspace_id, content_hash, status, source_sha256,
                 pipeline_identity, claim_job_id, updated_at)
            VALUES (%s, %s, %s, 'processing', %s, %s, %s, now())
            ON CONFLICT (workspace_id, content_hash) DO NOTHING
            RETURNING id, status, claim_job_id
            """,
            (
                content_id,
                workspace_id,
                content_hash,
                source_sha256,
                pipeline_identity,
                claim_job_id,
            ),
        )
        row = await cur.fetchone()
        created = row is not None
        if row is None:
            cur = await conn.execute(
                """
                SELECT id, status, claim_job_id FROM rag_contents
                WHERE workspace_id = %s AND content_hash = %s
                FOR UPDATE
                """,
                (workspace_id, content_hash),
            )
            row = await cur.fetchone()
        if row is None:
            raise RuntimeError("canonical retrieval content disappeared")
        if (
            not created
            and row["status"] != "ready"
            and claim_job_id
            and row["claim_job_id"] == claim_job_id
        ):
            created = True
        if refresh is not None:
            await conn.execute(
                "UPDATE source_refresh_candidates SET content_id=%s,content_hash=%s WHERE file_id=%s AND job_id=%s AND lease_token=%s",
                (
                    row["id"],
                    content_hash,
                    file_id,
                    refresh["_jobId"],
                    refresh["sourceLeaseToken"],
                ),
            )
        else:
            await conn.execute(
                """
                INSERT INTO rag_file_contents (file_id, workspace_id, content_id)
                VALUES (%s, %s, %s)
                ON CONFLICT (file_id) DO UPDATE SET
                    workspace_id = EXCLUDED.workspace_id,
                    content_id = EXCLUDED.content_id
                """,
                (file_id, workspace_id, row["id"]),
            )
        return {
            "content_id": row["id"],
            "ready": row["status"] == "ready",
            "created": created,
        }


async def steal_stale_content(
    *, workspace_id: str, content_hash: str, stale_s: int
) -> bool:
    """Drop a processing claim whose owning job is no longer alive.

    ``updated_at`` is only the floor so a heartbeat that just started is not
    stolen on a race. The death signal is the owner's job lease: a running job
    with ``lease_expires_at > now()`` still owns the row.
    """
    db = await pool()
    async with db.connection() as conn:
        cur = await conn.execute(
            """
            DELETE FROM rag_contents rc
            WHERE rc.workspace_id = %s AND rc.content_hash = %s
              AND rc.status = 'processing'
              AND rc.updated_at < now() - make_interval(secs => %s)
              AND NOT EXISTS (
                  SELECT 1 FROM jobs j
                  WHERE j.id = rc.claim_job_id
                    AND j.status = 'running'
                    AND j.lease_expires_at IS NOT NULL
                    AND j.lease_expires_at > now()
              )
            """,
            (workspace_id, content_hash, stale_s),
        )
        return bool(cur.rowcount)


async def find_ready_donor(
    *,
    workspace_id: str,
    source_sha256: str,
    pipeline_identity: str,
    embedding_provider_slug: str,
    embedding_model_slug: str,
    embedding_model_version: int,
    embedding_dim: int,
) -> dict[str, Any] | None:
    """A ready index of the same source bytes produced by the same pipeline.

    Prefers a donor already in this workspace's vector space so a retarget of
    the embedding default does not force every old workspace to re-embed a
    file that already exists in its pin. Falls back to any ready donor; the
    caller then copies text and re-embeds.
    """
    if not source_sha256 or not pipeline_identity:
        return None
    db = await pool()
    async with db.connection() as conn:
        cur = await conn.execute(
            """
            SELECT rc.id, rc.workspace_id, rc.content_hash,
                   rc.embedding_provider_slug, rc.embedding_model_slug,
                   rc.embedding_model_version, rc.embedding_dim,
                   preview.preview_blob_path
            FROM rag_contents rc
            LEFT JOIN LATERAL (
                SELECT f.preview_blob_path
                FROM rag_file_contents rfc
                JOIN files f ON f.id = rfc.file_id
                WHERE rfc.content_id = rc.id
                  AND f.preview_blob_path IS NOT NULL
                  AND f.source_sha256 = rc.source_sha256
                ORDER BY f.added_at DESC, f.id
                LIMIT 1
            ) preview ON true
            WHERE rc.source_sha256 = %s
              AND rc.pipeline_identity = %s
              AND rc.status = 'ready'
              AND EXISTS (
                  SELECT 1 FROM rag_file_contents holder
                  JOIN files f ON f.id = holder.file_id
                  JOIN workspaces w ON w.id = f.workspace_id
                  JOIN users owner ON owner.id = w.user_id
                  WHERE holder.content_id = rc.id
                    AND owner.deleted_at IS NULL AND owner.deletion_requested_at IS NULL
                    AND (w.id = %s OR w.privacy IN ('link','public'))
              )
            ORDER BY (
                rc.embedding_provider_slug = %s
                AND rc.embedding_model_slug = %s
                AND rc.embedding_model_version = %s
                AND rc.embedding_dim = %s
            ) DESC, rc.updated_at DESC
            LIMIT 1
            """,
            (
                source_sha256,
                pipeline_identity,
                workspace_id,
                embedding_provider_slug,
                embedding_model_slug,
                embedding_model_version,
                embedding_dim,
            ),
        )
        row = await cur.fetchone()
    return dict(row) if row else None


async def mark_content_ready(
    content_id: str, *, claim_job_id: str | None = None
) -> None:
    db = await pool()
    async with db.connection() as conn:
        if claim_job_id is None:
            await conn.execute(
                """
                UPDATE rag_contents
                SET status = 'ready', claim_job_id = NULL, updated_at = now()
                WHERE id = %s
                """,
                (content_id,),
            )
            return
        cur = await conn.execute(
            """
            UPDATE rag_contents
            SET status = 'ready', claim_job_id = NULL, updated_at = now()
            WHERE id = %s AND claim_job_id = %s
            """,
            (content_id, claim_job_id),
        )
        if not cur.rowcount:
            raise RetryableError("content claim taken over")


async def content_status(content_id: str) -> str | None:
    db = await pool()
    async with db.connection() as conn:
        cur = await conn.execute(
            "SELECT status FROM rag_contents WHERE id = %s", (content_id,)
        )
        row = await cur.fetchone()
        return str(row["status"]) if row else None


async def abandon_content(content_id: str) -> None:
    """Release a failed indexing claim so another upload can retry it."""
    db = await pool()
    async with db.connection() as conn:
        await conn.execute(
            "DELETE FROM rag_contents WHERE id = %s AND status = 'processing'",
            (content_id,),
        )


# Dest chunk ids are `'rc_' || substr(md5(dest_workspace_id || donor_chunk_id), 1, 12)`,
# matching CloneWorkspace in server/internal/store/share.go so the vector copy
# can recompute them and pair each embedding with its passage.
_NEW_CHUNK_ID_SQL = "'rc_' || substr(md5(%s || c.id), 1, 12)"


async def _attach_donor_captions(
    conn,
    *,
    donor_id: str,
    dest_workspace_id: str,
    dest_file_id: str,
    refresh: dict[str, Any] | None,
) -> None:
    await conn.execute(
        """
        INSERT INTO image_caption_associations
            (id,file_id,image_sha256,caption_blob_path,size_bytes,published)
        SELECT 'ica_' || md5(%s || c.id), %s, c.image_sha256,c.caption_blob_path,c.size_bytes,%s
        FROM image_caption_associations c
        JOIN rag_file_contents holder ON holder.file_id=c.file_id
        JOIN files f ON f.id=c.file_id JOIN workspaces w ON w.id=f.workspace_id
        JOIN users owner ON owner.id=w.user_id
        WHERE c.published AND holder.content_id=%s
          AND owner.deleted_at IS NULL AND owner.deletion_requested_at IS NULL
          AND (w.id=%s OR w.privacy IN ('link','public'))
        ON CONFLICT DO NOTHING
        """,
        (dest_file_id, dest_file_id, refresh is None, donor_id, dest_workspace_id),
    )
    if refresh is not None:
        await conn.execute(
            """UPDATE source_refresh_candidates candidate
            SET image_sha256s=ARRAY(SELECT DISTINCT c.image_sha256 FROM image_caption_associations c
            JOIN rag_file_contents holder ON holder.file_id=c.file_id
            JOIN files f ON f.id=c.file_id JOIN workspaces w ON w.id=f.workspace_id
            JOIN users owner ON owner.id=w.user_id
            WHERE c.published AND holder.content_id=%s
              AND owner.deleted_at IS NULL AND owner.deletion_requested_at IS NULL
              AND (w.id=%s OR w.privacy IN ('link','public')))
            WHERE candidate.file_id=%s AND candidate.job_id=%s AND candidate.lease_token=%s""",
            (
                donor_id,
                dest_workspace_id,
                dest_file_id,
                refresh["_jobId"],
                refresh["sourceLeaseToken"],
            ),
        )


async def attach_donor_captions(
    *, donor_id: str, dest_workspace_id: str, dest_file_id: str
) -> bool:
    """Attach caption ownership when canonical content is already ready."""
    refresh = jobdb.source_refresh_for(dest_file_id)
    db = await pool()
    async with db.connection() as conn, conn.transaction():
        if refresh is not None:
            await _lock_source_candidate(conn, refresh)
        cur = await conn.execute(
            """SELECT rc.id FROM rag_contents rc WHERE rc.id=%s AND rc.status='ready'
            AND EXISTS(SELECT 1 FROM rag_file_contents holder JOIN files f ON f.id=holder.file_id
            JOIN workspaces w ON w.id=f.workspace_id
            JOIN users owner ON owner.id=w.user_id
            WHERE holder.content_id=rc.id AND owner.deleted_at IS NULL AND owner.deletion_requested_at IS NULL
              AND (w.id=%s OR w.privacy IN ('link','public'))) FOR SHARE""",
            (donor_id, dest_workspace_id),
        )
        if await cur.fetchone() is None:
            return False
        await _attach_donor_captions(
            conn,
            donor_id=donor_id,
            dest_workspace_id=dest_workspace_id,
            dest_file_id=dest_file_id,
            refresh=refresh,
        )
    return True


async def copy_content_from_donor(
    *,
    donor_id: str,
    dest_content_id: str,
    dest_workspace_id: str,
    dest_file_id: str,
    copy_vectors: bool,
) -> bool:
    """Copy a ready donor's index into this workspace's content row.

    Mirrors CloneWorkspace. Returns False if the donor vanished under FOR SHARE
    (workspace delete) so the caller can fall through to parsing.
    """
    refresh = jobdb.source_refresh_for(dest_file_id)
    db = await pool()
    async with db.connection() as conn, conn.transaction():
        if refresh is not None:
            await _lock_source_candidate(conn, refresh)
        cur = await conn.execute(
            """
            SELECT id, workspace_id, content_hash, source_sha256, pipeline_identity,
                   embedding_provider_slug, embedding_model_slug,
                   embedding_model_version, embedding_dim
            FROM rag_contents rc
            WHERE id = %s AND status = 'ready'
              AND EXISTS (
                SELECT 1 FROM rag_file_contents holder JOIN files f ON f.id=holder.file_id
                JOIN workspaces w ON w.id=f.workspace_id
                JOIN users owner ON owner.id=w.user_id
                WHERE holder.content_id=rc.id AND owner.deleted_at IS NULL AND owner.deletion_requested_at IS NULL
                  AND (w.id=%s OR w.privacy IN ('link','public'))
              )
            FOR SHARE
            """,
            (donor_id, dest_workspace_id),
        )
        donor = await cur.fetchone()
        if donor is None:
            return False
        await _attach_donor_captions(
            conn,
            donor_id=donor_id,
            dest_workspace_id=dest_workspace_id,
            dest_file_id=dest_file_id,
            refresh=refresh,
        )
        if donor_id == dest_content_id:
            return True
        pin = donor
        table = None
        if copy_vectors:
            table = vector_table_for_pin(pin)

        # INSERT..SELECT keeps tsvector/jsonb typed and derives dest chunk ids
        # in SQL, the same shape as cloneRetrievalIndex.
        await conn.execute(
            "DELETE FROM rag_chunks WHERE content_id = %s", (dest_content_id,)
        )
        await conn.execute(
            f"""
            INSERT INTO rag_chunks (
                id, workspace_id, content_id, chunk_idx, section_path, text,
                indexed_text, token_count, page_start, page_end, regions, lang,
                search
            )
            SELECT {_NEW_CHUNK_ID_SQL},
                   %s, %s, c.chunk_idx, c.section_path, c.text, c.indexed_text,
                   c.token_count, c.page_start, c.page_end, c.regions, c.lang,
                   c.search
            FROM rag_chunks c
            WHERE c.content_id = %s
            """,
            (dest_workspace_id, dest_workspace_id, dest_content_id, donor_id),
        )
        if copy_vectors and table:
            await conn.execute(
                f"""
                INSERT INTO {table} (chunk_id, workspace_id, embedding)
                SELECT {_NEW_CHUNK_ID_SQL}, %s, v.embedding
                FROM rag_chunks c
                JOIN {table} v ON v.chunk_id = c.id
                WHERE c.content_id = %s
                """,
                (dest_workspace_id, dest_workspace_id, donor_id),
            )

        await conn.execute(
            """
            INSERT INTO rag_content_summaries
                (content_id, workspace_id, fingerprint, descriptor, summary,
                 summary_version, updated_at)
            SELECT %s, %s, s.fingerprint, s.descriptor, s.summary,
                   s.summary_version, s.updated_at
            FROM rag_content_summaries s
            WHERE s.content_id = %s
            ON CONFLICT (content_id) DO UPDATE SET
                fingerprint = EXCLUDED.fingerprint,
                descriptor = EXCLUDED.descriptor,
                summary = EXCLUDED.summary,
                summary_version = EXCLUDED.summary_version,
                updated_at = EXCLUDED.updated_at
            """,
            (dest_content_id, dest_workspace_id, donor_id),
        )

        await conn.execute(
            """
            UPDATE rag_contents SET
                source_sha256 = %s,
                pipeline_identity = %s,
                embedding_provider_slug = CASE WHEN %s THEN %s ELSE embedding_provider_slug END,
                embedding_model_slug = CASE WHEN %s THEN %s ELSE embedding_model_slug END,
                embedding_model_version = CASE WHEN %s THEN %s ELSE embedding_model_version END,
                embedding_dim = CASE WHEN %s THEN %s ELSE embedding_dim END,
                updated_at = now()
            WHERE id = %s
            """,
            (
                pin["source_sha256"],
                pin["pipeline_identity"],
                copy_vectors,
                pin["embedding_provider_slug"],
                copy_vectors,
                pin["embedding_model_slug"],
                copy_vectors,
                pin["embedding_model_version"],
                copy_vectors,
                pin["embedding_dim"],
                dest_content_id,
            ),
        )
    return True


async def load_content_chunks(content_id: str) -> list[dict[str, Any]]:
    db = await pool()
    async with db.connection() as conn:
        cur = await conn.execute(
            """
            SELECT id, chunk_idx, section_path, text, indexed_text, token_count,
                   page_start, page_end, regions, lang,
                   search = ''::tsvector AS reference
            FROM rag_chunks WHERE content_id = %s
            ORDER BY chunk_idx
            """,
            (content_id,),
        )
        return [dict(row) for row in await cur.fetchall()]


async def replace_content_chunks(
    *,
    workspace_id: str,
    content_id: str,
    rows: list[dict[str, Any]],
    claim_job_id: str | None = None,
) -> None:
    """Swap in canonical content chunks atomically.

    Delete-then-insert rather than upsert-by-index: a re-ingest that produces
    fewer chunks must not leave the tail of the previous run behind.

    The vector table and the provenance written onto the content row both come
    from the workspace's own pin, read here rather than passed in, so a caller
    that embedded with the wrong model cannot also record the wrong model.

    ``claim_job_id`` is the fencing token. Holding the content row FOR UPDATE
    for the insert loop is what stops a waiter from deleting it mid-write.
    """
    pin = await workspace_embedding_pin(workspace_id)
    table = vector_table_for_pin(pin)
    db = await pool()
    async with db.connection() as conn, conn.transaction():
        if claim_job_id is not None:
            cur = await conn.execute(
                """
                SELECT claim_job_id FROM rag_contents
                WHERE id = %s
                FOR UPDATE
                """,
                (content_id,),
            )
            owned = await cur.fetchone()
            if owned is None or owned["claim_job_id"] != claim_job_id:
                raise RetryableError("content claim taken over")
        await conn.execute(
            "DELETE FROM rag_chunks WHERE content_id = %s", (content_id,)
        )
        for row in rows:
            await conn.execute(
                """
                    INSERT INTO rag_chunks (
                        id, workspace_id, content_id, chunk_idx, section_path, text,
                        indexed_text, token_count, page_start, page_end, regions,
                        lang, search
                    ) VALUES (
                        %(id)s, %(workspace_id)s, %(content_id)s, %(chunk_idx)s,
                        %(section_path)s, %(text)s, %(indexed_text)s, %(token_count)s,
                        %(page_start)s, %(page_end)s, %(regions)s, %(lang)s,
                        to_tsvector(%(ts_config)s::regconfig, %(search_text)s)
                    )
                    """,
                {
                    **row,
                    "ts_config": TS_CONFIG[row["lang"]],
                    "workspace_id": workspace_id,
                    "content_id": content_id,
                    "regions": Jsonb(row["regions"]),
                },
            )
            # A vector of the wrong width is rejected by the column type, which
            # is the point of splitting these tables: a same-width model from a
            # different space is not detectable here, and is prevented instead by
            # the workspace pin being immutable.
            await conn.execute(
                f"""
                    INSERT INTO {table} (chunk_id, workspace_id, embedding)
                    VALUES (%(id)s, %(workspace_id)s, %(embedding)s::halfvec)
                    """,
                {
                    "id": row["id"],
                    "workspace_id": workspace_id,
                    "embedding": row["embedding"],
                },
            )
        await conn.execute(
            """
            UPDATE rag_contents SET
                embedding_provider_slug = %s,
                embedding_model_slug = %s,
                embedding_model_version = %s,
                embedding_dim = %s
            WHERE id = %s
            """,
            (
                pin["embedding_provider_slug"] if rows else None,
                pin["embedding_model_slug"] if rows else None,
                pin["embedding_model_version"] if rows else None,
                pin["embedding_dim"] if rows else None,
                content_id,
            ),
        )


async def upsert_content_summary(
    *,
    workspace_id: str,
    content_id: str,
    fingerprint: str,
    descriptor: str,
    summary: str,
    summary_version: int = 1,
) -> None:
    db = await pool()
    async with db.connection() as conn:
        await conn.execute(
            """
            INSERT INTO rag_content_summaries
                (content_id, workspace_id, fingerprint, descriptor, summary,
                 summary_version, updated_at)
            VALUES (%s, %s, %s, %s, %s, %s, now())
            ON CONFLICT (content_id) DO UPDATE SET
                workspace_id    = EXCLUDED.workspace_id,
                fingerprint     = EXCLUDED.fingerprint,
                descriptor      = EXCLUDED.descriptor,
                summary         = EXCLUDED.summary,
                summary_version = EXCLUDED.summary_version,
                updated_at      = now()
            """,
            (
                content_id,
                workspace_id,
                fingerprint,
                descriptor,
                summary,
                summary_version,
            ),
        )


async def content_fingerprint(content_id: str) -> str:
    db = await pool()
    async with db.connection() as conn:
        cur = await conn.execute(
            "SELECT fingerprint FROM rag_content_summaries WHERE content_id = %s",
            (content_id,),
        )
        row = await cur.fetchone()
        return str(row["fingerprint"]) if row else ""


# ---------------------------------------------------------------- search


_RRF_K = 60

# Lexical ranks count half as much as vector ranks in the fusion. Measured on
# the lab corpus (IB biology PDFs, 19 questions): equal weights let a passage
# that merely repeats common query words outrank the passage the embedding put
# first by a wide margin, and hits@5 went 22 -> 26 of 28 at 0.5, matching
# vector-only. The lexical half stays for exact identifiers the embedding
# blurs (names, codes, rare terms), not as an equal vote.
#
# At half weight a lexical-only candidate can never reach the top: its best
# score (0.5 / 61) is below every vector candidate's (1 / (60 + n) for n up to
# the candidate count). That is intended for partial matches. A passage that
# contains every term of a two- or three-term query is different evidence —
# 'Figure 3.20' or 'River Namsen' names one place in the corpus — so those rows
# count at full weight and can outrank a vector-only candidate. Longer queries
# are questions, and a passage that repeats every word of a question echoes
# its phrasing rather than answering it: on the lab corpus 'What is convergent
# evolution? Give an example' at full weight pulled up a cladogram passage that
# happened to say "give", "example", "convergent" and "evolution". Terms are
# counted as typed (each CJK run once, however many bigrams the tokenizer made
# of it), and the query must carry no function word of the chunk's language:
# a lookup is content only ('Figure 3.20', 'Table 3 OSCAR', '图1 CIL'), a
# question has function words. Counting after stopword removal instead let
# 'What is CamemBERT trained on?' shrink to two terms under the english
# configuration and promote English bibliography rows on a French corpus.
_LEX_WEIGHT = 0.5
_LOOKUP_TERMS = (2, 3)

# Each chunk is indexed with its own language's configuration (rag_chunks.lang,
# lang.TS_CONFIG), so the query is parsed once per language present in the
# scope and matched against the chunks of that language. A French query
# against English chunks is parsed by the english stemmer and misses, which is
# what should happen: the vector leg carries cross-language questions.
_SEARCH_SQL_TEMPLATE = """
WITH scoped_files AS (
        SELECT DISTINCT ON (fc.content_id)
                     fc.content_id, f.id AS file_id, f.name AS file_name
        FROM rag_file_contents fc
        JOIN rag_contents rc ON rc.id = fc.content_id AND rc.status = 'ready'
        JOIN files f ON f.id = fc.file_id
        WHERE fc.workspace_id = %(ws)s
            AND (%(no_filter)s OR f.id = ANY(%(file_ids)s))
        ORDER BY fc.content_id, f.added_at, f.id
),
vec AS (
    SELECT c.id, v.embedding <=> %(vector)s::halfvec AS dist,
           row_number() OVER (ORDER BY v.embedding <=> %(vector)s::halfvec) AS rank
        FROM {vector_table} v
        JOIN rag_chunks c ON c.id = v.chunk_id
        JOIN scoped_files sf ON sf.content_id = c.content_id
        WHERE v.workspace_id = %(ws)s
    ORDER BY v.embedding <=> %(vector)s::halfvec
    LIMIT %(candidates)s
),
q AS (
    SELECT m.lang,
           websearch_to_tsquery(m.cfg::regconfig, %(any_of)s) AS any_of,
           websearch_to_tsquery(m.cfg::regconfig, %(all_of)s) AS all_of,
           %(terms)s BETWEEN %(lookup_min)s AND %(lookup_max)s
             AND coalesce(array_length(tsvector_to_array(
                   to_tsvector(m.cfg::regconfig, %(latin)s)), 1), 0)
               = coalesce(array_length(tsvector_to_array(
                   to_tsvector('simple', %(latin)s)), 1), 0) AS lookup
      FROM unnest(%(langs)s::text[], %(cfgs)s::text[]) AS m(lang, cfg)
),
lex AS (
    SELECT c.id,
           row_number() OVER (
               ORDER BY (c.search @@ q.all_of) DESC,
                        ts_rank_cd(c.search, q.any_of) DESC
           ) AS rank,
           (c.search @@ q.all_of AND q.lookup) AS exact
        FROM rag_chunks c
        JOIN scoped_files sf ON sf.content_id = c.content_id
        JOIN q ON q.lang = c.lang
    WHERE c.workspace_id = %(ws)s
      AND c.search @@ q.any_of
    ORDER BY (c.search @@ q.all_of) DESC, ts_rank_cd(c.search, q.any_of) DESC
    LIMIT %(candidates)s
),
fused AS (
    SELECT id, sum(score) AS score, sum(flat) AS flat_score FROM (
        SELECT id, 1.0 / (%(rrf_k)s + rank) AS score,
               1.0 / (%(rrf_k)s + rank) AS flat
          FROM vec
        UNION ALL
        SELECT id,
               CASE WHEN exact THEN 1.0 ELSE %(lex_weight)s END / (%(rrf_k)s + rank)
                   AS score,
               %(lex_weight)s / (%(rrf_k)s + rank) AS flat
          FROM lex
    ) parts GROUP BY id
)
SELECT c.id, sf.file_id, c.chunk_idx, c.section_path, c.text, c.page_start,
       c.page_end, c.regions, c.lang, sf.file_name, fused.score, fused.flat_score,
       vec.rank AS vec_rank, vec.dist AS vec_dist, lex.rank AS lex_rank
FROM fused
JOIN rag_chunks c ON c.id = fused.id
JOIN scoped_files sf ON sf.content_id = c.content_id
LEFT JOIN vec ON vec.id = fused.id
LEFT JOIN lex ON lex.id = fused.id
ORDER BY fused.score DESC
LIMIT %(candidates)s
"""


async def hybrid_search(
    *,
    workspace_id: str,
    vector: list[float],
    terms: QueryTerms,
    file_ids: list[str] | None,
    candidates: int,
) -> list[dict[str, Any]]:
    """Vector + lexical search fused with reciprocal rank fusion.

    RRF rather than a weighted score sum because the two scales are not
    comparable and never will be: cosine distance and ts_rank_cd have no shared
    unit, so any weight would be a tuning constant that drifts with the corpus.
    Ranks are unitless.

    The vector table comes from the workspace pin, not from a width: two
    models of the same dimension do not share a table. The lexical half is
    model-independent and always reads rag_chunks.

    Lexical candidates match any term; those matching every term rank first.
    On the lab corpus 'Figure 3.20' by OR alone ranked every passage that says
    'figure' above the one that says '3.20', because a rare token adds little
    to ts_rank_cd against a frequent one. The AND tier is what makes the
    lexical leg earn its place for identifiers, names, and codes.

    Rows carry the per-leg evidence (``vec_rank``, ``vec_dist``, ``lex_rank``)
    and ``flat_score``, the fusion with every lexical row at half weight, so
    the caller can tell which hits the exact tier put there.
    """
    pin = await workspace_embedding_pin(workspace_id)
    db = await pool()
    sql = _SEARCH_SQL_TEMPLATE.format(vector_table=vector_table_for_pin(pin))
    async with db.connection() as conn:
        cur = await conn.execute(
            sql,
            {
                "ws": workspace_id,
                "vector": vector_literal(vector),
                "any_of": terms.any_of,
                "all_of": terms.all_of,
                "latin": terms.latin,
                "terms": terms.terms,
                "lookup_min": _LOOKUP_TERMS[0],
                "lookup_max": _LOOKUP_TERMS[1],
                "langs": list(TS_CONFIG),
                "cfgs": list(TS_CONFIG.values()),
                "file_ids": list(file_ids or []),
                "no_filter": not file_ids,
                "candidates": candidates,
                "rrf_k": _RRF_K,
                "lex_weight": _LEX_WEIGHT,
            },
        )
        return [dict(row) for row in await cur.fetchall()]


# ------------------------------------------------------------- search telemetry

_SEARCH_EVENT_COLUMNS = (
    "trace_id",
    "workspace_id",
    "actor_user_id",
    "message_id",
    "search_index",
    "hits_lang",
    "query_terms",
    "cjk_runs",
    "scope_files",
    "embed_ms",
    "sql_ms",
    "hits",
    "prior_overlap",
    "chunk_ids",
    "file_ids",
    "chunk_langs",
    "vec_ranks",
    "lex_ranks",
    "vec_dists",
    "tier_only",
    "cited",
)
_SEARCH_EVENTS_RETENTION = "90 days"
_search_events_pruned_at = 0.0


async def record_search_events(events: list[dict[str, Any]]) -> None:
    """Append one row per search of a finished turn (see rag_search_events).

    Pruning rides on the write path, at most once an hour per process, so no
    separate sweeper is needed for a table this small.
    """
    global _search_events_pruned_at
    if not events:
        return
    columns = ", ".join(_SEARCH_EVENT_COLUMNS)
    placeholders = ", ".join(f"%({name})s" for name in _SEARCH_EVENT_COLUMNS)
    db = await pool()
    async with db.connection() as conn:
        async with conn.cursor() as cur:
            await cur.executemany(
                f"INSERT INTO rag_search_events ({columns}) VALUES ({placeholders})",
                events,
            )
        now = time.monotonic()
        if now - _search_events_pruned_at >= 3600:
            _search_events_pruned_at = now
            await conn.execute(
                "DELETE FROM rag_search_events WHERE created_at < now() - %s::interval",
                (_SEARCH_EVENTS_RETENTION,),
            )


# ------------------------------------------------------- structure & summaries


async def workspace_outline(workspace_id: str) -> dict[str, Any]:
    """Chapters, their files, and the per-file descriptor the listing tool prints."""
    db = await pool()
    async with db.connection() as conn:
        cur = await conn.execute(
            """
            SELECT ch.id, ch.name
            FROM chapters ch
            WHERE ch.workspace_id = %s
            ORDER BY ch.position, ch.id
            """,
            (workspace_id,),
        )
        chapters = [dict(row) for row in await cur.fetchall()]

        cur = await conn.execute(
            """
                 SELECT f.id, f.name, f.chapter_id, f.status,
                     coalesce(cs.descriptor, '') AS descriptor,
                     coalesce(cs.summary, '') AS summary,
                     (SELECT count(*) FROM rag_chunks c
                      JOIN rag_file_contents rfc ON rfc.content_id = c.content_id
                      WHERE rfc.file_id = f.id) AS chunks
            FROM files f
                 LEFT JOIN rag_file_contents fc ON fc.file_id = f.id
                 LEFT JOIN rag_content_summaries cs ON cs.content_id = fc.content_id
            WHERE f.workspace_id = %s
            ORDER BY f.position, f.added_at
            """,
            (workspace_id,),
        )
        files = [dict(row) for row in await cur.fetchall()]

    return {"chapters": chapters, "files": files}


async def file_summaries(
    workspace_id: str, file_ids: list[str]
) -> list[dict[str, Any]]:
    if not file_ids:
        return []
    db = await pool()
    async with db.connection() as conn:
        cur = await conn.execute(
            """
            SELECT f.id, f.name, coalesce(cs.descriptor, '') AS descriptor,
                   coalesce(cs.summary, '') AS summary
            FROM files f
            LEFT JOIN rag_file_contents fc ON fc.file_id = f.id
            LEFT JOIN rag_content_summaries cs ON cs.content_id = fc.content_id
            WHERE f.workspace_id = %s AND f.id = ANY(%s)
            """,
            (workspace_id, file_ids),
        )
        rows = [dict(row) for row in await cur.fetchall()]
    by_id = {row["id"]: row for row in rows}
    return [by_id[fid] for fid in file_ids if fid in by_id]


async def file_ids_for_names(workspace_id: str, names: list[str]) -> list[str]:
    if not names:
        return []
    db = await pool()
    async with db.connection() as conn:
        cur = await conn.execute(
            "SELECT id FROM files WHERE workspace_id = %s AND name = ANY(%s)",
            (workspace_id, names),
        )
        return [row["id"] for row in await cur.fetchall()]


async def read_file_range(
    *, workspace_id: str, file_id: str, start: int, count: int
) -> list[dict[str, Any]]:
    db = await pool()
    async with db.connection() as conn:
        cur = await conn.execute(
            """
            SELECT c.id, fc.file_id, c.chunk_idx, c.section_path, c.text, c.page_start,
                   c.page_end, c.regions, f.name AS file_name
            FROM rag_file_contents fc
            JOIN files f ON f.id = fc.file_id
            JOIN rag_chunks c ON c.content_id = fc.content_id
            WHERE f.workspace_id = %s AND fc.file_id = %s AND c.chunk_idx >= %s
            ORDER BY c.chunk_idx
            LIMIT %s
            """,
            (workspace_id, file_id, start, count),
        )
        return [dict(row) for row in await cur.fetchall()]


def decode_regions(value: Any) -> list[dict[str, Any]]:
    if isinstance(value, list):
        return value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            return []
        return parsed if isinstance(parsed, list) else []
    return []
