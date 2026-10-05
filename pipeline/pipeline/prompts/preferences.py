"""Study preferences as instructions for the build flow.

The learner saves these in Settings; a request overrides any of them ("make it
brief this time"). Language is the account locale, not a preference. Kept next
to the prompt so the playground can tune the wording.
"""

from __future__ import annotations

from typing import Any

DEFAULTS: dict[str, Any] = {
    "explainerStyle": "standard",
    "practice": "quiz",
    "quizLength": 8,
    "flashcardsPerChapter": 15,
    "miniChecks": True,
    "visualAids": "more",
    "mainFormat": "auto",
}

# Each chapter's main explainer (decks: openwiki/decks.md).
MAIN_FORMAT = {
    "note": "Main explainer: a note for every chapter.",
    "deck": "Main explainer: a deck for every chapter.",
    "auto": (
        "Main explainer: a deck for brief or lecture-like learning, a note for "
        "detailed, text-dense learning; choose from the explainer style (brief "
        "leans deck, detailed leans note)."
    ),
}

EXPLAINER = {
    "brief": "Explainer notes are short: key points first, one example where it helps.",
    "standard": "Explainer notes cover each idea with a definition, an explanation and an example.",
    "detailed": "Explainer notes are full: every idea explained step by step with worked examples.",
}

VISUALS = {
    "fewer": "Add a diagram, mindmap or interactive block only where text cannot carry the idea.",
    "more": "Add diagrams, mindmaps and interactive blocks wherever they make an idea easier to see.",
}


# The field that sets /generate's count for a kind when the request leaves it
# out. /generate makes no notes, so explainer style, mini checks and visual aids
# never apply to it.
GENERATE_COUNT = {"quiz": "quizLength", "flashcards": "flashcardsPerChapter"}


def merged(saved: dict[str, Any] | None) -> dict[str, Any]:
    """Saved values over defaults."""
    return {**DEFAULTS, **{k: v for k, v in (saved or {}).items() if v is not None}}


def generate_count(kind: str, saved: dict[str, Any] | None) -> int:
    """How many questions or cards /generate makes of a quiz or flashcard set."""
    return int(merged(saved)[GENERATE_COUNT[kind]])


def lines(saved: dict[str, Any] | None) -> list[str]:
    """One instruction per preference, saved values over defaults."""
    p = merged(saved)
    practice = {
        "none": "Build no practice unless asked.",
        "quiz": f"Practise each chapter with a quiz of {p['quizLength']} questions.",
        "flashcards": f"Practise each chapter with {p['flashcardsPerChapter']} flashcards.",
        "both": (
            f"Practise each chapter with a quiz of {p['quizLength']} questions "
            f"and {p['flashcardsPerChapter']} flashcards."
        ),
    }
    checks = (
        "Close each note section with a mini knowledge check of two or three questions or cards."
        if p["miniChecks"]
        else "Put no knowledge checks inside notes."
    )
    return [
        MAIN_FORMAT.get(p["mainFormat"], MAIN_FORMAT["auto"]),
        EXPLAINER.get(p["explainerStyle"], EXPLAINER["standard"]),
        practice.get(p["practice"], practice["quiz"]),
        checks,
        VISUALS.get(p["visualAids"], VISUALS["more"]),
    ]
