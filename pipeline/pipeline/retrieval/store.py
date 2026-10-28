"""Async Postgres access for the retrieval index.

The schema is owned by ``server/migrations/0001_init.sql``; nothing here creates
tables. Both processes run on an event loop, so one async pool serves the ingest
worker and the retrieval service alike.
"""

from __future__ import annotations

import json
import logging
import re
import secrets
import time
from datetime import datetime
from typing import Any

from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from psycopg_pool import AsyncConnectionPool

from ..config import cfg
from ..jobs import RetryableError, TerminalError
from ..store import db as jobdb
from ..store.db import SourceSupersededError
from .chunking import Chunk, QueryTerms, search_query_terms, tokenize_for_search
from .lang import TS_CONFIG, detect_lang

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
    *, workspace_id: str | None, file_id: str, spec, inputs: list[str]
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
            WHERE fc.file_id = %s AND fc.workspace_id IS NOT DISTINCT FROM %s
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


async def existing_content_vectors(
    *, workspace_id: str, content_id: str, spec, inputs: list[str]
) -> dict[str, list[float]]:
    """Reuse exact embedding input from one ready content row: a note's
    previous index, read before the alias moves and the orphan trigger drops it."""
    table = vector_table(spec.provider_slug, spec.model_slug, spec.version)
    db = await pool()
    async with db.connection() as conn:
        cur = await conn.execute(
            f"""
            SELECT c.indexed_text, v.embedding::text AS embedding
            FROM rag_contents rc
            JOIN rag_chunks c ON c.content_id = rc.id
            JOIN {table} v ON v.chunk_id = c.id
            WHERE rc.id = %s AND rc.workspace_id = %s AND rc.status = 'ready'
              AND rc.embedding_provider_slug = %s AND rc.embedding_model_slug = %s
              AND rc.embedding_model_version = %s
              AND c.indexed_text = ANY(%s::text[])
            """,
            (
                content_id,
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


async def attach_material_content(
    *,
    workspace_id: str,
    material_id: str,
    content_hash: str,
    claim_job_id: str,
    blocks: list[dict[str, Any]],
) -> dict[str, Any]:
    """Claim canonical workspace content for a note, like attach_file_content
    without a source revision: the note's projection is the only version.

    The alias moves now only onto content that is already ready. A new claim
    is aliased by ``publish_material_content`` once it is ready, so the old
    index keeps serving search and lends its vectors until then. ``blocks``
    is the per-block index text the content was chunked from (Go's
    MaterialIndexText.Blocks); it moves with the alias."""
    content_id = f"rgc_{secrets.token_hex(8)}"
    db = await pool()
    async with db.connection() as conn, conn.transaction():
        cur = await conn.execute(
            "SELECT content_id FROM rag_material_contents WHERE material_id = %s",
            (material_id,),
        )
        previous = await cur.fetchone()
        cur = await conn.execute(
            """
            INSERT INTO rag_contents
                (id, workspace_id, content_hash, status, claim_job_id, updated_at)
            VALUES (%s, %s, %s, 'processing', %s, now())
            ON CONFLICT (workspace_id, content_hash) DO NOTHING
            RETURNING id, status, claim_job_id
            """,
            (content_id, workspace_id, content_hash, claim_job_id),
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
            and row["claim_job_id"] == claim_job_id
        ):
            created = True
        ready = row["status"] == "ready"
        if ready:
            await _alias_material_content(
                conn, material_id, workspace_id, row["id"], blocks
            )
        return {
            "content_id": row["id"],
            "previous_content_id": previous["content_id"] if previous else None,
            "ready": ready,
            "created": created,
        }


async def publish_material_content(
    *,
    workspace_id: str,
    material_id: str,
    content_id: str,
    claim_job_id: str,
    blocks: list[dict[str, Any]],
) -> None:
    """Mark a note's claimed content ready and move its alias in one
    transaction; the orphan trigger then drops the previous content."""
    db = await pool()
    async with db.connection() as conn, conn.transaction():
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
        await _alias_material_content(
            conn, material_id, workspace_id, content_id, blocks
        )


async def _alias_material_content(
    conn,
    material_id: str,
    workspace_id: str,
    content_id: str,
    blocks: list[dict[str, Any]],
) -> None:
    # The blocks become the note's indexed_blocks, the baseline Go measures
    # its pending changes against (Epo 2026-10-17); its pending tokens and
    # cached changes (Q415) are measured again.
    await conn.execute(
        "UPDATE materials SET indexed_blocks = %s, pending_tokens = NULL,"
        " effects_cache = NULL WHERE id = %s",
        (Jsonb(blocks), material_id),
    )
    await conn.execute(
        """
        INSERT INTO rag_material_contents (material_id, workspace_id, content_id)
        VALUES (%s, %s, %s)
        ON CONFLICT (material_id) DO UPDATE SET
            workspace_id = EXCLUDED.workspace_id,
            content_id = EXCLUDED.content_id
        """,
        (material_id, workspace_id, content_id),
    )


async def _lock_source_candidate(conn, refresh: dict[str, Any]) -> None:
    """Fence an attach to the live candidate. Saves made after the capture
    stay pending against it (deferred publication), so a newer checkpoint
    passes, as in the heartbeat's boundary fence."""
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
    # The file's payer (uploader pays) is set once at insert; fence it too.
    cur = await conn.execute("SELECT user_id FROM files WHERE id=%s", (file_id,))
    payer = await cur.fetchone()
    actors = sorted(
        {owner, str(refresh["actorUserId"])}
        | ({str(payer["user_id"])} if payer else set())
    )
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
        OR(w.privacy IN ('link','public') AND w.share_role='editor' AND (w.privacy='public'
          OR EXISTS(SELECT 1 FROM workspace_members m WHERE m.workspace_id=w.id AND m.user_id=%s)
          OR EXISTS(SELECT 1 FROM workspace_link_grants g WHERE g.workspace_id=w.id AND g.user_id=%s))))""",
        (
            refresh["workspaceId"],
            refresh["actorUserId"],
            refresh["actorUserId"],
            refresh["actorUserId"],
            refresh["actorUserId"],
        ),
    )
    if await cur.fetchone() is None:
        raise TerminalError("source editing access was revoked")
    cur = await conn.execute(
        """SELECT c.file_id FROM source_refresh_candidates c
        JOIN source_documents d ON d.file_id=c.file_id JOIN files f ON f.id=c.file_id
        JOIN jobs j ON j.id=c.job_id
        WHERE c.file_id=%s AND c.job_id=%s AND c.epoch=%s AND c.checkpoint=%s AND c.lease_token=%s
          AND d.epoch=c.epoch AND d.running_job_id=c.job_id AND d.base_revision=f.revision AND f.revision=%s
          AND f.workspace_id=%s AND f.trashed_at IS NULL AND j.payload->>'sourceETag'=%s
          AND d.checkpoint>=c.checkpoint
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
            refresh["sourceETag"],
            refresh["_attempt"],
        ),
    )
    if await cur.fetchone() is None:
        raise SourceSupersededError("source candidate was superseded")


