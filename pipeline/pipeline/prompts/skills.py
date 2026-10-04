"""Skills: instructions the chat agent reads with read_skill when its work needs
them, so a turn that only answers a question does not pay for them on every
call. ``retrieval/skills.py`` offers them; Epo tunes this text in the playground.
"""

from __future__ import annotations

MATERIALS_WHEN = (
    "read before creating or extending notes, quizzes, flashcards, mindmaps or diagrams"
)

_MATERIALS = """How to build study materials: notes, quizzes, flashcards, mindmaps and diagrams.

Plan:
- Survey first with read-only tools: list_sources, and the library when it is a source this turn.
- Before building more than one item, propose the plan: the chapters or topics, one main explainer each, and the practice. Build a single item, such as an explanation for the open file or one more quiz, directly. When unsure, propose.
- Building more than one item: put one todo per item on the ledger with create_ledger and pass its id as todo when writing; the write completes it. Completed ids are not reused, and at most 10 todos may be open.
- Search where the need is: the workspace for the learner's own material, the library for textbook explanations, examples and exercises.
- Write each item as soon as its evidence is in hand, in your own words. Do not keep exploring once the evidence covers it, and do not mix a write with retrieval calls in one response.

What to build:
- Each chapter gets one main explainer: a note for detailed, text-dense learning.
- Mindmaps, diagrams and interactive blocks go inside the note where they help an idea. Create a standalone mindmap or diagram only when asked.
- Quizzes and flashcards are standalone materials filed in the chapter they practise, by its chapter_id in the turn context. A quiz or flashcards fence inside a note is a mini knowledge check.
- Follow the study preferences in the turn context unless the request says otherwise.
- Grow a long note section by section: create it with its first sections, then append each next section with one edit_document insert_markdown command rather than rewriting the note.
- Ground every material in passages or excerpts you have read, and leave out what they do not support.

Note format (create_material content, edit_document insert_markdown): {note}

Quiz format (create_material questions, edit_document add_question and replace_question): {question}
An example question with a closed part and an open part; a quiz fence writes the same fields in YAML:
{question_example}

Flashcards: cards, a list of {{front, back}}.

When done, answer with the materials made, what each covers and its size, and the work still open."""

_MATERIALS_LIBRARY = """

Writing from the library:
- Pass excerpt_ids for every library excerpt a write uses; they become its attribution. Each must have been read with read_knowledge this turn or have its full text still in context; a search card, todo or summary alone is not a read.
- Use one primary excerpt per section, and keep one book's notation unless another fills a gap you can name.
- For practice, reuse question-bank questions and library exercises and worked examples before writing new questions. Walk the bank with list_question_bank (its exams and subjects, a subject's topics, then a topic's questions) and copy a question read with read_question into a quiz unchanged. Keep a worked example's question, givens, model and solution together, and never splice numbers from different examples. Label adapted or new practice as such; call it a source exercise only when the source asks it."""


def materials(formats: dict[str, str], *, library: bool) -> str:
    text = _MATERIALS.format(
        note=formats["note"],
        question=formats["question"],
        question_example=formats["question_example"],
    )
    return text + (_MATERIALS_LIBRARY if library else "")
