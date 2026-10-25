"""Study preferences as instructions for the build flow.

The learner saves these in Settings; a request overrides any of them ("make it
brief this time"). Language is the account locale, not a preference. Kept next
to the prompt so the playground can tune the wording.
"""

from __future__ import annotations

from typing import Any

DEFAULTS: dict[str, Any] = {
    "mainFormat": "note",
    "writingStyle": "normal",
    "quiz": "less",
    "flashcards": "off",
    "visualAids": "more",
    "knowledgeChecks": True,
}

# The output file that explains each chapter: Settings' Capy Note or
# Powerpoint (decks: openwiki/decks.md).
# Other materials follow these preferences and what teaching the chapter
# needs (Epo 2026-10-14).
MAIN_FORMAT = {
    "note": (
        "Output files: a note explains each chapter; make other materials as these "
        "preferences and what teaching the chapter needs say."
    ),
    "deck": (
        "Output files: a deck explains each chapter; make other materials as these "
        "preferences and what teaching the chapter needs say."
    ),
}

# How the main explainer, a note or a deck, explains (Epo 2026-10-14).
WRITING = {
    "brief": "Explainers are short: key points first, one example where it helps.",
    "normal": "Explainers cover each idea with a definition, an explanation and an example.",
    "verbose": "Explainers are full: every idea explained step by step with worked examples.",
}

VISUALS = {
    "fewer": "Add a chart, plot or interactive block only where text cannot carry the idea.",
    "more": "Add charts, plots and interactive blocks wherever they make an idea easier to see.",
}

# A note's knowledge checks: questions unless flashcards is set higher than
# quiz (Epo 2026-10-14). Their size and placement are said here only.
CHECKS = {
    "questions": "Close each note section with a knowledge check of at most 2 questions.",
    "cards": "Close each note section with a knowledge check of at most 3 flashcards.",
    "off": "Put no knowledge checks inside notes.",
}

# Questions or cards per chapter for each practice level; a quiz is smaller
# than a card set (Epo 2026-10-25).
COUNT = {
    "quiz": {"more": 5, "less": 2},
    "flashcards": {"more": 10, "less": 5},
}
LEVEL = {"off": 0, "less": 1, "more": 2}


def merged(saved: dict[str, Any] | None) -> dict[str, Any]:
    """Saved values over defaults."""
    return {**DEFAULTS, **{k: v for k, v in (saved or {}).items() if v is not None}}


def lines(saved: dict[str, Any] | None) -> list[str]:
    """One instruction per preference, saved values over defaults."""
    p = merged(saved)
    # Each item on gets its count; an item off is said off, or the model adds
    # it anyway (a default build made flashcards, 2026-10-14).
    items = {
        "quiz": ("a quiz of {} questions", "quizzes"),
        "flashcards": ("a set of {} flashcards", "flashcards"),
    }
    on = [
        made.format(COUNT[k][p[k]])
        for k, (made, _) in items.items()
        if p[k] in COUNT[k]
    ]
    off = [name for k, (_, name) in items.items() if p[k] not in COUNT[k]]
    # Knowledge checks are notes only; a check is a quiz or flashcards fence, so
    # with them on only standalone ones are off.
    notes = p["mainFormat"] != "deck"
    checks = "off"
    if p["knowledgeChecks"]:
        cards = LEVEL.get(p["flashcards"], 0) > LEVEL.get(p["quiz"], 0)
        checks = "cards" if cards else "questions"
    standalone = "standalone " if notes and checks != "off" else ""
    if not on:
        practice = f"Build no {standalone}quizzes or flashcards unless asked."
    else:
        practice = f"Practise each chapter with {' and '.join(on)}"
        practice += (
            f"; make no {standalone}{' or '.join(off)} unless asked." if off else "."
        )
    return [
        MAIN_FORMAT.get(p["mainFormat"], MAIN_FORMAT["note"]),
        WRITING.get(p["writingStyle"], WRITING["normal"]),
        practice,
        *([CHECKS[checks]] if notes else []),
        VISUALS.get(p["visualAids"], VISUALS["more"]),
    ]
