"""Question bank, read-only: list and read published questions for the agent.

The bank is its own database (server/bankmigrations) that UAT and production
share. Its syllabus (exams, subjects, topics) is fixed by the syllabus files,
so the agent walks it like a table of contents instead of searching: exams and
subjects, a subject's topics, then a topic's questions a page at a time.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool

from ..config import cfg
from ..jobs import TerminalError
from . import library

PAGE = 50  # questions per listed page

_pool: AsyncConnectionPool | None = None
_pool_lock = asyncio.Lock()


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


def _text(blocks: list[dict[str, Any]]) -> str:
    return " ".join(
        str(b.get("text") or "") for b in blocks if b.get("type") == "text"
    ).strip()


def _clip(text: str, limit: int) -> str:
    return text if len(text) <= limit else text[:limit].rsplit(" ", 1)[0] + "…"


_SELECT = """
    SELECT q.id, q.content, q.question_types, q.sources, t.id AS topic_id,
           t.label AS topic, s.label AS subject, e.id AS exam
    FROM questions q
    JOIN topics t ON t.id = q.topic_id
    JOIN subjects s ON s.id = t.subject_id
    JOIN exams e ON e.id = s.exam_id
"""


async def _rows(sql: str, params: tuple[Any, ...] = ()) -> list[dict[str, Any]]:
    db = await pool()
    async with db.connection() as conn:
        return await (await conn.execute(sql, params)).fetchall()


async def subjects() -> list[dict[str, Any]]:
    """Every exam's subjects in syllabus order, with their question counts."""
    return await _rows(
        """
        SELECT e.id AS exam, e.label AS exam_label, s.id, s.label,
               count(q.id) AS questions
        FROM exams e
        JOIN subjects s ON s.exam_id = e.id
        LEFT JOIN topics t ON t.subject_id = s.id
        LEFT JOIN questions q ON q.topic_id = t.id
        GROUP BY e.id, e.label, e.position, s.id, s.label, s.position
        ORDER BY e.position, s.position
        """
    )


async def topics(subject_id: str) -> list[dict[str, Any]]:
    """A subject's topics in syllabus order, with their question counts."""
    return await _rows(
        """
        SELECT t.id, t.label, count(q.id) AS questions
        FROM topics t LEFT JOIN questions q ON q.topic_id = t.id
        WHERE t.subject_id = %s
        GROUP BY t.id, t.label, t.position
        ORDER BY t.position
        """,
        (subject_id,),
    )


async def questions(topic_id: str, offset: int) -> tuple[int, list[dict[str, Any]]]:
    """A topic's question count and one page of its questions, in bank order."""
    total = await _rows(
        "SELECT count(*) AS n FROM questions WHERE topic_id = %s", (topic_id,)
    )
    rows = await _rows(
        _SELECT + " WHERE t.id = %s ORDER BY q.position LIMIT %s OFFSET %s",
        (topic_id, PAGE, offset),
    )
    return total[0]["n"], rows


async def read(question_id: str) -> dict[str, Any] | None:
    db = await pool()
    async with db.connection() as conn:
        cur = await conn.execute(_SELECT + " WHERE q.id = %s", (question_id,))
        return await cur.fetchone()


def card(row: dict[str, Any]) -> str:
    """One listed question as the model reads it: the opening of its stem (a
    reading passage, for passage questions) and then what it asks."""
    content = row["content"]
    parts = content.get("parts") or []
    marks = sum(int(p.get("marks") or 0) for p in parts)
    types = (
        f" · {', '.join(row['question_types'])}" if row.get("question_types") else ""
    )
    stem = _text(content.get("stem") or [])
    asks = _text([b for p in parts for b in p.get("blocks") or []])
    lines = [_clip(stem, 120)] if stem else []
    if asks:
        lines.append(_clip(asks, 200))
    return (
        f"{row['id']} · {len(parts)} part{'s' if len(parts) != 1 else ''}, "
        f"{marks} marks{types}\n" + "\n".join(lines)
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
