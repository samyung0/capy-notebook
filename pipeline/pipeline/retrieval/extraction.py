"""Questions read from the selected pages of an uploaded paper into a quiz
(todo-study-tracking.md §8, Make a quiz).

A fixed pipeline, like /generate, not the chat agent (Epo 2026-11-05, map, copy,
solve; bench/extraction/reports/2026-11-05-copy-first-structured.md):

0. The layout service's regions on every selected page (``layout``), which
   number the boxes figures are picked from, once across the selection.
1. The map: one call sees every selected page and its boxes and answers one
   line a question: label, pages, parts, figures.
   The answer files go with it (Epo 2026-11-05, "dont use code for pairing, send the
   files directly"), as indexed text or page images, so every later call reads them
   from the cache. The run then waits for its starter to confirm the questions found
   (``confirm``, Epo 2026-11-05): the map is charged by its tokens, and they pay per
   question from here.
2. Copy batches of 16 of the map's questions, at most 4 at once, each continuing
   the map's conversation at low reasoning. ``record_question`` carries no answers.
3. Code checks the copies against the map and sends a repair for a question left
   out: a map row not copied, a gap in the numbers, or the next number printed on
   a page no row covers. A figure the map lists and a batch left out is added
   from the map's boxes.
4. Solve batches of up to 8 questions, in parallel at medium reasoning, each continue
   the copy batch holding their questions and give ``record_answers``: taken from the
   answer files or the page when they give them, otherwise worked out.

Every recorded question and answer goes through the Go validator at once and a
problem goes back to the model. A call that fails is tried once more where it is
in its own thread; a thread that still fails ends alone. Its copied questions
stay, and a part left with no answer is named in the report.

The printed option order is kept (``add_questions`` shuffles; this does not),
and option lines the model also copied into a part's text are taken out. No
question is left out for want of a key. Each figure a question needs is recorded by box number (Epo
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
import io
import json
import logging
import math
import re
import time
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

from .. import elitellm, registry
from ..config import cfg
from ..generated import limits
from ..prompts import extraction as prompts
from ..registry import ModelConfig
from . import accounting, capture, layout, models, store, tools
from . import limits as slots
from .workflows import extract_json

log = logging.getLogger("capy.retrieval.extraction")

# Questions a copy batch holds and a solve batch holds, each a thread of its own
# (Epo 2026-11-05).
COPY_BATCH = 16
SOLVE_BATCH = 8
# Batches of a run, copying or solving, that run at once. A settlement saying
# credits ran out stops a thread only before its next call, and a long map is many
# batches (500 rows, 32): the ones still waiting here stop without spending anything.
BATCHES_AT_ONCE = 4
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
# Figures a whole question holds, stem and parts together (Epo 2026-11-05, "cap at 5, i
# thought its per part, if whole quesiton then 5"). A call past it is refused. Worked
# solutions hold text alone, so they can't add one.
QUESTION_FIGURES_MAX = 5
# A figure is cropped at the scale that gives its page's long side this many
# pixels (about 190 DPI on A4, against the page images' 1,568), so its labels read
# and a small figure stays small; the crop's long side is still at most
# CAPY_CAPTURE_MAX_EDGE.
FIGURE_PAGE_EDGE = 2_200
# The locate call's reply: a few boxes.
LOCATE_MAX_TOKENS = 1_000
# Indexed text shown per page.
PAGE_TEXT_CHARS = 6_000
# A file with no page view counts one page of output budget per this much text.
TEXT_PAGE_CHARS = 500
# The most whole-file and answer text a run sends, about 60 dense pages (Epo
# 2026-11-05); more is refused rather than cut.
RUN_TEXT_CHARS = 200_000
# How long a run waits for its starter to confirm the questions found, and how often it
# looks at their answer. The wait holds a turn slot.
CONFIRM_WAIT_S = 600
CONFIRM_POLL_S = 1.0
# How often a run says how far it has got, for its panel.
PROGRESS_EVERY_S = 2.0

# A busy, failing or silent provider costs a call one silent retry (Epo
# 2026-11-03): the map or a thread's round runs once more. A
# definitive client error does not retry.
ATTEMPTS = 2
ATTEMPT_WAIT_S = 20.0

Validate = Callable[[dict[str, Any]], Awaitable[str | None]]
# Given how many questions the map found, how many to make; None ends the run.
Confirm = Callable[[int], Awaitable[int | None]]

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
    it is (``page_layer``); what is not known counts as a scan. A text paper is one page
    with no image and no crop: its whole indexed text."""

    number: int
    file_name: str
    text: str
    image: Callable[[], Awaitable[str]] | None
    crop: Callable[[list[float]], Awaitable[tuple[bytes, tuple[int, int]]]] | None
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
class AnswerFile:
    """A mark scheme, answer key or someone's answers, as the map's message carries it:
    its page images, each with its number, or else its indexed text."""

    name: str
    text: str = ""
    images: tuple[tuple[int, Callable[[], Awaitable[str]]], ...] = ()


