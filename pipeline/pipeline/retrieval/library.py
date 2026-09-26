"""Shared knowledge library: the reader side used by curate-mode tools.

The library is a separate database (deploy/docker-compose.library-db.yml)
holding one live workspace, ``library``, with one file per book. Each book
carries a version: publishing a book loads new content and swaps the book's
pointer, so every environment reads the same live set with no pins. The index
tables mirror the workspace ones so the production hybrid search statement runs
unchanged and sees only current content through ``rag_file_contents``; the
library-owned tables carry books with their version history, excerpts with
verified role and topic tags, figures and model-run receipts.

Retrieval unit is the excerpt (one section of one book). ``search`` ranks
chunks with hybrid search, restricted in SQL to excerpts whose verified tags
match the requested topics and roles, and folds the hits into excerpts by
best chunk. The taxonomy has subjects (the committed fixture) over topics
(derived per book): ``catalog`` lists the subjects that hold excerpts,
``browse_subject`` a subject's topics, ``browse`` one topic's excerpts. Measured
motivation in bench/rag/reports/2026-09-17-knowledge-base-retrieval.md: role
wording in a query does not move the ranker, tag predicates do.
"""

from __future__ import annotations

import asyncio
import re
from dataclasses import dataclass, field
from typing import Any

from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool

from .. import registry
from ..config import cfg
from ..jobs import TerminalError
from . import models, store
from .chunking import search_query_terms
from .knowledge_metadata import RetrievalMetadata
from .search import rerank

ROLES = ("introduction", "formal", "worked_example", "exercise", "summary", "reference")

# The one live workspace. Books are its files; a book version is one content.
WORKSPACE = "library"

