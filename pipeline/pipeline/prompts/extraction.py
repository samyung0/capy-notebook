"""Extraction prompts: questions read from the selected pages of a paper
(todo-study-tracking.md §8).

One conversation (Epo 2026-11-05): the map call has every selected page, the layout
model's boxes as JSON and the answer files, the copy batches continue it, and the solve
calls continue the copy batch that holds their questions. The system prompt and tools
are the same on all of them, so the cache holds. A scan or an image goes with no page
text (Epo 2026-11-05), which only changes the first paragraph and each page's heading.
How a question was made has no say (Epo 2026-11-05, "i dont care how the quesitons is
made"): no prompt says printed or handwritten. A figure with no box takes a call of
its own.

A question's text is kept as written, in its own language: no locale rule.
"""

from __future__ import annotations

import json
from typing import Any

from ..generated import limits
from .sources import SOURCE_RULE, source_block

SYSTEM = f"""You copy the questions on the selected pages into a quiz, exactly as they appear. You see all the selected page images at once, each with the page's indexed text, which may be rough: the image is what counts. After the question pages may come answer files: a mark scheme, an answer key or someone's own answers, in any layout.

First you are asked for a map of the questions, as plain text. Then you are asked to copy some of them: give each its own record_question call, in order, from all its pages. Do not work out any answers yet. Later you are asked for the answers to some questions: give each its own record_answers call. Take each answer and its marks from the answer files or the page when they give them, even when your own working disagrees; otherwise work it out, and never change the question.

Copying:
- Keep the wording, numbers, symbols and language exactly as they appear. Write math as LaTeX between $ signs ($\\frac{{7(x-2)}}{{5}}$, $x^2$, $\\angle ABC$), and a dollar sign for money as \\$ ($\\$78$ or \\$78); never simplify or reword the text.
- A table becomes a table block. Leave out answer lines, boxes for working, working written under a question, "Answers written in the margins will not be marked", page headers and footers.
- A question's parts follow its labels (a), (b), (b)(i). The quiz holds parts in one flat list, so (b)(i) and (b)(ii) are two parts labelled "b(i)" and "b(ii)". Text under (b) before (i), such as the data the sub-parts use, is never left out: give it as b(i)'s lead_in. A question without parts has an empty stem and one part labelled "".
- At most {limits.QUIZ_QUESTION_PARTS_MAX} parts a question.
- mcq: the options' text in order, without their letters A, B, C, D. Keep that order, and leave the options out of the part's blocks.
- short: a single final value or word the learner types, for a part worth 1 mark with no working to show.
- open: anything answered with working, a proof, an explanation or a drawing, and any part marked for its method or worth more than 1 mark.
- marks: the part's marks as shown. When only the question's total is shown ("(3 marks)" after (a) and (b)), split it across the parts as the work suggests and give that total in total_marks. An item with no marks shown has 1.

Answers, when asked for them:
- Give every part its correct answer and a short worked solution.
- The answer: mcq "correct" (zero-based indexes of the right options); short "accepted"; open "points", the marking points with their marks, at most {limits.QUIZ_MARKSCHEME_MAX} adding up to the part's marks, and "accepted", a short model answer.

Figures: a layout model looked for pictures and charts on these pages. After the pages comes what it found, as JSON: each box's number, page, coordinates [left, top, right, bottom] on a 0-1000 grid of the page image (0, 0 is the top left corner), label and score. Boxes are hints from a model, not part of the page. For each diagram, graph, chart or photo a question needs, give boxes, the numbers of the boxes that hold it; the part whose text it follows ("" for the text shared by every part); and a few words on what it shows. A figure split across boxes (a diagram and its key, two shapes side by side) takes all of them. When boxes overlap, give the one that holds the whole figure and the least else. Leave out a box that holds no figure of a question. When no box holds a figure the question needs, give boxes [] and image, the page image it is on (counted from 1 in the order shown). The figure is cropped from the page into the quiz, so the blocks never describe it.

Each recorded question is checked at once. Fix what a result names and record that question again with the same label; an accepted question needs no second call. When every question or answer asked for is recorded, reply with the single word DONE.
{SOURCE_RULE}"""

# Scans and images (Epo 2026-11-05): no page text, nothing else changes.
SYSTEM_NO_PAGE_TEXT = SYSTEM.replace(
    ", each with the page's indexed text, which may be rough: the image is what counts.",
    ".",
    1,
)

# A text paper (Epo 2026-11-05, "keep going"): only its indexed text exists, so the
# opening says so and nothing asks for figures.
SYSTEM_TEXT_ONLY = (
    SYSTEM.split("\n\n", 1)[1]
    .split("\n\nFigures:", 1)[0]
    .join(
        (
            "You copy the questions in the selected files into a quiz, exactly as they "
            "appear. You see their indexed text at once. After the questions may come "
            "answer files: a mark scheme, an answer key or someone's own answers, in any "
            "layout.\n\n",
            "\n\nEach recorded" + SYSTEM.split("\n\nEach recorded", 1)[1],
        )
    )
)

