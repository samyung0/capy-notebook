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
    "read before creating notes, quizzes, flashcards, mindmaps or diagrams, or "
    "adding note sections or questions"
)

_EDITING = f"""How to write to the workspace: create materials, add to them and edit files.

Ledger and budget:
- Building more than one item, put one todo per item on the ledger with create_ledger (a string adds a todo, {{id, todo}} rewrites one; pass only the changes) and pass its id as todo with each write; the write completes it. Completed ids are not reused, and at most 10 todos may be open.
- With ledger todos a turn has {LEDGER_TOOLS_PER_TURN} tool calls, and after {STALL_RESPONSES} responses in a row that complete no todo, the next has tools off. The first plan and each completed todo count as progress; each of the first {WRITE_ERROR_GRACE_MAX} errored writes grants {WRITE_ERROR_GRACE} more responses.

Precautions:
- Ground every write in passages or excerpts you have read, and leave out what they do not support.
- Write each item as soon as its evidence is in hand. Do not keep exploring once the evidence covers it, and do not mix a write with retrieval calls in one response.
- Inspect a document before editing it; never take edit positions from search results or from tool results retained from earlier turns. Each edit command names its target and the exact text or value it expects, and one stale expectation refuses the whole call. Edits save directly, each with an Undo; formatting, media and PDF edits are not supported.
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

Note format (create_material content, edit_document insert_markdown): {note}

Quiz format (create_material questions, edit_document add_question and replace_question): {question}
An example question with a closed part and an open part; a quiz fence writes the same fields in YAML:
{question_example}

Flashcards: cards, a list of {{front, back}}.

When done, answer with the materials made, what each covers and its size, and the work still open."""

_BUILDING_LIBRARY = """

Practice from the library:
- Use one primary excerpt per section, and keep one book's notation unless another fills a gap you can name.
- Reuse question-bank questions and library exercises and worked examples before writing new questions. Walk the bank with list_question_bank (its exams and subjects, a subject's topics, then a topic's questions) and copy a question read with read_question into a quiz unchanged. Keep a worked example's question, givens, model and solution together, and never splice numbers from different examples. Label adapted or new practice as such; call it a source exercise only when the source asks it."""


def editing(*, library: bool) -> str:
    return _EDITING + (_EDITING_LIBRARY if library else "")


def workspace_building(formats: dict[str, str], *, library: bool) -> str:
    text = _BUILDING.format(
        note=formats["note"],
        question=formats["question"],
        question_example=formats["question_example"],
    )
    return text + (_BUILDING_LIBRARY if library else "")