# Owned here so the loader (bench/rag/scripts/knowledge_base_library.py) and
# the tests create exactly the schema this module reads.
LIBRARY_SCHEMA = """
CREATE EXTENSION IF NOT EXISTS vector;
-- Production-shaped index tables; one workspace row, 'library', carries the
-- embedding pin, and rag_file_contents points each book at its current content.
CREATE TABLE IF NOT EXISTS workspaces (id text PRIMARY KEY, embedding_provider_slug text NOT NULL, embedding_model_slug text NOT NULL, embedding_model_version int NOT NULL, embedding_dim int NOT NULL);
CREATE TABLE IF NOT EXISTS files (id text PRIMARY KEY, name text NOT NULL, added_at timestamptz NOT NULL DEFAULT now(), trashed_at timestamptz);
CREATE TABLE IF NOT EXISTS rag_contents (id text PRIMARY KEY, status text NOT NULL);
CREATE TABLE IF NOT EXISTS rag_file_contents (file_id text PRIMARY KEY REFERENCES files, workspace_id text NOT NULL REFERENCES workspaces, content_id text NOT NULL REFERENCES rag_contents);
-- Notes never enter the library. These stay empty so the production search
-- statement, which ranks note chunks in the same pool as file chunks, runs
-- unchanged here.
CREATE TABLE IF NOT EXISTS materials (id text PRIMARY KEY, title text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), trashed_at timestamptz);
CREATE TABLE IF NOT EXISTS rag_material_contents (material_id text PRIMARY KEY REFERENCES materials, workspace_id text NOT NULL REFERENCES workspaces, content_id text NOT NULL REFERENCES rag_contents);
CREATE TABLE IF NOT EXISTS library_chunks (
  id text PRIMARY KEY, workspace_id text NOT NULL REFERENCES workspaces, content_id text NOT NULL REFERENCES rag_contents,
  chunk_idx int NOT NULL, section_path text NOT NULL, text text NOT NULL, indexed_text text NOT NULL,
  page_start int, page_end int, regions jsonb NOT NULL, lang text NOT NULL, confidence double precision,
  confidence_reasons text[] NOT NULL, search tsvector NOT NULL, searchable boolean NOT NULL,
  book_id text NOT NULL, excerpt_id text NOT NULL, reference boolean NOT NULL
);
CREATE INDEX IF NOT EXISTS library_chunks_search_idx ON library_chunks USING gin(search);
CREATE INDEX IF NOT EXISTS library_chunks_content_idx ON library_chunks (content_id, chunk_idx);
CREATE INDEX IF NOT EXISTS library_chunks_excerpt_idx ON library_chunks (excerpt_id);
CREATE OR REPLACE VIEW rag_chunks AS SELECT id,workspace_id,content_id,chunk_idx,section_path,text,indexed_text,page_start,page_end,regions,lang,confidence,confidence_reasons,search FROM library_chunks WHERE searchable;
CREATE TABLE IF NOT EXISTS rag_chunk_vectors_2560 (chunk_id text PRIMARY KEY REFERENCES library_chunks, workspace_id text NOT NULL, embedding halfvec(2560) NOT NULL);
-- ponytail: exact vector scans, matching the pilot; add an HNSW index when the corpus outgrows them.
CREATE TABLE IF NOT EXISTS library_books (
  id text PRIMARY KEY, title text NOT NULL, authors jsonb NOT NULL,
  edition text NOT NULL, source_url text NOT NULL, download_url text NOT NULL, license text NOT NULL, license_url text NOT NULL,
  attribution text NOT NULL, sha256 text NOT NULL, bytes bigint NOT NULL, pages int NOT NULL, first_content_page int NOT NULL,
  -- The current version and the content it published; the parse and chunker
  -- identity of that content is a receipt on the version row.
  content_id text NOT NULL REFERENCES rag_contents, version int NOT NULL,
  rights_notes jsonb NOT NULL, figure_exclusions jsonb NOT NULL
);
-- Pages of reprinted texts the library withholds; page capture never renders them.
ALTER TABLE library_books ADD COLUMN IF NOT EXISTS withheld_pages int[] NOT NULL DEFAULT '{}';
CREATE TABLE IF NOT EXISTS library_book_versions (
  book_id text NOT NULL REFERENCES library_books, version int NOT NULL,
  content_id text NOT NULL REFERENCES rag_contents, published_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL CHECK (status IN ('current', 'retained', 'retired')),
  source_run text NOT NULL, corpus_identity text NOT NULL, parser_release text NOT NULL,
  parser_fingerprint text NOT NULL, chunker_version text NOT NULL,
  -- Written from this version's content, so a rollback restores them with it.
  descriptor text NOT NULL, summary text NOT NULL,
  -- books/<sha256>.pdf in the knowledge-base bucket; null until the object exists.
  object_key text, note text NOT NULL DEFAULT '',
  PRIMARY KEY (book_id, version)
);
-- Taxonomy: subjects are the committed fixture (lab/knowledge/subjects.json),
-- loaded by the loader; topics are library-wide, derived per book and upserted
-- by each publish under the book's subject.
CREATE TABLE IF NOT EXISTS library_subjects (id text PRIMARY KEY, area text NOT NULL, label text NOT NULL, aliases jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS library_topics (
  id text PRIMARY KEY, subject_id text NOT NULL REFERENCES library_subjects, label text NOT NULL, aliases jsonb NOT NULL,
  scope text NOT NULL, source_sections text NOT NULL
);
CREATE TABLE IF NOT EXISTS library_excerpts (
  content_id text NOT NULL REFERENCES rag_contents, id text NOT NULL, book_id text NOT NULL, section_path text NOT NULL,
  chunk_ids text[] NOT NULL, pages int[] NOT NULL, regions jsonb NOT NULL, figure_ids text[] NOT NULL, text text NOT NULL,
  tag_status text NOT NULL CHECK (tag_status IN ('tagged', 'failed')),
  roles text[] NOT NULL, topic_ids text[] NOT NULL, confidence double precision, evidence text NOT NULL,
  evidence_verified boolean NOT NULL, synopsis text NOT NULL, proposed_topic text, review_reasons text[] NOT NULL,
  PRIMARY KEY (content_id, id)
);
CREATE INDEX IF NOT EXISTS library_excerpts_id_idx ON library_excerpts (id);
-- NULL explicitly means scope has not been reviewed. Full synopses are retained.
ALTER TABLE library_excerpts ADD COLUMN IF NOT EXISTS retrieval jsonb;
CREATE TABLE IF NOT EXISTS library_figures (
  content_id text NOT NULL REFERENCES rag_contents, id text NOT NULL, book_id text NOT NULL, page int NOT NULL,
  bbox int[] NOT NULL, caption_bbox int[], space text NOT NULL, geometry_kind text NOT NULL, block_index int NOT NULL,
  original_caption jsonb NOT NULL, original_footnote jsonb NOT NULL, section_path text NOT NULL, excluded boolean NOT NULL,
  exclusion_evidence jsonb NOT NULL, capture_path text, capture_pixel_size int[],
  -- What the figure visibly shows, from the builder's transcribe stage; empty for the pilot books.
  description text NOT NULL DEFAULT '', PRIMARY KEY (content_id, id)
);
-- Book agents' figure notes: the printed label and caption, the printed credit
-- and licence, and whether the record is decorative (header band, icon, ornament).
ALTER TABLE library_figures ADD COLUMN IF NOT EXISTS label text NOT NULL DEFAULT '';
ALTER TABLE library_figures ADD COLUMN IF NOT EXISTS credit text NOT NULL DEFAULT '';
ALTER TABLE library_figures ADD COLUMN IF NOT EXISTS decorative boolean NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS library_model_runs (
  book_id text NOT NULL, content_id text NOT NULL REFERENCES rag_contents, stage text NOT NULL,
  transport text NOT NULL, model text NOT NULL,
  attempts int NOT NULL, collection jsonb NOT NULL, usage jsonb NOT NULL, approximate_cost_usd double precision,
  request_start_utc text, request_end_utc text, results_path text NOT NULL, PRIMARY KEY (book_id, content_id, stage)
);
"""

