"""Questions read from the selected pages of an uploaded paper into a quiz
(todo-study-tracking.md §8, Make a quiz).

A fixed pipeline, like /generate, not the chat agent (Epo 2026-11-05, map, copy,
solve; bench/extraction/reports/2026-11-05-copy-first-structured.md):

0. The layout service's regions on every selected page (``layout``), which
   number the boxes figures are picked from, once across the selection.
1. The map: one call sees every selected page and its boxes and answers one
   line a question: label, pages, parts, figures.
2. Copy batches of 16 of the map's questions, in parallel, each continuing the
   map's conversation at low reasoning. ``record_question`` carries no answers.
   The mark scheme and answer files are parsed as text from the moment the map
   ends, each on its own and never beside the pages, naming entries by the map's
   labels and parts.
3. Code checks the copies against the map and sends a repair for a question left
   out: a map row not copied, a gap in the numbers, or the next number printed on
   a page no row covers. A figure the map lists and a batch left out is added
   from the map's boxes.
4. Code pairs the scheme with the copies by label: a question whose every part
   it covers needs no model call. Solve batches of up to 8 of the rest, in
   parallel at medium reasoning, each continue the copy batch holding their
   questions and give ``record_answers``: copied when the page prints them,
   otherwise worked out (Epo 2026-11-03). A printed key stays, a scheme's replaces
   a worked-out one, and any disagreement is named in the report.

Every recorded question and answer goes through the Go validator at once and a
problem goes back to the model. A call that fails is tried once more where it is
in its own thread; a thread that still fails ends alone. Its copied questions
stay, and a part left with no answer is named in the report.

The printed option order is kept (``add_questions`` shuffles; this does not),
and option lines the model also copied into a part's text are taken out. No
question is left out for want of a key. A worked-out solution carries an
"AI-written" label. Each figure a question needs is recorded by box number (Epo
2026-11-04). One with no box is boxed at the end by a call that sees its page
alone. Each is cropped from its page and placed after the text of the part it
names, as an image block whose asset is ``figure:<id>``; the ``done`` event
carries the crops and Go stores them as the quiz's own editor assets. Nothing
links a question to its file, page or region (§8 item 7).
"""

from __future__ import annotations

import asyncio
import base64
import copy
import dataclasses
import functools
import json
import logging
import math
import re
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

from .. import elitellm, registry
from ..config import cfg
from ..generated import limits
from ..prompts import extraction as prompts
from ..prompts.locale import normalize_locale
from ..registry import ModelConfig
from . import accounting, capture, layout, models, store, tools
from . import limits as slots
from .workflows import extract_json

log = logging.getLogger("capy.retrieval.extraction")

# Questions a copy batch holds and a solve batch holds, each a thread of its own
# (Epo 2026-11-05).
COPY_BATCH = 16
SOLVE_BATCH = 8
# Model calls a thread may make: the first records, the rest send again what the
# validator refused or what was not valid JSON, or what a reply cut off at the
# output cap left out.
THREAD_ROUNDS = 12
# The map and every thread. Hard multiple choice reasons up to 21,000 tokens in one
# reply before it records anything (bench/extraction/reports/2026-11-04-copy-first.md).
MAX_TOKENS = 48_000
# Copying reasons low and solving at the run's bound level, mid. Reasoning off on the
# copy calls makes every solve call miss the cache (2026-11-04-copy-first.md).
COPY_THINKING = "low"
# Passes of repairs for questions a batch left out.
COPY_REPAIR_PASSES = 2
# The output tokens a run may spend per selected page before it stops
# (stopped: output_limit) and saves what it has. A runaway on Wafer wrote 21,700 a
# page and cost 17 times a normal run
# (bench/extraction/reports/2026-11-03-keys-in-one-prompt.md, Epo 2026-11-04).
OUTPUT_PER_PAGE = 8_000
SCHEME_MAX_TOKENS = 12_000
# A figure is cropped at the scale that gives its page's long side this many
# pixels (about 190 DPI on A4, against the page images' 1,568), so its labels read
# and a small figure stays small; the crop's long side is still at most
# CAPY_CAPTURE_MAX_EDGE.
FIGURE_PAGE_EDGE = 2_200
# The locate call's reply: a few boxes.
LOCATE_MAX_TOKENS = 1_000
# Indexed text shown per page, and scheme text per parse call.
PAGE_TEXT_CHARS = 6_000
SCHEME_CHUNK_CHARS = 12_000
# The longest mark scheme or answer file a run reads, about 60 dense pages;
# a longer one is refused rather than cut.
SCHEME_TEXT_CHARS = 200_000

# A busy, failing or silent provider costs a call one silent retry (Epo
# 2026-11-03): the map, a thread's round or a scheme piece runs once more. A
# definitive client error does not retry.
ATTEMPTS = 2
ATTEMPT_WAIT_S = 20.0

PRINTED, WORKED_OUT, SCHEME = "printed", "worked_out", "scheme"
# A part left with no answer: its failed solve call could not be made up.
NO_ANSWER = "none"
# The label a worked-out solution carries in the saved quiz, in the starter's
# language (QuestionView draws a text block's label before its text).
AI_WRITTEN = {"en": "AI-written", "zh": "AI 撰写"}
# The marking note on a part saved with no answer, which the report names too.
ANSWER_MISSING = {
    "en": "No answer was worked out for this part. Add one before using this question.",
    "zh": "这一部分还没有答案。使用这道题之前请先补上。",
}

Validate = Callable[[dict[str, Any]], Awaitable[str | None]]

# What a selected page is, for whether its text goes to the model (Epo 2026-11-05).
BORN_DIGITAL, SCAN, BLANK = "born_digital", "scan", "blank"
VISIBLE_CHARS = 40
IMAGE_COVERS_PAGE = 0.9
# Far past a page of print. The read of what a page shows holds about 400 bytes a
# character, in the retrieval service's own memory.
PAGE_CHARS_MOST = 100_000


@dataclass(frozen=True)
class Page:
    """One selected page: its number in its file, the file's name, the
    page's indexed text, its image as a data URL, a box on it as a JPEG with
    its pixel size, for a figure, what the layout model found on it, and what
    it is (``page_layer``); what is not known counts as a scan."""

    number: int
    file_name: str
    text: str
    image: Callable[[], Awaitable[str]]
    crop: Callable[[list[float]], Awaitable[tuple[bytes, tuple[int, int]]]]
    regions: tuple[layout.Region, ...] = ()
    layer: str = SCAN

    def __deepcopy__(self, memo: dict[int, Any]) -> Page:
        # A recorded question's copies share its figures' pages.
        return self


@dataclass(frozen=True)
class Figure:
    """A figure a question needs: its page, the part whose text it follows
    ("" for the stem), its description, and its crop on the 0-1000 grid: from
    the boxes picked for it, or from the box call (``locate_figures``)."""

    page: Page
    part: str
    description: str
    box: list[float] | None = None


@dataclass(frozen=True)
class SchemeFile:
    name: str
    text: str


@dataclass
class Recorded:
    """One question as recorded, every part with its key, and where each
    part's key came from: printed, worked_out, or scheme once paired."""

    label: str
    question: dict[str, Any]
    part_labels: list[str]
    sources: list[str]
    figures: list[Figure] = field(default_factory=list)
    # The question's printed total, when the page prints only a total.
    total: int | None = None


@dataclass(frozen=True)
class MapRow:
    """One line of the map: a question's label, the pages it is printed on, its
    part labels and the boxes that hold its figures."""

    label: str
    first: int
    last: int
    parts: list[str]
    figures: list[int]


@dataclass
class Entry:
    question: str
    part: str
    answer: str = ""
    points: list[dict[str, Any]] = field(default_factory=list)
    solution: str = ""


# ---------------------------------------------------------------- labels


def label_key(label: str) -> str:
    """A printed label as pairing compares it: "Q3", "3." and "3" are one;
    "(b)(ii)", "b(ii)" and "b ii" are one."""
    tokens = re.findall(r"[a-z]+|\d+", label.lower())
    if tokens and tokens[0] in ("q", "question", "no"):
        tokens = tokens[1:]
    return ".".join(tokens)


def part_name(label: str, part_label: str) -> str:
    """A part as the report names it: 4(a), or 12 for a one-part question."""
    return f"{label}({part_label})" if part_label else label


# ------------------------------------------------------- recorded questions


def _text(value: Any, limit: int) -> str:
    return str(value or "").strip()[:limit].strip()


def _whole(value: Any) -> int | None:
    """A mark count the model wrote as 2, 2.0 or "2"."""
    if isinstance(value, str) and value.strip().isdigit():
        value = int(value.strip())
    if isinstance(value, float) and value.is_integer():
        value = int(value)
    return value if type(value) is int else None


