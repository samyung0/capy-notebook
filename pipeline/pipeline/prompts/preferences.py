"""Study preferences as instructions for the build flow.

The learner saves these in Settings; a request overrides any of them ("make it
brief this time"). Language is the account locale, not a preference. Kept next
to the prompt so the playground can tune the wording.
"""

from __future__ import annotations

from typing import Any

DEFAULTS: dict[str, Any] = {
    "mainFormat": "note",
    "writingStyle": "brief",
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
        "Output files: a PowerPoint explains each chapter; make other materials as these "
        "preferences and what teaching the chapter needs say."
    ),
}

# How the main explainer, a note or a deck, explains (Epo 2026-10-14).
WRITING = {
    "brief": "Explainers are short: key points first, one example where it helps.",
    "normal": "Explainers cover each idea with a definition, an explanation and an example.",
    # From three narrated science-documentary transcripts: a scene with stakes,
    # a question held open, the idea's history with each concept explained
    # where the story needs it, turns, a closed loop (Epo 2026-10-25).
    "story": (
        "Explainers tell a story: open on a concrete moment with stakes (a "
        "person, place or date the sources give, or a scene marked as imagined) "
        "and pose the question it raises; then follow how the idea was found or "
        "how the process unfolds, in order, explaining each concept exactly when "
        "the story needs it, step by step, with an everyday comparison; let each "
        "section turn on a surprise, a failure or a reversal; close by answering "
        "the opening question and linking it to the learner's world. Never "
        "invent names, dates, quotes or events; definitions and numbers stay "
        "exact. Keep paragraphs short and easy to read."
    ),
}

VISUALS = {
    "fewer": "Add a chart, plot or interactive block only where text cannot carry the idea. Fewer images.",
    "more": "Add more images whenever possible.",
}

# A note's knowledge checks: questions unless flashcards is set higher than
# quiz (Epo 2026-10-14). Their size and placement are said here only.
CHECKS = {
    "questions": "Close each note section with a knowledge check of at most 1 question.",
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


# Account chat's wording (Epo 2026-10-30).
ACCOUNT_WRITING = {
    **WRITING,
    "brief": (
        "Avoid stacking difficult terms, chemical names or long equations unless "
        "its the central idea/flow for the response. Prefer hiding complexities for "
        'generic questions such as "How does a car work" when its obvious that user '
        "just want to have a brief overview. If more explanations can be provided, "
        "ask if the user wants to know more."
    ),
    "normal": (
        'Prefer hiding complexities for generic questions such as "How does a car '
        'work" when its obvious that user just want to have a brief overview. If '
        "more explanations can be provided, ask if the user wants to know more."
    ),
}


def merged(saved: dict[str, Any] | None) -> dict[str, Any]:
    """Saved values over defaults."""
    return {**DEFAULTS, **{k: v for k, v in (saved or {}).items() if v is not None}}


def lines(saved: dict[str, Any] | None, *, account: bool = False) -> list[str]:
    """One instruction per preference, saved values over defaults, each led by
    what it governs: Output files, Notes or General (Epo 2026-10-30).
    ``account``: account chat's wording."""
    p = merged(saved)
    writing = ACCOUNT_WRITING if account else WRITING
    # Each item on gets its count; an item off is said off, or the model adds
    # it anyway (a default build made flashcards, 2026-10-14).
    items = {
        "quiz": ("a quiz of at most {} questions", "quizzes"),
        "flashcards": ("a set of at most {} flashcards", "flashcards"),
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
        practice = (
            f"Output files: build no {standalone}quizzes or flashcards unless asked."
        )
    else:
        practice = f"Output files: each chapter with {' and '.join(on)}"
        practice += (
            f"; make no {standalone}{' or '.join(off)} unless asked." if off else "."
        )
    return [
        MAIN_FORMAT.get(p["mainFormat"], MAIN_FORMAT["note"]),
        f"General: {writing.get(p['writingStyle'], writing['brief'])}",
        practice,
        *([f"Notes: {CHECKS[checks]}"] if notes else []),
        f"General: {VISUALS.get(p['visualAids'], VISUALS['more'])}",
    ]