# A chunk qualifies when its excerpt carries a verified tag matching every
# requested facet. Empty facets pass everything, so a plain library search is
# still restricted to excerpts the tagger could verify.
_VERIFIED = """e.tag_status = 'tagged' AND e.evidence_verified
              AND e.confidence >= %(min_confidence)s
              AND NOT ('non_teaching' = ANY(e.roles))"""
_ELIGIBLE = f"""{_VERIFIED}
              AND EXISTS (SELECT 1 FROM library_chunks eligible_chunk
                          WHERE eligible_chunk.content_id = e.content_id
                            AND eligible_chunk.excerpt_id = e.id
                            AND eligible_chunk.searchable)"""

_VERIFIED_TAG_FILTER = f"""
      AND EXISTS (
            SELECT 1 FROM library_chunks lc
            JOIN library_excerpts e
              ON e.content_id = lc.content_id AND e.id = lc.excerpt_id
            WHERE lc.id = c.id
              AND {_VERIFIED}
              AND (%(no_topics)s OR e.topic_ids && %(topics)s::text[])
              AND (%(no_roles)s OR e.roles && %(roles)s::text[])
      )"""

_pool: AsyncConnectionPool | None = None
_pool_lock = asyncio.Lock()

# A library that is down must fail the turn fast enough to become a typed
# `model_unavailable`, not sit in the pool's default 30-second wait.
POOL_WAIT_S = 10.0


def enabled() -> bool:
    return bool(cfg.library_dsn)


async def pool() -> AsyncConnectionPool:
    """The library reader pool, opened once.

    The lock matters because two curate turns starting together would
    otherwise each build a pool and one would be dropped unclosed.
    """
    global _pool
    if not cfg.library_dsn:
        raise TerminalError("LIBRARY_DATABASE_URL is not configured")
    if _pool is None:
        async with _pool_lock:
            if _pool is None:
                opening = AsyncConnectionPool(
                    cfg.library_dsn,
                    min_size=1,
                    max_size=cfg.db_async_pool_max_size,
                    open=False,
                    timeout=POOL_WAIT_S,
                    kwargs={
                        "row_factory": dict_row,
                        "connect_timeout": 5,
                        "options": "-c statement_timeout=60000",
                    },
                )
                try:
                    await opening.open()
                except BaseException:
                    await opening.close()
                    raise
                _pool = opening
    return _pool


async def close_pool() -> None:
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None