@dataclass
class Recorded:
    """One question as recorded, every part with its key."""

    label: str
    question: dict[str, Any]
    part_labels: list[str]
    figures: list[Figure] = field(default_factory=list)


@dataclass(frozen=True)
class MapRow:
    """One line of the map: a question's label, the pages it is printed on, its
    part labels and the boxes that hold its figures."""

    label: str
    first: int
    last: int
    parts: list[str]
    figures: list[int]


# ---------------------------------------------------------------- labels


def label_key(label: str) -> str:
    """A printed label as pairing compares it: "Q3", "3." and "3" are one;
    "(b)(ii)", "b(ii)" and "b ii" are one."""
    # Any other letter or number is a token too: 甲, or ① and ②, which a Chinese paper
    # labels parts with, would otherwise all read as "".
    tokens = re.findall(r"[a-z]+|\d+|[^\W\d_a-z]+", label.lower())
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
    if isinstance(value, str) and value.strip().isdigit() and len(value.strip()) < 10:
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


def _solution(text: str) -> list[dict[str, Any]]:
    return [{"type": "text", "text": text}] if text else []


def _part(raw: Any) -> tuple[str, dict[str, Any]]:
    """A recorded part: its printed label and the part."""
    raw = raw if isinstance(raw, dict) else {}
    answer, items = _answer(raw.get("answer"))
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
        "solution": _solution(_text(raw.get("solution"), limits.QUESTION_TEXT_MAX)),
    }
    if answer["type"] == "open":
        part["markscheme"] = items
    return str(raw.get("label") or ""), part


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