def _points(raw: Any) -> list[dict[str, Any]]:
    points = []
    for point in raw if isinstance(raw, list) else []:
        if not isinstance(point, dict):
            continue
        marks = _whole(point.get("marks"))
        text = _text(point.get("text"), limits.QUESTION_MARK_ITEM_MAX)
        if marks is not None and marks >= 1 and text:
            points.append({"text": text, "marks": marks})
    return points


def _items(points: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Marking points as at most QUIZ_MARKSCHEME_MAX items: consecutive points
    are joined when there are more, keeping every mark."""
    size = limits.QUIZ_MARKSCHEME_MAX
    if len(points) <= size:
        return [dict(point) for point in points]
    groups: list[list[dict[str, Any]]] = [[] for _ in range(size)]
    for index, point in enumerate(points):
        groups[index * size // len(points)].append(point)
    return [
        {
            "text": "; ".join(p["text"] for p in group)[
                : limits.QUESTION_MARK_ITEM_MAX
            ],
            "marks": sum(p["marks"] for p in group),
        }
        for group in groups
    ]


def _blocks(raw: Any) -> list[dict[str, Any]]:
    blocks: list[dict[str, Any]] = []
    for block in raw if isinstance(raw, list) else []:
        if not isinstance(block, dict):
            continue
        if block.get("type") == "table":
            blocks.append(
                {
                    "type": "table",
                    "header": bool(block.get("header")),
                    "rows": block.get("rows"),
                }
            )
        elif str(block.get("text") or "").strip():
            blocks.append({"type": "text", "text": str(block["text"]).strip()})
    return blocks


def _answer(raw: Any) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """The answer with its key, and an open part's marking items."""
    raw = raw if isinstance(raw, dict) else {}
    kind = raw.get("type")
    accepted = [str(v).strip() for v in raw.get("accepted") or [] if str(v).strip()]
    if kind == "mcq":
        return {
            "type": "mcq",
            "options": [str(v).strip() for v in raw.get("options") or []],
            "correct": [v for v in raw.get("correct") or [] if type(v) is int],
        }, []
    if kind == "short":
        answer: dict[str, Any] = {"type": "short", "accepted": accepted}
        if str(raw.get("unit") or "").strip():
            answer["unit"] = str(raw["unit"]).strip()
        return answer, []
    if kind == "open":
        sample = [a[: limits.QUIZ_OPEN_ANSWER_MAX] for a in accepted[:1]]
        return {"type": "open", "accepted": sample, "hints": []}, _items(
            _points(raw.get("points"))
        )
    return {"type": kind}, []


def _solution(text: str, source: str, ai_label: str) -> list[dict[str, Any]]:
    if not text:
        return []
    block: dict[str, Any] = {"type": "text", "text": text}
    if source == WORKED_OUT:
        block["label"] = ai_label
    return [block]


def _part(raw: Any, ai_label: str) -> tuple[str, str, dict[str, Any]]:
    """A recorded part: its printed label, where its key came from (empty when
    the model named neither), and the part."""
    raw = raw if isinstance(raw, dict) else {}
    answer, items = _answer(raw.get("answer"))
    source = (
        raw.get("key_source") if raw.get("key_source") in (PRINTED, WORKED_OUT) else ""
    )
    blocks = _blocks(raw.get("blocks"))
    # A sub-part's lead-in, the text printed under (b) before (i), starts its
    # blocks unless the model put it there too (2021 Q8(b) and Q10(b) lost
    # theirs when the prompt only asked for it in the blocks).
    lead_in = _text(raw.get("lead_in"), limits.QUESTION_TEXT_MAX)
    if lead_in and not (
        blocks and _same_blocks(blocks[:1], _blocks([{"text": lead_in}]))
    ):
        blocks.insert(0, {"type": "text", "text": lead_in})
    part: dict[str, Any] = {
        "id": str(uuid.uuid4()),
        "blocks": blocks,
        "answer": answer,
        "marks": raw.get("marks"),
        "solution": _solution(
            _text(raw.get("solution"), limits.QUESTION_TEXT_MAX), source, ai_label
        ),
    }
    if answer["type"] == "open":
        part["markscheme"] = items
    return str(raw.get("label") or ""), source, part


# A printed option letter: "A. ", "(B) ", "C) ".
_OPTION_LETTER = re.compile(r"(?:^|(?<=\s))\(?([A-H])[.)](?=\s)")


def _option_text(value: str) -> str:
    """An option as an option line is compared with it: spacing, $ signs and a
    closing full stop aside."""
    return re.sub(r"\s+", " ", value.replace("$", "")).strip().rstrip(".").rstrip()


def _without_options(text: str, options: list[str]) -> str:
    """The text without the lettered lines that repeat ``options``: a run of
    letters A, B, C… whose texts are the options, in order, one a line or
    several on a line. Text the run does not match is left as it is."""
    letters = [chr(ord("A") + i) for i in range(len(options))]
    wanted = [_option_text(option) for option in options]
    marks = list(_OPTION_LETTER.finditer(text))
    for start in range(len(marks) - len(options) + 1):
        run = marks[start : start + len(options)]
        if [m.group(1) for m in run] != letters:
            continue
        ends = [m.start() for m in run[1:]]
        line_end = text.find("\n", run[-1].end())
        # The last option runs to the end of the text, or of its line.
        for last in dict.fromkeys((len(text), len(text) if line_end < 0 else line_end)):
            texts = [text[m.end() : end] for m, end in zip(run, [*ends, last])]
            if [_option_text(t) for t in texts] == wanted:
                return (text[: run[0].start()] + text[last:]).strip()
    return text


def _loose_option(value: str) -> str:
    r"""An option or a line as they are compared: $ signs, spacing, \text{} and a
    closing full stop aside ("A. $131\text{ cm}$." repeats "131 cm")."""
    plain = re.sub(r"\\text\{([^{}]*)\}", r"\1", value.replace("$", ""))
    return re.sub(r"\s+", "", plain.replace("\\ ", " ")).rstrip(".")


def _option_line(line: str, letter: str) -> str:
    """A line as an option is compared with it, its own letter aside: "A. x",
    "(A) x", "A x" or in the math, "$A.\\ x$"."""
    line = line.replace("$", "").replace("\\ ", " ").strip()
    return _loose_option(re.sub(rf"^\(?{letter}[.)]?\s+", "", line))


def _without_option_lines(
    blocks: list[dict[str, Any]], options: list[str]
) -> list[dict[str, Any]]:
    """The blocks without a run of lines that are the options, in order, one a
    line, in one block or one a block, with or without their letters (2022
    Paper 2: "48 kg.\n\n50 kg.\n\n53 kg.\n\n60 kg." beside the same options)."""
    wanted = [_loose_option(option) for option in options]
    if len(wanted) < 2 or not all(wanted):
        return blocks
    letters = [chr(ord("A") + i) for i in range(len(options))]
    lines = [
        (at, number, line)
        for at, block in enumerate(blocks)
        if block["type"] == "text"
        for number, line in enumerate(block["text"].split("\n"))
        if line.strip()
    ]
    for start in range(len(lines) - len(options) + 1):
        run = lines[start : start + len(options)]
        if [_option_line(r[2], letter) for r, letter in zip(run, letters)] != wanted:
            continue
        taken = {(at, number) for at, number, _ in run}
        kept = []
        for at, block in enumerate(blocks):
            if block["type"] == "text" and any(where == at for where, _ in taken):
                text = "\n".join(
                    line
                    for number, line in enumerate(block["text"].split("\n"))
                    if (at, number) not in taken
                ).strip()
                if not text:
                    continue
                block = {**block, "text": text}
            kept.append(block)
        return kept
    return blocks


def _blocks_without_options(
    blocks: list[dict[str, Any]], options: list[str]
) -> list[dict[str, Any]]:
    kept = []
    for block in blocks:
        if block["type"] == "text":
            text = _without_options(block["text"], options)
            if not text:
                continue
            block = {**block, "text": text}
        kept.append(block)
    return _without_option_lines(kept, options)


def _drop_option_lines(question: dict[str, Any]) -> None:
    """Take out of an mcq part's text (and a one-part question's stem) the
    option lines the model copied there as well as into the options, so a
    learner does not see them twice. A one-part question whose part held only
    the options takes its stem as the part's text, as the prompt asks."""
    parts = question["parts"]
    single = len(parts) == 1
    for part in parts:
        options = part["answer"].get("options")
        if part["answer"]["type"] != "mcq" or not options:
            continue
        blocks = _blocks_without_options(part["blocks"], options)
        stem = (
            _blocks_without_options(question["stem"], options)
            if single
            else question["stem"]
        )
        if not blocks and single:
            blocks, stem = stem, []
        # A part left with no text at all keeps it.
        if blocks:
            part["blocks"], question["stem"] = blocks, stem


def _same_blocks(a: list[dict[str, Any]], b: list[dict[str, Any]]) -> bool:
    def norm(block: dict[str, Any]) -> Any:
        if block["type"] == "text":
            return re.sub(r"\s+", " ", block["text"]).strip()
        return block

    return [norm(x) for x in a] == [norm(x) for x in b]


def _drop_repeated_stem(question: dict[str, Any]) -> None:
    """A one-part question shows its text once: a stem its part starts with
    goes (the bench saw the whole text in both), and so does a stem's last
    sentence the part repeats (2024 Q5: "Find …" in both)."""
    stem, parts = question["stem"], question["parts"]
    if len(parts) != 1 or not stem:
        return
    blocks = parts[0]["blocks"]
    if _same_blocks(stem, blocks[: len(stem)]):
        question["stem"] = []
        return
    if stem[-1]["type"] != "text" or not blocks or blocks[0]["type"] != "text":
        return
    tail, text = blocks[0]["text"].strip(), stem[-1]["text"].rstrip()
    if tail and text != tail and text.endswith(tail):
        head = text[: -len(tail)].rstrip()
        question["stem"] = (
            [*stem[:-1], {**stem[-1], "text": head}] if head else stem[:-1]
        )


def record(item: Any, ai_label: str) -> Recorded:
    """A question's call as a quiz question in paper layout; its figures are
    read against the selection's pages (``read_figures``)."""
    item = item if isinstance(item, dict) else {}
    parsed = [_part(p, ai_label) for p in item.get("parts") or []]
    labels = [label for label, _, _ in parsed]
    first = next((label for label in labels if label), "")
    question = {
        "id": str(uuid.uuid4()),
        "stem": _blocks(item.get("stem")),
        "parts": [part for _, _, part in parsed],
        "layout": "paper",
        "labels": "numbers" if first[:1].isdigit() else "letters",
    }
    _drop_option_lines(question)
    _drop_repeated_stem(question)
    return Recorded(
        label=str(item.get("label") or "").strip(),
        question=question,
        part_labels=labels,
        sources=[source for _, source, _ in parsed],
        total=_whole(item.get("total_marks")),
    )


def _box(raw: Any) -> list[float] | None:
    """A [left, top, right, bottom] box on the 0-1000 grid, held to the page,
    or None when it is not one."""
    if not (
        isinstance(raw, list)
        and len(raw) == 4
        and all(type(v) in (int, float) and math.isfinite(v) for v in raw)
    ):
        return None
    box = [min(1000.0, max(0.0, float(v))) for v in raw]
    return box if box[0] < box[2] and box[1] < box[3] else None


def numbered_boxes(pages: list[Page]) -> dict[int, tuple[Page, layout.Region]]:
    """The boxes figures are picked from, numbered once across the selection."""
    boxes: dict[int, tuple[Page, layout.Region]] = {}
    for page in pages:
        for region in layout.figure_boxes(page.regions):
            boxes[len(boxes) + 1] = (page, region)
    return boxes


def read_figures(
    raw: Any,
    pages: list[Page],
    part_labels: list[str],
    boxes: dict[int, tuple[Page, layout.Region]],
) -> tuple[list[Figure], str | None]:
    """A call's figures, by box number (cropped from them) or, with no box, by
    page image (for the box call), or the tool-result problem
    naming the first that cannot be read."""
    read: list[Figure] = []
    parts = {label_key(label) for label in part_labels}
    for index, item in enumerate(raw if isinstance(raw, list) else []):
        name = f"figures[{index}]"
        item = item if isinstance(item, dict) else {}
        part = str(item.get("part") or "").strip()
        if part and label_key(part) not in parts:
            return [], (
                f"{name}.part: the question has no part {part}; its parts are "
                + ", ".join(label for label in part_labels if label)
            )
        description = " ".join(str(item.get("description") or "").split())
        if len(description) > limits.QUESTION_DESCRIPTION_MAX:
            return [], (
                f"{name}.description: expected at most "
                f"{limits.QUESTION_DESCRIPTION_MAX} characters; sent {len(description)}"
            )
        numbers = item.get("boxes")
        numbers = numbers if isinstance(numbers, list) else []
        if not numbers:
            image = _whole(item.get("image"))
            if image is None or not 1 <= image <= len(pages):
                choices = " or ".join(str(n + 1) for n in range(len(pages)))
                return [], f"{name}: with boxes [] give image, {choices}"
            read.append(Figure(pages[image - 1], part, description))
            continue
        unknown = [number for number in numbers if number not in boxes]
        if unknown:
            shown = ", ".join(str(number) for number in boxes) or "none"
            return [], (
                f"{name}.boxes: there is no box {unknown[0]} on these pages; "
                f"the boxes are {shown}"
            )
        page = boxes[numbers[0]][0]
        if any(boxes[number][0] is not page for number in numbers):
            return [], f"{name}.boxes: a figure's boxes are on one page"
        crop = layout.crop_box(
            [boxes[number][1].box for number in numbers], page.regions
        )
        read.append(Figure(page, part, description, crop))
    return read, None


async def placed(held: Recorded, crops: dict[str, str]) -> dict[str, Any]:
    """The question with each figure cropped from its page and placed after
    the text of the part it names (the stem for ""); the crops go into
    ``crops`` by figure id, base64, as the done event carries them."""
    if not held.figures:
        return held.question
    question = copy.deepcopy(held.question)
    for n, figure in enumerate(held.figures, 1):
        if figure.box is None:
            raise AssertionError("a figure is located before it is placed")
        jpeg, (width, height) = await figure.page.crop(figure.box)
        figure_id = f"q{label_key(held.label)}-{n}"
        crops[figure_id] = base64.b64encode(jpeg).decode()
        block: dict[str, Any] = {
            "type": "image",
            "image": {"assetId": f"figure:{figure_id}"},
            "width": width,
            "height": height,
        }
        if figure.description:
            block["description"] = figure.description
        blocks = next(
            (
                part["blocks"]
                for label, part in zip(held.part_labels, question["parts"])
                if label_key(label) == label_key(figure.part)
            ),
            question["stem"],
        )
        blocks.append(block)
    return question


def _unsourced(held: Recorded) -> str | None:
    """The tool-result problem for parts that do not say where their key came
    from."""
    missing = [
        part_name(held.label, label)
        for label, source in zip(held.part_labels, held.sources)
        if not source
    ]
    if not missing:
        return None
    return f"{', '.join(missing)}: key_source must be printed or worked_out"


_MAP_LINE = re.compile(
    r"^\s*(?:\*\*)?(?P<label>[^|]+?)(?:\*\*)?\s*\|\s*pages?\s*(?P<first>\d+)(?:\s*-\s*(?P<last>\d+))?"
    r"\s*\|\s*parts?\s*(?P<parts>[^|]*?)\s*\|\s*figures?\s*(?P<figures>.*?)\s*$",
    re.IGNORECASE,
)


def parse_map(text: str) -> list[MapRow]:
    """The map reply's rows; a line not in its form is not a row."""
    rows = []
    for line in text.splitlines():
        match = _MAP_LINE.match(line)
        if not match:
            continue
        parts = match["parts"].strip()
        rows.append(
            MapRow(
                match["label"].strip(),
                int(match["first"]),
                int(match["last"] or match["first"]),
                []
                if parts.lower() in ("none", "-", "")
                else [p.strip() for p in parts.split(",") if p.strip()],
                [int(n) for n in re.findall(r"\d+", match["figures"])],
            )
        )
    return rows


def _number(label: str) -> int | None:
    digits = re.findall(r"\d+", label)
    return int(digits[-1]) if digits else None


def _runs_of(labels: list[str]) -> list[list[str]]:
    """Labels in runs of contiguous numbers."""
    runs: list[list[str]] = []
    for label in labels:
        number = _number(label)
        last = _number(runs[-1][-1]) if runs else None
        if runs and number is not None and last is not None and number == last + 1:
            runs[-1].append(label)
        else:
            runs.append([label])
    return runs


def _chunks_of(items: list[Any], size: int) -> list[list[Any]]:
    return [items[i : i + size] for i in range(0, len(items), size)]


def _keyless(item: dict[str, Any]) -> dict[str, Any]:
    """A copy call as code keeps it, anything it sent of a key taken out."""
    out = copy.deepcopy(item)
    for part in out.get("parts") or []:
        if not isinstance(part, dict):
            continue
        part.pop("solution", None)
        part.pop("key_source", None)
        if isinstance(part.get("answer"), dict):
            for name in ("correct", "accepted", "points"):
                part["answer"].pop(name, None)
    return out


def _with_placeholders(item: dict[str, Any]) -> dict[str, Any]:
    """A copy with placeholder keys, so the validator checks what was copied and
    nothing that comes later. It is never saved."""
    out = copy.deepcopy(item)
    for part in out.get("parts") or []:
        if not isinstance(part, dict) or not isinstance(part.get("answer"), dict):
            continue
        answer = part["answer"]
        kind = answer.get("type")
        if kind == "mcq":
            answer["correct"] = [0]
        elif kind == "short":
            answer["accepted"] = ["0"]
        elif kind == "open":
            answer["points"] = [{"text": "-", "marks": part.get("marks")}]
    return out


def _worked_out(item: dict[str, Any]) -> dict[str, Any]:
    """A copy with no answers yet, which a scheme entry can replace."""
    out = copy.deepcopy(item)
    for part in out.get("parts") or []:
        if isinstance(part, dict):
            part["key_source"] = WORKED_OUT
    return out


def _has_key(part: dict[str, Any]) -> bool:
    answer = part["answer"]
    kind = answer["type"]
    if kind == "mcq":
        return bool(answer["correct"])
    if kind == "short":
        return bool(answer["accepted"])
    return bool(part.get("markscheme"))


def _mark_no_answer(held: Recorded, note: str) -> list[str]:
    """Keep a part with no answer as an open part whose marking note says so, the
    only form with no key the validator takes; an mcq's options go in its text. The
    part names, for the report."""
    names: list[str] = []
    for index, (label, part) in enumerate(
        zip(held.part_labels, held.question["parts"])
    ):
        if _has_key(part):
            continue
        answer = part["answer"]
        if answer["type"] == "mcq":
            lines = [
                f"{chr(ord('A') + n)}. {option}"
                for n, option in enumerate(answer.get("options") or [])
            ]
            part["blocks"] = [
                *part["blocks"],
                {"type": "text", "text": "\n".join(lines)},
            ]
        part["answer"] = {"type": "open", "accepted": [], "hints": []}
        part["markscheme"] = [{"text": note, "marks": part["marks"]}]
        part["solution"] = []
        held.sources[index] = NO_ANSWER
        names.append(part_name(held.label, label))
    return names


# A code span, math already between $ signs, or math between \( \) or \[ \].
_MATH_SPANS = re.compile(
    r"```.*?```|`[^`\n]*`"
    r"|\$\$.*?\$\$|(?<!\\)\$(?:\\.|[^$\\])+?\$"
    r"|(?<!\\)\\\((?P<inline>.+?)(?<!\\)\\\)"
    r"|(?<!\\)\\\[(?P<display>.+?)(?<!\\)\\\]",
    re.DOTALL,
)


def dollar_math(text: str) -> str:
    r"""``\(...\)`` and ``\[...\]`` as ``$...$``: the quiz's text shows nothing else
    as math (``parseMathText``), and a page read writes them so
    (bench/extraction/reports/2026-11-05-copy-first-structured.md). A code span,
    math already between $ signs, an escaped ``\\(``, a pair holding a bare $ and any
    text with a bare $ beside it stay as they are."""

    # A bare $ left over would pair with the ones added here.
    if re.search(r"(?<!\\)\$", _MATH_SPANS.sub("", text)):
        return text

    def replace(match: re.Match[str]) -> str:
        inner = match["inline"] if match["inline"] is not None else match["display"]
        if inner is None or not inner.strip() or re.search(r"(?<!\\)\$", inner):
            return match[0]
        return f"${inner.strip()}$"

    return _MATH_SPANS.sub(replace, text)


# What sits beside a power's ** and never beside bold: x**2, (x)**(y), a**β. Chinese
# bold has no spaces around it, so these are not every word character.
_POWER_SIDE = r"0-9A-Za-z_\u0370-\u03ff"
_BOLD = re.compile(
    rf"(?<![{_POWER_SIDE}*\\)\]}}\x00])\*\*(?=[^\s*])"
    r"[^\n]*?"
    rf"(?<=[^\s*\\])\*\*(?![{_POWER_SIDE}*(\[{{\x00])"
)


def strip_bold(text: str) -> str:
    """Markdown bold without its markers: the quiz's text shows them raw
    (bench/extraction/reports/2026-11-05-no-page-text.md). Only a pair on one line
    that opens and closes as bold goes, outside code and math, so a power or an
    A** stays."""
    if "**" not in text:
        return text
    masked = _MATH_SPANS.sub(lambda match: "\x00" * len(match[0]), text)
    kept: list[str] = []
    at = 0
    for match in _BOLD.finditer(masked):
        kept += [text[at : match.start()], text[match.start() + 2 : match.end() - 2]]
        at = match.end()
    return "".join(kept) + text[at:]


def _tidy_text_in(question: dict[str, Any]) -> None:
    """Every text a saved question shows, in place: math as ``$...$``, bold without
    its markers. A table's cells keep their ``\\(``: a table can hold a literal, as a
    code or regular expression column does."""

    def tidy(text: str) -> str:
        return strip_bold(dollar_math(text))

    def in_blocks(blocks: list[dict[str, Any]]) -> None:
        for block in blocks:
            if block["type"] == "text":
                block["text"] = tidy(block["text"])
            elif block["type"] == "table":
                block["rows"] = [
                    [strip_bold(cell) for cell in row] for row in block["rows"]
                ]

    in_blocks(question["stem"])
    for part in question["parts"]:
        in_blocks(part["blocks"])
        in_blocks(part.get("solution") or [])
        answer = part["answer"]
        for name in ("options", "accepted", "hints"):
            if isinstance(answer.get(name), list):
                answer[name] = [tidy(str(value)) for value in answer[name]]
        for item in part.get("markscheme") or []:
            item["text"] = tidy(item["text"])


def _counts(question: dict[str, Any]) -> tuple[int, int]:
    parts = question["parts"]
    return len(parts), sum(1 for p in parts if p["answer"].get("type") == "open")


# ------------------------------------------------------------------ pairing


def entries_from(data: Any) -> list[Entry]:
    entries: list[Entry] = []
    rows = data.get("entries") if isinstance(data, dict) else None
    for row in rows if isinstance(rows, list) else []:
        if not isinstance(row, dict) or not str(row.get("question") or "").strip():
            continue
        entries.append(
            Entry(
                question=str(row["question"]).strip(),
                part=str(row.get("part") or "").strip(),
                answer=_text(row.get("answer"), limits.QUIZ_OPEN_ANSWER_MAX),
                points=_points(row.get("points")),
                solution=_text(row.get("solution"), limits.QUESTION_TEXT_MAX),
            )
        )
    return entries


def _merged(
    pieces: list[list[Entry]],
) -> tuple[dict[tuple[str, str], Entry], list[str]]:
    """Entries by label, from each scheme piece's entries in order. An entry
    the scheme split across two pieces (the last of one piece and the first
    of the next, under one label) becomes one. Any other repeat of a label is
    another question's entry the parse named wrongly (the bench saw a later
    question's solution named 2021 Q8(b)(ii), doubling its marks): the first
    stays, and the repeats are returned by name."""
    out: dict[tuple[str, str], Entry] = {}
    repeats: list[str] = []
    last: tuple[str, str] | None = None
    for piece in pieces:
        for index, entry in enumerate(piece):
            key = (label_key(entry.question), label_key(entry.part))
            held = out.get(key)
            if held is None:
                out[key] = Entry(
                    entry.question,
                    entry.part,
                    entry.answer,
                    list(entry.points),
                    entry.solution,
                )
            elif index == 0 and key == last:
                held.answer = held.answer or entry.answer
                held.points.extend(entry.points)
                held.solution = "\n".join(
                    s for s in (held.solution, entry.solution) if s
                )
            else:
                repeats.append(part_name(entry.question, entry.part))
        if piece:
            last = (label_key(piece[-1].question), label_key(piece[-1].part))
    return out, repeats


def _letters(answer: str, count: int) -> list[int]:
    found = re.findall(r"(?<![A-Za-z])([A-H])(?![A-Za-z])", answer.upper())
    indexes = sorted({ord(letter) - ord("A") for letter in found})
    return indexes if indexes and indexes[-1] < count else []


def _same(a: str, b: str) -> bool:
    """Two short answers that differ only in spacing, case, $ signs or a full
    stop."""

    def norm(value: str) -> str:
        return re.sub(r"[\s$]", "", value).rstrip(".").lower()

    return norm(a) == norm(b)


def _entry_for(
    entries: dict[tuple[str, str], Entry], label: str, part_label: str, single: bool
) -> Entry | None:
    question = label_key(label)
    found = entries.get((question, label_key(part_label)))
    if found is None and single:
        found = entries.get((question, ""))
    return found


@dataclass
class Paired:
    """A question after pairing: the paired copy, whether any entry matched,
    and the parts whose key disagreed with the scheme."""

    held: Recorded
    matched: bool
    disagreed: list[str]


def pair(held: Recorded, entries: dict[tuple[str, str], Entry]) -> Paired:
    """A copy of the question with its scheme entries applied: a scheme key,
    marking points and solution replace worked-out ones; a printed key stays.
    A key that differs from the scheme's is named either way."""
    out = copy.deepcopy(held)
    matched = False
    disagreed: list[str] = []
    single = len(out.part_labels) == 1
    for index, (part_label, part) in enumerate(
        zip(out.part_labels, out.question["parts"])
    ):
        entry = _entry_for(entries, out.label, part_label, single)
        if entry is None:
            continue
        matched = True
        name = part_name(out.label, part_label)
        replace = out.sources[index] == WORKED_OUT
        replaced = False
        answer = part["answer"]
        if answer["type"] == "mcq":
            letters = _letters(entry.answer, len(answer["options"]))
            if letters and letters != sorted(answer["correct"]):
                disagreed.append(name)
            if letters and replace:
                answer["correct"], replaced = letters, True
        elif answer["type"] == "short" and entry.answer:
            value = entry.answer
            unit = answer.get("unit", "")
            if unit and value.endswith(unit):
                value = value[: -len(unit)].strip()
            if not answer["accepted"] or not _same(value, answer["accepted"][0]):
                disagreed.append(name)
            if replace:
                answer["accepted"], replaced = [value[: limits.QUESTION_TEXT_MAX]], True
        elif answer["type"] == "open" and entry.points:
            items = _items(entry.points)
            marks = sum(item["marks"] for item in items)
            if marks <= limits.QUESTION_MARKS_MAX:
                if marks != part["marks"]:
                    disagreed.append(name)
                if replace:
                    part["markscheme"], part["marks"], replaced = items, marks, True
                    if entry.answer:
                        answer["accepted"] = [entry.answer]
        if replaced:
            out.sources[index] = SCHEME
            if entry.solution:
                part["solution"] = [{"type": "text", "text": entry.solution}]
    return Paired(out, matched, disagreed)


# --------------------------------------------------------------- the run


@dataclass
class Run:
    """What one extraction holds across its threads."""

    validate: Validate
    ai_label: str
    # The boxes figures are picked from, by number.
    boxes: dict[int, tuple[Page, layout.Region]] = field(default_factory=dict)
    recorded: dict[str, Recorded] = field(default_factory=dict)
    # What each question's copy call sent, its keys taken out, and its pages.
    copies: dict[str, dict[str, Any]] = field(default_factory=dict)
    spans: dict[str, tuple[int, int]] = field(default_factory=dict)
    # Questions with their answers recorded, or wholly covered by the scheme.
    answered: set[str] = field(default_factory=set)
    # Printed order: a label's place is the map's, or its first record attempt.
    order: dict[str, int] = field(default_factory=dict)
    full: bool = False
    credits_out: bool = False
    # The run's output budget and what it has spent.
    output_budget: int = 0
    output_tokens: int = 0

    @property
    def over_budget(self) -> bool:
        return self.output_tokens > self.output_budget

    @property
    def stopping(self) -> bool:
        return self.full or self.credits_out or self.over_budget

    def stopped(self) -> str:
        if self.full:
            return "quiz_full"
        if self.credits_out:
            return "credits"
        return "output_limit" if self.over_budget else ""

    def held(self) -> list[Recorded]:
        return sorted(
            self.recorded.values(), key=lambda h: self.order[label_key(h.label)]
        )

    def counts(self, leaving_out: str = "") -> tuple[int, int]:
        parts = opened = 0
        for label, held in self.recorded.items():
            if label != leaving_out:
                p, o = _counts(held.question)
                parts, opened = parts + p, opened + o
        return parts, opened

    def _fits(self, key: str, question: dict[str, Any]) -> bool:
        parts, opened = self.counts(leaving_out=key)
        p, o = _counts(question)
        return (
            parts + p <= limits.QUIZ_PARTS_MAX
            and opened + o <= limits.QUIZ_OPEN_PARTS_MAX
        )

    def _not_fitting(self, label: str) -> str:
        self.full = True
        return (
            f"Question {label} was not recorded: a quiz holds at most "
            f"{limits.QUIZ_PARTS_MAX} parts and {limits.QUIZ_OPEN_PARTS_MAX} "
            "AI-marked parts. Record nothing more."
        )

    async def copy_question(self, item: dict[str, Any], pages: list[Page]) -> str:
        """Keep one question as copied, with no answers; the tool result line."""
        kept = _keyless(item)
        checked = record(_with_placeholders(_worked_out(kept)), self.ai_label)
        if not checked.label or not checked.question["parts"]:
            return (
                "A question needs its printed label and at least one part, given "
                "as the call's arguments themselves."
            )
        key = label_key(checked.label)
        self.order.setdefault(key, len(self.order))
        sent = item.get("pages")
        numbers = {page.number for page in pages}
        figures: list[Figure] = []
        problem = None
        if not (
            isinstance(sent, list)
            and len(sent) == 2
            and all(type(n) is int and n in numbers for n in sent)
            and sent[0] <= sent[1]
        ):
            problem = "pages: expected [first, last], the page numbers it is printed on"
        elif "figures" not in item:
            problem = "figures: give [] when it needs none"
        else:
            figures, problem = read_figures(
                item.get("figures"), pages, checked.part_labels, self.boxes
            )
        problem = problem or await self.validate(checked.question)
        if problem:
            return f"Question {checked.label}: {problem}. Fix it and record it again."
        if not self._fits(key, checked.question):
            return self._not_fitting(checked.label)
        new = record(_worked_out(kept), self.ai_label)
        new.figures = figures
        held = self.recorded.get(key)
        if held is not None:
            new.question["id"] = held.question["id"]
        self.recorded[key] = new
        self.copies[key] = kept
        self.spans[key] = (sent[0], sent[1])
        return f"Question {checked.label}: recorded."

    async def record_answers(self, args: dict[str, Any], pages: list[Page]) -> str:
        """Merge one question's answers into its copy; the tool result line."""
        label = str(args.get("label") or "").strip()
        key = label_key(label)
        kept = self.copies.get(key)
        if kept is None:
            return (
                f"Question {label}: no question with this label was copied. "
                "Give the label it was copied with."
            )
        merged = copy.deepcopy(kept)
        by_part = {label_key(str(p.get("label") or "")): p for p in merged["parts"]}
        for given in args.get("parts") or []:
            given = given if isinstance(given, dict) else {}
            name = str(given.get("label") or "")
            part = by_part.get(label_key(name))
            if part is None:
                names = ", ".join(
                    str(p.get("label") or "") or '""' for p in merged["parts"]
                )
                return (
                    f'Question {label}: it has no part "{name}"; its parts are '
                    f"{names}. Fix it and record it again."
                )
            answer = part["answer"] if isinstance(part.get("answer"), dict) else {}
            part["answer"] = answer
            for field_name in ("correct", "accepted", "points"):
                if field_name in given:
                    value = given[field_name]
                    answer[field_name] = value if isinstance(value, list) else [value]
            part["solution"] = given.get("solution")
            part["key_source"] = given.get("key_source")
        # The validator lets an open part go without a model answer; a flat part
        # dropped most of them without this (Epo 2026-11-05).
        no_model_answer = [
            part_name(label, str(p.get("label") or ""))
            for p in merged["parts"]
            if isinstance(p.get("answer"), dict)
            and p["answer"].get("type") == "open"
            and not any(str(v).strip() for v in p["answer"].get("accepted") or [])
        ]
        if no_model_answer:
            return (
                f"Question {label}: {', '.join(no_model_answer)}: invalid accepted "
                "answers. Fix it and record it again."
            )
        new = record(merged, self.ai_label)
        new.figures, problem = read_figures(
            merged.get("figures"), pages, new.part_labels, self.boxes
        )
        problem = problem or _unsourced(new) or await self.validate(new.question)
        if problem:
            return f"Question {new.label}: {problem}. Fix it and record it again."
        if not self._fits(key, new.question):
            return self._not_fitting(new.label)
        new.question["id"] = self.recorded[key].question["id"]
        self.recorded[key] = new
        self.answered.add(key)
        return f"Question {new.label}: recorded."

    def uncopied(self, rows: list[MapRow], pages: list[Page]) -> list[str]:
        """What a repair should copy: map rows with no copy, numbers missing inside
        the map and the copies, and the next number when it is printed on a page past
        the last question's: a page no row covers."""
        out = [row.label for row in rows if label_key(row.label) not in self.copies]
        labels = [*(row.label for row in rows), *self.copies]
        numbers = {_number(label) for label in labels} - {None}
        if not numbers:
            return out
        known = {label_key(label) for label in out}
        out += [
            str(n)
            for n in sorted(set(range(min(numbers), max(numbers) + 1)) - numbers)
            if str(n) not in known
        ]
        last_page = max(
            [*(row.last for row in rows), *(span[1] for span in self.spans.values())],
            default=pages[0].number,
        )
        following = re.compile(rf"(?m)^\W*{max(numbers) + 1}\s*[.)]?(\s|$)")
        if any(
            page.number > last_page and following.search(page.text) for page in pages
        ):
            out.append(str(max(numbers) + 1))
        return sorted(out, key=lambda label: _number(label) or 0)

    def fill_figures(self, rows: list[MapRow], pages: list[Page]) -> None:
        """A question the map gives figures and its batch gave none takes the map's
        boxes, one figure a page (28 of 536 bench rows left one out). The boxes go in
        its copy, so its answers keep them."""
        for row in rows:
            key = label_key(row.label)
            held = self.recorded.get(key)
            if held is None or held.figures:
                continue
            by_page: dict[int, list[int]] = {}
            for number in row.figures:
                if number in self.boxes:
                    by_page.setdefault(self.boxes[number][0].number, []).append(number)
            if not by_page:
                continue
            items = [
                {"boxes": numbers, "part": "", "description": ""}
                for numbers in by_page.values()
            ]
            figures, problem = read_figures(items, pages, held.part_labels, self.boxes)
            if problem is None:
                held.figures = figures
                self.copies[key]["figures"] = items

    def in_printed_order(self) -> None:
        """By number once repairs may have come late, unless numbers repeat."""
        keys = list(self.order)
        numbers = [_number(key) for key in keys]
        if None not in numbers and len(set(numbers)) == len(numbers):
            keys.sort(key=lambda key: _number(key) or 0)
        self.order = {key: n for n, key in enumerate(keys)}

    def labels(self) -> list[str]:
        return [held.label for held in self.held()]


def _chunks(text: str) -> list[str]:
    """Scheme text in pieces of at most SCHEME_CHUNK_CHARS, cut at line ends."""
    pieces: list[str] = []
    current = ""
    for line in text.splitlines(keepends=True):
        if current and len(current) + len(line) > SCHEME_CHUNK_CHARS:
            pieces.append(current)
            current = ""
        current += line
    if current.strip():
        pieces.append(current)
    return pieces


async def parse_schemes(
    files: list[SchemeFile],
    *,
    model: ModelConfig,
    labels: list[tuple[str, list[str]]],
) -> list[list[Entry]]:
    """Each scheme or answer file piece's entries, one parse call per piece,
    in order. ``labels`` are the map's labels with their part labels, so entries
    are named as the questions are (Epo 2026-11-03: 2024 Q3(b) was read as b(ii))."""

    async def one(name: str, text: str) -> list[Entry]:
        message = await models.complete(
            prompts.scheme_messages(name, text, labels),
            model=model,
            response_format={"type": "json_object"},
            max_tokens=SCHEME_MAX_TOKENS,
            reasoning=False,
            call_purpose="extraction_scheme",
        )
        data = extract_json(getattr(message, "content", "") or "")
        if not isinstance(data, dict) or not isinstance(data.get("entries"), list):
            # A reply cut off at the cap or not JSON is a failed attempt, not
            # a scheme without answers.
            raise elitellm.ProviderError(
                "the mark scheme reply was cut off or not JSON"
            )
        return entries_from(data)

    calls = [
        _attempted(functools.partial(one, f.name, piece))
        for f in files
        for piece in _chunks(f.text)
    ]
    return list(await asyncio.gather(*calls))


async def _attempted(call: Callable[[], Awaitable[Any]]) -> Any:
    for attempt in range(ATTEMPTS):
        try:
            return await call()
        except (elitellm.ProviderError, TimeoutError) as exc:
            definitive = (
                accounting.provider_status(exc) in models.DEFINITIVE_CLIENT_ERRORS
            )
            if definitive or attempt == ATTEMPTS - 1:
                raise
            log.warning("extraction call failed, attempt %d: %s", attempt + 1, exc)
            await asyncio.sleep(ATTEMPT_WAIT_S * (attempt + 1))
    raise AssertionError("the attempts loop returns or raises")


def _call_args(call: dict[str, Any]) -> tuple[str, dict[str, Any] | str]:
    """A tool call's name and its arguments, or the tool result naming why
    they could not be read (the bench saw long calls closed a bracket early)."""
    function = call.get("function") or {}
    name = str(function.get("name") or "")
    try:
        args = json.loads(function.get("arguments") or "{}")
    except json.JSONDecodeError as exc:
        return name, (
            f"The arguments were not valid JSON ({exc.msg} at character {exc.pos}), "
            "so nothing was recorded; send this call again."
        )
    if not isinstance(args, dict):
        return name, "The arguments must be a JSON object; send this call again."
    return name, args


class EmptyMap(elitellm.ProviderError):
    """The map reply held no question."""


async def read_map(
    pages: list[Page],
    boxes: dict[int, tuple[Page, layout.Region]],
    *,
    model: ModelConfig,
) -> tuple[list[dict[str, Any]], list[MapRow], int]:
    """The map call: its messages with its reply, for every thread to continue,
    its rows, and its output tokens. A reply that calls a tool or is cut off is a
    failed attempt."""
    with_text = sends_page_text(pages)
    messages = prompts.map_messages(
        [
            (
                prompts.page_text(
                    index, p.number, p.file_name, p.text[:PAGE_TEXT_CHARS]
                )
                if with_text
                else prompts.page_heading(index, p.number, p.file_name),
                await p.image(),
            )
            for index, p in enumerate(pages, 1)
        ],
        [
            {
                "box": number,
                "page": page.number,
                "coordinates": [round(value) for value in region.box],
                "label": region.label,
                "score": round(region.score, 2),
            }
            for number, (page, region) in boxes.items()
        ],
        with_text=with_text,
    )
    response = await models.complete_response(
        messages,
        model=model,
        tools=prompts.TOOLS,
        max_tokens=MAX_TOKENS,
        call_purpose="extraction_map",
    )
    reply = elitellm.assistant_message_from_obj(
        elitellm.message_from_response(response)
    )
    if reply.get("tool_calls") or response.choices[0].finish_reason == "length":
        raise elitellm.ProviderError("the map reply was cut off or called a tool")
    rows = parse_map(str(reply.get("content") or ""))
    if not rows:
        raise EmptyMap("the map reply held no map lines")
    return [*messages, reply], rows, response.usage.output_tokens


Handle = Callable[[str, dict[str, Any]], Awaitable[str]]


async def _rounds(
    run: Run,
    messages: list[dict[str, Any]],
    *,
    model: ModelConfig,
    purpose: str,
    handle: Handle,
) -> None:
    """One thread's calls, up to THREAD_ROUNDS, added to ``messages``. A failed call
    is tried once more where it is, so a failed stream costs its own round; what the
    thread already recorded stays when it fails for good."""
    for _ in range(THREAD_ROUNDS):
        if _credits_out():
            run.credits_out = True
        if run.stopping:
            return
        response = await _attempted(
            functools.partial(
                models.complete_response,
                messages,
                model=model,
                tools=prompts.TOOLS,
                max_tokens=MAX_TOKENS,
                call_purpose=purpose,
            )
        )
        run.output_tokens += response.usage.output_tokens
        if run.over_budget:
            return
        if response.choices[0].finish_reason == "length":
            # Cut off at the output cap, its calls unfinished: ask again for
            # smaller calls.
            messages.append({"role": "user", "content": prompts.CUT_OFF})
            continue
        reply = elitellm.assistant_message_from_obj(
            elitellm.message_from_response(response)
        )
        messages.append(reply)
        calls = reply.get("tool_calls") or []
        if not calls:
            return
        for call in calls:
            name, args = _call_args(call)
            result = args if isinstance(args, str) else await handle(name, args)
            messages.append(
                {"role": "tool", "tool_call_id": call.get("id"), "content": result}
            )
        if run.full:
            return


_THREAD_FAILURES = (elitellm.ProviderError, TimeoutError)


def _kept_going(results: list[Any]) -> list[BaseException]:
    """A thread that failed on the provider ends alone; anything else fails the
    run. The failures, for a run left with nothing."""
    failures = [r for r in results if isinstance(r, BaseException)]
    for failure in failures:
        if not isinstance(failure, _THREAD_FAILURES):
            raise failure
        log.warning("extraction thread failed: %s", failure)
    return failures


async def _cancelled(tasks: list[asyncio.Task[Any]]) -> None:
    """Stop what is still running when the run's stream goes away."""
    for task in tasks:
        task.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)