# Searchable, verified excerpts of current versions: the unit taxonomy counts.
_CURRENT_ELIGIBLE = f"""
        SELECT e.id, e.content_id, e.topic_ids FROM library_excerpts e
        JOIN rag_file_contents fc
          ON fc.content_id = e.content_id AND fc.workspace_id = %(ws)s
        WHERE {_ELIGIBLE}"""


async def catalog(conn: Any) -> list[dict[str, Any]]:
    """Subjects holding searchable teaching excerpts, for the tool description."""
    cur = await conn.execute(
        f"""
        WITH held AS (
          SELECT t.subject_id, count(DISTINCT (e.content_id, e.id)) AS excerpts
          FROM ({_CURRENT_ELIGIBLE}) e
          CROSS JOIN unnest(e.topic_ids) AS topic_id
          JOIN library_topics t ON t.id = topic_id
          GROUP BY t.subject_id
        )
        SELECT s.id, s.label, s.aliases, s.area, held.excerpts
        FROM library_subjects s JOIN held ON held.subject_id = s.id ORDER BY s.label
        """,
        {"ws": WORKSPACE, "min_confidence": cfg.library_tag_min_confidence},
    )
    return [dict(row) for row in await cur.fetchall()]


async def browse_subject(subject_id: str) -> dict[str, Any]:
    """One subject with its topics and their tagged-excerpt counts.

    Subjects and topics are separate catalogs whose ids may coincide (the
    loader refuses new collisions, but the reader never guesses), so the
    tool dispatches here on the ``subject`` argument, never on lookup order.
    """
    db = await pool()
    async with db.connection() as conn:
        cur = await conn.execute(
            "SELECT id, label, aliases, area FROM library_subjects WHERE id = %s",
            (subject_id,),
        )
        subject = await cur.fetchone()
        if subject is None:
            raise ValueError(
                f"unknown subject id {subject_id!r}; subject ids are the ones "
                "listed in the browse_knowledge description"
            )
        cur = await conn.execute(
            f"""
            WITH held AS (
              SELECT t.id, count(DISTINCT (e.content_id, e.id)) AS excerpts
              FROM ({_CURRENT_ELIGIBLE}) e
              CROSS JOIN unnest(e.topic_ids) AS topic_id
              JOIN library_topics t ON t.id = topic_id
              WHERE t.subject_id = %(subject)s GROUP BY t.id
            )
            SELECT t.id, t.label, t.aliases, t.scope, coalesce(held.excerpts, 0) AS excerpts
            FROM library_topics t LEFT JOIN held ON held.id = t.id
            WHERE t.subject_id = %(subject)s ORDER BY t.label
            """,
            {
                "ws": WORKSPACE,
                "subject": subject_id,
                "min_confidence": cfg.library_tag_min_confidence,
            },
        )
        topics = [dict(row) for row in await cur.fetchall()]
    return {"subject": dict(subject), "topics": topics}


async def known_topics(topic_ids: list[str]) -> set[str]:
    """Which of these topic ids the library holds, in one query."""
    if not topic_ids:
        return set()
    db = await pool()
    async with db.connection() as conn:
        cur = await conn.execute(
            "SELECT id FROM library_topics WHERE id = ANY(%s)", (topic_ids,)
        )
        return {row["id"] for row in await cur.fetchall()}


@dataclass
class Excerpt:
    id: str
    book_id: str
    book_title: str
    section_path: str
    roles: list[str]
    topic_ids: list[str]
    confidence: float | None
    synopsis: str
    pages: list[int]
    figure_ids: list[str]
    chunk_ids: list[str]
    retrieval: RetrievalMetadata | None = None
    # Search only: the chunk that ranked this excerpt, and its fused score.
    hit_chunk_id: str = ""
    hit_text: str = ""
    hit_page_start: int | None = None
    hit_regions: list[dict[str, Any]] = field(default_factory=list)
    score: float = 0.0


@dataclass
class SearchResult:
    excerpts: list[Excerpt]
    topics: list[str]
    roles: list[str]
    # When topics and roles filtered everything out: verified excerpts on the
    # same topics by role, so the caller can relax on purpose rather than
    # guess. Without topics the counts are the whole library's and say nothing
    # about the query, so they are not computed.
    available_roles: dict[str, int] | None = None