MAP_ASK = (
    "Map these pages before recording anything. Call no tool in this reply. Answer with "
    "plain text, one line for each question, in order, exactly in this form:\n"
    "<label> | pages <first>-<last> | parts <part labels, or none> | figures <box "
    "numbers, or none>\n"
    "label is the question's number alone, as in 31, not B31; add a section (A1, B1) only "
    "when two questions on these pages would otherwise share a number. A question with no "
    "number takes the next number in order, starting from 1. first and last are the page "
    "numbers it is on, from its number to its last line, as the page headings give them. "
    "parts lists its part labels in order, separated by "
    "commas, with sub-parts written out: a, b(i), b(ii). figures lists the numbers of the "
    "boxes that hold its figures, separated by commas."
)

CUT_OFF = (
    "Your last reply was cut off at the output limit before its calls finished, "
    "so nothing in it was recorded. Record the questions on these pages again, "
    "fewer in each reply, and keep your working short."
)

_BLOCK = {
    "type": "object",
    "properties": {
        "type": {"type": "string", "enum": ["text", "table"]},
        "text": {"type": "string", "description": "text: the text."},
        "header": {
            "type": "boolean",
            "description": "table: whether the first row is a header.",
        },
        "rows": {
            "type": "array",
            "items": {"type": "array", "items": {"type": "string"}},
            "description": "table: the rows of cells.",
        },
    },
    "required": ["type"],
}

_LABEL = {
    "type": "string",
    "description": 'The question\'s label from the map, e.g. "7".',
}

_PART_LABEL = {
    "type": "string",
    "description": 'The part label: "a", "b(ii)"; "" for a question without parts.',
}

_ANSWER = {
    "type": "object",
    "properties": {
        "type": {"type": "string", "enum": ["mcq", "short", "open"]},
        "options": {
            "type": "array",
            "items": {"type": "string"},
            "description": "mcq: each option's text in order, without its letter.",
        },
        "unit": {
            "type": "string",
            "description": "short: the unit shown beside the answer space, if any.",
        },
    },
    "required": ["type"],
}

_PART = {
    "type": "object",
    "properties": {
        "label": _PART_LABEL,
        "lead_in": {
            "type": "string",
            "description": 'The first sub-part only: the text under its parent label before it, as under (b) before (i); "" when there is none.',
        },
        "blocks": {"type": "array", "items": _BLOCK, "minItems": 1},
        "answer": _ANSWER,
        "marks": {
            "type": "integer",
            "minimum": 1,
            "maximum": limits.QUESTION_MARKS_MAX,
        },
    },
    "required": ["label", "blocks", "answer", "marks"],
}

_FIGURE = {
    "type": "object",
    "properties": {
        "boxes": {
            "type": "array",
            "items": {"type": "integer"},
            "description": "The numbers of the boxes that hold the figure; [] when no box does.",
        },
        "image": {
            "type": "integer",
            "minimum": 1,
            "description": "Only with boxes []: the page image it is on, counted from 1 in the order shown.",
        },
        "part": {
            "type": "string",
            "description": 'The label of the part whose text the figure follows; "" for the text shared by every part.',
        },
        "description": {
            "type": "string",
            "description": f"A few words on what the figure shows, at most {limits.QUESTION_DESCRIPTION_MAX} characters.",
        },
    },
    "required": ["boxes", "part", "description"],
}

_QUESTION = {
    "type": "object",
    "properties": {
        "label": _LABEL,
        "stem": {
            "type": "array",
            "items": _BLOCK,
            "description": "Text before the first part, shared by every part.",
        },
        "parts": {"type": "array", "items": _PART, "minItems": 1},
        "total_marks": {
            "type": "integer",
            "description": "The question's total, when only a total is shown.",
        },
        "figures": {"type": "array", "items": _FIGURE},
        "pages": {
            "type": "array",
            "items": {"type": "integer"},
            "minItems": 2,
            "maxItems": 2,
            "description": "The first and last page it is on, from its number to its last line, as the page headings give them.",
        },
    },
    "required": ["label", "stem", "parts", "pages", "figures"],
}

