"""Extraction prompts: questions read from the selected pages of a paper, and the
mark scheme or answer files parsed as text (todo-study-tracking.md §8).

Three calls, each on its own: the outline (expected question labels from the
pages' indexed text), one page window at a time (two page images with the layout
model's boxes as JSON, the outline, the open question and the two tools below),
and the scheme or answer text, which never shares a request with the pages. Code
pairs the scheme with the questions by label (``retrieval.extraction``).

The printed text is kept as written, in its own language: no locale rule.
"""

from __future__ import annotations

import json
from typing import Any

from ..generated import limits
from .sources import SOURCE_RULE, source_block

# --------------------------------------------------------------------- outline

OUTLINE_SYSTEM = (
    "You list the questions a printed paper holds, from the text of its pages. "
    'Answer with JSON only: {"questions": ["1", "2", ...]}, each question\'s '
    "printed number in printed order, once, without its parts (write 3, not "
    "3(a)). Leave out instructions, headings, formula lists, page numbers and "
    "anything that is not a question. Keep a section letter only when the "
    'numbering restarts in each section (A1, B1). With no questions, answer {"questions": []}. '
    + SOURCE_RULE
)


def outline_messages(pages: list[tuple[str, str]]) -> list[dict[str, Any]]:
    """``pages`` are (heading, indexed text) in selected order."""
    body = "\n\n".join(f"{heading}\n{source_block(text)}" for heading, text in pages)
    return [
        {"role": "system", "content": OUTLINE_SYSTEM},
        {"role": "user", "content": body},
    ]


# --------------------------------------------------------------- page windows

EXTRACT_SYSTEM = f"""You copy the questions printed on exam or worksheet pages into a quiz, exactly as printed, each with its answer key. You see a few page images at a time, each with the page's indexed text, which may be rough: the image is what counts.

Record each question that starts on these pages with its own record_question call, in printed order; one reply may hold several calls. When the first page carries on the open question from the previous page (more parts, or more of its last part's text), add that with continue_question first.

Copying:
- Keep the wording, numbers, symbols and language exactly as printed. Write math as LaTeX between $ signs ($\\frac{{7(x-2)}}{{5}}$, $x^2$, $\\angle ABC$), and a printed dollar sign for money as \\$ ($\\$78$ or \\$78); never simplify or reword the printed text.
- A table becomes a table block. Leave out answer lines, boxes for working, "Answers written in the margins will not be marked", page headers and footers.
- A question's parts follow its printed labels (a), (b), (b)(i). The quiz holds parts in one flat list, so (b)(i) and (b)(ii) are two parts labelled "b(i)" and "b(ii)". Text printed under (b) before (i), such as the data the sub-parts use, is never left out: give it as b(i)'s lead_in. A question without parts has an empty stem and one part labelled "".
- Text printed at the very end of the last page shown that leads into parts on the next page, such as the data under (b) with (b)(i) over the page, is never left out either: give it word for word as that question's trailing_text, and it goes in front of the question's next part.
- At most {limits.QUIZ_QUESTION_PARTS_MAX} parts a question.

Answers:
- mcq: the options' text in printed order, without their letters A, B, C, D. Copy each option exactly as printed, digit for digit; never change one to fit your working. Keep that order, and leave the options out of the part's blocks.
- short: a single final value or word the learner types, for a part worth 1 mark with no working to show.
- open: anything answered with working, a proof, an explanation or a drawing, and any part marked for its method or worth more than 1 mark.
- Give every part its correct answer and a short worked solution. Copy them when the page prints them and set key_source to printed; otherwise work them out, set key_source to worked_out, and never change the printed question.
- The answer: mcq "correct" (zero-based indexes of the right options); short "accepted"; open "points", the marking points with their marks, at most {limits.QUIZ_MARKSCHEME_MAX} adding up to the part's marks, and "accepted", a short model answer.
- marks: the part's printed marks. When only the question's total is printed ("(3 marks)" after (a) and (b)), split it across the parts as the work suggests and give the printed total in total_marks. An item printed without marks has 1.

Figures: a layout model looked for pictures and charts on these pages. After each page's text comes what it found on that page, as JSON: each box's number (unique among these pages), page, coordinates [left, top, right, bottom] on a 0-1000 grid of the page image (0, 0 is the top left corner), label and score. Boxes are hints from a model, not part of the page. For each diagram, graph, chart or photo a question needs, give boxes, the numbers of the boxes that hold it; the part whose text it follows ("" for the text shared by every part); and a few words on what it shows. A figure split across boxes (a diagram and its key, two shapes side by side) takes all of them. When boxes overlap, give the one that holds the whole figure and the least else. Leave out a box that holds no figure of a question you record, such as a figure of a question that is not on these pages. When no box holds a figure the question needs, give boxes [] and image, the page image it is on (counted from 1 in the order shown). The figure is cropped from the page into the quiz, so the blocks never describe it.

Each recorded question is checked at once. Fix what a result names and record that question again with the same label; an accepted question needs no second call. When every question on these pages is recorded, reply with the single word DONE.
{SOURCE_RULE}"""