@dataclass
class ExcerptRead:
    """One excerpt's chunks from a chunk index; ``next_start`` when more remain.

    ``start``, ``next_start`` and ``first``/``last`` are chunk indexes of the
    book, the same unit ``read_document`` pages a workspace file in.
    """

    excerpt: Excerpt
    start: int
    chunks: list[dict[str, Any]]
    next_start: int | None
    first: int
    last: int
    # The excerpt's figures a model may pick (id, label, description, credit);
    # decorative and excluded ones are left out.
    figures: list[dict[str, Any]] = field(default_factory=list)


@dataclass
class BrowseResult:
    topic: dict[str, Any]
    by_role: dict[str, int]
    by_book: dict[str, int]
    total: int
    page: int
    page_size: int
    items: list[Excerpt]


def _validate_facets(
    topics: list[str] | None, roles: list[str] | None
) -> tuple[list[str], list[str]]:
    topics = [t for t in (topics or []) if isinstance(t, str) and t]
    roles = [r for r in (roles or []) if isinstance(r, str) and r]
    unknown = [r for r in roles if r not in ROLES]
    if unknown:
        raise ValueError(f"unknown roles {unknown}; roles are {', '.join(ROLES)}")
    return topics, roles


async def _excerpts(conn: Any, ids: list[str]) -> dict[str, Excerpt]:
    """Excerpts of the books' current versions only, by id. Their figure ids
    leave out decorative and excluded figures, which a model never picks."""
    if not ids:
        return {}
    cur = await conn.execute(
        """
        SELECT e.id, e.book_id, b.title, e.section_path, e.roles, e.topic_ids,
               e.confidence, e.synopsis, e.pages, e.chunk_ids, e.retrieval,
               ARRAY(
                 SELECT u.id FROM unnest(e.figure_ids) WITH ORDINALITY AS u(id, n)
                 WHERE NOT EXISTS (
                   SELECT 1 FROM library_figures f
                   WHERE f.content_id = e.content_id AND f.id = u.id
                     AND (f.excluded OR f.decorative))
                 ORDER BY u.n) AS figure_ids
        FROM library_excerpts e
        JOIN rag_file_contents fc
          ON fc.content_id = e.content_id AND fc.workspace_id = %s
        JOIN library_books b ON b.id = e.book_id
        WHERE e.id = ANY(%s)
        """,
        (WORKSPACE, ids),
    )
    out = {}
    for row in await cur.fetchall():
        out[row["id"]] = Excerpt(
            id=row["id"],
            book_id=row["book_id"],
            book_title=row["title"],
            section_path=row["section_path"],
            roles=list(row["roles"]),
            topic_ids=list(row["topic_ids"]),
            confidence=row["confidence"],
            synopsis=row["synopsis"],
            pages=list(row["pages"]),
            figure_ids=list(row["figure_ids"]),
            chunk_ids=list(row["chunk_ids"]),
            retrieval=row["retrieval"],
        )
    return out