async def locate(
    page: Page, figures: list[tuple[str, str]], *, model: ModelConfig
) -> list[list[float]]:
    """The boxes of a page's figures, (question label, description) each, from
    a call that sees that page alone, reasoning off."""
    message = await models.complete(
        prompts.locate_messages(await page.image(), figures),
        model=model,
        response_format={"type": "json_object"},
        max_tokens=LOCATE_MAX_TOKENS,
        reasoning=False,
        call_purpose="extraction_figures",
    )
    data = extract_json(getattr(message, "content", "") or "")
    raw = data.get("boxes") if isinstance(data, dict) else None
    boxes = [_box(b) for b in raw] if isinstance(raw, list) else []
    if len(boxes) != len(figures) or None in boxes:
        # As a scheme reply that is not JSON: a failed attempt.
        raise elitellm.ProviderError("the figure boxes reply was not one box a figure")
    return [box for box in boxes if box is not None]


async def locate_figures(held: list[Recorded], *, model: ModelConfig) -> list[str]:
    """Give each saved figure with no box the box a call seeing its page alone
    answers: coordinates asked of the window, beside two pages and the whole
    extraction, were too far off to crop from (2022 Paper 2: 3 of 10 whole, 3
    missing the figure; bench/extraction/reports/2026-11-04-figures-and-fidelity.md).
    A page whose call fails twice keeps its questions without those figures
    (Epo 2026-11-04); the labels of those questions are returned."""
    pages: dict[int, tuple[Page, list[tuple[Recorded, int]]]] = {}
    for question in held:
        for index, figure in enumerate(question.figures):
            if figure.box is None:
                pages.setdefault(id(figure.page), (figure.page, []))[1].append(
                    (question, index)
                )

    failed: set[tuple[int, int]] = set()

    async def one(page: Page, items: list[tuple[Recorded, int]]) -> None:
        try:
            boxes = await _attempted(
                functools.partial(
                    locate,
                    page,
                    [(q.label, q.figures[i].description) for q, i in items],
                    model=model,
                )
            )
        except (elitellm.ProviderError, TimeoutError) as exc:
            log.warning("figure boxes for page %d failed: %s", page.number, exc)
            failed.update((id(q), i) for q, i in items)
            return
        # The box grown to the ink on the page image the call saw (Epo 2026-11-04).
        jpeg = layout.jpeg_of(await page.image())
        grown = await slots.render_thread(layout.grown_to_ink, jpeg, boxes)
        for (question, index), box in zip(items, grown):
            question.figures[index] = dataclasses.replace(
                question.figures[index], box=box
            )

    await asyncio.gather(*(one(page, items) for page, items in pages.values()))
    left_out = []
    for question in held:
        kept = [
            f for i, f in enumerate(question.figures) if (id(question), i) not in failed
        ]
        if len(kept) < len(question.figures):
            left_out.append(question.label)
            question.figures = kept
    return left_out


