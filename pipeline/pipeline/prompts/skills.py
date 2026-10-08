"""Skills: instructions the chat agent reads with read_skill when its work needs
them, so a turn that only answers a question does not pay for them on every
call. ``retrieval/skills.py`` offers them; Epo tunes this text in the playground.
"""

from __future__ import annotations

from ..retrieval.limits import (
    LEDGER_TOOLS_PER_TURN,
    STALL_RESPONSES,
    WRITE_ERROR_GRACE,
    WRITE_ERROR_GRACE_MAX,
)

EDITING_WHEN = (
    "read before any write: creating materials, adding to them, or editing a file"
)
BUILDING_WHEN = (
    "read together with editing, in the same response, before creating notes, "
    "quizzes, flashcards, mindmaps or diagrams, or adding note sections or questions"
)
DECK_WHEN = "read before making a slide deck (create_deck, write_slide)"

_EDITING = f"""How to write to the workspace: create materials, add to them and edit files.

Ledger and budget:
- Building more than one item, put one todo per item on the ledger with create_ledger (a string adds a todo, {{id, todo}} rewrites one; pass only the changes) and pass its id as todo with each write; the write completes it. Completed ids are not reused, and at most 10 todos may be open.
- With ledger todos a turn has {LEDGER_TOOLS_PER_TURN} tool calls, and after {STALL_RESPONSES} responses in a row that complete no todo, the next has tools off. The first plan and each completed todo count as progress; each of the first {WRITE_ERROR_GRACE_MAX} errored writes grants {WRITE_ERROR_GRACE} more responses.

Precautions:
- Ground every write in passages or excerpts you have read, and leave out what they do not support.
- Write each item as soon as its evidence is in hand. Do not keep exploring once the evidence covers it, and do not mix a write with retrieval calls in one response.
- Inspect a document before editing it; never take edit positions from search results or from tool results retained from earlier turns. Each edit command names its target and the exact text or value it expects, as inspect_document shows it, and one stale expectation refuses the whole call. Edits save directly, each with an Undo; media and PDF edits are not supported.
- In a note, change plain wording with replace_text. Rewrite a block that has formatting or math ($…$ in inspect_document) with replace_block, writing the whole block as note markdown (a heading keeps its #).
- Keep changes other people made to a document unless the learner asks otherwise.
- Edit the learner's own source files only when asked. Such an edit takes no todo and no excerpt_ids."""

_EDITING_LIBRARY = """
- Pass excerpt_ids for every library excerpt a write uses; they become its attribution. Each must have been read with read_knowledge this turn or have its full text still in context; a search card, todo or summary alone is not a read."""

_BUILDING = """How to build new study materials: notes, quizzes, flashcards, mindmaps and diagrams.

Plan:
- Survey first with read-only tools: list_sources, and the library when it is a source this turn.
- Before building more than one item, propose the plan: the chapters or topics, one main explainer each, and the practice. Build a single item, such as an explanation for the open file or one more quiz, directly. When unsure, propose.
- Search where the need is: the workspace for the learner's own material, the library for textbook explanations, examples and exercises.

What to build:
- Each chapter gets one main explainer: a note for detailed, text-dense learning.
- Mindmaps, diagrams and interactive blocks go inside the note where they help an idea. Create a standalone mindmap or diagram only when asked.
- Quizzes and flashcards are standalone materials filed in the chapter they practise, by its chapter_id in the turn context. A quiz or flashcards fence inside a note is a mini knowledge check.
- Follow the study preferences in the turn context unless the request says otherwise.
- Grow a long note section by section: create it with its first sections, then append each next section with one edit_document insert_markdown command rather than rewriting the note.

Note format (create_material content, edit_document insert_markdown and replace_block): {note}

Quiz format (create_material questions, edit_document add_question and replace_question): {question}
An example question with a closed part and an open part; a quiz fence writes the same fields in YAML:
{question_example}

Flashcards: cards, a list of {{front, back}}.

When done, answer with the materials made, what each covers and its size, and the work still open."""

_BUILDING_LIBRARY = """

Practice from the library:
- Use one primary excerpt per section, and keep one book's notation unless another fills a gap you can name.
- Reuse question-bank questions and library exercises and worked examples before writing new questions. Walk the bank with list_question_bank (its exams and subjects, a subject's topics, then a topic's questions), read a question with read_question when its card is not enough to judge it, and copy the chosen ones with copy_questions by id: they arrive unchanged with their solutions and credits, and you write none of them. Keep a worked example's question, givens, model and solution together, and never splice numbers from different examples. Label adapted or new practice as such; call it a source exercise only when the source asks it."""


def editing(*, library: bool) -> str:
    return _EDITING + (_EDITING_LIBRARY if library else "")


def workspace_building(formats: dict[str, str], *, library: bool) -> str:
    text = _BUILDING.format(
        note=formats["note"],
        question=formats["question"],
        question_example=formats["question_example"],
    )
    return text + (_BUILDING_LIBRARY if library else "")


def deck_rules(viewbox: str) -> str:
    """How one slide is written; ppt-master's checker and exporter enforce it."""
    return f"""Write one slide as a single SVG; ppt-master's exporter turns it into native PowerPoint shapes.
- Root: <svg xmlns="http://www.w3.org/2000/svg" viewBox="{viewbox}" lang="<the deck's BCP-47 language>" data-pptx-page-role="cover|toc|section|content|ending" font-family=... font-size=...>, then a background <rect id="background" data-pptx-role="background" .../>.
- Every visible part sits in a module: a root-level <g id="..." data-pptx-bounds="x y width height"> whose bounds enclose its children. Modules do not overlap. A checker measures every text line against its module's bounds and the canvas and refuses the slide when text spills out, so write each sentence first, estimate its width from the style's characters-per-100px table, then size the module.
- Allowed: rect, circle, ellipse, line, polyline, polygon, path, text and tspan, g, defs with linearGradient, and image. Each text has x and y; set font-size, font-weight and fill on it or inherit them from its module. Write raw Unicode; escape & < > as &amp; &lt; &gt;. No style element, class, foreignObject, textPath, filters, animation, script, symbol or use, and no HTML entities.
- A figure is <image href="../images/p<page>.jpg" x y width height preserveAspectRatio="xMidYMid meet"/> for a page captured this turn with a bbox around the figure.
- Write the slide for one audience move (what the student knows before it and after it) and lay its points out by how they relate: order as a numbered sequence, contrast side by side, membership as parallel cards. Use only facts from what you read; the footer names the source."""


def deck(rules: str, style: str, style_text: str) -> str:
    """The deck skill: the method, the slide rules and the style with its
    reference slides (ppt-master's Quick route, openwiki/decks.md)."""
    return (
        "How to make a slide deck, the brief or lecture-like main explainer.\n\n"
        "Plan:\n"
        "- Outline with create_deck: one title and brief per slide, in order, one slide per idea, "
        "8 to 20 per chapter, opening with a cover. A brief says the slide's audience move (what "
        "the student knows before and after), how its points relate, and the content with its source.\n"
        "- Then write the slides one per write_slide call, each from what you just read for it. "
        "Each write_slide completes the ledger todo it names, so keep one open todo per slide still "
        "to write. Pass excerpt_ids for library content and todo while todos are open.\n"
        "- A slide the checker refuses comes back with its errors: fix those and send the whole "
        "slide again. Once every slide is written the deck is exported and stored in the workspace "
        "as a PPTX file.\n\n"
        f"Slides:\n{rules}\n\n"
        f"Write every slide in the {style} style:\n\n{style_text}"
    )