async def search(
    query: str,
    *,
    topics: list[str] | None = None,
    roles: list[str] | None = None,
    top_k: int | None = None,
    candidates: int | None = None,
    vector: list[float] | None = None,
) -> SearchResult:
    """Excerpt-level hybrid search restricted to verified tags.

    The fused chunks are reranked (``search.rerank``) before they fold into
    excerpts. ``vector`` bypasses query embedding; evaluations and tests use it
    to skip that provider call.
    """
    topics, roles = _validate_facets(topics, roles)
    top_k = top_k or cfg.search_top_k
    candidates = candidates or cfg.search_candidates
    db = await pool()
    async with db.connection() as conn:
        cur = await conn.execute(
            "SELECT embedding_provider_slug, embedding_model_slug, embedding_model_version, embedding_dim "
            "FROM workspaces WHERE id = %s",
            (WORKSPACE,),
        )
        pin = await cur.fetchone()
        if pin is None:
            raise TerminalError("the library has no embedding pin")
        pin = dict(pin)
        if vector is None:
            spec = registry.resolve_pinned(
                pin["embedding_provider_slug"],
                pin["embedding_model_slug"],
                pin["embedding_model_version"],
                registry.Slot.RETRIEVAL,
            )
            vectors = await models.embed([models.format_query(query, spec)], spec=spec)
            if not vectors:
                return SearchResult([], topics, roles)
            vector = vectors[0]
        rows = await store.hybrid_search(
            workspace_id=WORKSPACE,
            vector=vector,
            terms=search_query_terms(query),
            file_ids=None,
            candidates=candidates,
            pin=pin,
            conn=conn,
            chunk_filter=_VERIFIED_TAG_FILTER,
            chunk_filter_params={
                "min_confidence": cfg.library_tag_min_confidence,
                "no_topics": not topics,
                "topics": topics,
                "no_roles": not roles,
                "roles": roles,
            },
        )
        if not rows:
            available = (
                await _available_roles(conn, topics) if roles and topics else None
            )
            return SearchResult([], topics, roles, available)
    # No pooled connection is held while the reranker runs.
    rows, _ = await rerank(query, rows)
    async with db.connection() as conn:
        chunk_to_excerpt = await _chunk_excerpts(conn, [r["id"] for r in rows])
        ordered: list[tuple[str, dict[str, Any]]] = []
        seen: set[str] = set()
        passages: set[str] = set()
        for row in rows:
            excerpt_id = chunk_to_excerpt[row["id"]]
            if excerpt_id in seen:
                continue
            # Collapse repeated copies of the same hit within a book. Cross-book
            # similarity can hide different applicability, so it is not inferred.
            passage = re.sub(r"\s+", " ", row["text"]).strip()
            duplicate_key = f"{row['file_id']}\n{passage}"
            if passage and duplicate_key in passages:
                continue
            seen.add(excerpt_id)
            passages.add(duplicate_key)
            ordered.append((excerpt_id, row))
            if len(ordered) == top_k:
                break
        excerpts = await _excerpts(conn, [e for e, _ in ordered])
    result = []
    for excerpt_id, row in ordered:
        excerpt = excerpts[excerpt_id]
        excerpt.hit_chunk_id = row["id"]
        excerpt.hit_text = row["text"]
        excerpt.hit_page_start = row.get("page_start")
        excerpt.hit_regions = store.decode_regions(row.get("regions"))
        excerpt.score = float(row.get("score") or 0.0)
        result.append(excerpt)
    return SearchResult(result, topics, roles)


async def _chunk_excerpts(conn: Any, chunk_ids: list[str]) -> dict[str, str]:
    cur = await conn.execute(
        "SELECT id, excerpt_id FROM library_chunks WHERE workspace_id = %s AND id = ANY(%s)",
        (WORKSPACE, chunk_ids),
    )
    return {row["id"]: row["excerpt_id"] for row in await cur.fetchall()}


async def _available_roles(conn: Any, topics: list[str]) -> dict[str, int]:
    cur = await conn.execute(
        f"""
        SELECT role, count(DISTINCT (e.content_id, e.id)) AS n
        FROM library_excerpts e
        JOIN rag_file_contents fc
          ON fc.content_id = e.content_id AND fc.workspace_id = %(ws)s
        CROSS JOIN unnest(e.roles) AS role
        WHERE {_ELIGIBLE}
          AND (%(no_topics)s OR e.topic_ids && %(topics)s::text[])
        GROUP BY role ORDER BY role
        """,
        {
            "ws": WORKSPACE,
            "min_confidence": cfg.library_tag_min_confidence,
            "no_topics": not topics,
            "topics": topics,
        },
    )
    return {row["role"]: int(row["n"]) for row in await cur.fetchall()}


READ_CHUNKS = 12


