"""The gateway's bank routes, answered from a local restore of a bank dump.

Production reads the bank only through Go (`/api/internal/bank/list`, `read`,
`copy`); the playground has no gateway, so these return the same JSON from
`CAPY_PLAYGROUND_BANK_URL` (default the restore on port 15499; see the
playground README). Never point it at the live bank.
"""

from __future__ import annotations

import os
from typing import Any

import psycopg
from psycopg.rows import dict_row

PAGE = 50
URL = os.environ.get(
    "CAPY_PLAYGROUND_BANK_URL", "postgresql://postgres:lab@127.0.0.1:15499/bank"
)


async def _rows(sql: str, params: tuple[Any, ...] = ()) -> list[dict[str, Any]]:
    # One short connection per call: a pool that fails its first connect
    # stalls the turn instead of failing it.
    async with await psycopg.AsyncConnection.connect(
        URL, row_factory=dict_row, connect_timeout=3
    ) as conn:
        return await (await conn.execute(sql, params)).fetchall()


async def list_(payload: dict[str, Any]) -> tuple[int, dict[str, Any]]:
    qtype = payload.get("questionType") or ""
    if qtype and not payload.get("topicId"):
        return 400, {"code": "invalid_input", "message": "questionType needs topicId"}
    if payload.get("topicId"):
        topic, offset = payload["topicId"], int(payload.get("offset") or 0)
        # An empty question type matches every question, as in Go's Page.
        typed = "(%s = '' OR %s = ANY(question_types))"
        exists = await _rows(
            "SELECT (SELECT count(*) FROM topics WHERE id = %s) AS t, "
            f"(SELECT count(*) FROM questions WHERE topic_id = %s AND {typed}) AS n",
            (topic, topic, qtype, qtype),
        )
        if not exists[0]["t"]:
            return 404, {"code": "unavailable_target", "message": f"No bank topic {topic}."}
        rows = await _rows(
            "SELECT id, content AS question, question_types AS \"questionTypes\" "
            f"FROM questions WHERE topic_id = %s AND {typed} "
            "ORDER BY position, id OFFSET %s LIMIT %s",
            (topic, qtype, qtype, offset, PAGE),
        )
        return 200, {"total": exists[0]["n"], "questions": rows}
    if payload.get("subjectId"):
        rows = await _rows(
            "SELECT t.id, t.label, count(q.id) AS questions FROM topics t "
            "LEFT JOIN questions q ON q.topic_id = t.id WHERE t.subject_id = %s "
            "GROUP BY t.id, t.label, t.position ORDER BY t.position",
            (payload["subjectId"],),
        )
        if not rows:
            return 404, {"code": "unavailable_target", "message": f"No bank subject {payload['subjectId']}."}
        return 200, {"topics": rows}
    rows = await _rows(
        "SELECT e.id AS exam, e.label AS \"examLabel\", s.id, s.label, count(q.id) AS questions "
        "FROM exams e JOIN subjects s ON s.exam_id = e.id "
        "LEFT JOIN topics t ON t.subject_id = s.id LEFT JOIN questions q ON q.topic_id = t.id "
        "GROUP BY e.id, e.label, e.position, s.id, s.label, s.position ORDER BY e.position, s.position"
    )
    return 200, {"subjects": rows}


async def read(question_id: str) -> dict[str, Any] | None:
    rows = await _rows(
        "SELECT q.id, q.content AS question, q.sources, e.label AS exam, "
        "s.label AS subject, t.label AS topic FROM questions q "
        "JOIN topics t ON t.id = q.topic_id JOIN subjects s ON s.id = t.subject_id "
        "JOIN exams e ON e.id = s.exam_id WHERE q.id = %s",
        (question_id,),
    )
    return rows[0] if rows else None


async def handle(path: str, payload: dict[str, Any]) -> tuple[int, dict[str, Any]]:
    """The gateway's answer to a bank read: status and JSON body."""
    if path.endswith("/bank/list"):
        return await list_(payload)
    row = await read(str(payload.get("questionId")))
    if row is None:
        return 404, {"code": "unavailable_target", "message": "No bank question with that id."}
    return 200, row
