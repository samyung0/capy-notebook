"""Question bank, as the chat agent reads it.

The bank is its own database (server/bankmigrations), and the retrieval
service holds no credentials for it: it lists and reads through the gateway
(`/api/internal/bank/*`), and copy_questions copies there. Its syllabus is
fixed, so the agent walks it like a table of contents: exams and subjects, a
subject's topics, then a topic's questions a page at a time.
"""

from __future__ import annotations

import json
from typing import Any

PAGE = 50  # questions per listed page; the gateway pages the same way


def _text(blocks: list[dict[str, Any]]) -> str:
    return " ".join(
        str(b.get("text") or "") for b in blocks if b.get("type") == "text"
    ).strip()


def _clip(text: str, limit: int) -> str:
    return text if len(text) <= limit else text[:limit].rsplit(" ", 1)[0] + "…"


def card(row: dict[str, Any]) -> str:
    """One listed question as the model reads it: the opening of its stem (a
    reading passage, for passage questions) and then what it asks."""
    content = row["question"]
    parts = content.get("parts") or []
    marks = sum(int(p.get("marks") or 0) for p in parts)
    types = f" · {', '.join(row['answerTypes'])}" if row.get("answerTypes") else ""
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
    """One question in full, to judge it before copying it with copy_questions."""
    return (
        f"Question {row['id']} ({row['exam']} · {row['subject']} · {row['topic']}).\n"
        "Copy it with copy_questions; its worked solution and marking scheme "
        "travel with it.\n"
        + json.dumps(row["question"], ensure_ascii=False)
        + "\nSources: "
        + json.dumps(row.get("sources") or [], ensure_ascii=False)
    )