async def read_excerpt(
    excerpt_id: str, *, start: int = 0, count: int = READ_CHUNKS
) -> ExcerptRead:
    """The excerpt's own chunks from chunk index ``start``, like read_document.

    ``start`` is a chunk index, not an offset into the excerpt, so the numbers
    the reader sees in the chunk headers are the ones it pages with.
    """
    if start < 0:
        raise ValueError("start must be a chunk index of 0 or more")
    if not 1 <= count <= READ_CHUNKS:
        raise ValueError(f"count must be between 1 and {READ_CHUNKS}")
    db = await pool()
    async with db.connection() as conn:
        found = await _excerpts(conn, [excerpt_id])
        excerpt = found.get(excerpt_id)
        if excerpt is None:
            raise ValueError(f"unknown excerpt {excerpt_id!r}")
        cur = await conn.execute(
            """
            SELECT min(c.chunk_idx) AS first, max(c.chunk_idx) AS last
            FROM library_chunks c
            JOIN rag_file_contents fc
              ON fc.content_id = c.content_id AND fc.workspace_id = %s
            WHERE c.excerpt_id = %s
            """,
            (WORKSPACE, excerpt_id),
        )
        bounds = dict(await cur.fetchone() or {})
        cur = await conn.execute(
            """
            SELECT c.id, c.chunk_idx, c.section_path, c.text, c.page_start, c.page_end
            FROM library_chunks c
            JOIN rag_file_contents fc
              ON fc.content_id = c.content_id AND fc.workspace_id = %s
            WHERE c.excerpt_id = %s AND c.chunk_idx >= %s
            ORDER BY c.chunk_idx LIMIT %s
            """,
            (WORKSPACE, excerpt_id, start, count + 1),
        )
        rows = [dict(row) for row in await cur.fetchall()]
        figures = []
        if excerpt.figure_ids:
            cur = await conn.execute(
                """
                SELECT f.id, f.label, f.description, f.credit
                FROM rag_file_contents fc
                JOIN library_figures f
                  ON f.content_id = fc.content_id AND f.id = ANY(%s)
                WHERE fc.file_id = %s AND fc.workspace_id = %s
                  AND NOT f.excluded AND NOT f.decorative
                ORDER BY f.page, f.block_index
                """,
                (excerpt.figure_ids, excerpt.book_id, WORKSPACE),
            )
            figures = [dict(row) for row in await cur.fetchall()]
    more = len(rows) > count
    rows = rows[:count]
    return ExcerptRead(
        excerpt=excerpt,
        start=start,
        chunks=rows,
        next_start=rows[-1]["chunk_idx"] + 1 if more else None,
        first=int(bounds.get("first") or 0),
        last=int(bounds.get("last") or 0),
        figures=figures,
    )


@dataclass
class CaptureTarget:
    """What ``capture_knowledge_page`` may render for one excerpt: the book's
    stored object and the pages the excerpt itself (or one of its figures) covers,
    less the book's withheld pages."""

    excerpt_id: str
    book_id: str
    book_title: str
    object_key: str
    bytes: int
    pages: list[int]
    withheld_pages: list[int]


async def capture_target(excerpt_id: str) -> CaptureTarget:
    db = await pool()
    async with db.connection() as conn:
        cur = await conn.execute(
            """
            SELECT e.book_id, e.content_id, e.pages, e.figure_ids, b.title,
                   v.object_key, b.bytes, b.withheld_pages
            FROM library_excerpts e
            JOIN rag_file_contents fc
              ON fc.content_id = e.content_id AND fc.workspace_id = %s
            JOIN library_books b ON b.id = e.book_id
            JOIN library_book_versions v
              ON v.book_id = b.id AND v.version = b.version
            WHERE e.id = %s
            """,
            (WORKSPACE, excerpt_id),
        )
        row = await cur.fetchone()
        if row is None:
            raise ValueError(f"unknown excerpt {excerpt_id!r}")
        pages = set(row["pages"] or [])
        if row["figure_ids"]:
            cur = await conn.execute(
                "SELECT page FROM library_figures WHERE content_id = %s AND id = ANY(%s)",
                (row["content_id"], list(row["figure_ids"])),
            )
            pages.update(int(figure["page"]) for figure in await cur.fetchall())
    withheld = set(row["withheld_pages"])
    return CaptureTarget(
        excerpt_id=excerpt_id,
        book_id=row["book_id"],
        book_title=row["title"],
        object_key=row["object_key"] or "",
        bytes=int(row["bytes"] or 0),
        pages=sorted(pages - withheld),
        withheld_pages=sorted(withheld),
    )


