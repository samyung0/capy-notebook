"""Async Postgres access for the retrieval index.

The schema is owned by ``server/migrations/0001_init.sql``; nothing here creates
tables. Both processes run on an event loop, so one async pool serves the ingest
worker and the retrieval service alike.
"""

from __future__ import annotations

import json
import logging
import secrets
from typing import Any

from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from psycopg_pool import AsyncConnectionPool

from ..config import cfg
from ..jobs import RetryableError, TerminalError

log = logging.getLogger("evo.retrieval.store")

_pool: AsyncConnectionPool | None = None


async def pool() -> AsyncConnectionPool:
    global _pool
    if _pool is None:
        _pool = AsyncConnectionPool(
            cfg.dsn,
            min_size=1,
            max_size=8,
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
_VECTOR_TABLES = {
    ("openrouter", "qwen/qwen3-embedding-4b", 1): "rag_chunk_vectors_2560"
}


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


async def attach_file_content(
    *,
    workspace_id: str,
    file_id: str,
    content_hash: str,
    source_sha256: str | None = None,
    pipeline_identity: str | None = None,
    claim_job_id: str | None = None,
) -> dict[str, Any]:
    """Attach a logical file to canonical workspace content.

    ``claim_job_id`` records who owns the claim when this call creates it. On
    conflict the existing owner is left alone: the caller is a waiter, and
    ``created=False`` is what tells it so.
    """
    content_id = f"rgc_{secrets.token_hex(8)}"
    db = await pool()
    async with db.connection() as conn, conn.transaction():
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
            SELECT id, workspace_id, content_hash,
                   embedding_provider_slug, embedding_model_slug,
                   embedding_model_version, embedding_dim
            FROM rag_contents
            WHERE source_sha256 = %s
              AND pipeline_identity = %s
              AND status = 'ready'
            ORDER BY (
                embedding_provider_slug = %s
                AND embedding_model_slug = %s
                AND embedding_model_version = %s
                AND embedding_dim = %s
            ) DESC, updated_at DESC
            LIMIT 1
            """,
            (
                source_sha256,
                pipeline_identity,
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


async def copy_content_from_donor(
    *,
    donor_id: str,
    dest_content_id: str,
    dest_workspace_id: str,
    copy_vectors: bool,
) -> bool:
    """Copy a ready donor's index into this workspace's content row.

    Mirrors CloneWorkspace. Returns False if the donor vanished under FOR SHARE
    (workspace delete) so the caller can fall through to parsing.
    """
    db = await pool()
    async with db.connection() as conn, conn.transaction():
        cur = await conn.execute(
            """
            SELECT id, workspace_id, content_hash, source_sha256, pipeline_identity,
                   embedding_provider_slug, embedding_model_slug,
                   embedding_model_version, embedding_dim
            FROM rag_contents
            WHERE id = %s AND status = 'ready'
            FOR SHARE
            """,
            (donor_id,),
        )
        donor = await cur.fetchone()
        if donor is None:
            return False
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
                indexed_text, token_count, page_start, page_end, regions, search
            )
            SELECT {_NEW_CHUNK_ID_SQL},
                   %s, %s, c.chunk_idx, c.section_path, c.text, c.indexed_text,
                   c.token_count, c.page_start, c.page_end, c.regions, c.search
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
            INSERT INTO rag_concepts (id, workspace_id, name, norm)
            SELECT 'rcp_' || substr(md5(random()::text || clock_timestamp()::text || k.id), 1, 12),
                   %s, k.name, k.norm
            FROM rag_concepts k
            WHERE k.workspace_id = %s
              AND EXISTS (
                  SELECT 1
                  FROM rag_concept_mentions m
                  JOIN rag_chunks c ON c.id = m.chunk_id
                  WHERE m.concept_id = k.id AND c.content_id = %s
              )
            ON CONFLICT (workspace_id, norm) DO NOTHING
            """,
            (dest_workspace_id, pin["workspace_id"], donor_id),
        )
        await conn.execute(
            """
            INSERT INTO rag_concept_mentions (concept_id, chunk_id)
            SELECT nk.id, nc.id
            FROM rag_concept_mentions m
            JOIN rag_concepts ok ON ok.id = m.concept_id AND ok.workspace_id = %s
            JOIN rag_chunks oc ON oc.id = m.chunk_id AND oc.content_id = %s
            JOIN rag_chunks nc ON nc.content_id = %s AND nc.chunk_idx = oc.chunk_idx
            JOIN rag_concepts nk ON nk.workspace_id = %s AND nk.norm = ok.norm
            ON CONFLICT DO NOTHING
            """,
            (pin["workspace_id"], donor_id, dest_content_id, dest_workspace_id),
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
                   page_start, page_end, regions
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
    fewer chunks must not leave the tail of the previous run behind, and the
    concept mentions that reference those chunks have to go with them (they
    cascade).

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
                        search
                    ) VALUES (
                        %(id)s, %(workspace_id)s, %(content_id)s, %(chunk_idx)s,
                        %(section_path)s, %(text)s, %(indexed_text)s, %(token_count)s,
                        %(page_start)s, %(page_end)s, %(regions)s,
                        to_tsvector('simple', %(search_text)s)
                    )
                    """,
                {
                    **row,
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


async def replace_content_concepts(
    *, workspace_id: str, content_id: str, concepts: list[dict[str, Any]]
) -> None:
    """Re-link one canonical content item's concept mentions.

    Concepts themselves are workspace-scoped and shared: two files naming the
    same idea must land on one row, because co-mention across files is exactly
    the signal the index exists to provide.
    """
    db = await pool()
    async with db.connection() as conn, conn.transaction():
        await conn.execute(
            """
            DELETE FROM rag_concept_mentions m
            USING rag_chunks c
            WHERE m.chunk_id = c.id AND c.content_id = %s
            """,
            (content_id,),
        )
        for concept in concepts:
            cur = await conn.execute(
                """
                INSERT INTO rag_concepts (id, workspace_id, name, norm)
                VALUES (%s, %s, %s, %s)
                ON CONFLICT (workspace_id, norm) DO UPDATE SET name = rag_concepts.name
                RETURNING id
                """,
                (concept["id"], workspace_id, concept["name"], concept["norm"]),
            )
            row = await cur.fetchone()
            concept_id = row["id"]
            for chunk_id in concept["chunk_ids"]:
                await conn.execute(
                    """
                    INSERT INTO rag_concept_mentions (concept_id, chunk_id)
                    VALUES (%s, %s) ON CONFLICT DO NOTHING
                    """,
                    (concept_id, chunk_id),
                )
        # Concepts whose last mention just disappeared.
        await conn.execute(
            """
            DELETE FROM rag_concepts c
            WHERE c.workspace_id = %s
              AND NOT EXISTS (
                  SELECT 1 FROM rag_concept_mentions m WHERE m.concept_id = c.id
              )
            """,
            (workspace_id,),
        )


# ---------------------------------------------------------------- search


_RRF_K = 60

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
    SELECT c.id, row_number() OVER (ORDER BY v.embedding <=> %(vector)s::halfvec) AS rank
        FROM {vector_table} v
        JOIN rag_chunks c ON c.id = v.chunk_id
        JOIN scoped_files sf ON sf.content_id = c.content_id
        WHERE v.workspace_id = %(ws)s
    ORDER BY v.embedding <=> %(vector)s::halfvec
    LIMIT %(candidates)s
),
lex AS (
    SELECT c.id,
           row_number() OVER (ORDER BY ts_rank_cd(c.search, q.query) DESC) AS rank
        FROM rag_chunks c
        JOIN scoped_files sf ON sf.content_id = c.content_id,
            websearch_to_tsquery('simple', %(terms)s) AS q(query)
    WHERE c.workspace_id = %(ws)s
      AND c.search @@ q.query
    ORDER BY ts_rank_cd(c.search, q.query) DESC
    LIMIT %(candidates)s
),
fused AS (
    SELECT id, sum(score) AS score FROM (
        SELECT id, 1.0 / (%(rrf_k)s + rank) AS score FROM vec
        UNION ALL
        SELECT id, 1.0 / (%(rrf_k)s + rank) AS score FROM lex
    ) parts GROUP BY id
)
SELECT c.id, sf.file_id, c.chunk_idx, c.section_path, c.text, c.page_start,
       c.page_end, c.regions, sf.file_name, fused.score
FROM fused
JOIN rag_chunks c ON c.id = fused.id
JOIN scoped_files sf ON sf.content_id = c.content_id
ORDER BY fused.score DESC
LIMIT %(candidates)s
"""