# ``accepted`` is required for an open part's model answer. The flat part cannot
# name its answer type, so every part sends it (Epo 2026-11-05).
_ANSWERS = {
    "type": "object",
    "properties": {
        "label": _LABEL,
        "parts": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "label": _PART_LABEL,
                    "correct": {
                        "type": "array",
                        "items": {"type": "integer"},
                        "description": "mcq: zero-based indexes of the correct options.",
                    },
                    "accepted": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "short: the correct answer (the value alone when a unit is shown beside the answer space); open: a short model answer; mcq: an empty list.",
                    },
                    "points": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "text": {"type": "string"},
                                "marks": {"type": "integer", "minimum": 1},
                            },
                            "required": ["text", "marks"],
                        },
                        "description": f"open: the marking points, each a step that earns whole marks, at most {limits.QUIZ_MARKSCHEME_MAX}, adding up to the part's marks.",
                    },
                    "solution": {
                        "type": "string",
                        "description": "A short worked solution: the steps that lead to the answer.",
                    },
                },
                "required": ["label", "accepted", "solution"],
            },
            "minItems": 1,
        },
    },
    "required": ["label", "parts"],
}

TOOLS: list[dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "record_question",
            "description": "Record one whole question.",
            "parameters": _QUESTION,
        },
    },
    {
        "type": "function",
        "function": {
            "name": "record_answers",
            "description": "Record the answers to one question.",
            "parameters": _ANSWERS,
        },
    },
]


def page_heading(image: int, number: int, file_name: str) -> str:
    """A page sent with no text: its heading, numbered as figures name their page
    image."""
    return f"Page image {image}: page {number} of {file_name}."


def page_text(image: int, number: int, file_name: str, text: str) -> str:
    """A page's heading, numbered as figures name their page image, and its text."""
    heading = f"Page image {image}: page {number} of {file_name}"
    if not text.strip():
        return f"{heading}. It has no indexed text."
    return f"{heading}. Its indexed text:\n{source_block(text)}"


def text_page(number: int, file_name: str, text: str) -> str:
    """A question file with no page view: its heading and its indexed text."""
    return f"Page {number} of {file_name}. Its indexed text:\n{source_block(text)}"


def answer_image_heading(image: int, number: int, file_name: str) -> str:
    """An answer file's page sent as an image; ``image`` counts them across the files."""
    return f"Answer file page image {image}: page {number} of {file_name}."


def answer_text(file_name: str, text: str) -> str:
    """An answer file sent as its indexed text."""
    return f"Answer file {file_name}. Its indexed text:\n{source_block(text)}"


def map_messages(
    pages: list[tuple[str, str | None]],
    boxes: list[dict[str, Any]],
    answers: list[dict[str, Any]],
    *,
    system: str,
) -> list[dict[str, Any]]:
    """``pages`` are (page text or heading, image data URL or None) pairs; ``boxes`` the
    layout model's, numbered once across the selection; ``answers`` the answer files'
    content blocks. They go after the boxes, so the figures paragraph's "After the
    pages comes what it found" holds. Every thread continues these messages, so a run
    has one system prompt."""
    content: list[dict[str, Any]] = []
    for text, image in pages:
        content.append({"type": "text", "text": text})
        if image:
            content.append({"type": "image_url", "image_url": {"url": image}})
    if any(image for _, image in pages):
        content.append(
            {
                "type": "text",
                "text": f"Boxes on these pages, as JSON: {json.dumps(boxes)}",
            }
        )
    content.extend(answers)
    content.append({"type": "text", "text": MAP_ASK})
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": content},
    ]


def _named(labels: list[str]) -> str:
    if len(labels) == 1:
        return f"question {labels[0]}"
    return f"questions {labels[0]} to {labels[-1]}"


def copy_ask(labels: list[str]) -> str:
    """``labels`` are a contiguous run, by their numbers."""
    return f"Copy {_named(labels)} now."


def solve_ask(labels: list[str]) -> str:
    """``labels`` are a contiguous run, by their numbers."""
    return f"Give the answers to {_named(labels)} now."


# ------------------------------------------------------------------ figures

LOCATE_SYSTEM = (
    "You find figures on a page. Answer with JSON "
    'only: {"boxes": [[left, top, right, bottom], ...]}, one box for each '
    "figure listed, in the order listed, on a 0-1000 grid of the page image "
    "(0, 0 is the top left corner, 1000, 1000 the bottom right). A box holds "
    "the whole figure with its labels, title, axis labels and caption, and "
    "nothing of the question text, options or answer lines around it."
)


def locate_messages(image: str, figures: list[tuple[str, str]]) -> list[dict[str, Any]]:
    """``figures`` are (question label, what the figure shows) on one page."""
    listed = "\n".join(
        f"{n}. Question {label}: {what or 'its figure'}"
        for n, (label, what) in enumerate(figures, 1)
    )
    return [
        {"role": "system", "content": LOCATE_SYSTEM},
        {
            "role": "user",
            "content": [
                {"type": "text", "text": f"The figures on this page:\n{listed}"},
                {"type": "image_url", "image_url": {"url": image}},
            ],
        },
    ]