async def provenance(excerpt_ids: list[str]) -> list[dict[str, Any]]:
    """Attribution for the books behind these excerpts, one entry per book.

    This is the durable record a curated material carries, down to the book
    version it was written from; an unknown excerpt id is an error rather than
    a silently dropped credit.
    """
    wanted = list(dict.fromkeys(excerpt_ids))
    if not wanted:
        return []
    db = await pool()
    async with db.connection() as conn:
        cur = await conn.execute(
            """
            SELECT e.id AS excerpt_id, b.id, b.title, b.authors, b.edition,
                   b.license, b.license_url, b.source_url, b.version
            FROM library_excerpts e
            JOIN rag_file_contents fc
              ON fc.content_id = e.content_id AND fc.workspace_id = %s
            JOIN library_books b ON b.id = e.book_id
            WHERE e.id = ANY(%s)
            ORDER BY b.id, e.id
            """,
            (WORKSPACE, wanted),
        )
        rows = [dict(row) for row in await cur.fetchall()]
    missing = sorted(set(wanted) - {row["excerpt_id"] for row in rows})
    if missing:
        raise ValueError(f"unknown excerpt ids {missing}")
    books: dict[str, dict[str, Any]] = {}
    for row in rows:
        book = books.setdefault(
            row["id"],
            {
                "id": row["id"],
                "title": row["title"],
                "authors": list(row["authors"] or []),
                "edition": row["edition"],
                "license": row["license"],
                "licenseUrl": row["license_url"],
                "sourceUrl": row["source_url"],
                "version": int(row["version"]),
                "excerptIds": [],
            },
        )
        book["excerptIds"].append(row["excerpt_id"])
    return list(books.values())


async def browse(topic: str, *, page: int = 1, page_size: int = 20) -> BrowseResult:
    """One topic's verified counts by role and by book, then a page of excerpts."""
    if page < 1 or not 1 <= page_size <= 50:
        raise ValueError("page must be at least 1 and page_size between 1 and 50")
    db = await pool()
    async with db.connection() as conn:
        cur = await conn.execute(
            "SELECT id, label, aliases, scope FROM library_topics WHERE id = %s",
            (topic,),
        )
        found = await cur.fetchone()
        if found is None:
            raise ValueError(
                f"unknown topic id {topic!r}; topic ids come from browsing a subject"
            )
        by_role = await _available_roles(conn, [topic])
        cur = await conn.execute(
            f"""
            SELECT e.book_id, count(*) AS n FROM library_excerpts e
            JOIN rag_file_contents fc
              ON fc.content_id = e.content_id AND fc.workspace_id = %(ws)s
            WHERE {_ELIGIBLE} AND e.topic_ids && %(topics)s::text[]
            GROUP BY e.book_id ORDER BY e.book_id
            """,
            {
                "ws": WORKSPACE,
                "min_confidence": cfg.library_tag_min_confidence,
                "topics": [topic],
            },
        )
        by_book = {row["book_id"]: int(row["n"]) for row in await cur.fetchall()}
        cur = await conn.execute(
            f"""
            SELECT e.id FROM library_excerpts e
            JOIN rag_file_contents fc
              ON fc.content_id = e.content_id AND fc.workspace_id = %(ws)s
            WHERE {_ELIGIBLE} AND e.topic_ids && %(topics)s::text[]
            ORDER BY e.book_id, e.pages[1], e.id
            LIMIT %(limit)s OFFSET %(offset)s
            """,
            {
                "ws": WORKSPACE,
                "min_confidence": cfg.library_tag_min_confidence,
                "topics": [topic],
                "limit": page_size,
                "offset": (page - 1) * page_size,
            },
        )
        ids = [row["id"] for row in await cur.fetchall()]
        excerpts = await _excerpts(conn, ids)
    return BrowseResult(
        topic=dict(found),
        by_role=by_role,
        by_book=by_book,
        total=sum(by_book.values()),
        page=page,
        page_size=page_size,
        items=[excerpts[i] for i in ids],
    )
