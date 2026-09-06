"""Open-question marking: reading back what the judge returned.

The prompt itself lives in ``prompts/quiz.py``. Parsing stays here because
it is tolerant by design — a judge that wraps its JSON in prose still gets
scored rather than failing the attempt.
"""

from __future__ import annotations

from typing import Any


def snap_award(n: float) -> float:
    if n >= 0.75:
        return 1
    if n >= 0.25:
        return 0.5
    return 0


def parse_grade_response(text: str) -> dict[str, Any]:
    trimmed = (text or "").strip()
    start = trimmed.find("{")
    end = trimmed.rfind("}")
    if start < 0 or end <= start:
        return {"award": 0, "reason": "The judge did not return a score."}
    try:
        import json

        raw = json.loads(trimmed[start : end + 1])
    except (TypeError, ValueError):
        return {"award": 0, "reason": "The judge did not return a score."}
    score = raw.get("score")
    try:
        n = float(score)
    except (TypeError, ValueError):
        return {"award": 0, "reason": "The judge did not return a score."}
    reason = raw.get("reason")
    return {
        "award": snap_award(n),
        "reason": reason.strip() if isinstance(reason, str) else "",
    }
