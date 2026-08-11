"""Async Postgres access for the retrieval index.

The schema is owned by ``server/migrations/0001_init.sql``; nothing here creates
tables. Both processes run on an event loop, so one async pool serves the ingest
worker and the retrieval service alike.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from psycopg_pool import AsyncConnectionPool

from ..config import cfg

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
            kwargs={"row_factory": dict_row},
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


# --------------------------------------------------------------- chunk writes


async def replace_file_chunks(
    *, workspace_id: str, file_id: str, rows: list[dict[str, Any]]
) -> None:
    """Swap in a file's chunks atomically.

    Delete-then-insert rather than upsert-by-index: a re-ingest that produces
    fewer chunks must not leave the tail of the previous run behind, and the
    concept mentions that reference those chunks have to go with them (they
    cascade).
    """
    db = await pool()
    async with db.connection() as conn, conn.transaction():
        await conn.execute("DELETE FROM rag_chunks WHERE file_id = %s", (file_id,))
        for row in rows:
            await conn.execute(
                """
                    INSERT INTO rag_chunks (
                        id, workspace_id, file_id, chunk_idx, section_path, text,
                        indexed_text, token_count, page_start, page_end, regions,
                        search, embedding
                    ) VALUES (
                        %(id)s, %(workspace_id)s, %(file_id)s, %(chunk_idx)s,
                        %(section_path)s, %(text)s, %(indexed_text)s, %(token_count)s,
                        %(page_start)s, %(page_end)s, %(regions)s,
                        to_tsvector('simple', %(search_text)s), %(embedding)s::halfvec
                    )
                    """,
                {
                    **row,
                    "workspace_id": workspace_id,
                    "file_id": file_id,
                    "regions": Jsonb(row["regions"]),
                },
            )


async def upsert_file_summary(
    *,
    workspace_id: str,
    file_id: str,
    fingerprint: str,
    summary: str,
    outline: list[dict[str, Any]],
) -> None:
    db = await pool()
    async with db.connection() as conn:
        await conn.execute(
            """
            INSERT INTO rag_file_summaries
                (file_id, workspace_id, fingerprint, summary, outline, updated_at)
            VALUES (%s, %s, %s, %s, %s, now())
            ON CONFLICT (file_id) DO UPDATE SET
                workspace_id = EXCLUDED.workspace_id,
                fingerprint  = EXCLUDED.fingerprint,
                summary      = EXCLUDED.summary,
                outline      = EXCLUDED.outline,
                updated_at   = now()
            """,
            (file_id, workspace_id, fingerprint, summary, Jsonb(outline)),
        )


async def file_fingerprint(file_id: str) -> str:
    db = await pool()
    async with db.connection() as conn:
        cur = await conn.execute(
            "SELECT fingerprint FROM rag_file_summaries WHERE file_id = %s", (file_id,)
        )
        row = await cur.fetchone()
        return str(row["fingerprint"]) if row else ""


async def replace_file_concepts(
    *, workspace_id: str, file_id: str, concepts: list[dict[str, Any]]
) -> None:
    """Re-link one file's concept mentions.

    Concepts themselves are workspace-scoped and shared: two files naming the
    same idea must land on one row, because co-mention across files is exactly
    the signal the index exists to provide.
    """
    db = await pool()
    async with db.connection() as conn, conn.transaction():
        await conn.execute(
            "DELETE FROM rag_concept_mentions WHERE file_id = %s", (file_id,)
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
                    INSERT INTO rag_concept_mentions (concept_id, chunk_id, file_id)
                    VALUES (%s, %s, %s) ON CONFLICT DO NOTHING
                    """,
                    (concept_id, chunk_id, file_id),
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