CUT_OFF = (
    "Your last reply was cut off at the output limit before its calls finished, "
    "so nothing in it was recorded. Record the questions on these pages again, "
    "fewer in each reply, and keep your working short."
)

_BLOCK = {
    "type": "object",
    "properties": {
        "type": {"type": "string", "enum": ["text", "table"]},
        "text": {"type": "string", "description": "text: the printed text."},
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

_ANSWER = {
    "type": "object",
    "properties": {
        "type": {"type": "string", "enum": ["mcq", "short", "open"]},
        "options": {
            "type": "array",
            "items": {"type": "string"},
            "description": "mcq: each option's text in printed order, without its letter.",
        },
        "correct": {
            "type": "array",
            "items": {"type": "integer"},
            "description": "mcq: zero-based indexes of the correct options.",
        },
        "accepted": {
            "type": "array",
            "items": {"type": "string"},
            "description": "short: the correct answer (the value alone when a unit is printed beside the answer space); open: a short model answer.",
        },
        "unit": {
            "type": "string",
            "description": "short: the unit printed beside the answer space, if any.",
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
    },
    "required": ["type"],
}

_PART = {
    "type": "object",
    "properties": {
        "label": {
            "type": "string",
            "description": 'The printed part label: "a", "b(ii)"; "" for a question without parts.',
        },
        "lead_in": {
            "type": "string",
            "description": 'The first sub-part only: the text printed under its parent label before it, as under (b) before (i); "" when there is none.',
        },
        "blocks": {"type": "array", "items": _BLOCK, "minItems": 1},
        "answer": _ANSWER,
        "marks": {
            "type": "integer",
            "minimum": 1,
            "maximum": limits.QUESTION_MARKS_MAX,
        },
        "key_source": {
            "type": "string",
            "enum": ["printed", "worked_out"],
            "description": "printed when the page prints the answer, worked_out when you worked it out.",
        },
        "solution": {
            "type": "string",
            "description": "A short worked solution: the steps that lead to the answer.",
        },
    },
    "required": ["label", "blocks", "answer", "marks", "key_source", "solution"],
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

_TRAILING_TEXT = {
    "type": "string",
    "description": 'Text printed at the very end of the last page shown, after this question\'s last part, that leads into parts on the next page; "" when there is none.',
}

_QUESTION = {
    "type": "object",
    "properties": {
        "label": {
            "type": "string",
            "description": 'The printed question number, e.g. "7".',
        },
        "stem": {
            "type": "array",
            "items": _BLOCK,
            "description": "Text printed before the first part, shared by every part.",
        },
        "parts": {"type": "array", "items": _PART, "minItems": 1},
        "total_marks": {
            "type": "integer",
            "description": "The question's printed total, when only a total is printed.",
        },
        "figures": {"type": "array", "items": _FIGURE},
        "trailing_text": _TRAILING_TEXT,
    },
    "required": ["label", "stem", "parts"],
}

TOOLS: list[dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "record_question",
            "description": "Record one question that starts on these pages.",
            "parameters": _QUESTION,
        },
    },
    {
        "type": "function",
        "function": {
            "name": "continue_question",
            "description": "Add what the first page carries on from the open question: its next parts, or more of its last part's text.",
            "parameters": {
                "type": "object",
                "properties": {
                    "label": {
                        "type": "string",
                        "description": "The open question's label.",
                    },
                    "blocks": {
                        "type": "array",
                        "items": _BLOCK,
                        "description": "More of the last part's text, printed on this page.",
                    },
                    "parts": {
                        "type": "array",
                        "items": _PART,
                        "description": "The question's next parts, printed on this page.",
                    },
                    "figures": {"type": "array", "items": _FIGURE},
                    "trailing_text": _TRAILING_TEXT,
                },
                "required": ["label"],
            },
        },
    },
]


def window_intro(
    *, expected: list[str], recorded: list[str], open_question: dict[str, Any] | None
) -> str:
    lines = [
        "Questions the selected pages hold, from their text: "
        + (", ".join(expected) if expected else "unknown")
        + ".",
        "Already recorded: " + (", ".join(recorded) if recorded else "none") + ".",
    ]
    if open_question is not None:
        lines.append(
            "Open question, recorded last from the previous page; continue it with "
            "continue_question only if the first page below carries on with it:\n"
            + json.dumps(open_question, ensure_ascii=False)
        )
    return "\n".join(lines)


def page_heading(number: int, file_name: str) -> str:
    return f"Page {number} of {file_name}"


def page_text(
    image: int, number: int, file_name: str, text: str, boxes: list[dict[str, Any]]
) -> str:
    """A window page's heading, numbered as figures name their page image, its
    text, and the layout model's boxes on it."""
    heading = f"Page image {image}: page {number} of {file_name}"
    found = f"Boxes on this page, as JSON: {json.dumps(boxes)}"
    if not text.strip():
        return f"{heading}. It has no indexed text.\n{found}"
    return f"{heading}. Its indexed text:\n{source_block(text)}\n{found}"


def window_messages(intro: str, pages: list[tuple[str, str]]) -> list[dict[str, Any]]:
    """``pages`` are (page text, image data URL) pairs, one or two."""
    content: list[dict[str, Any]] = [{"type": "text", "text": intro}]
    for text, image in pages:
        content.append({"type": "text", "text": text})
        content.append({"type": "image_url", "image_url": {"url": image}})
    return [
        {"role": "system", "content": EXTRACT_SYSTEM},
        {"role": "user", "content": content},
    ]


# ------------------------------------------------------------------ figures

LOCATE_SYSTEM = (
    "You find figures on a printed exam or worksheet page. Answer with JSON "
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


# ------------------------------------------------------------- mark schemes

SCHEME_SYSTEM = (
    "You read a mark scheme or an answer key, as text, into entries. Answer with "
    'JSON only: {"entries": [{"question": "3", "part": "b(ii)", "answer": "...", '
    '"points": [{"text": "...", "marks": 1}], "solution": "..."}]}.\n'
    "- question: the printed question number; part: its part label as printed "
    '(a, b(ii)), or "" when the entry is for a whole question.\n'
    "- answer: the final answer: an option letter for multiple choice (B, or A, C "
    "when several are correct), else the final value, expression or statement. "
    "Empty when there is none.\n"
    "- points: each line that earns marks, in order, with its marks as a whole "
    "number and its text as printed, keeping the mark type (1M: …, 1A: …). Leave "
    "out lines worth no marks. A part's points add up to the marks printed for "
    "it; when one column lists the marks of several parts together, give each "
    "part the marks beside its own lines, so every part with an answer has at "
    "least one and the parts add up to the question's total (----(4)).\n"
    "- Alternative methods for the same part: the first one only. Case marking "
    "(Case 1 … 2, Case 2 … 1): one point worth the highest case, whose text "
    "states each case.\n"
    "- solution: the worked solution or explanation for that part, as printed. "
    "Empty when there is none.\n"
    "Copy the text exactly, with math as LaTeX between $ signs. Leave out "
    "examiners' comments, statistics, general marking instructions and anything "
    "that is not an answer, a mark or a solution. An entry may run past the end "
    "of the text; give what is there. " + SOURCE_RULE
)


def scheme_labels(labels: list[tuple[str, list[str]]]) -> str:
    """The recorded questions with their part labels: 1; 3: a, b; 4: a, b(i)."""
    return "; ".join(
        f"{label}: {', '.join(parts)}" if any(parts) else label
        for label, parts in labels
    )


def scheme_messages(
    file_name: str, text: str, labels: list[tuple[str, list[str]]]
) -> list[dict[str, Any]]:
    return [
        {"role": "system", "content": SCHEME_SYSTEM},
        {
            "role": "user",
            "content": (
                "The quiz holds these questions and parts; name each entry with "
                f"one of them where it matches: {scheme_labels(labels)}\n\n"
                f"{file_name}\n{source_block(text)}"
            ),
        },
    ]