def _credits_out() -> bool:
    state = accounting.current()
    return bool(state and state.credits_exhausted)


async def run(
    pages: list[Page],
    schemes: list[SchemeFile],
    *,
    model: ModelConfig,
    validate: Validate,
    locale: str | None,
) -> AsyncIterator[dict[str, Any]]:
    """Events: ``questions`` after each copy batch (every question copied so far,
    with no answers yet), then ``done`` with the quiz's questions and the report."""
    found = await layout.read_regions([page.image for page in pages])
    pages = [
        dataclasses.replace(page, regions=regions)
        for page, regions in zip(pages, found)
    ]
    current = Run(
        validate=validate,
        ai_label=AI_WRITTEN[normalize_locale(locale)],
        boxes=numbered_boxes(pages),
        output_budget=OUTPUT_PER_PAGE * len(pages),
    )
    note = ANSWER_MISSING[normalize_locale(locale)]
    try:
        base, rows, output = await _attempted(
            functools.partial(read_map, pages, current.boxes, model=model)
        )
    except EmptyMap:
        base, rows, output = [], [], 0
    current.output_tokens += output
    current.order = {label_key(row.label): n for n, row in enumerate(rows)}
    batches = [[row.label for row in group] for group in _chunks_of(rows, COPY_BATCH)]
    threads: list[list[dict[str, Any]]] = [list(base) for _ in batches]
    # The thread that copied each question: its solve call continues that one.
    copied_in: dict[str, int] = {}

    def copying(index: int) -> Handle:
        async def handle(name: str, args: dict[str, Any]) -> str:
            if name == "record_question":
                result = await current.copy_question(args, pages)
                if result.endswith("recorded."):
                    copied_in[label_key(str(args.get("label") or ""))] = index
                return result
            if name == "record_answers":
                label = str(args.get("label") or "").strip()
                return (
                    f"Question {label}: not yet. Copy every question first; you are "
                    "asked for the answers later."
                )
            return f"There is no tool {name}."

        return handle

    async def copy_batch(index: int, asks: list[list[str]]) -> None:
        # Its own task, so the level stays with this thread.
        registry.bind_request_llm(COPY_THINKING)
        for labels in asks:
            threads[index].append({"role": "user", "content": prompts.copy_ask(labels)})
            await _rounds(
                current,
                threads[index],
                model=model,
                purpose="extraction_copy",
                handle=copying(index),
            )

    def solving(index: int) -> Handle:
        async def handle(name: str, args: dict[str, Any]) -> str:
            if name == "record_answers":
                return await current.record_answers(args, pages)
            if name == "record_question":
                label = str(args.get("label") or "").strip()
                if label_key(label) in current.copies:
                    return (
                        f"Question {label}: it is already copied; give its answers "
                        "with record_answers."
                    )
                return await copying(index)(name, args)
            return f"There is no tool {name}."

        return handle

    async def solve_batch(index: int, labels: list[str]) -> None:
        await _rounds(
            current,
            [
                *threads[index],
                {"role": "user", "content": prompts.solve_ask(labels)},
            ],
            model=model,
            purpose="extraction_solve",
            handle=solving(index),
        )

    def solve_tasks() -> list[asyncio.Task[None]]:
        """Solve batches for what has no answers yet: runs of contiguous numbers, in
        the thread that copied them."""
        by_thread: dict[int, list[str]] = {}
        for held in current.held():
            key = label_key(held.label)
            if key not in current.answered and key in copied_in:
                by_thread.setdefault(copied_in[key], []).append(held.label)
        return [
            asyncio.create_task(solve_batch(index, group))
            for index, labels in by_thread.items()
            for contiguous in _runs_of(labels)
            for group in _chunks_of(contiguous, SOLVE_BATCH)
        ]

    tasks: list[asyncio.Task[Any]] = []
    parsing: asyncio.Task[list[list[Entry]]] | None = None
    if schemes and rows:
        parsing = asyncio.create_task(
            parse_schemes(
                schemes,
                model=model,
                labels=[(row.label, row.parts) for row in rows],
            )
        )
        tasks.append(parsing)
    failures: list[BaseException] = []
    pieces: list[list[Entry]] = []
    scheme_failed = False
    try:
        copies = [
            asyncio.create_task(copy_batch(index, [labels]))
            for index, labels in enumerate(batches)
        ]
        tasks.extend(copies)
        for finished in asyncio.as_completed(copies):
            try:
                await finished
            except _THREAD_FAILURES as exc:
                failures.append(exc)
                log.warning("extraction copy batch failed: %s", exc)
            yield {
                "type": "questions",
                "questions": [held.question for held in current.held()],
            }
        tried: set[str] = set()
        for _ in range(COPY_REPAIR_PASSES):
            missing = [
                label for label in current.uncopied(rows, pages) if label not in tried
            ]
            if not missing or current.stopping or not threads:
                break
            tried.update(missing)
            asks: dict[int, list[list[str]]] = {}
            for labels in _runs_of(missing):
                number = _number(labels[0]) or 0
                index = next(
                    (
                        i
                        for i, batch in enumerate(batches)
                        if max(_number(label) or 0 for label in batch) >= number
                    ),
                    len(batches) - 1,
                )
                asks.setdefault(index, []).append(labels)
            repairs = [
                asyncio.create_task(copy_batch(index, runs))
                for index, runs in asks.items()
            ]
            tasks.extend(repairs)
            failures += _kept_going(
                await asyncio.gather(*repairs, return_exceptions=True)
            )
            yield {
                "type": "questions",
                "questions": [held.question for held in current.held()],
            }
        current.fill_figures(rows, pages)
        current.in_printed_order()
        if failures and not current.copies:
            raise failures[0]
        if parsing is not None:
            try:
                pieces = await parsing
            except _THREAD_FAILURES as exc:
                # The copies stay and the model works every answer out.
                log.warning("extraction scheme failed: %s", exc)
                scheme_failed = True
        known, _ = _merged(pieces)
        for held in current.held():
            paired = pair(held, known)
            if all(
                source == SCHEME for source in paired.held.sources
            ) and not await validate(paired.held.question):
                current.answered.add(label_key(held.label))
        # A thread that ended early gets one more call for what it left out.
        for _ in range(2):
            if current.stopping:
                break
            solves = solve_tasks()
            if not solves:
                break
            tasks.extend(solves)
            _kept_going(await asyncio.gather(*solves, return_exceptions=True))
    except BaseException:
        await _cancelled(tasks)
        raise
    if _credits_out():
        current.credits_out = True
    held = current.held()
    entries, repeats = _merged(pieces)
    used: set[tuple[str, str]] = set()
    worked_out: list[str] = []
    disagreements: list[str] = []
    refused: list[str] = []
    marks_differ: list[str] = []
    answers_missing: list[str] = []
    finals: list[Recorded] = []
    for question in held:
        paired = pair(question, entries)
        missing_here = _mark_no_answer(paired.held, note)
        if paired.matched:
            key = label_key(question.label)
            used.update(k for k in entries if k[0] == key)
            disagreements.extend(paired.disagreed)
        # The scheme's version is checked as the quiz's creation will check it; a
        # refusal keeps the page's keys rather than losing the question.
        if paired.matched and await validate(paired.held.question):
            refused.append(question.label)
            missing_here = _mark_no_answer(question, note)
        else:
            question = paired.held
        answers_missing.extend(missing_here)
        finals.append(question)
        if WORKED_OUT in question.sources:
            worked_out.append(question.label)
        parts_total = sum(part["marks"] for part in question.question["parts"])
        if question.total is not None and parts_total != question.total:
            marks_differ.append(question.label)
    figures_left_out = await locate_figures(finals, model=model)
    figures = [question.label for question in finals if question.figures]
    crops: dict[str, str] = {}
    saved = [await placed(question, crops) for question in finals]
    for question in saved:
        _tidy_text_in(question)
    recorded = {label_key(label) for label in current.labels()}
    expected = [row.label for row in rows]
    yield {
        "type": "done",
        "questions": saved,
        # The crops the questions' image blocks name (figure:<id>), base64.
        "figures": [{"id": key, "image": image} for key, image in crops.items()],
        "report": {
            # The map's questions, those with no copy, and those copied.
            "expected": expected,
            "missing": [
                label for label in expected if label_key(label) not in recorded
            ],
            "recorded": current.labels(),
            # Parts saved with no answer, a marking note in its place, because their
            # solve call failed or the run stopped first.
            "answersMissing": answers_missing,
            # The answer files could not be parsed, so every answer was worked out.
            "schemeFailed": scheme_failed,
            # Questions with a part whose key the model worked out and no
            # scheme replaced: their solutions carry the AI-written label.
            "keysWorkedOut": worked_out,
            # Parts whose printed or worked-out key differs from the scheme's.
            "keyDisagreements": disagreements,
            # Questions the validator refused with the scheme's keys; they keep
            # the page's.
            "schemeRefused": refused,
            # Saved questions whose part marks do not add up to the total
            # printed on the page.
            "marksDiffer": marks_differ,
            "unpaired": sorted(
                {entries[key].question for key in entries if key not in used},
                key=lambda label: (len(label), label),
            ),
            # Scheme entries named like an earlier one and not its
            # continuation: left out rather than merged into it.
            "schemeRepeats": repeats,
            # Questions saved with figures cropped from the page, for the
            # starter to check, and questions saved without theirs: they had
            # no box and the box call for their page failed twice (Go adds
            # those whose figures did not fit in the starter's storage).
            "figures": figures,
            "figuresLeftOut": figures_left_out,
            "stopped": current.stopped(),
            "pages": len(pages),
            # The copy batches: the name stays for the screens' API.
            "windows": len(batches),
        },
    }


