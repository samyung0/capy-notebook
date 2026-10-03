"""Generate-slot prompts: the fixed study-material workflows.

Generation is not a conversation. Each kind states its output contract in the
instruction because the gateway has to persist what comes back — a model that
answers in prose instead of JSON fails the request, so the format rule is not
advisory.
"""

from __future__ import annotations

from ..generated import limits
from .locale import response_language_rule

# Mermaid header per diagram type. The prompt names the exact header so the
# reply parses; an unknown type lets the model pick the diagram that fits.
_DIAGRAM_HEADER = {
    "flowchart": "flowchart TD",
    "sequence": "sequenceDiagram",
    "class": "classDiagram",
    "state": "stateDiagram-v2",
    "er": "erDiagram",
}

# What each cognitive level asks the LLM to write, so questions have a purpose
# instead of a vague difficulty knob.
_LEVEL_GUIDE = (
    "recall (remember a fact, term, or definition), "
    "application (use a concept or procedure to solve a problem), "
    "analysis (compare, break down, or reason about relationships between ideas)"
)


def generate_messages(
    *,
    instruction: str,
    context: str,
    scope: str,
    locale: str | None,
) -> list[dict[str, str]]:
    """One material request: the grounding rules, then the kind's instruction."""
    system = (
        "You create study materials strictly from the provided source passages. "
        "Do not invent facts that are not in them. `[formula]` in a passage marks "
        "a formula printed as a picture: never copy it into a generated item, and "
        "skip items whose answer needs that formula. Follow the requested output "
        "format exactly, with no commentary around it.\n"
        + response_language_rule(locale)
    )
    user = instruction
    if scope:
        user += f"\n\nScope: {scope}."
    user += "\n\nSource passages:\n" + (context or "(no indexed content)")
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ]


def flashcards_instruction(count: int) -> str:
    return (
        f"Create {count} study flashcards from these sources. Return ONLY a JSON "
        'array of objects {"front": "...", "back": "..."}. Each front is a '
        "single question or term; each back is a self-contained answer."
    )


def mindmap_instruction(detail: str) -> str:
    return (
        "Create a Mermaid `mindmap` organizing the key concepts of these "
        f"sources and their relationships ({detail} level of detail). Return "
        "ONLY the Mermaid code starting with the line `mindmap` — no code "
        "fences, no prose."
    )


def diagram_instruction(diagram_type: str) -> str:
    header = _DIAGRAM_HEADER.get(diagram_type.lower())
    want = (
        f"a Mermaid `{header}` diagram"
        if header
        else "the most appropriate Mermaid diagram"
    )
    return (
        f"Create {want} that best illustrates the key ideas, processes or "
        "relationships in these sources. Return ONLY the Mermaid code (a "
        "valid diagram) — no code fences, no prose."
    )


QUESTION_CONTRACT = (
    """Return canonical question objects only, with no legacy fields:
{"stem": [Block], "parts": [{"blocks": [Block], "answer": Answer, "marks": 1,
"markscheme": [{"text": "one explicit marking item", "marks": 1}], "solution": [Block]}],
"layout": "paper" or "split", "labels": "letters" or "numbers"}.
The application assigns UUID ids to questions and parts; omit their ids.
"""
    + (
        f"Every question has 1 to {limits.QUIZ_QUESTION_PARTS_MAX} parts. Each part has "
        f"nonempty blocks, whole marks from 1 to {limits.QUESTION_MARKS_MAX} and a worked "
        "solution. Only an open part has a markscheme: 1 to "
        f"{limits.QUIZ_MARKSCHEME_MAX} items, each with whole marks, adding up to the "
        "part's marks; harder steps can carry more. Every other answer type has no "
        "markscheme key and explains its answer in the solution. The whole quiz has "
        f"at most {limits.QUIZ_PARTS_MAX} parts, of which "
        f"at most {limits.QUIZ_OPEN_PARTS_MAX} are open answers, and an open model answer "
        f"stays under {limits.QUIZ_OPEN_ANSWER_MAX} characters. A one-part question may "
        "have an empty stem.\n"
    )
    + """Block forms:
- {"type":"text", "text":"plain text with $inline math$ or $$display math$$", "label":"optional paragraph label"}.
- {"type":"table", "header":true, "rows":[["cell", "cell"]]}.
- {"type":"chart", "kind":"bar|hbar|line|area|pie|stacked", "title":"...", "labels":["..."], "series":[{"name":"...", "values":[1]}], optional "unit", "xTitle", "yTitle", "gridlines":"normal|fine"}.
Do not invent image URLs or SVGs. Use text, tables or charts for generated app quizzes.
Answer is one of:
- {"type":"mcq" or "multi", "options":["text option"], "correct":[0]} using zero-based indices; mcq has exactly one correct index.
- {"type":"boolean", "correct":true}.
- {"type":"short", "accepted":["value"], optional "unit":"authored fixed unit"}.
- {"type":"matching", "options":["complete choice pool including unused distractors"], "pairs":[{"left":"prompt", "right":0}]} with zero-based option indices; reusable choices only when question instructions permit them.
- {"type":"ordering", "items":["first", "second"]} stored in correct order.
- {"type":"open", "accepted":["model answer"], "hints":["hint"]}.
Strings are plain strings, never {value:...} wrappers. Put explanations in the
part's solution blocks, not on options. Do not emit points, rubrics, prompt,
difficulty, explanation or top-level type.
Open/essay answers must be NON-COMPUTATIONAL: only facts, definitions and
explanations assessable from text. Calculations, numerical equivalence, algebraic
or logical derivations and proofs must use deterministic answer types such as
mcq, multi or short instead. Do not ask an open answer to check mathematical working.
For quantities requiring units, author one required unit, state it in the question
and short answer unit field, and write accepted VALUES ONLY in that unit. The UI
fixes that unit; do not accept unit text or alternative-unit conversions. Text
blanks and unitless quantities omit unit. Each marking item is explicit plain text.
"""
)


def quiz_instruction(
    *, count: int, types: list[str], levels: list[str] | None = None
) -> str:
    level_rule = (
        f'Tag each question with "level" chosen only from {levels}: {_LEVEL_GUIDE}. '
        "Match the cognitive demand of each selected level. "
        if levels
        else 'Omit the optional "level" field. '
    )
    return (
        f"Create a {count}-question quiz from these sources using answer types {types}. "
        + level_rule
        + "Return ONLY a JSON array. "
        + QUESTION_CONTRACT
    )