async def _lock_file_source(
    conn, file_id: str, source_revision: int, source_etag: str
) -> None:
    """Fence an alias write to the file revision the job ingests."""
    current = await conn.execute(
        """
        SELECT revision, COALESCE(source_etag, '') AS source_etag
        FROM files WHERE id = %s AND trashed_at IS NULL FOR UPDATE
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
        raise SourceSupersededError("ingest source was superseded by a newer revision")


def _content_scope(
    workspace_id: str | None, owner_user_id: str | None, alias: str = ""
) -> tuple[str, str]:
    """The rag_contents predicate for one scope and its parameter: a
    workspace, or a standalone file's owner (todo-standalone-files.md)."""
    if workspace_id:
        return f"{alias}workspace_id = %s", workspace_id
    if not owner_user_id:
        raise TerminalError("standalone content has no owner")
    return f"{alias}workspace_id IS NULL AND {alias}user_id = %s", owner_user_id


async def attach_file_content(
    *,
    workspace_id: str | None,
    file_id: str,
    content_hash: str,
    source_sha256: str | None = None,
    pipeline_identity: str | None = None,
    claim_job_id: str | None = None,
    source_revision: int | None = None,
    source_etag: str = "",
    owner_user_id: str | None = None,
) -> dict[str, Any]:
    """Attach a logical file to canonical content in its scope: its
    workspace, or for a standalone file (no workspace) ``owner_user_id``.

    ``claim_job_id`` records who owns the claim when this call creates it. On
    conflict the existing owner is left alone: the caller is a waiter, and
    ``created=False`` is what tells it so.

    The file's alias moves now unless it serves ready content and the attached
    content is not ready yet: a re-ingest keeps the previous index searchable
    (and lending its vectors and descriptor to ``index_file``) until
    ``publish_file_content``, so a failed retry leaves it in place.
    """
    content_id = f"rgc_{secrets.token_hex(8)}"
    scope_sql, scope_arg = _content_scope(workspace_id, owner_user_id)
    refresh = jobdb.source_refresh_for(file_id)
    db = await pool()
    async with db.connection() as conn, conn.transaction():
        if refresh is not None:
            await _lock_source_candidate(conn, refresh)
        elif source_revision is not None:
            await _lock_file_source(conn, file_id, source_revision, source_etag)
        # No conflict target: the scope's unique key is (workspace_id,
        # content_hash), or the owner's partial twin for standalone content.
        cur = await conn.execute(
            """
            INSERT INTO rag_contents
                (id, workspace_id, user_id, content_hash, status, source_sha256,
                 pipeline_identity, claim_job_id, updated_at)
            VALUES (%s, %s, %s, %s, 'processing', %s, %s, %s, now())
            ON CONFLICT DO NOTHING
            RETURNING id, status, claim_job_id
            """,
            (
                content_id,
                workspace_id or None,
                None if workspace_id else owner_user_id,
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
                f"""
                SELECT id, status, claim_job_id FROM rag_contents
                WHERE {scope_sql} AND content_hash = %s
                FOR UPDATE
                """,
                (scope_arg, content_hash),
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
                WHERE %s OR NOT EXISTS (
                    SELECT 1 FROM rag_contents served
                    WHERE served.id = rag_file_contents.content_id
                      AND served.status = 'ready'
                )
                """,
                (file_id, workspace_id, row["id"], row["status"] == "ready"),
            )
        return {
            "content_id": row["id"],
            "ready": row["status"] == "ready",
            "created": created,
        }


async def publish_file_content(
    *,
    workspace_id: str | None,
    file_id: str,
    content_id: str,
    claim_job_id: str,
    source_revision: int | None = None,
    source_etag: str = "",
) -> None:
    """Mark a file's claimed content ready and move its alias onto it in one
    transaction; the orphan trigger then drops the previous content. A source
    refresh's candidate is only marked ready: Go's publication aliases it."""
    refresh = jobdb.source_refresh_for(file_id)
    db = await pool()
    async with db.connection() as conn, conn.transaction():
        if refresh is None and source_revision is not None:
            await _lock_file_source(conn, file_id, source_revision, source_etag)
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
        if refresh is None:
            await conn.execute(
                """
                INSERT INTO rag_file_contents (file_id, workspace_id, content_id)
                VALUES (%s, %s, %s)
                ON CONFLICT (file_id) DO UPDATE SET
                    workspace_id = EXCLUDED.workspace_id,
                    content_id = EXCLUDED.content_id
                WHERE rag_file_contents.content_id <> EXCLUDED.content_id
                """,
                (file_id, workspace_id, content_id),
            )


async def steal_stale_content(
    *,
    workspace_id: str | None,
    content_hash: str,
    stale_s: int,
    owner_user_id: str | None = None,
) -> bool:
    """Drop a processing claim whose owning job is no longer alive.

    ``updated_at`` is only the floor so a heartbeat that just started is not
    stolen on a race. The death signal is the owner's job lease: a running job
    with ``lease_expires_at > now()`` still owns the row, and so does a clone's
    index_copy job waiting in its queue or for a retry, which claimed the row
    when the clone was made (Epo 2026-10-28).
    """
    scope_sql, scope_arg = _content_scope(workspace_id, owner_user_id, "rc.")
    db = await pool()
    async with db.connection() as conn:
        cur = await conn.execute(
            f"""
            DELETE FROM rag_contents rc
            WHERE {scope_sql} AND rc.content_hash = %s
              AND rc.status = 'processing'
              AND rc.updated_at < now() - make_interval(secs => %s)
              AND NOT EXISTS (
                  SELECT 1 FROM jobs j
                  WHERE j.id = rc.claim_job_id
                    AND ((j.status = 'running'
                          AND j.lease_expires_at IS NOT NULL
                          AND j.lease_expires_at > now())
                      OR (j.type = 'index_copy' AND j.status = 'pending'))
              )
            """,
            (scope_arg, content_hash, stale_s),
        )
        return bool(cur.rowcount)


# A donor's content is visible to a destination while a live file holds it:
# the destination workspace or a shared one for a workspace file, the owner's
# own standalone files for a standalone file (no workspace). The two never
# cross. ``holder`` is the rag_file_contents row; the arguments are
# _holder_args(dest workspace, dest owner).
_HOLDER_JOINS = """JOIN files f ON f.id = holder.file_id
    LEFT JOIN workspaces w ON w.id = f.workspace_id
    JOIN users owner ON owner.id = COALESCE(w.user_id, f.user_id)"""
_HOLDER_LIVE = """f.trashed_at IS NULL
    AND owner.deleted_at IS NULL AND owner.deletion_requested_at IS NULL
    AND CASE WHEN %s::text IS NULL
        THEN f.workspace_id IS NULL AND f.user_id = %s
        ELSE w.id = %s OR w.privacy IN ('link','public') END"""


def _holder_args(
    workspace_id: str | None, owner_user_id: str | None
) -> tuple[str | None, str | None, str | None]:
    if not workspace_id and not owner_user_id:
        raise TerminalError("standalone content has no owner")
    workspace_id = workspace_id or None
    return workspace_id, None if workspace_id else owner_user_id, workspace_id


async def find_ready_donor(
    *,
    workspace_id: str | None,
    source_sha256: str,
    pipeline_identity: str,
    embedding_provider_slug: str,
    embedding_model_slug: str,
    embedding_model_version: int,
    embedding_dim: int,
    owner_user_id: str | None = None,
) -> dict[str, Any] | None:
    """A ready index of the same source bytes produced by the same pipeline,
    visible to this scope (``_HOLDER_LIVE``).

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
            f"""
            SELECT rc.id, rc.workspace_id, rc.content_hash,
                   rc.embedding_provider_slug, rc.embedding_model_slug,
                   rc.embedding_model_version, rc.embedding_dim
            FROM rag_contents rc
            WHERE rc.source_sha256 = %s
              AND rc.pipeline_identity = %s
              AND rc.status = 'ready'
              AND EXISTS (
                  SELECT 1 FROM rag_file_contents holder
                  {_HOLDER_JOINS}
                  WHERE holder.content_id = rc.id AND {_HOLDER_LIVE}
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
                *_holder_args(workspace_id, owner_user_id),
                embedding_provider_slug,
                embedding_model_slug,
                embedding_model_version,
                embedding_dim,
            ),
        )
        row = await cur.fetchone()
    return dict(row) if row else None


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


# Dest chunk ids are `'rc_' || substr(md5(dest_content_id || donor_chunk_id), 1, 12)`
# so the vector copy can recompute them and pair each embedding with its
# passage. The new content id is unique on its own, so the ids stay unique
# after a Move re-tags content into another workspace (Epo 2026-10-28), as in
# Go's clones (copyRetrievalContents in server/internal/store/share.go).
_NEW_CHUNK_ID_SQL = "'rc_' || substr(md5(%s || c.id), 1, 12)"


async def _attach_donor_captions(
    conn,
    *,
    donor_id: str,
    dest_workspace_id: str | None,
    dest_owner_user_id: str | None,
    dest_file_id: str,
    refresh: dict[str, Any] | None,
) -> None:
    holder = _holder_args(dest_workspace_id, dest_owner_user_id)
    await conn.execute(
        f"""
        INSERT INTO image_caption_associations
            (id,file_id,image_sha256,caption_blob_path,size_bytes,published)
        SELECT 'ica_' || md5(%s || c.id), %s, c.image_sha256,c.caption_blob_path,c.size_bytes,%s
        FROM image_caption_associations c
        JOIN rag_file_contents holder ON holder.file_id=c.file_id
        {_HOLDER_JOINS}
        WHERE c.published AND holder.content_id=%s AND {_HOLDER_LIVE}
        ON CONFLICT DO NOTHING
        """,
        (dest_file_id, dest_file_id, refresh is None, donor_id, *holder),
    )
    if refresh is not None:
        await conn.execute(
            f"""UPDATE source_refresh_candidates candidate
            SET image_sha256s=ARRAY(SELECT DISTINCT c.image_sha256 FROM image_caption_associations c
            JOIN rag_file_contents holder ON holder.file_id=c.file_id
            {_HOLDER_JOINS}
            WHERE c.published AND holder.content_id=%s AND {_HOLDER_LIVE})
            WHERE candidate.file_id=%s AND candidate.job_id=%s AND candidate.lease_token=%s""",
            (
                donor_id,
                *holder,
                dest_file_id,
                refresh["_jobId"],
                refresh["sourceLeaseToken"],
            ),
        )


async def attach_donor_captions(
    *,
    donor_id: str,
    dest_workspace_id: str | None,
    dest_file_id: str,
    owner_user_id: str | None = None,
) -> bool:
    """Attach caption ownership when canonical content is already ready.
    ``owner_user_id`` names a standalone destination's owner."""
    refresh = jobdb.source_refresh_for(dest_file_id)
    db = await pool()
    async with db.connection() as conn, conn.transaction():
        if refresh is not None:
            await _lock_source_candidate(conn, refresh)
        cur = await conn.execute(
            f"""SELECT rc.id FROM rag_contents rc WHERE rc.id=%s AND rc.status='ready'
            AND EXISTS(SELECT 1 FROM rag_file_contents holder {_HOLDER_JOINS}
            WHERE holder.content_id=rc.id AND {_HOLDER_LIVE}) FOR SHARE""",
            (donor_id, *_holder_args(dest_workspace_id, owner_user_id)),
        )
        if await cur.fetchone() is None:
            return False
        await _attach_donor_captions(
            conn,
            donor_id=donor_id,
            dest_workspace_id=dest_workspace_id,
            dest_owner_user_id=owner_user_id,
            dest_file_id=dest_file_id,
            refresh=refresh,
        )
    return True


async def copy_content_from_donor(
    *,
    donor_id: str,
    dest_content_id: str,
    dest_workspace_id: str | None,
    dest_file_id: str,
    copy_vectors: bool,
    owner_user_id: str | None = None,
) -> bool:
    """Copy a ready donor's index into this scope's content row: the
    workspace's, or a standalone file's owner's (``owner_user_id``).

    Mirrors CloneWorkspace. Returns False if the donor vanished under FOR SHARE
    (workspace delete) so the caller can fall through to parsing.
    """
    refresh = jobdb.source_refresh_for(dest_file_id)
    db = await pool()
    async with db.connection() as conn, conn.transaction():
        if refresh is not None:
            await _lock_source_candidate(conn, refresh)
        cur = await conn.execute(
            f"""
            SELECT id, workspace_id, content_hash, source_sha256, pipeline_identity,
                   embedding_provider_slug, embedding_model_slug,
                   embedding_model_version, embedding_dim
            FROM rag_contents rc
            WHERE id = %s AND status = 'ready'
              AND EXISTS (
                SELECT 1 FROM rag_file_contents holder {_HOLDER_JOINS}
                WHERE holder.content_id=rc.id AND {_HOLDER_LIVE}
              )
            FOR SHARE
            """,
            (donor_id, *_holder_args(dest_workspace_id, owner_user_id)),
        )
        donor = await cur.fetchone()
        if donor is None:
            return False
        await _attach_donor_captions(
            conn,
            donor_id=donor_id,
            dest_workspace_id=dest_workspace_id,
            dest_owner_user_id=owner_user_id,
            dest_file_id=dest_file_id,
            refresh=refresh,
        )
        if donor_id == dest_content_id:
            return True
        pin = donor
        table = None
        if copy_vectors:
            table = vector_table_for_pin(pin)
        salt = dest_content_id

        # INSERT..SELECT keeps tsvector/jsonb typed and derives dest chunk ids
        # in SQL, the same shape as cloneRetrievalIndex.
        await conn.execute(
            "DELETE FROM rag_chunks WHERE content_id = %s", (dest_content_id,)
        )
        await conn.execute(
            f"""
            INSERT INTO rag_chunks (
                id, content_id, chunk_idx, section_path, text,
                indexed_text, token_count, page_start, page_end, regions, lang,
                search, confidence, confidence_reasons
            )
            SELECT {_NEW_CHUNK_ID_SQL},
                   %s, c.chunk_idx, c.section_path, c.text, c.indexed_text,
                   c.token_count, c.page_start, c.page_end, c.regions, c.lang,
                   c.search, c.confidence, c.confidence_reasons
            FROM rag_chunks c
            WHERE c.content_id = %s
            """,
            (salt, dest_content_id, donor_id),
        )
        if copy_vectors and table:
            await conn.execute(
                f"""
                INSERT INTO {table} (chunk_id, content_id, embedding)
                SELECT {_NEW_CHUNK_ID_SQL}, %s, v.embedding
                FROM rag_chunks c
                JOIN {table} v ON v.chunk_id = c.id
                WHERE c.content_id = %s
                """,
                (salt, dest_content_id, donor_id),
            )

        await conn.execute(
            """
            INSERT INTO rag_content_summaries
                (content_id, fingerprint, descriptor, change_share, updated_at,
                 lang, search)
            SELECT %s, s.fingerprint, s.descriptor, s.change_share,
                   s.updated_at, s.lang, s.search
            FROM rag_content_summaries s
            WHERE s.content_id = %s
            ON CONFLICT (content_id) DO UPDATE SET
                fingerprint = EXCLUDED.fingerprint,
                descriptor = EXCLUDED.descriptor,
                change_share = EXCLUDED.change_share,
                updated_at = EXCLUDED.updated_at,
                lang = EXCLUDED.lang,
                search = EXCLUDED.search
            """,
            (dest_content_id, donor_id),
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
                   page_start, page_end, regions, lang, confidence,
                   confidence_reasons, search = ''::tsvector AS reference
            FROM rag_chunks WHERE content_id = %s
            ORDER BY chunk_idx
            """,
            (content_id,),
        )
        return [dict(row) for row in await cur.fetchall()]


async def replace_content_chunks(
    *,
    workspace_id: str | None,
    content_id: str,
    rows: list[dict[str, Any]],
    claim_job_id: str | None = None,
    pin: dict[str, Any] | None = None,
) -> None:
    """Swap in canonical content chunks atomically.

    Delete-then-insert rather than upsert-by-index: a re-ingest that produces
    fewer chunks must not leave the tail of the previous run behind.

    The vector table and the provenance written onto the content row both come
    from the workspace's own pin, read here rather than passed in, so a caller
    that embedded with the wrong model cannot also record the wrong model.

    A standalone file (no workspace) passes ``pin``, the space its job
    resolved and embedded in (todo-standalone-files.md).

    ``claim_job_id`` is the fencing token. Holding the content row FOR UPDATE
    for the insert loop is what stops a waiter from deleting it mid-write.
    """
    if workspace_id:
        pin = await workspace_embedding_pin(workspace_id)
    elif pin is None:
        raise TerminalError("standalone content has no embedding pin")
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
                        id, content_id, chunk_idx, section_path, text,
                        indexed_text, token_count, page_start, page_end, regions,
                        lang, search, confidence, confidence_reasons
                    ) VALUES (
                        %(id)s, %(content_id)s, %(chunk_idx)s,
                        %(section_path)s, %(text)s, %(indexed_text)s, %(token_count)s,
                        %(page_start)s, %(page_end)s, %(regions)s, %(lang)s,
                        to_tsvector(%(ts_config)s::regconfig, %(search_text)s),
                        %(confidence)s, %(confidence_reasons)s
                    )
                    """,
                {
                    **row,
                    "ts_config": TS_CONFIG[row["lang"]],
                    "content_id": content_id,
                    "regions": Jsonb(row["regions"]),
                    "confidence": row.get("confidence"),
                    "confidence_reasons": list(row.get("confidence_reasons") or []),
                },
            )
            # A vector of the wrong width is rejected by the column type, which
            # is the point of splitting these tables: a same-width model from a
            # different space is not detectable here, and is prevented instead by
            # the workspace pin being immutable.
            await conn.execute(
                f"""
                    INSERT INTO {table} (chunk_id, content_id, embedding)
                    VALUES (%(id)s, %(content_id)s, %(embedding)s::halfvec)
                    """,
                {
                    "id": row["id"],
                    "content_id": content_id,
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


def summary_search_text(descriptor: str) -> tuple[str, str, str]:
    """A summary's language, its text-search configuration and its tokenized
    text, as a passage's (account chat's summary search, Epo 2026-10-28)."""
    lang = detect_lang(descriptor)
    return lang, TS_CONFIG[lang], tokenize_for_search(descriptor)


async def upsert_content_summary(
    *,
    content_id: str,
    fingerprint: str,
    descriptor: str,
    change_share: float,
    written_at: datetime | None = None,
) -> None:
    """``updated_at`` is when the descriptor was written: ``written_at`` for a
    reused one, else now."""
    lang, config, text = summary_search_text(descriptor)
    db = await pool()
    async with db.connection() as conn:
        await conn.execute(
            """
            INSERT INTO rag_content_summaries
                (content_id, fingerprint, descriptor, change_share, updated_at,
                 lang, search)
            VALUES (%s, %s, %s, %s, coalesce(%s, now()), %s,
                    to_tsvector(%s::regconfig, %s))
            ON CONFLICT (content_id) DO UPDATE SET
                fingerprint     = EXCLUDED.fingerprint,
                descriptor      = EXCLUDED.descriptor,
                change_share    = EXCLUDED.change_share,
                updated_at      = EXCLUDED.updated_at,
                lang            = EXCLUDED.lang,
                search          = EXCLUDED.search
            """,
            (
                content_id,
                fingerprint,
                descriptor,
                change_share,
                written_at,
                lang,
                config,
                text,
            ),
        )


async def published_summary(
    *, workspace_id: str | None, file_id: str
) -> dict[str, Any] | None:
    """The file's published descriptor row with the chunks it describes, for
    the summary reuse gate; None when the file has no ready descriptor."""
    db = await pool()
    async with db.connection() as conn:
        cur = await conn.execute(
            """
            SELECT fc.content_id
            FROM rag_file_contents fc
            JOIN rag_contents rc ON rc.id = fc.content_id AND rc.status = 'ready'
            WHERE fc.file_id = %s AND fc.workspace_id IS NOT DISTINCT FROM %s
            """,
            (file_id, workspace_id),
        )
        row = await cur.fetchone()
        return await _summary_row(conn, row["content_id"]) if row else None


async def content_summary(content_id: str) -> dict[str, Any] | None:
    """A content's descriptor row with the chunks it describes, for a note's
    summary gate; None when it has none."""
    db = await pool()
    async with db.connection() as conn:
        return await _summary_row(conn, content_id)


async def _summary_row(conn, content_id: str) -> dict[str, Any] | None:
    """The descriptor, its change share, when it was written and its age in
    seconds, and the chunks it describes."""
    cur = await conn.execute(
        """
        SELECT descriptor, change_share, updated_at,
               extract(epoch FROM now() - updated_at)::float AS age
        FROM rag_content_summaries WHERE content_id = %s
        """,
        (content_id,),
    )
    row = await cur.fetchone()
    if row is None:
        return None
    cur = await conn.execute(
        "SELECT text, section_path FROM rag_chunks WHERE content_id = %s "
        "ORDER BY chunk_idx",
        (content_id,),
    )
    chunks = [
        Chunk(text=chunk["text"], section_path=chunk["section_path"] or "")
        for chunk in await cur.fetchall()
    ]
    return {**dict(row), "chunks": chunks}


async def has_content_summary(content_id: str) -> bool:
    """False while the content's descriptor is pending (a missing row)."""
    db = await pool()
    async with db.connection() as conn:
        cur = await conn.execute(
            "SELECT 1 FROM rag_content_summaries WHERE content_id = %s",
            (content_id,),
        )
        return await cur.fetchone() is not None


async def fill_content_summary(
    *, workspace_id: str | None, content_id: str, descriptor: str
) -> None:
    """Insert a pending descriptor, never overwriting one another job or a
    refresh wrote meanwhile. The fingerprint is the content hash, which is
    ``indexing.content_hash`` of the stored chunks."""
    lang, config, text = summary_search_text(descriptor)
    db = await pool()
    async with db.connection() as conn:
        await conn.execute(
            """
            INSERT INTO rag_content_summaries
                (content_id, fingerprint, descriptor, change_share, updated_at,
                 lang, search)
            SELECT id, content_hash, %s, 0, now(), %s, to_tsvector(%s::regconfig, %s)
            FROM rag_contents WHERE id = %s AND workspace_id IS NOT DISTINCT FROM %s
            ON CONFLICT (content_id) DO NOTHING
            """,
            (descriptor, lang, config, text, content_id, workspace_id),
        )


async def file_content(file_id: str) -> dict[str, Any] | None:
    """The content a parts-only job fills: the source refresh candidate's
    under a bound refresh, else the file's alias."""
    refresh = jobdb.source_refresh_for(file_id)
    db = await pool()
    async with db.connection() as conn:
        if refresh is not None:
            cur = await conn.execute(
                """
                SELECT rc.id, rc.content_hash, rc.status, rc.pipeline_identity
                FROM source_refresh_candidates c
                JOIN rag_contents rc ON rc.id = c.content_id
                WHERE c.file_id = %s AND c.job_id = %s AND c.lease_token = %s
                """,
                (file_id, refresh["_jobId"], refresh["sourceLeaseToken"]),
            )
        else:
            cur = await conn.execute(
                """
                SELECT rc.id, rc.content_hash, rc.status, rc.pipeline_identity
                FROM rag_file_contents fc JOIN rag_contents rc ON rc.id = fc.content_id
                WHERE fc.file_id = %s
                """,
                (file_id,),
            )
        row = await cur.fetchone()
    return dict(row) if row else None


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
# Passages and vectors are reached through their content ids (migration 0126):
# the array is built once from scoped_files, so both legs read their content
# index. The knowledge library's schema still tags them with its workspace.
_CONTENT_SCOPE = "{alias}.content_id = ANY(ARRAY(SELECT content_id FROM scoped_files))"
_LIBRARY_SCOPE = "{alias}.workspace_id = %(ws)s"

# Files and notes alias the same canonical content and rank in one pool; the
# scoped resource carries a kind so citations can open the right thing. The
# note leg only exists in the workspace database: the knowledge library runs
# the same statement against its own schema, which has no materials.
_MATERIAL_SCOPE_SQL = """
            UNION ALL
            SELECT mc.content_id, m.id, m.title, 'material', m.created_at
            FROM rag_material_contents mc
            JOIN rag_contents rc ON rc.id = mc.content_id AND rc.status = 'ready'
            JOIN materials m ON m.id = mc.material_id
            WHERE mc.workspace_id {in_ws} AND m.trashed_at IS NULL
                AND (%(no_filter)s OR m.id = ANY(%(file_ids)s))"""

_SEARCH_SQL_TEMPLATE = """
WITH scoped_files AS (
        SELECT DISTINCT ON (content_id) content_id, file_id, file_name, kind
        FROM (
            SELECT fc.content_id, f.id AS file_id, f.name AS file_name,
                   'file' AS kind, f.added_at AS ordered_at
            FROM rag_file_contents fc
            JOIN rag_contents rc ON rc.id = fc.content_id AND rc.status = 'ready'
            JOIN files f ON f.id = fc.file_id
            WHERE {file_scope} AND f.trashed_at IS NULL
                AND (%(no_filter)s OR f.id = ANY(%(file_ids)s)){material_scope}
        ) resources
        ORDER BY content_id, ordered_at, file_id
),
vec AS (
    SELECT c.id, v.embedding <=> %(vector)s::halfvec AS dist,
           row_number() OVER (ORDER BY v.embedding <=> %(vector)s::halfvec, c.id) AS rank
        FROM {vector_table} v
        JOIN rag_chunks c ON c.id = v.chunk_id
        JOIN scoped_files sf ON sf.content_id = c.content_id
        WHERE {vec_scope}{chunk_filter}
    ORDER BY v.embedding <=> %(vector)s::halfvec, c.id
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
                        ts_rank_cd(c.search, q.any_of) DESC, c.id
           ) AS rank,
           (c.search @@ q.all_of AND q.lookup) AS exact
        FROM rag_chunks c
        JOIN scoped_files sf ON sf.content_id = c.content_id
        JOIN q ON q.lang = c.lang
    WHERE {lex_scope}{chunk_filter}
      AND c.search @@ q.any_of
    ORDER BY (c.search @@ q.all_of) DESC, ts_rank_cd(c.search, q.any_of) DESC, c.id
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
SELECT c.id, sf.file_id, sf.kind, c.chunk_idx, c.section_path, c.text, c.indexed_text, c.page_start,
       c.page_end, c.regions, c.lang, c.confidence, c.confidence_reasons,
       sf.file_name, fused.score, fused.flat_score,
       vec.rank AS vec_rank, vec.dist AS vec_dist, lex.rank AS lex_rank
FROM fused
JOIN rag_chunks c ON c.id = fused.id
JOIN scoped_files sf ON sf.content_id = c.content_id
LEFT JOIN vec ON vec.id = fused.id
LEFT JOIN lex ON lex.id = fused.id
ORDER BY fused.score DESC, c.id
LIMIT %(candidates)s
"""

# The file aliases a search reaches: those in its workspaces and, for account
# chat, the caller's own files with no workspace, owned through rag_contents
# and kept to the search's embedding space. Both rank in one pool (Epo
# 2026-10-27); standalone notes are never indexed, so there is no note leg
# for them. Passages and vectors follow through scoped_files' content ids.
_STANDALONE_OWNER = (
    "(fc.workspace_id IS NULL AND rc.user_id = %(owner)s"
    " AND rc.embedding_provider_slug = %(pin_provider)s"
    " AND rc.embedding_model_slug = %(pin_model)s"
    " AND rc.embedding_model_version = %(pin_version)s)"
)


def _file_scope(in_ws: str | None, *, owned: bool) -> str:
    legs = [f"fc.workspace_id {in_ws}"] if in_ws else []
    if owned:
        legs.append(_STANDALONE_OWNER)
    return legs[0] if len(legs) == 1 else "(" + " OR ".join(legs) + ")"


async def hybrid_search(
    *,
    workspace_id: str = "",
    vector: list[float],
    terms: QueryTerms,
    file_ids: list[str] | None,
    candidates: int,
    pin: dict[str, Any] | None = None,
    conn: Any | None = None,
    chunk_filter: str = "",
    chunk_filter_params: dict[str, Any] | None = None,
    workspace_ids: list[str] | None = None,
    owner_user_id: str | None = None,
) -> list[dict[str, Any]]:
    """Vector + lexical search fused with reciprocal rank fusion.

    Account chat searches ``workspace_ids`` (one pin's workspaces) and, with
    ``owner_user_id``, that user's standalone content in ``pin``'s space, in
    one statement so both rank in one pool; it needs ``pin``.

    ``pin``, ``conn`` and ``chunk_filter`` exist for the knowledge library,
    which runs this same statement against its own database with a
    predicate on excerpt tags; workspace search never sets them.

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

    Every ordering ends on the chunk id: lexical scores tie constantly (35 of
    44 adjacent candidates on a pilot question), and without it the cut and
    the order inside a tied block followed physical row order.

    Rows carry the per-leg evidence (``vec_rank``, ``vec_dist``, ``lex_rank``)
    and ``flat_score``, the fusion with every lexical row at half weight, so
    the caller can tell which hits the exact tier put there, plus
    ``indexed_text`` (heading context and text), which the reranker scores.
    """
    pin = pin or await workspace_embedding_pin(workspace_id)
    if workspace_ids is None:
        in_ws: str | None = "= %(ws)s"
    else:
        in_ws = "= ANY(%(ws)s)" if workspace_ids else None
    scope = _LIBRARY_SCOPE if conn is not None else _CONTENT_SCOPE
    sql = _SEARCH_SQL_TEMPLATE.format(
        vector_table=vector_table_for_pin(pin),
        chunk_filter=chunk_filter,
        material_scope=""
        if conn is not None or in_ws is None
        else _MATERIAL_SCOPE_SQL.format(in_ws=in_ws),
        file_scope=_file_scope(in_ws, owned=bool(owner_user_id)),
        vec_scope=scope.format(alias="v"),
        lex_scope=scope.format(alias="c"),
    )
    params = dict(chunk_filter_params or {})
    if owner_user_id:
        params.update(
            {
                "owner": owner_user_id,
                "pin_provider": pin["embedding_provider_slug"],
                "pin_model": pin["embedding_model_slug"],
                "pin_version": pin["embedding_model_version"],
            }
        )
    params.update(
        {
            "ws": workspace_id if workspace_ids is None else list(workspace_ids),
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
        }
    )
    if conn is not None:
        cur = await conn.execute(sql, params)
        return [dict(row) for row in await cur.fetchall()]
    db = await pool()
    async with db.connection() as pooled:
        cur = await pooled.execute(sql, params)
        return [dict(row) for row in await cur.fetchall()]


async def account_search_spaces(
    user_id: str, workspace_ids: list[str]
) -> list[dict[str, Any]]:
    """An account search's targets by embedding space: each pin with its
    workspaces among ``workspace_ids`` and whether the user's standalone
    content holds ready passages in it (its recorded pin)."""
    db = await pool()
    async with db.connection() as conn:
        cur = await conn.execute(
            """
            SELECT embedding_provider_slug, embedding_model_slug,
                   embedding_model_version, embedding_dim,
                   array_agg(id ORDER BY id) AS workspace_ids, false AS standalone
            FROM workspaces WHERE id = ANY(%s)
            GROUP BY 1, 2, 3, 4
            UNION ALL
            SELECT DISTINCT embedding_provider_slug, embedding_model_slug,
                   embedding_model_version, embedding_dim, NULL::text[], true
            FROM rag_contents
            WHERE workspace_id IS NULL AND user_id = %s AND status = 'ready'
              AND embedding_provider_slug IS NOT NULL
            """,
            (list(workspace_ids), user_id),
        )
        rows = [dict(row) for row in await cur.fetchall()]
    spaces: dict[tuple, dict[str, Any]] = {}
    for row in rows:
        key = (
            row["embedding_provider_slug"],
            row["embedding_model_slug"],
            int(row["embedding_model_version"]),
            int(row["embedding_dim"]),
        )
        space = spaces.setdefault(
            key,
            {
                "pin": dict(zip(_PIN_COLUMNS, key, strict=True)),
                "workspace_ids": [],
                "standalone": False,
            },
        )
        space["workspace_ids"].extend(row["workspace_ids"] or [])
        space["standalone"] = space["standalone"] or row["standalone"]
    return list(spaces.values())


_PIN_COLUMNS = (
    "embedding_provider_slug",
    "embedding_model_slug",
    "embedding_model_version",
    "embedding_dim",
)


# Account chat's summary search (Epo 2026-10-28, option B of
# bench/rag/reports/2026-10-28-summary-search-scale.md): the caller's items
# first (their workspaces', then their own with no workspace), then each
# item's name and its summary's stored search vector. A name match ranks
# first; no index covers the summaries, as the scope is small.
_SUMMARY_SEARCH_SQL = """
WITH scoped AS (
    SELECT f.id, 'file' AS kind, f.name AS title, f.workspace_id, f.chapter_id,
           fc.content_id
    FROM files f LEFT JOIN rag_file_contents fc ON fc.file_id = f.id
    WHERE f.workspace_id = ANY(%(ws)s) AND f.trashed_at IS NULL
    UNION ALL
    SELECT f.id, 'file', f.name, NULL, NULL, fc.content_id
    FROM files f LEFT JOIN rag_file_contents fc ON fc.file_id = f.id
    WHERE f.workspace_id IS NULL AND f.user_id = %(me)s AND f.trashed_at IS NULL
    UNION ALL
    SELECT m.id, 'material', m.title, m.workspace_id, m.chapter_id, mc.content_id
    FROM materials m LEFT JOIN rag_material_contents mc ON mc.material_id = m.id
    WHERE m.workspace_id = ANY(%(ws)s) AND m.trashed_at IS NULL
      AND m.parent_material_id IS NULL
    UNION ALL
    SELECT m.id, 'material', m.title, NULL, NULL, mc.content_id
    FROM materials m LEFT JOIN rag_material_contents mc ON mc.material_id = m.id
    WHERE m.workspace_id IS NULL AND m.owner_user_id = %(me)s
      AND m.trashed_at IS NULL AND m.parent_material_id IS NULL
),
q AS (
    SELECT m.lang, websearch_to_tsquery(m.cfg::regconfig, %(any_of)s) AS q
    FROM unnest(%(langs)s::text[], %(cfgs)s::text[]) AS m(lang, cfg)
),
ranked AS (
    SELECT sc.*, coalesce(s.descriptor, '') AS descriptor,
           (SELECT count(*) FROM unnest(%(names)s::text[]) n
            WHERE sc.title ILIKE '%%' || n || '%%') AS name_hits,
           coalesce((SELECT ts_rank_cd(s.search, q.q) FROM q
                     WHERE q.lang = s.lang AND s.search @@ q.q), 0) AS summary_rank
    FROM scoped sc LEFT JOIN rag_content_summaries s ON s.content_id = sc.content_id
)
SELECT r.id, r.kind, r.title, r.workspace_id, r.chapter_id, ch.name AS chapter_name,
       r.descriptor
FROM ranked r LEFT JOIN chapters ch ON ch.id = r.chapter_id
WHERE r.name_hits > 0 OR r.summary_rank > 0
ORDER BY r.name_hits DESC, r.summary_rank DESC, r.id
LIMIT %(limit)s
"""

# A name term: a word of three or more letters, or a CJK run (one or two
# letters there are whole words); shorter Latin words match too many names.
_NAME_TERM = re.compile(r"\w{3,}|[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]+")


async def summary_search(
    *, user_id: str, workspace_ids: list[str], query: str, limit: int
) -> list[dict[str, Any]]:
    """The caller's files and top-level materials whose name or summary
    matches ``query``, best first."""
    terms = search_query_terms(query)
    names = list(dict.fromkeys(t.lower() for t in _NAME_TERM.findall(query)))[:20]
    if not terms.any_of and not names:
        return []
    db = await pool()
    async with db.connection() as conn:
        cur = await conn.execute(
            _SUMMARY_SEARCH_SQL,
            {
                "ws": list(workspace_ids),
                "me": user_id,
                "any_of": terms.any_of,
                "langs": list(TS_CONFIG),
                "cfgs": list(TS_CONFIG.values()),
                "names": names,
                "limit": limit,
            },
        )
        return [dict(row) for row in await cur.fetchall()]


async def item_places(
    file_ids: list[str], material_ids: list[str]
) -> dict[str, dict[str, Any]]:
    """Where each untrashed file and material lives now: its workspace (None
    for none), owner, chapter and a file's kind, for labelling account chat's
    passages."""
    if not file_ids and not material_ids:
        return {}
    db = await pool()
    async with db.connection() as conn:
        cur = await conn.execute(
            """
            SELECT f.id, f.workspace_id, f.user_id AS owner_id, f.chapter_id,
                   ch.name AS chapter_name, f.kind AS file_kind
            FROM files f LEFT JOIN chapters ch ON ch.id = f.chapter_id
            WHERE f.id = ANY(%s) AND f.trashed_at IS NULL
            UNION ALL
            SELECT m.id, m.workspace_id, m.owner_user_id, m.chapter_id, ch.name, NULL
            FROM materials m LEFT JOIN chapters ch ON ch.id = m.chapter_id
            WHERE m.id = ANY(%s) AND m.trashed_at IS NULL
            """,
            (list(file_ids), list(material_ids)),
        )
        return {row["id"]: dict(row) for row in await cur.fetchall()}


async def account_history_passages(
    user_id: str, workspace_ids: list[str], chunk_ids: list[str]
) -> list[dict[str, Any]]:
    """history_passages across an account chat's scope: its workspaces' files
    and notes and the user's standalone files."""
    db = await pool()
    async with db.connection() as conn:
        cur = await conn.execute(
            """
            SELECT c.id, fc.file_id, 'file' AS kind, c.chunk_idx, c.section_path, c.text,
                   c.page_start, c.page_end, c.regions, c.confidence, c.confidence_reasons,
                   f.name AS file_name
            FROM rag_file_contents fc
            JOIN files f ON f.id = fc.file_id
            JOIN rag_chunks c ON c.content_id = fc.content_id
            WHERE (f.workspace_id = ANY(%s) OR (f.workspace_id IS NULL AND f.user_id = %s))
              AND f.trashed_at IS NULL AND c.id = ANY(%s)
            UNION ALL
            SELECT c.id, mc.material_id, 'material', c.chunk_idx, c.section_path, c.text,
                   c.page_start, c.page_end, c.regions, c.confidence, c.confidence_reasons,
                   m.title
            FROM rag_material_contents mc
            JOIN materials m ON m.id = mc.material_id
            JOIN rag_chunks c ON c.content_id = mc.content_id
            WHERE m.workspace_id = ANY(%s) AND m.trashed_at IS NULL AND c.id = ANY(%s)
            """,
            (workspace_ids, user_id, chunk_ids, workspace_ids, chunk_ids),
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


async def workspace_chapters(
    workspace_id: str, open_id: str | None = None
) -> tuple[list[dict[str, Any]], str | None]:
    """The chapters in order, and the chapter the open file or material is in."""
    db = await pool()
    async with db.connection() as conn:
        cur = await conn.execute(
            "SELECT id, name FROM chapters WHERE workspace_id = %s ORDER BY position, id",
            (workspace_id,),
        )
        chapters = [dict(row) for row in await cur.fetchall()]
        if not open_id:
            return chapters, None
        cur = await conn.execute(
            """
            SELECT chapter_id FROM files WHERE id = %s AND workspace_id = %s
            UNION ALL
            SELECT chapter_id FROM materials WHERE id = %s AND workspace_id = %s
            LIMIT 1
            """,
            (open_id, workspace_id, open_id, workspace_id),
        )
        row = await cur.fetchone()
    return chapters, (row["chapter_id"] if row else None)


async def resource_titles(workspace_id: str, ids: list[str]) -> dict[str, str]:
    """The names of this workspace's files and titles of its materials by id,
    trashed ones included (restore_file names them), for the chat's tool rows."""
    if not ids:
        return {}
    db = await pool()
    async with db.connection() as conn:
        cur = await conn.execute(
            """
            SELECT id, name AS title FROM files WHERE workspace_id = %s AND id = ANY(%s)
            UNION ALL
            SELECT id, title FROM materials WHERE workspace_id = %s AND id = ANY(%s)
            """,
            (workspace_id, ids, workspace_id, ids),
        )
        return {row["id"]: row["title"] for row in await cur.fetchall()}


async def workspace_outline(workspace_id: str) -> dict[str, Any]:
    """Chapters, their files and top-level materials, and the per-file
    descriptor the listing tool prints."""
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
                     (SELECT count(*) FROM rag_chunks c
                      JOIN rag_file_contents rfc ON rfc.content_id = c.content_id
                      WHERE rfc.file_id = f.id) AS chunks
            FROM files f
                 LEFT JOIN rag_file_contents fc ON fc.file_id = f.id
                 LEFT JOIN rag_content_summaries cs ON cs.content_id = fc.content_id
            WHERE f.workspace_id = %s AND f.trashed_at IS NULL
            ORDER BY f.position, f.added_at
            """,
            (workspace_id,),
        )
        files = [dict(row) for row in await cur.fetchall()]

        # Indexed or not, every top-level workspace material is a scope target
        # (Epo 2026-10-21): a note that is still dirty has no passages yet, and
        # a quiz, flashcard set, mindmap or diagram never has any.
        cur = await conn.execute(
            """
            SELECT m.id, m.title AS name, m.chapter_id, 'ready' AS status,
                   coalesce(cs.descriptor, '') AS descriptor, 'material' AS kind,
                   m.kind AS material_kind,
                   (SELECT count(*) FROM rag_chunks c
                    WHERE c.content_id = mc.content_id) AS chunks
            FROM materials m
                 LEFT JOIN rag_material_contents mc ON mc.material_id = m.id
                 LEFT JOIN rag_content_summaries cs ON cs.content_id = mc.content_id
            WHERE m.workspace_id = %s AND m.trashed_at IS NULL
              AND m.parent_material_id IS NULL
            ORDER BY m.position, m.created_at
            """,
            (workspace_id,),
        )
        files.extend(dict(row) for row in await cur.fetchall())

    return {"chapters": chapters, "files": files}


async def file_page_source(
    workspace_id: str | None, file_id: str
) -> dict[str, Any] | None:
    """Published source identity for page capture; names may change
    independently. None is a standalone file, which account chat reads only
    after Go's access check (tools.document_access)."""
    db = await pool()
    async with db.connection() as conn:
        cur = await conn.execute(
            """
            SELECT f.kind, f.name, f.parse_mode, f.ever_parsed_successfully, f.blob_path, f.source_sha256, f.size_bytes
            FROM files f
            WHERE f.workspace_id IS NOT DISTINCT FROM %s AND f.id = %s
              AND f.trashed_at IS NULL
            """,
            (workspace_id, file_id),
        )
        row = await cur.fetchone()
    return dict(row) if row else None


async def file_ids_for_names(workspace_id: str, names: list[str]) -> list[str]:
    if not names:
        return []
    db = await pool()
    async with db.connection() as conn:
        cur = await conn.execute(
            "SELECT id FROM files WHERE workspace_id = %s AND name = ANY(%s) AND trashed_at IS NULL",
            (workspace_id, names),
        )
        return [row["id"] for row in await cur.fetchall()]


async def history_passages(
    workspace_id: str, chunk_ids: list[str]
) -> list[dict[str, Any]]:
    """Validate saved evidence against the current untrashed workspace index."""
    db = await pool()
    async with db.connection() as conn:
        cur = await conn.execute(
            """
            SELECT c.id, fc.file_id, 'file' AS kind, c.chunk_idx, c.section_path, c.text,
                   c.page_start, c.page_end, c.regions, c.confidence, c.confidence_reasons,
                   f.name AS file_name
            FROM rag_file_contents fc
            JOIN files f ON f.id = fc.file_id
            JOIN rag_chunks c ON c.content_id = fc.content_id
            WHERE f.workspace_id = %s AND f.trashed_at IS NULL AND c.id = ANY(%s)
            UNION ALL
            SELECT c.id, mc.material_id, 'material', c.chunk_idx, c.section_path, c.text,
                   c.page_start, c.page_end, c.regions, c.confidence, c.confidence_reasons,
                   m.title
            FROM rag_material_contents mc
            JOIN materials m ON m.id = mc.material_id
            JOIN rag_chunks c ON c.content_id = mc.content_id
            WHERE m.workspace_id = %s AND m.trashed_at IS NULL AND c.id = ANY(%s)
            """,
            (workspace_id, chunk_ids, workspace_id, chunk_ids),
        )
        return [dict(row) for row in await cur.fetchall()]


async def read_file_range(
    *, workspace_id: str | None, file_id: str, start: int, count: int
) -> list[dict[str, Any]]:
    """A file's or note's passages from ``start``; workspace_id None is a
    standalone file, read only after Go's access check (account chat)."""
    db = await pool()
    async with db.connection() as conn:
        cur = await conn.execute(
            """
            SELECT * FROM (
                SELECT c.id, fc.file_id, 'file' AS kind, c.chunk_idx, c.section_path, c.text,
                       c.page_start, c.page_end, c.regions, c.confidence, c.confidence_reasons,
                       f.name AS file_name
                FROM rag_file_contents fc
                JOIN files f ON f.id = fc.file_id
                JOIN rag_chunks c ON c.content_id = fc.content_id
                WHERE f.workspace_id IS NOT DISTINCT FROM %s AND fc.file_id = %s
                  AND f.trashed_at IS NULL
                UNION ALL
                SELECT c.id, mc.material_id, 'material', c.chunk_idx, c.section_path, c.text,
                       c.page_start, c.page_end, c.regions, c.confidence, c.confidence_reasons,
                       m.title
                FROM rag_material_contents mc
                JOIN materials m ON m.id = mc.material_id
                JOIN rag_chunks c ON c.content_id = mc.content_id
                WHERE m.workspace_id = %s AND mc.material_id = %s AND m.trashed_at IS NULL
            ) passages
            WHERE chunk_idx >= %s
            ORDER BY chunk_idx
            LIMIT %s
            """,
            (workspace_id, file_id, workspace_id, file_id, start, count),
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