async def hybrid_search(
    *,
    workspace_id: str,
    vector: list[float],
    terms: str,
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
                "terms": terms,
                "file_ids": list(file_ids or []),
                "no_filter": not file_ids,
                "candidates": candidates,
                "rrf_k": _RRF_K,
            },
        )
        return [dict(row) for row in await cur.fetchall()]


async def neighbor_chunks(
    *, file_id: str, chunk_idx: int, radius: int = 1
) -> list[dict[str, Any]]:
    """The chunks immediately around a hit.

    A definition and the example that uses it routinely land in adjacent chunks,
    and the boundary between them is an artifact of packing, not of meaning.
    """
    db = await pool()
    async with db.connection() as conn:
        cur = await conn.execute(
            """
            SELECT c.id, fc.file_id, c.chunk_idx, c.section_path, c.text, c.page_start,
                   c.page_end, c.regions, f.name AS file_name
            FROM rag_file_contents fc
            JOIN files f ON f.id = fc.file_id
            JOIN rag_chunks c ON c.content_id = fc.content_id
            WHERE fc.file_id = %s AND c.chunk_idx BETWEEN %s AND %s
            ORDER BY c.chunk_idx
            """,
            (file_id, chunk_idx - radius, chunk_idx + radius),
        )
        return [dict(row) for row in await cur.fetchall()]


