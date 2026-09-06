"""Generate-slot prompts: the fixed study-material workflows.

Generation is not a conversation. Each kind states its output contract in the
instruction because the gateway has to persist what comes back — a model that
answers in prose instead of JSON fails the request, so the format rule is not
advisory.
"""

from __future__ import annotations

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
        "Do not invent facts that are not in them. Follow the requested output "
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


def quiz_instruction(*, count: int, types: list[str], levels: list[str]) -> str:
    return (
        f"Create a {count}-question quiz from these sources using question types "
        f'{types}. Tag each question with a cognitive "level" chosen from: '
        f"{_LEVEL_GUIDE}. Aim for a mix across these levels: {levels}, and make "
        "each question genuinely match the cognitive demand of its level. "
        "Return ONLY a JSON array of question objects. Each object has: "
        '"type" (one of mcq, multi, boolean, short, open, ordering, matching), '
        '"level" (recall|application|analysis), "prompt", and the fields '
        "appropriate to its type (mcq/multi: options[] + correct[] indices; "
        "boolean: correct bool; short: accepted[]; open: accepted[] model "
        "answer, hints[], rubrics[] marking-scheme strings, optional points; "
        "ordering: items[] in order; matching: pairs[] of {left,right}). For "
        "mcq and multi, each option MUST be an object "
        '{"value": "...", "explanation": "..."} where the explanation says '
        "why that option is correct or incorrect. For boolean, short, open, "
        "ordering and matching, add a single "
        '"explanation" field for the question.'
    )
