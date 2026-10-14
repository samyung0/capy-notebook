"""Skills: instructions the chat agent reads with read_skill when its work needs
them, so a turn that only answers a question does not pay for them on every
call. ``retrieval/skills.py`` offers them; Epo tunes this text in the playground.
"""

from __future__ import annotations

from ..retrieval.limits import WRITE_ERROR_GRACE, WRITE_ERROR_GRACE_MAX

EDITING_WHEN = (
    "read before any write: creating materials, adding to them, or editing a file"
)
NOTE_BUILDING_WHEN = (
    "read together with editing, in the same response, before writing a note or "
    "adding note sections"
)
DECK_BUILDING_WHEN = (
    "read together with editing, in the same response, before making a PowerPoint "
    "deck (create_deck, write_slide)"
)

# The general guideline for every write (Epo 2026-10-14): the build plan, the
# quiz, flashcards, mindmap and diagram formats, and how to edit. A note's and
# a deck's own instructions are note_building and deck_building.
_EDITING = f"""How to write to the workspace: build study materials, add to them and edit files.

Plan:
- Survey first with read-only tools: list_sources, and the library when it is a source this turn.
- Search where the need is: the workspace for the learner's own material, the library for textbook explanations, examples and exercises.

What to build:
- Each chapter gets one main explainer, a note or a deck as the output-files preference says; note_building or deck_building says how to write it.
- Quizzes and flashcards are standalone materials filed in the chapter they practise, by its chapter_id in the turn context.
- Make other materials, a standalone mindmap or diagram included, as the study preferences and what teaching the chapter needs say.
- Follow the study preferences in the turn context unless the request says otherwise.

Budget:
- Once a write lands, each successful write is progress and the turn context counts the responses left without one; each of the first {WRITE_ERROR_GRACE_MAX} errored writes grants {WRITE_ERROR_GRACE} more.

Precautions:
- Ground every write in passages or excerpts you have read, and leave out what they do not support. Label an example the sources do not give as illustrative.
- Write each item as soon as its evidence is in hand. Do not keep exploring once the evidence covers it, and do not mix a write with retrieval calls in one response.
- Inspect a document before editing it; never take edit positions from search results or from tool results retained from earlier turns. Each edit command names its target and the exact text or value it expects, as inspect_document shows it, and one stale expectation refuses the whole call. Edits save directly, each with an Undo; uploaded media and PDFs cannot be edited.
- In a note, change plain wording with replace_text. Rewrite a block that has formatting or math ($…$ in inspect_document) with replace_block, writing the whole block as note markdown (a heading keeps its #).
- Keep changes other people made to a document unless the learner asks otherwise.
- Edit the learner's own source files only when asked. Such an edit takes no excerpt_ids.

Quizzes: add_questions writes multiple-choice, short-answer and open (written-answer, with a markscheme) questions, creating the quiz with its first ones (title) or adding to a quiz by quiz_id, a note's quiz too; options are shown in the order you write them, so vary which position holds the correct one; add_question_media puts a chart, a plot or a library figure under a question's text; edit_document remove_question removes one. Results list the question ids these tools take.

Flashcards: cards, a list of {{front, back}}.

Mindmaps and diagrams: content is one ```mermaid fence.

When done, answer with the materials made, what each covers and its size, and the work still open."""

_EDITING_LIBRARY = """
- excerpt_ids are a write's attribution: name the library excerpts it uses, each read with read_knowledge this turn or with its full text still in context (a search card or summary is not a read). Omitted, the write credits the excerpts read since your last write, or all read this turn when none are new."""

_NOTE_BUILDING = """How to write a note, a chapter's main explainer when the output-files preference says Capy Note.

- Mindmaps, diagrams and interactive blocks go inside the note where they help an idea, as the study preferences say.
- A quiz or flashcards fence inside a note is a knowledge check, sized and placed as the study preferences say.
- Grow a long note section by section: create it with its first sections, then append each next section with one edit_document insert_markdown command after block "end" rather than rewriting the note.

Note format (create_material content, edit_document insert_markdown and replace_block): {note}"""

_BUILDING_LIBRARY = """

Practice from the library:
- Use one primary excerpt per section, and keep one book's notation unless another fills a gap you can name.
- To show a figure read_knowledge listed this turn, put `![caption](figure:<figure id>)` on its own line in a note: the note stores the picture with its printed credit and credits its book. Any other image URL becomes a plain link.
- Reuse library exercises and worked examples before writing new questions. Keep a worked example's question, givens, model and solution together, and never splice numbers from different examples. Label adapted or new practice as such; call it a source exercise only when the source asks it."""


def editing(*, library: bool) -> str:
    return _EDITING + (_EDITING_LIBRARY if library else "")


def note_building(formats: dict[str, str], *, library: bool) -> str:
    return _NOTE_BUILDING.format(note=formats["note"]) + (
        _BUILDING_LIBRARY if library else ""
    )


def deck_rules(viewbox: str) -> str:
    """How one slide is written; ppt-master's checker and exporter enforce it."""
    return f"""Write one slide as a single SVG; ppt-master's exporter turns it into native PowerPoint shapes.
- Root: <svg xmlns="http://www.w3.org/2000/svg" viewBox="{viewbox}" lang="<the deck's BCP-47 language>" data-pptx-page-role="cover|toc|section|content|ending" font-family=... font-size=...>, then a background <rect id="background" data-pptx-role="background" .../>.
- Every visible part sits in a module: a root-level <g id="..." data-pptx-bounds="x y width height"> whose bounds enclose its children. Modules do not overlap. A checker measures every text line against its module's bounds and the canvas and refuses the slide when text spills out, so write each sentence first, estimate its width from the style's characters-per-100px table, then size the module.
- Allowed: rect, circle, ellipse, line, polyline, polygon, path, text and tspan, g, defs with linearGradient, and image. Each text has x and y; set font-size, font-weight and fill on it or inherit them from its module. Write raw Unicode; escape & < > as &amp; &lt; &gt;. No style element, class, foreignObject, textPath, filters, animation, script, symbol or use, and no HTML entities.
- A figure is <image href="../images/c<n>.jpg" x y width height preserveAspectRatio="xMidYMid meet"/> for capture n of this turn, made with a bbox around the figure (its result names n).
- Write the slide for one audience move (what the student knows before it and after it) and lay its points out by how they relate: order as a numbered sequence, contrast side by side, membership as parallel cards. Use only facts from what you read; the footer names the source."""


def deck_building(rules: str, style: str, style_text: str) -> str:
    """The deck skill: the method, the slide rules and the style with its
    reference slides (ppt-master's Quick route, openwiki/decks.md)."""
    return (
        "How to make a PowerPoint deck, a chapter's main explainer when the "
        "output-files preference says Powerpoint.\n\n"
        "Plan:\n"
        "- Outline with create_deck: one title and brief per slide, in order, one slide per idea, "
        "8 to 20 per chapter, opening with a cover. A brief says the slide's audience move (what "
        "the student knows before and after), how its points relate, and the content with its source.\n"
        "- Then write the slides one per write_slide call, each from what you just read for it.\n"
        "- A slide the checker refuses comes back with its errors: fix those and send the whole "
        "slide again. Once every slide is written the deck is exported and stored in the workspace "
        "as a PPTX file.\n"
        "- Finish a deck in the turn that creates it: its slides last only until the turn ends, "
        "and a deck with slides left unwritten is not saved.\n\n"
        f"Slides:\n{rules}\n\n"
        f"Write every slide in the {style} style:\n\n{style_text}"
    )