# ------------------------------------------------- the request, from the store


class ExtractionRefused(ValueError):
    """The request names something the run cannot read; Go shows the message."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def page_texts(passages: list[dict[str, Any]]) -> dict[int, str]:
    """Each page's indexed text; a passage spanning pages counts for each, and
    an image's caption (no page) is page 1."""
    pages: dict[int, list[str]] = {}
    for passage in passages:
        first = passage.get("page_start") or 1
        last = passage.get("page_end") or first
        for number in range(int(first), int(last) + 1):
            pages.setdefault(number, []).append(str(passage.get("text") or ""))
    return {number: "\n\n".join(texts) for number, texts in pages.items()}


def page_layer(page: Any, text: str) -> str:
    """What a PDF page is, from the stored PDF and its indexed text, since no stored
    field says: the parser's hidden layer and text-less tests (parser/odl/hidden.py,
    textless.py) are not saved. Born digital: at least 40 characters the page shows
    (a hidden OCR layer is render mode 3 or zero opacity) and no image covering nine
    tenths of it. Blank: fewer, no image and no page read. Anything else is a scan."""
    import pymupdf

    if len(page.get_text()) > PAGE_CHARS_MOST:
        return SCAN
    visible = sum(
        len(span["chars"])
        for span in page.get_texttrace()
        if span["type"] != 3 and span.get("opacity", 1) != 0
    )
    images = page.get_image_info()
    covered = max(
        (
            (pymupdf.Rect(image["bbox"]) & page.rect).get_area() / page.rect.get_area()
            for image in images
        ),
        default=0,
    )
    if visible >= VISIBLE_CHARS:
        return BORN_DIGITAL if covered < IMAGE_COVERS_PAGE else SCAN
    return SCAN if images or len(text.strip()) >= VISIBLE_CHARS else BLANK