def record(item: Any) -> Recorded:
    """A question's call as a quiz question in paper layout; its figures are
    read against the selection's pages (``read_figures``)."""
    item = item if isinstance(item, dict) else {}
    parsed = [_part(p) for p in item.get("parts") or []]
    labels = [label for label, _ in parsed]
    first = next((label for label in labels if label), "")
    question = {
        "id": str(uuid.uuid4()),
        "stem": _blocks(item.get("stem")),
        "parts": [part for _, part in parsed],
        "layout": "paper",
        "labels": "numbers" if first[:1].isdigit() else "letters",
    }
    _drop_option_lines(question)
    _drop_repeated_stem(question)
    return Recorded(
        label=str(item.get("label") or "").strip(),
        question=question,
        part_labels=labels,
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
    items = raw if isinstance(raw, list) else []
    read: list[Figure] = []
    # Only pages with an image can give a figure, and only they are counted.
    pictured = [page for page in pages if page.image]
    if not pictured:
        return [], None
    if len(items) > QUESTION_FIGURES_MAX:
        return [], f"too many figures, a question holds at most {QUESTION_FIGURES_MAX}"
    parts = {label_key(label) for label in part_labels}
    for index, item in enumerate(items):
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
            if image is None or not 1 <= image <= len(pictured):
                choices = " or ".join(str(n + 1) for n in range(len(pictured)))
                return [], f"{name}: with boxes [] give image, {choices}"
            read.append(Figure(pictured[image - 1], part, description))
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
    ``crops`` by figure id, base64, as the done event carries them. A figure
    whose crop fails leaves ``held.figures``: the run is already paid for."""
    if not held.figures:
        return held.question
    question = copy.deepcopy(held.question)
    for n, figure in enumerate(list(held.figures), 1):
        if figure.box is None:
            raise AssertionError("a figure is located before it is placed")
        try:
            jpeg, (width, height) = await figure.page.crop(figure.box)
        except Exception as exc:  # noqa: BLE001 - the run is already paid for
            log.warning("figure crop for question %s failed: %s", held.label, exc)
            held.figures.remove(figure)
            continue
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


_MAP_LINE = re.compile(
    r"^\s*(?:\*\*)?(?P<label>[^|]+?)(?:\*\*)?\s*\|\s*pages?\s*(?P<first>\d{1,9})(?:\s*-\s*(?P<last>\d{1,9}))?"
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
        # "none | pages 1-1 | ..." is the model saying it found no question.
        if match["label"].strip().lower() == "none":
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
                [int(n) for n in re.findall(r"\b\d{1,9}\b", match["figures"])],
            )
        )
    return rows


def _number(label: str) -> int | None:
    digits = re.findall(r"\d+", label)
    # Python refuses to read over 4,300 digits, and nothing that long is a number here.
    return int(digits[-1]) if digits and len(digits[-1]) < 10 else None


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


def _as_list(value: Any) -> list[Any]:
    if value is None:
        return []
    return value if isinstance(value, list) else [value]


def _keyless(item: dict[str, Any]) -> dict[str, Any]:
    """A copy call as code keeps it, anything it sent of a key taken out."""
    out = copy.deepcopy(item)
    for part in out.get("parts") or []:
        if not isinstance(part, dict):
            continue
        part.pop("solution", None)
        if isinstance(part.get("answer"), dict):
            for name in ("correct", "accepted", "points"):
                part["answer"].pop(name, None)
    return out


def _with_placeholders(
    item: dict[str, Any], only: set[str] | None = None
) -> dict[str, Any]:
    """A copy with placeholder keys, so the validator checks what was copied and
    nothing that comes later; ``only`` limits them to those parts, by label key. It is
    never saved."""
    out = copy.deepcopy(item)
    for part in out.get("parts") or []:
        if not isinstance(part, dict) or not isinstance(part.get("answer"), dict):
            continue
        if only is not None and label_key(str(part.get("label") or "")) not in only:
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


def _has_key(part: dict[str, Any]) -> bool:
    answer = part["answer"]
    kind = answer["type"]
    if kind == "mcq":
        return bool(answer["correct"])
    if kind == "short":
        return bool(answer["accepted"])
    return bool(part.get("markscheme"))


def _parts_with_no_answer(held: Recorded) -> list[str]:
    """The parts that never got an answer, as the report names them. They stay as
    copied: a live quiz holds an incomplete question, and only complete ones are
    marked (Epo 2026-11-05, "allow no answers for questions then")."""
    return [
        part_name(held.label, label)
        for label, part in zip(held.part_labels, held.question["parts"])
        if not _has_key(part)
    ]


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


# --------------------------------------------------------------- the run


@dataclass
class Run:
    """What one extraction holds across its threads."""

    validate: Validate
    # The boxes figures are picked from, by number.
    boxes: dict[int, tuple[Page, layout.Region]] = field(default_factory=dict)
    recorded: dict[str, Recorded] = field(default_factory=dict)
    # What each question's copy call sent, its keys taken out, and its pages.
    copies: dict[str, dict[str, Any]] = field(default_factory=dict)
    spans: dict[str, tuple[int, int]] = field(default_factory=dict)
    # The starter confirmed fewer questions than the map found: these keys alone are
    # kept, whatever a batch copies.
    only: set[str] | None = None
    # Questions whose map boxes could not fill in for what their batch left out.
    figures_refused: list[str] = field(default_factory=list)
    # Questions with their answers recorded.
    answered: set[str] = field(default_factory=set)
    # Printed order: a label's place is the map's, or its first record attempt.
    order: dict[str, int] = field(default_factory=dict)
    full: bool = False
    # The quiz filled while copying: what was copied still gets its answers.
    filled_copying: bool = False
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
        if self.full or self.filled_copying:
            return "quiz_full"
        if self.credits_out:
            return "credits"
        return "output_limit" if self.over_budget else ""

    def held(self) -> list[Recorded]:
        return sorted(
            (
                held
                for key, held in self.recorded.items()
                if self.only is None or key in self.only
            ),
            key=lambda h: self.order[label_key(h.label)],
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
        checked = record(_with_placeholders(kept))
        if not checked.label or not checked.question["parts"]:
            return (
                "A question needs its label and at least one part, given "
                "as the call's arguments themselves."
            )
        key = label_key(checked.label)
        self.order.setdefault(key, len(self.order))
        sent = item.get("pages")
        # A file with no page view has one page, whatever page numbers its text holds.
        if not any(page.image for page in pages):
            sent = [pages[0].number, pages[0].number]
        numbers = {page.number for page in pages}
        figures: list[Figure] = []
        problem = None
        if not (
            isinstance(sent, list)
            and len(sent) == 2
            and all(type(n) is int and n in numbers for n in sent)
            and sent[0] <= sent[1]
        ):
            problem = "pages: expected [first, last], the page numbers it is on"
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
        new = record(kept)
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
        # A part sent with no answer at all is skipped (Epo 2026-11-05, "skip the answer
        # if there not enough information"): it stays as copied, and the report names it.
        skipped: set[str] = set()
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
            if not any(
                str(value).strip()
                for field_name in ("correct", "accepted", "points")
                for value in _as_list(given.get(field_name))
            ):
                skipped.add(label_key(name))
                continue
            for field_name in ("correct", "accepted", "points"):
                if field_name in given:
                    value = given[field_name]
                    answer[field_name] = value if isinstance(value, list) else [value]
            part["solution"] = given.get("solution")
        # The validator lets an open part go without a model answer; a flat part
        # dropped most of them without this (Epo 2026-11-05).
        no_model_answer = [
            part_name(label, str(p.get("label") or ""))
            for p in merged["parts"]
            if isinstance(p.get("answer"), dict)
            and p["answer"].get("type") == "open"
            and label_key(str(p.get("label") or "")) not in skipped
            and not any(str(v).strip() for v in p["answer"].get("accepted") or [])
        ]
        if no_model_answer:
            return (
                f"Question {label}: {', '.join(no_model_answer)}: invalid accepted "
                "answers. Fix it and record it again."
            )
        new = record(merged)
        new.figures, problem = read_figures(
            merged.get("figures"), pages, new.part_labels, self.boxes
        )
        checked = record(_with_placeholders(merged, skipped))
        problem = problem or await self.validate(checked.question)
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
        the map and the copies, and the next number when it is on a page past
        the last question's: a page no row covers."""
        out = [row.label for row in rows if label_key(row.label) not in self.copies]
        if self.only is not None:
            return out
        labels = [*(row.label for row in rows), *self.copies]
        numbers = {_number(label) for label in labels} - {None}
        if not numbers:
            return out
        known = {label_key(label) for label in out}
        # A printed number far from the rest (a year, a code) is not a run of
        # questions, and the range would be as big as the number.
        if max(numbers) - min(numbers) <= limits.QUIZ_PARTS_MAX:
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

    def progress(self) -> dict[str, Any]:
        """How far the run has got, for its panel."""
        return {
            "type": "progress",
            "copied": len(self.copies),
            "answered": len(self.answered),
        }

    def fill_figures(self, rows: list[MapRow], pages: list[Page]) -> None:
        """A question the map gives figures and its batch gave none takes the map's
        boxes, one figure a page (28 of 536 bench rows left one out). The boxes go in
        its copy, so its answers keep them."""
        for row in rows:
            key = label_key(row.label)
            held = self.recorded.get(key)
            if held is None or held.figures:
                continue
            # By the page itself: two files both have a page 1.
            by_page: dict[int, list[int]] = {}
            for number in row.figures:
                if number in self.boxes:
                    by_page.setdefault(id(self.boxes[number][0]), []).append(number)
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
            else:
                self.figures_refused.append(held.label)

    def in_printed_order(self) -> None:
        """By number once repairs may have come late, unless numbers repeat."""
        keys = list(self.order)
        numbers = [_number(key) for key in keys]
        if None not in numbers and len(set(numbers)) == len(numbers):
            keys.sort(key=lambda key: _number(key) or 0)
        self.order = {key: n for n, key in enumerate(keys)}

    def labels(self) -> list[str]:
        return [held.label for held in self.held()]


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


async def _answer_blocks(answers: list[AnswerFile]) -> list[dict[str, Any]]:
    """The answer files as the map's message carries them."""
    blocks: list[dict[str, Any]] = []
    shown = 0
    for file in answers:
        if not file.images:
            blocks.append(
                {"type": "text", "text": prompts.answer_text(file.name, file.text)}
            )
        for number, image in file.images:
            shown += 1
            heading = prompts.answer_image_heading(shown, number, file.name)
            blocks.append({"type": "text", "text": heading})
            blocks.append({"type": "image_url", "image_url": {"url": await image()}})
    return blocks


async def read_map(
    pages: list[Page],
    answers: list[AnswerFile],
    boxes: dict[int, tuple[Page, layout.Region]],
    *,
    model: ModelConfig,
) -> tuple[list[dict[str, Any]], list[MapRow], int]:
    """The map call: its messages with its reply, for every thread to continue,
    its rows, and its output tokens. A reply that calls a tool or is cut off is a
    failed attempt."""
    with_text = sends_page_text(pages)
    pictured = [p for p in pages if p.image]
    index = {id(p): n for n, p in enumerate(pictured, 1)}
    messages = prompts.map_messages(
        [
            (
                prompts.text_page(p.number, p.file_name, p.text),
                None,
            )
            if p.image is None
            else (
                prompts.page_text(
                    index[id(p)], p.number, p.file_name, p.text[:PAGE_TEXT_CHARS]
                )
                if with_text
                else prompts.page_heading(index[id(p)], p.number, p.file_name),
                await p.image(),
            )
            for p in pages
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
        await _answer_blocks(answers),
        system=prompts.SYSTEM_TEXT_ONLY
        if not pictured
        else prompts.SYSTEM
        if with_text
        else prompts.SYSTEM_NO_PAGE_TEXT,
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
            if isinstance(args, str):
                result = args
            else:
                try:
                    result = await handle(name, args)
                except TypeError as exc:
                    # Valid JSON of the wrong shape ("parts": 5) costs this call,
                    # not the paid run.
                    log.warning("extraction arguments of the wrong shape: %s", exc)
                    label = str(args.get("label") or "").strip()
                    result = (
                        f"Question {label}: invalid arguments. Fix it and record it "
                        "again."
                    )
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
            # The box grown to the ink on the page image the call saw (Epo 2026-11-04).
            jpeg = layout.jpeg_of(await page.image())
            grown = await slots.render_thread(layout.grown_to_ink, jpeg, boxes)
        except Exception as exc:  # noqa: BLE001 - the run is already paid for
            log.warning("figure boxes for page %d failed: %s", page.number, exc)
            failed.update((id(q), i) for q, i in items)
            return
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


def _pages_worth(page: Page) -> int:
    """What a selected page counts for in the run's output budget: a file with no page
    view counts a page for each TEXT_PAGE_CHARS of its text, up to a whole run's pages. A
    worksheet's page holds about 500 characters (2021 P1 Q1 to Q10: 3,856 on 7 pages) and
    its one copy call wrote 9,400 tokens."""
    if page.image:
        return 1
    worth = math.ceil(len(page.text) / TEXT_PAGE_CHARS)
    return min(max(1, worth), limits.EXTRACTION_PAGES_MAX)


def _credits_out() -> bool:
    state = accounting.current()
    return bool(state and state.credits_exhausted)


async def run(
    pages: list[Page],
    answers: list[AnswerFile],
    *,
    model: ModelConfig,
    validate: Validate,
    confirm: Confirm | None = None,
) -> AsyncIterator[dict[str, Any]]:
    """Events: ``map`` with the questions found when ``confirm`` is given, which then
    says how many to make (None ends the run), and ``progress`` while it copies and
    solves; with no starter, as on the bench, ``questions`` after each copy batch (every
    question copied so far, with no answers yet). Then ``done`` with the quiz's questions
    and the report."""
    found = iter(
        await layout.read_regions([page.image for page in pages if page.image])
    )
    pages = [
        dataclasses.replace(page, regions=next(found)) if page.image else page
        for page in pages
    ]
    current = Run(
        validate=validate,
        boxes=numbered_boxes(pages),
        output_budget=OUTPUT_PER_PAGE * sum(_pages_worth(page) for page in pages),
    )
    try:
        base, rows, output = await _attempted(
            functools.partial(read_map, pages, answers, current.boxes, model=model)
        )
    except EmptyMap:
        base, rows, output = [], [], 0
    current.output_tokens += output
    if confirm and rows:
        yield {
            "type": "map",
            "questions": [
                {
                    "label": row.label,
                    "first": row.first,
                    "last": row.last,
                    "parts": row.parts,
                }
                for row in rows
            ],
        }
        chosen = await confirm(len(rows))
        if chosen is None:
            return
        # Fewer than the map found: what the starter afforded is all it copies.
        if chosen < len(rows):
            rows = rows[:chosen]
            current.only = {label_key(row.label) for row in rows}
        # Confirming took the credits to pay for it: a map that crossed zero is over.
        state = accounting.current()
        if state:
            state.credits_exhausted = False
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

    batch_turns = asyncio.Semaphore(BATCHES_AT_ONCE)

    async def copy_batch(index: int, asks: list[list[str]]) -> None:
        async with batch_turns:
            # Its own task, so the level stays with this thread.
            registry.bind_request_llm(COPY_THINKING)
            for labels in asks:
                threads[index].append(
                    {"role": "user", "content": prompts.copy_ask(labels)}
                )
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
        async with batch_turns:
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
    failures: list[BaseException] = []
    try:
        copies = [
            asyncio.create_task(copy_batch(index, [labels]))
            for index, labels in enumerate(batches)
        ]
        tasks.extend(copies)
        copying_now = set(copies)
        while copying_now:
            finished, copying_now = await asyncio.wait(
                copying_now,
                timeout=PROGRESS_EVERY_S,
                return_when=asyncio.FIRST_COMPLETED,
            )
            for task in finished:
                try:
                    task.result()
                except _THREAD_FAILURES as exc:
                    failures.append(exc)
                    log.warning("extraction copy batch failed: %s", exc)
                if not confirm:
                    yield {
                        "type": "questions",
                        "questions": [held.question for held in current.held()],
                    }
            if confirm:
                yield current.progress()
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
            if confirm:
                yield current.progress()
            else:
                yield {
                    "type": "questions",
                    "questions": [held.question for held in current.held()],
                }
        current.fill_figures(rows, pages)
        current.in_printed_order()
        if failures and not current.copies:
            raise failures[0]
        current.filled_copying, current.full = current.full, False
        # A thread that ended early gets one more call for what it left out.
        for _ in range(2):
            if current.stopping:
                break
            solves = solve_tasks()
            if not solves:
                break
            tasks.extend(solves)
            solving_now = set(solves)
            while solving_now:
                _, solving_now = await asyncio.wait(
                    solving_now, timeout=PROGRESS_EVERY_S
                )
                if confirm:
                    yield current.progress()
            _kept_going(await asyncio.gather(*solves, return_exceptions=True))
    except BaseException:
        await _cancelled(tasks)
        raise
    if _credits_out():
        current.credits_out = True
    finals = current.held()
    answers_missing = [
        name for question in finals for name in _parts_with_no_answer(question)
    ]
    figures_left_out = [
        *current.figures_refused,
        *await locate_figures(finals, model=model),
    ]
    crops: dict[str, str] = {}
    saved = []
    for question in finals:
        had = len(question.figures)
        saved.append(await placed(question, crops))
        if len(question.figures) < had and question.label not in figures_left_out:
            figures_left_out.append(question.label)
    figures = [question.label for question in finals if question.figures]
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
            # Parts saved with no answer, because their solve call failed or the run
            # stopped first.
            "answersMissing": answers_missing,
            # Questions saved with figures cropped from the page, for the
            # starter to check, and questions saved without theirs: they had
            # no box and the box call for their page failed twice, or their crop
            # failed (Go adds those whose figures did not fit in the starter's
            # storage).
            "figures": figures,
            "figuresLeftOut": figures_left_out,
            "stopped": current.stopped(),
            "pages": len(pages),
            # The copy batches: the name stays for the screens' API.
            "windows": len(batches),
        },
    }


# ------------------------------------------------- the request, from the store


class ConfirmExpired(Exception):
    """The starter did not answer in time."""


async def starter_confirm(run_id: str, found: int) -> int | None:
    """How many questions the starter confirmed, read from the run's row: None when
    they cancelled. ``found`` is what the map found, which the row's answer can't pass."""
    deadline = time.monotonic() + CONFIRM_WAIT_S
    while time.monotonic() < deadline:
        try:
            status, confirmed = await store.extraction_decision(run_id)
        except Exception as exc:  # noqa: BLE001 - a blip mustn't lose the paid map
            log.warning("extraction confirm read failed: %s", exc)
        else:
            if confirmed is not None:
                return min(confirmed, found)
            if status not in ("running", "confirming"):
                return None
        await asyncio.sleep(CONFIRM_POLL_S)
    raise ConfirmExpired


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


def _text_goes(layers: dict[int, str]) -> bool:
    """Whether a PDF's text goes to the model: as for question pages, when no page is a
    scan and one is born digital (Epo 2026-11-05)."""
    return set(layers.values()) - {BLANK} == {BORN_DIGITAL}


def _usable_text(name: str, text: str) -> str:
    """A file's indexed text, refused when it has none."""
    text = text.strip()
    if not text:
        raise ExtractionRefused(
            "no_indexed_text", f"{name} has no indexed text to read from."
        )
    return text


def _whole_text(name: str, passages: list[dict[str, Any]]) -> str:
    return _usable_text(name, "\n\n".join(str(p.get("text") or "") for p in passages))


async def _answer_file(workspace_id: str, file: dict[str, Any]) -> AnswerFile:
    """An answer file's picked pages as they go: indexed text for a born-digital PDF,
    page images for a scan, an image upload or a Word or PowerPoint file the browser
    drew; a text file goes whole (Epo 2026-11-05)."""
    file_id, name, numbers = file["fileId"], file["name"], file["pages"]
    if file.get("images"):
        return AnswerFile(
            name,
            images=tuple(
                (number, functools.partial(_drawn_image, jpeg))
                for number, jpeg in zip(
                    numbers, (base64.b64decode(image) for image in file["images"])
                )
            ),
        )
    row = await store.file_page_source(workspace_id, file_id)
    if row is None:
        raise ExtractionRefused(
            "file_unavailable", f"{name} is no longer in the workspace."
        )
    render = functools.partial(_render, workspace_id, file_id)
    if row.get("kind") == "image":
        return AnswerFile(name, images=((1, functools.partial(render, 1)),))
    passages = await store.file_passages(workspace_id, file_id)
    if row.get("kind") == "pdf":
        try:
            pdf = await capture.pdf_path(workspace_id, file_id)
        except capture.CaptureUnavailable as exc:
            raise ExtractionRefused(exc.code, f"{name}: {exc}.") from exc
        count = await slots.render_thread(_page_count, pdf)
        past = [number for number in numbers if number > count]
        if past:
            raise ExtractionRefused(
                "page_out_of_range",
                f"{name} has {count} pages; page {past[0]} is past its end.",
            )
        indexed = page_texts(passages)
        texts = {number: indexed.get(number, "") for number in numbers}
        layers = await slots.render_thread(page_layers, pdf, texts)
        if _text_goes(layers):
            return AnswerFile(
                name, _usable_text(name, "\n\n".join(texts[n] for n in numbers))
            )
        return AnswerFile(
            name,
            images=tuple(
                (number, functools.partial(render, number))
                for number in numbers
                if layers[number] != BLANK
            ),
        )
    return AnswerFile(name, _whole_text(name, passages))


async def _drawn_image(jpeg: bytes) -> str:
    """Shrunk as any image on its way to a model is (Epo 2026-11-05): the picker already
    draws at this size, and a larger one sent by hand costs no more than a page."""
    small, _box, _size = await slots.render_thread(
        capture.image_jpeg, io.BytesIO(jpeg), None, cfg.capture_max_edge
    )
    return capture.data_url(small)


async def _drawn_crop(jpeg: bytes, box: list[float]) -> tuple[bytes, tuple[int, int]]:
    """A box on a page the browser drew: the page's own pixels, so a figure is only as
    sharp as the page sent."""
    piece, _box, size = await slots.render_thread(
        capture.image_jpeg, io.BytesIO(jpeg), box, cfg.capture_max_edge
    )
    return piece, size


def _drawn_pages(file: dict[str, Any]) -> list[Page]:
    """A Word or PowerPoint paper's selected pages, as the browser drew them (Epo
    2026-11-05, "draw those pages on client side"). They go as a scan's do: their page
    breaks are the browser's, which the indexed text's need not match."""
    return [
        Page(
            number,
            file["name"],
            "",
            functools.partial(_drawn_image, jpeg),
            functools.partial(_drawn_crop, jpeg),
            layer=SCAN,
        )
        for number, jpeg in zip(
            file["pages"], (base64.b64decode(image) for image in file["images"])
        )
    ]


async def prepare(
    workspace_id: str, paper: list[dict[str, Any]], answers: list[dict[str, Any]]
) -> tuple[list[Page], list[AnswerFile]]:
    """The picked pages and the answer files, checked before the run starts: a page
    past its file's end, a file with no usable text, or more text than a run reads is
    refused. Go holds the run to its picked pages."""
    pages: list[Page] = []
    for file in paper:
        if file.get("images"):
            pages.extend(_drawn_pages(file))
            continue
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
            # A text file: its whole indexed text, as one page.
            pages.append(
                Page(
                    1,
                    name,
                    _whole_text(name, await store.file_passages(workspace_id, file_id)),
                    None,
                    None,
                    layer=BORN_DIGITAL,
                )
            )
            continue
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
    files = [await _answer_file(workspace_id, file) for file in answers]
    text = sum(len(file.text) for file in files) + sum(
        len(page.text) for page in pages if not page.image
    )
    if text > RUN_TEXT_CHARS:
        raise ExtractionRefused(
            "too_much_text",
            f"A run reads at most {RUN_TEXT_CHARS:,} characters of text; "
            f"these files hold {text:,}.",
        )
    return pages, files


async def gateway_validate(question: dict[str, Any]) -> str | None:
    """Go's quiz validator on one question: its refusal, or None. A check that fails
    twice ends its thread as a failed call does, so a brief gateway or network failure
    costs that thread and not the paid run; the model is told nothing."""

    async def check() -> str | None:
        try:
            resp = await asyncio.to_thread(
                tools._post_json,
                "/api/internal/questions/check",
                {"question": question},
            )
        except OSError as exc:
            raise elitellm.ProviderError(f"the question check failed: {exc}") from exc
        if resp.status_code != 200:
            raise elitellm.ProviderError(
                f"the question check answered {resp.status_code}"
            )
        return resp.json().get("problem") or None

    return await _attempted(check)
