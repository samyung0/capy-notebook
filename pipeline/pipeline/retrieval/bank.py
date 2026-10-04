"""Question bank, read-only: search and read published questions for the agent.

The bank is its own database (server/bankmigrations) that UAT and production
share. Search filters by exam, topic and question type in SQL, then ranks by
embedding similarity with the library's embedding model: keyword search missed
most concept requests in bench/rag/reports/2026-10-04-bank-search.md.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import math
from typing import Any

from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool

from .. import registry
from ..config import cfg
from ..jobs import TerminalError
from . import library, models

_pool: AsyncConnectionPool | None = None
_pool_lock = asyncio.Lock()
# ponytail: question vectors live in process memory, embedded on the first
# search that needs them and re-embedded when the text changes. Store them in
# the bank at publication before production, so a search never waits on this.
_vectors: dict[str, tuple[str, list[float]]] = {}


def enabled() -> bool:
    return bool(cfg.bank_dsn)


async def pool() -> AsyncConnectionPool:
    global _pool
    if not cfg.bank_dsn:
        raise TerminalError("BANK_DATABASE_URL is not configured")
    if _pool is None:
        async with _pool_lock:
            if _pool is None:
                opening = AsyncConnectionPool(
                    cfg.bank_dsn,
                    min_size=1,
                    max_size=cfg.db_async_pool_max_size,
                    open=False,
                    timeout=library.POOL_WAIT_S,
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


def question_text(content: dict[str, Any]) -> str:
    """Stem and part text, without solutions or marking schemes."""
    blocks = list(content.get("stem") or [])
    for part in content.get("parts") or []:
        blocks.extend(part.get("blocks") or [])
    return " ".join(
        str(b.get("text") or "") for b in blocks if b.get("type") == "text"
    ).strip()


_SELECT = """
    SELECT q.id, q.content, q.question_types, q.sources, t.id AS topic_id,
           t.label AS topic, s.label AS subject, e.id AS exam
    FROM questions q
    JOIN topics t ON t.id = q.topic_id
    JOIN subjects s ON s.id = t.subject_id
    JOIN exams e ON e.id = s.exam_id
"""


async def _embedding_spec() -> registry.ModelConfig:
    """The library's embedding pin, so bank and library vectors agree."""
    db = await library.pool()
    async with db.connection() as conn:
        cur = await conn.execute(
            "SELECT embedding_provider_slug, embedding_model_slug, embedding_model_version "
            "FROM workspaces WHERE id = %s",
            (library.WORKSPACE,),
        )
        pin = await cur.fetchone()
    if pin is None:
        raise TerminalError("the library has no embedding pin")
    return registry.resolve_pinned(
        pin["embedding_provider_slug"],
        pin["embedding_model_slug"],
        pin["embedding_model_version"],
        registry.Slot.RETRIEVAL,
    )


def _unit(vector: list[float]) -> list[float]:
    norm = math.sqrt(sum(x * x for x in vector)) or 1.0
    return [x / norm for x in vector]


async def search(
    query: str,
    *,
    exam: str | None = None,
    topics: list[str] | None = None,
    types: list[str] | None = None,
    limit: int = 8,
) -> list[dict[str, Any]]:
    """The questions that best practise ``query`` among those matching the filters."""
    where, params = [], []
    if exam:
        where.append("e.id = %s")
        params.append(exam)
    if topics:
        where.append("t.id = ANY(%s)")
        params.append(topics)
    if types:
        where.append("q.question_types && %s")
        params.append(types)
    sql = _SELECT + (" WHERE " + " AND ".join(where) if where else "")
    db = await pool()
    async with db.connection() as conn:
        rows = await (await conn.execute(sql, params)).fetchall()
    if not rows:
        return []
    spec = await _embedding_spec()
    texts = {r["id"]: question_text(r["content"]) for r in rows}
    stale = [
        qid
        for qid, text in texts.items()
        if _vectors.get(qid, ("",))[0] != hashlib.sha256(text.encode()).hexdigest()
    ]
    for start in range(0, len(stale), 64):
        batch = stale[start : start + 64]
        vectors = await models.embed([texts[q][:4000] for q in batch], spec=spec)
        for qid, vector in zip(batch, vectors, strict=True):
            digest = hashlib.sha256(texts[qid].encode()).hexdigest()
            _vectors[qid] = (digest, _unit(vector))
    (query_vector,) = await models.embed([models.format_query(query, spec)], spec=spec)
    query_vector = _unit(query_vector)

    def score(row: dict[str, Any]) -> float:
        vector = _vectors[row["id"]][1]
        return sum(a * b for a, b in zip(vector, query_vector, strict=True))

    ranked = sorted(rows, key=score, reverse=True)[:limit]
    return [{**row, "text": texts[row["id"]]} for row in ranked]


async def read(question_id: str) -> dict[str, Any] | None:
    db = await pool()
    async with db.connection() as conn:
        cur = await conn.execute(_SELECT + " WHERE q.id = %s", (question_id,))
        return await cur.fetchone()


def card(row: dict[str, Any]) -> str:
    """One search hit as the model reads it."""
    content = row["content"]
    parts = content.get("parts") or []
    marks = sum(int(p.get("marks") or 0) for p in parts)
    types = (
        f" · {', '.join(row['question_types'])}" if row.get("question_types") else ""
    )
    text = row["text"]
    snippet = text if len(text) <= 300 else text[:300].rsplit(" ", 1)[0] + "…"
    return (
        f"{row['id']} · {row['exam']} · {row['topic']}{types} · "
        f"{len(parts)} part{'s' if len(parts) != 1 else ''}, {marks} marks\n{snippet}"
    )


def full(row: dict[str, Any]) -> str:
    """One question in full: its JSON to copy into a quiz unchanged, and its sources."""
    return (
        f"Question {row['id']} ({row['exam']} · {row['subject']} · {row['topic']}).\n"
        "Copy the JSON below into a quiz unchanged; the worked solution and "
        "marking scheme are part of it.\n"
        + json.dumps(row["content"], ensure_ascii=False)
        + "\nSources: "
        + json.dumps(row.get("sources") or [], ensure_ascii=False)
    )