async def related_concepts(
    *,
    workspace_id: str,
    name: str,
    file_ids: list[str] | None = None,
    limit: int = 12,
) -> list[dict[str, Any]]:
    """Concepts co-mentioned with this one, and where they are discussed.

    This is the relation-free substitute for a knowledge graph edge: no relation
    was ever extracted, but 'appears in the same passage' is recoverable by a
    self-join and, unlike an extracted relation, cannot be hallucinated.
    """
    db = await pool()
    async with db.connection() as conn:
        cur = await conn.execute(
            """
            WITH seed AS (
                SELECT id FROM rag_concepts
                WHERE workspace_id = %(ws)s AND norm = %(norm)s
            ),
            seed_chunks AS (
                SELECT DISTINCT m.chunk_id
                  FROM rag_concept_mentions m
                  JOIN rag_chunks rc ON rc.id = m.chunk_id
                  JOIN rag_file_contents fc ON fc.content_id = rc.content_id
                 WHERE m.concept_id IN (SELECT id FROM seed)
                   AND (%(no_filter)s OR fc.file_id = ANY(%(file_ids)s))
            )
            SELECT c.name,
                   count(DISTINCT m.chunk_id) AS mentions,
                   array_agg(DISTINCT f.name) AS files
            FROM rag_concept_mentions m
            JOIN rag_concepts c ON c.id = m.concept_id
            JOIN rag_chunks rc ON rc.id = m.chunk_id
            JOIN rag_file_contents fc ON fc.content_id = rc.content_id
            JOIN files f ON f.id = fc.file_id
            WHERE m.chunk_id IN (SELECT chunk_id FROM seed_chunks)
              AND c.norm <> %(norm)s
              AND c.workspace_id = %(ws)s
              AND (%(no_filter)s OR fc.file_id = ANY(%(file_ids)s))
            GROUP BY c.name
            ORDER BY mentions DESC
            LIMIT %(limit)s
            """,
            {
                "ws": workspace_id,
                "norm": normalize_concept(name),
                "file_ids": list(file_ids or []),
                "no_filter": not file_ids,
                "limit": limit,
            },
        )
        return [dict(row) for row in await cur.fetchall()]


def normalize_concept(name: str) -> str:
    return " ".join(name.strip().casefold().split())


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
