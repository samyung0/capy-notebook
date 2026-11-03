"""Extraction prompts: questions read from the selected pages of a paper, and the
mark scheme or answer files parsed as text (todo-study-tracking.md §8).

Three calls, each on its own: the outline (expected question labels from the
pages' indexed text), one page window at a time (two page images, the outline,
the open question and the two tools below), and the scheme or answer text, which
never shares a request with the pages. Code pairs the scheme with the questions
by label (``retrieval.extraction``).

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

EXTRACT_SYSTEM = f"""You copy the questions printed on exam or worksheet pages into a quiz, exactly as printed. You see up to two page images at a time, each with the page's indexed text, which may be rough: the image is what counts.

Record every question that starts on these pages with record_question, in printed order, one call for all of them. When the first page carries on the open question from the previous page (more parts, or more of its last part's text), add that with continue_question first.

Copying:
- Keep the wording, numbers, symbols and language exactly as printed. Write math as LaTeX between $ signs ($\\frac{{7(x-2)}}{{5}}$, $x^2$, $\\angle ABC$); never solve, simplify or reword.
- A table becomes a table block. Leave out answer lines, boxes for working, "Answers written in the margins will not be marked", page headers and footers.
- A question's parts follow its printed labels (a), (b), (b)(i). The quiz holds parts in one flat list, so (b)(i) and (b)(ii) are two parts labelled "b(i)" and "b(ii)", and text printed under (b) before (i) goes at the start of b(i)'s blocks. A question without parts has an empty stem and one part labelled "".
- At most {limits.QUIZ_QUESTION_PARTS_MAX} parts a question.

Answers:
- mcq: the options' text in printed order, without their letters A, B, C, D. Keep that order.
- short: a single final value or word the learner types.
- open: anything answered with working, a proof, an explanation or a drawing.
- Give a key only when the page prints it: mcq "correct" (zero-based indexes), short "accepted". Never work an answer out yourself; the mark scheme supplies the keys.
- marks: the part's printed marks. When only the question's total is printed ("(3 marks)" after (a) and (b)), split it across the parts as the work suggests and give the printed total in total_marks. An item printed without marks has 1.

Figures: for each diagram, graph, chart or photo a question needs, give its page number and box [left, top, right, bottom] on a 0-1000 grid of that page.

Each recorded question is checked at once. Fix what a result names and record that question again with the same label; an accepted question needs no second call. When every question on these pages is recorded, reply with the single word DONE.
{SOURCE_RULE}"""

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
            "description": "mcq: zero-based indexes of the correct options, only when the page prints them.",
        },
        "accepted": {
            "type": "array",
            "items": {"type": "string"},
            "description": "short: the printed answer; open: a printed model answer. Only when printed.",
        },
        "unit": {
            "type": "string",
            "description": "short: the unit printed beside the answer space, if any.",
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
        "page": {"type": "integer", "description": "The page number it is on."},
        "box": {
            "type": "array",
            "items": {"type": "number"},
            "minItems": 4,
            "maxItems": 4,
            "description": "[left, top, right, bottom] on a 0-1000 grid.",
        },
    },
    "required": ["page", "box"],
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
    },
    "required": ["label", "stem", "parts"],
}

TOOLS: list[dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "record_question",
            "description": "Record the questions that start on these pages, in printed order.",
            "parameters": {
                "type": "object",
                "properties": {"questions": {"type": "array", "items": _QUESTION}},
                "required": ["questions"],
            },
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


def page_text(number: int, file_name: str, text: str) -> str:
    heading = page_heading(number, file_name)
    if not text.strip():
        return f"{heading}. It has no indexed text."
    return f"{heading}. Its indexed text:\n{source_block(text)}"


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


def scheme_messages(file_name: str, text: str) -> list[dict[str, Any]]:
    return [
        {"role": "system", "content": SCHEME_SYSTEM},
        {"role": "user", "content": f"{file_name}\n{source_block(text)}"},
    ]
