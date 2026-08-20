"""Open-question marking. Prompt and parse match src/features/quizzes/judge.ts."""

from __future__ import annotations

from typing import Any

GRADE_SYSTEM = (
    "You mark one student answer against a marking scheme. Reply with ONLY JSON: "
    '{"score":0|0.5|1,"reason":"one short sentence"}. No markdown.'
)


def build_grade_prompt(
    *,
    prompt: str,
    hints: list[str],
    rubrics: list[str],
    model_answer: str,
    user_answer: str,
) -> str:
    hint_lines = [h.strip() for h in hints if h.strip()]
    rubric_lines = [r.strip() for r in rubrics if r.strip()]
    lines = [
        f"Question: {prompt.strip()}",
        "",
        "Hints:\n" + "\n".join(f"- {h}" for h in hint_lines) if hint_lines else "",
        "",
        (
            "Marking scheme:\n" + "\n".join(f"- {r}" for r in rubric_lines)
            if rubric_lines
            else "Marking scheme: (none given — use the model answer)"
        ),
        "",
        f"Model answer: {model_answer.strip() or '(none)'}",
        f"Student answer: {user_answer.strip() or '(empty)'}",
        "",
        (
            "score 1 if the marking scheme is met, 0.5 if partly met, 0 if not. "
            "Do not reward wording that misses the rubrics."
        ),
    ]
    out: list[str] = []
    for line in lines:
        if line == "" and out and out[-1] == "":
            continue
        out.append(line)
    return "\n".join(out)


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