_SEARCH_SQL = """
WITH vec AS (
    SELECT id, row_number() OVER (ORDER BY embedding <=> %(vector)s::halfvec) AS rank
    FROM rag_chunks
    WHERE workspace_id = %(ws)s
      AND embedding IS NOT NULL
      AND (%(no_filter)s OR file_id = ANY(%(file_ids)s))
    ORDER BY embedding <=> %(vector)s::halfvec
    LIMIT %(candidates)s
),
lex AS (
    SELECT c.id,
           row_number() OVER (ORDER BY ts_rank_cd(c.search, q.query) DESC) AS rank
    FROM rag_chunks c, websearch_to_tsquery('simple', %(terms)s) AS q(query)
    WHERE c.workspace_id = %(ws)s
      AND c.search @@ q.query
      AND (%(no_filter)s OR c.file_id = ANY(%(file_ids)s))
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
SELECT c.id, c.file_id, c.chunk_idx, c.section_path, c.text, c.page_start,
       c.page_end, c.regions, f.name AS file_name, fused.score
FROM fused
JOIN rag_chunks c ON c.id = fused.id
JOIN files f ON f.id = c.file_id
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
    """
    db = await pool()
    async with db.connection() as conn:
        cur = await conn.execute(
            _SEARCH_SQL,
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
            SELECT c.id, c.file_id, c.chunk_idx, c.section_path, c.text, c.page_start,
                   c.page_end, c.regions, f.name AS file_name
            FROM rag_chunks c JOIN files f ON f.id = c.file_id
            WHERE c.file_id = %s AND c.chunk_idx BETWEEN %s AND %s
            ORDER BY c.chunk_idx
            """,
            (file_id, chunk_idx - radius, chunk_idx + radius),
        )
        return [dict(row) for row in await cur.fetchall()]


async def related_concepts(
    *, workspace_id: str, name: str, limit: int = 12
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
                SELECT chunk_id FROM rag_concept_mentions
                WHERE concept_id IN (SELECT id FROM seed)
            )
            SELECT c.name,
                   count(DISTINCT m.chunk_id) AS mentions,
                   array_agg(DISTINCT f.name) AS files
            FROM rag_concept_mentions m
            JOIN rag_concepts c ON c.id = m.concept_id
            JOIN files f ON f.id = m.file_id
            WHERE m.chunk_id IN (SELECT chunk_id FROM seed_chunks)
              AND c.norm <> %(norm)s
              AND c.workspace_id = %(ws)s
            GROUP BY c.name
            ORDER BY mentions DESC
            LIMIT %(limit)s
            """,
            {"ws": workspace_id, "norm": normalize_concept(name), "limit": limit},
        )
        return [dict(row) for row in await cur.fetchall()]


def normalize_concept(name: str) -> str:
    return " ".join(name.strip().casefold().split())


# ------------------------------------------------------- structure & summaries


async def workspace_outline(workspace_id: str) -> dict[str, Any]:
    """Chapters, their files, and every summary the tree currently holds."""
    db = await pool()
    async with db.connection() as conn:
        cur = await conn.execute(
            """
            SELECT ch.id, ch.name, cs.summary
            FROM chapters ch
            LEFT JOIN rag_chapter_summaries cs ON cs.chapter_id = ch.id
            WHERE ch.workspace_id = %s
            ORDER BY ch.position, ch.id
            """,
            (workspace_id,),
        )
        chapters = [dict(row) for row in await cur.fetchall()]

        cur = await conn.execute(
            """
            SELECT f.id, f.name, f.chapter_id, f.status, fs.summary,
                   coalesce(fs.outline, '[]'::jsonb) AS outline,
                   (SELECT count(*) FROM rag_chunks c WHERE c.file_id = f.id) AS chunks
            FROM files f
            LEFT JOIN rag_file_summaries fs ON fs.file_id = f.id
            WHERE f.workspace_id = %s
            ORDER BY f.position, f.added_at
            """,
            (workspace_id,),
        )
        files = [dict(row) for row in await cur.fetchall()]

        cur = await conn.execute(
            "SELECT summary FROM rag_workspace_summaries WHERE workspace_id = %s",
            (workspace_id,),
        )
        row = await cur.fetchone()

    return {
        "chapters": chapters,
        "files": files,
        "summary": (row or {}).get("summary") or "",
    }


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
    *, file_id: str, start: int, count: int
) -> list[dict[str, Any]]:
    db = await pool()
    async with db.connection() as conn:
        cur = await conn.execute(
            """
            SELECT c.id, c.file_id, c.chunk_idx, c.section_path, c.text, c.page_start,
                   c.page_end, c.regions, f.name AS file_name
            FROM rag_chunks c JOIN files f ON f.id = c.file_id
            WHERE c.file_id = %s AND c.chunk_idx >= %s
            ORDER BY c.chunk_idx
            LIMIT %s
            """,
            (file_id, start, count),
        )
        return [dict(row) for row in await cur.fetchall()]


