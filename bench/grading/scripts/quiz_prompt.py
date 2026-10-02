"""The retired generative quiz-grading prompt, frozen for this benchmark.

Production grading moved to Jev (`server/internal/jev`), which takes the
marking items directly. This copy keeps earlier reports reproducible;
`benchmark.py` loads it by path and hashes it alongside its results.
"""

from __future__ import annotations

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