def page_layers(pdf: Any, texts: dict[int, str]) -> dict[int, str]:
    import pymupdf

    with pymupdf.open(pdf) as doc:
        return {n: page_layer(doc[n - 1], text) for n, text in texts.items()}


def sends_page_text(pages: list[Page]) -> bool:
    """The run's page text goes only when no page is a scan and one is born digital
    (Epo 2026-11-05, "scans only"): a run has one system prompt, so the cache holds."""
    return {page.layer for page in pages} - {BLANK} == {BORN_DIGITAL}


def _page_count(pdf: Any) -> int:
    import pymupdf

    with pymupdf.open(pdf) as doc:
        return len(doc)


async def _render(workspace_id: str, file_id: str, number: int) -> str:
    jpeg, _box, _size = await capture.render_file(
        workspace_id, file_id, number, None, cfg.capture_max_edge
    )
    return capture.data_url(jpeg)


async def _crop(
    workspace_id: str, file_id: str, number: int, box: list[float]
) -> tuple[bytes, tuple[int, int]]:
    jpeg, _box, size = await capture.render_file(
        workspace_id, file_id, number, box, cfg.capture_max_edge, FIGURE_PAGE_EDGE
    )
    return jpeg, size


async def prepare(
    workspace_id: str, paper: list[dict[str, Any]], answers: list[dict[str, Any]]
) -> tuple[list[Page], list[SchemeFile]]:
    """The selected pages and the scheme texts, checked before the run starts:
    a page past its file's end or a file with no page view is refused."""
    pages: list[Page] = []
    for file in paper:
        file_id, name, numbers = file["fileId"], file["name"], file["pages"]
        row = await store.file_page_source(workspace_id, file_id)
        if row is None:
            raise ExtractionRefused(
                "file_unavailable", f"{name} is no longer in the workspace."
            )
        pdf = None
        if row.get("kind") == "pdf":
            try:
                pdf = await capture.pdf_path(workspace_id, file_id)
            except capture.CaptureUnavailable as exc:
                raise ExtractionRefused(exc.code, f"{name}: {exc}.") from exc
            count = await slots.render_thread(_page_count, pdf)
        elif row.get("kind") == "image":
            count = 1
        else:
            raise ExtractionRefused(
                "no_page_view", f"{name} has no pages to read questions from."
            )
        past = [number for number in numbers if number > count]
        if past:
            raise ExtractionRefused(
                "page_out_of_range",
                f"{name} has {count} pages; page {past[0]} is past its end.",
            )
        indexed = page_texts(await store.file_passages(workspace_id, file_id))
        texts = {number: indexed.get(number, "") for number in numbers}
        # An image has no text layer, and its caption is no page read: a scan.
        layers = await slots.render_thread(page_layers, pdf, texts) if pdf else {}
        pages.extend(
            Page(
                number,
                name,
                texts[number],
                functools.partial(_render, workspace_id, file_id, number),
                functools.partial(_crop, workspace_id, file_id, number),
                layer=layers.get(number, SCAN),
            )
            for number in numbers
        )
    schemes: list[SchemeFile] = []
    for file in answers:
        passages = await store.file_passages(workspace_id, file["fileId"])
        text = "\n\n".join(str(p.get("text") or "") for p in passages).strip()
        if not text:
            raise ExtractionRefused(
                "no_indexed_text",
                f"{file['name']} has no indexed text to read answers from.",
            )
        if len(text) > SCHEME_TEXT_CHARS:
            raise ExtractionRefused(
                "scheme_too_long",
                f"{file['name']} is longer than the {SCHEME_TEXT_CHARS:,} characters "
                "of mark scheme a run reads.",
            )
        schemes.append(SchemeFile(file["name"], text))
    return pages, schemes


async def gateway_validate(question: dict[str, Any]) -> str | None:
    """Go's quiz validator on one question: its refusal, or None."""
    resp = await asyncio.to_thread(
        tools._post_json, "/api/internal/questions/check", {"question": question}
    )
    if resp.status_code != 200:
        raise RuntimeError(f"the question check answered {resp.status_code}")
    return resp.json().get("problem") or None