async def chapter_file_summaries(chapter_id: str) -> list[dict[str, Any]]:
    db = await pool()
    async with db.connection() as conn:
        cur = await conn.execute(
            """
            SELECT f.name, coalesce(fs.summary, '') AS summary
            FROM files f LEFT JOIN rag_file_summaries fs ON fs.file_id = f.id
            WHERE f.chapter_id = %s
            ORDER BY f.position, f.added_at
            """,
            (chapter_id,),
        )
        return [dict(row) for row in await cur.fetchall()]


async def dirty_chapters(workspace_id: str) -> list[dict[str, Any]]:
    db = await pool()
    async with db.connection() as conn:
        cur = await conn.execute(
            """
            SELECT cs.chapter_id, ch.name
            FROM rag_chapter_summaries cs JOIN chapters ch ON ch.id = cs.chapter_id
            WHERE cs.workspace_id = %s AND cs.dirty
            """,
            (workspace_id,),
        )
        return [dict(row) for row in await cur.fetchall()]


async def set_chapter_summary(chapter_id: str, summary: str) -> None:
    db = await pool()
    async with db.connection() as conn:
        await conn.execute(
            """
            UPDATE rag_chapter_summaries
            SET summary = %s, dirty = false, updated_at = now()
            WHERE chapter_id = %s
            """,
            (summary, chapter_id),
        )


async def set_workspace_summary(workspace_id: str, summary: str) -> None:
    db = await pool()
    async with db.connection() as conn:
        await conn.execute(
            """
            INSERT INTO rag_workspace_summaries (workspace_id, summary, dirty, updated_at)
            VALUES (%s, %s, false, now())
            ON CONFLICT (workspace_id) DO UPDATE
            SET summary = EXCLUDED.summary, dirty = false, updated_at = now()
            """,
            (workspace_id, summary),
        )


async def mark_workspace_dirty(workspace_id: str) -> None:
    """Content changed (as opposed to organization, which the trigger covers)."""
    db = await pool()
    async with db.connection() as conn, conn.transaction():
        await conn.execute(
            """
            INSERT INTO rag_workspace_summaries (workspace_id, dirty)
            VALUES (%s, true)
            ON CONFLICT (workspace_id) DO UPDATE SET dirty = true
            """,
            (workspace_id,),
        )
        await conn.execute(
            """
            INSERT INTO rag_chapter_summaries (chapter_id, workspace_id, dirty)
            SELECT f.chapter_id, f.workspace_id, true
            FROM files f
            WHERE f.workspace_id = %s AND f.chapter_id IS NOT NULL
            ON CONFLICT (chapter_id) DO UPDATE SET dirty = true
            """,
            (workspace_id,),
        )
        await conn.execute(
            """
            INSERT INTO jobs (id, type, payload)
            VALUES ('job_' || substr(md5(random()::text || clock_timestamp()::text), 1, 10),
                    'summaries_rollup', jsonb_build_object('workspaceId', %s::text))
            ON CONFLICT DO NOTHING
            """,
            (workspace_id,),
        )


async def content_hash_owner(
    workspace_id: str, content_hash: str
) -> dict[str, Any] | None:
    """Another ready file in this workspace with identical parsed content."""
    db = await pool()
    async with db.connection() as conn:
        cur = await conn.execute(
            """
            SELECT id, name FROM files
            WHERE workspace_id = %s AND content_hash = %s AND status = 'ready'
            LIMIT 1
            """,
            (workspace_id, content_hash),
        )
        row = await cur.fetchone()
        return dict(row) if row else None


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
