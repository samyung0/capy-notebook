"""Questions read from the selected pages of an uploaded paper into a quiz
(todo-study-tracking.md §8, Make a quiz).

A fixed pipeline, like /generate, not the chat agent:

1. The outline: the question labels the selected pages' indexed text lists,
   for the completeness check at the end.
2. Page windows of up to two pages, in selected order. Each call sees the two
   page images and their text, the outline, the labels recorded so far and the
   open question (the last one recorded, which may run onto the next page),
   and records questions with ``record_question`` / ``continue_question``.
   Every recorded question goes through the Go validator at once and a
   problem goes back to the model. Questions are kept outside the
   conversation as they come, so the next window carries labels and the open
   question only.
3. The mark scheme and answer files are parsed as text, each on its own and
   never beside the pages, into entries; code pairs them with the questions by
   label and fills keys, marking points and worked solutions.

The printed option order is kept (``add_questions`` shuffles; this does not).
A page's printed key is used when there is one; otherwise the scheme's. A
question with a part left without a key is not saved and is named in the
report, as are expected labels never recorded and a question the validator
refuses once its keys are paired. Figures are boxed by the model
but not cropped this round (``report.figures``). Nothing links a question to
its file, page or region (§8 item 7).
"""

from __future__ import annotations

import asyncio
import copy
import functools
import json
import logging
import re
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

from .. import elitellm
from ..config import cfg
from ..generated import limits
from ..prompts import extraction as prompts
from ..registry import ModelConfig
from . import accounting, capture, models, store, tools
from . import limits as slots
from .workflows import extract_json

log = logging.getLogger("capy.retrieval.extraction")

# Two pages a call (Epo 2026-11-03): small enough that a window stays far under
# any context limit, large enough for a question that runs onto the next page.
WINDOW_PAGES = 2
# Model calls per window: the first records, the rest fix what the validator
# refused.
WINDOW_STEPS = 4
WINDOW_MAX_TOKENS = 16_000
OUTLINE_MAX_TOKENS = 2_000
SCHEME_MAX_TOKENS = 12_000
# Indexed text shown per page, and scheme text per parse call.
PAGE_TEXT_CHARS = 6_000
SCHEME_CHUNK_CHARS = 12_000
# The longest mark scheme or answer file a run reads, about 60 dense pages;
# a longer one is refused rather than cut.
SCHEME_TEXT_CHARS = 200_000

# A run is a background job the user cannot retry piece by piece, so a busy,
# failing or silent provider costs a window or a scheme piece another attempt
# rather than the run (AGENTS.md: background jobs such as parsing and ingest
# retry), as ingest's three calls; a definitive client error does not retry.
ATTEMPTS = 3
ATTEMPT_WAIT_S = 20.0

# Validator stand-ins for keys the scheme fills later, used only for the
# validation call; the stored question never carries them.
_STAND_IN_MARK = "(from the mark scheme)"

Validate = Callable[[dict[str, Any]], Awaitable[str | None]]


@dataclass(frozen=True)
class Page:
    """One selected page: its number in its file, the file's name, the
    page's indexed text, and its image as a data URL, rendered when its window
    runs."""

    number: int
    file_name: str
    text: str
    image: Callable[[], Awaitable[str]]


@dataclass(frozen=True)
class SchemeFile:
    name: str
    text: str


@dataclass
class Recorded:
    """One question as recorded. Keys the page does not print are empty until
    pairing: mcq ``correct``, short ``accepted``, open ``markscheme``."""

    label: str
    question: dict[str, Any]
    part_labels: list[str]
    figures: int = 0
    # The question's printed total, when the page prints only a total.
    total: int | None = None


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


# ------------------------------------------------------- recorded questions


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


def _answer(raw: Any) -> dict[str, Any]:
    """The answer with the page's printed key, or an empty key."""
    raw = raw if isinstance(raw, dict) else {}
    kind = raw.get("type")
    printed = [str(v).strip() for v in raw.get("accepted") or [] if str(v).strip()]
    if kind == "mcq":
        return {
            "type": "mcq",
            "options": [str(v).strip() for v in raw.get("options") or []],
            "correct": [v for v in raw.get("correct") or [] if type(v) is int],
        }
    if kind == "short":
        answer: dict[str, Any] = {"type": "short", "accepted": printed}
        if str(raw.get("unit") or "").strip():
            answer["unit"] = str(raw["unit"]).strip()
        return answer
    if kind == "open":
        return {"type": "open", "accepted": printed[:1], "hints": []}
    return {"type": kind}


def _part(raw: Any) -> tuple[str, dict[str, Any]]:
    raw = raw if isinstance(raw, dict) else {}
    answer = _answer(raw.get("answer"))
    part: dict[str, Any] = {
        "id": str(uuid.uuid4()),
        "blocks": _blocks(raw.get("blocks")),
        "answer": answer,
        "marks": raw.get("marks"),
        "solution": [],
    }
    if answer["type"] == "open":
        part["markscheme"] = []
    return str(raw.get("label") or ""), part


def record(item: Any) -> Recorded:
    """A ``record_question`` item as a quiz question in paper layout."""
    item = item if isinstance(item, dict) else {}
    parsed = [_part(p) for p in item.get("parts") or []]
    labels = [label for label, _ in parsed]
    first = next((label for label in labels if label), "")
    return Recorded(
        label=str(item.get("label") or "").strip(),
        question={
            "id": str(uuid.uuid4()),
            "stem": _blocks(item.get("stem")),
            "parts": [part for _, part in parsed],
            "layout": "paper",
            "labels": "numbers" if first[:1].isdigit() else "letters",
        },
        part_labels=labels,
        figures=len(item.get("figures") or []),
        total=_whole(item.get("total_marks")),
    )


def _stand_ins(question: dict[str, Any]) -> dict[str, Any]:
    """The question with every empty key filled, so the validator checks
    everything but the keys pairing fills."""
    checked = copy.deepcopy(question)
    for part in checked["parts"]:
        answer = part["answer"]
        if answer.get("type") == "mcq" and not answer.get("correct"):
            answer["correct"] = [0]
        elif answer.get("type") == "short" and not answer.get("accepted"):
            answer["accepted"] = ["1"]
        elif answer.get("type") == "open" and not part.get("markscheme"):
            marks = part.get("marks")
            part["markscheme"] = [{"text": _STAND_IN_MARK, "marks": marks}]
    return checked


def keyless(question: dict[str, Any]) -> bool:
    for part in question["parts"]:
        answer = part["answer"]
        if (
            (answer["type"] == "mcq" and not answer["correct"])
            or (answer["type"] == "short" and not answer["accepted"])
            or (answer["type"] == "open" and not part["markscheme"])
        ):
            return True
    return False


def _counts(question: dict[str, Any]) -> tuple[int, int]:
    parts = question["parts"]
    return len(parts), sum(1 for p in parts if p["answer"].get("type") == "open")


# ------------------------------------------------------------------ pairing


def _text(value: Any, limit: int) -> str:
    return str(value or "").strip()[:limit].strip()


def _whole(value: Any) -> int | None:
    """A mark count the model wrote as 2, 2.0 or "2"."""
    if isinstance(value, str) and value.strip().isdigit():
        value = int(value.strip())
    if isinstance(value, float) and value.is_integer():
        value = int(value)
    return value if type(value) is int else None


def entries_from(data: Any) -> list[Entry]:
    entries: list[Entry] = []
    rows = data.get("entries") if isinstance(data, dict) else None
    for row in rows if isinstance(rows, list) else []:
        if not isinstance(row, dict) or not str(row.get("question") or "").strip():
            continue
        points = []
        for point in row.get("points") or []:
            if not isinstance(point, dict):
                continue
            marks, text = _whole(point.get("marks")), _text(point.get("text"), 1_000)
            if marks is not None and marks >= 1 and text:
                points.append({"text": text, "marks": marks})
        entries.append(
            Entry(
                question=str(row["question"]).strip(),
                part=str(row.get("part") or "").strip(),
                answer=_text(row.get("answer"), limits.QUIZ_OPEN_ANSWER_MAX),
                points=points,
                solution=_text(row.get("solution"), limits.QUESTION_TEXT_MAX),
            )
        )
    return entries


def _merged(entries: list[Entry]) -> dict[tuple[str, str], Entry]:
    """Entries by label; one split across scheme chunks becomes one."""
    out: dict[tuple[str, str], Entry] = {}
    for entry in entries:
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
            continue
        held.answer = held.answer or entry.answer
        held.points.extend(entry.points)
        held.solution = "\n".join(s for s in (held.solution, entry.solution) if s)
    return out


def _letters(answer: str, count: int) -> list[int]:
    found = re.findall(r"(?<![A-Za-z])([A-H])(?![A-Za-z])", answer.upper())
    indexes = sorted({ord(letter) - ord("A") for letter in found})
    return indexes if indexes and indexes[-1] < count else []


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


def _entry_for(
    entries: dict[tuple[str, str], Entry], label: str, part_label: str, single: bool
) -> Entry | None:
    question = label_key(label)
    found = entries.get((question, label_key(part_label)))
    if found is None and single:
        found = entries.get((question, ""))
    return found


def pair(recorded: Recorded, entries: dict[tuple[str, str], Entry]) -> bool:
    """Fill the question's empty keys, marking points and worked solutions from
    its scheme entries. True when an entry matched any part."""
    matched = False
    single = len(recorded.part_labels) == 1
    for part_label, part in zip(recorded.part_labels, recorded.question["parts"]):
        entry = _entry_for(entries, recorded.label, part_label, single)
        if entry is None:
            continue
        matched = True
        answer = part["answer"]
        if answer["type"] == "mcq" and not answer["correct"]:
            answer["correct"] = _letters(entry.answer, len(answer["options"]))
        elif answer["type"] == "short" and not answer["accepted"] and entry.answer:
            value = entry.answer
            unit = answer.get("unit", "")
            if unit and value.endswith(unit):
                value = value[: -len(unit)].strip()
            answer["accepted"] = [value[: limits.QUESTION_TEXT_MAX]]
        elif answer["type"] == "open" and not part["markscheme"] and entry.points:
            items = _items(entry.points)
            marks = sum(item["marks"] for item in items)
            if marks <= limits.QUESTION_MARKS_MAX:
                part["markscheme"], part["marks"] = items, marks
                if entry.answer and not answer["accepted"]:
                    answer["accepted"] = [entry.answer]
        if entry.solution and not part["solution"]:
            part["solution"] = [{"type": "text", "text": entry.solution}]
    return matched


# --------------------------------------------------------------- the run


@dataclass
class Run:
    """What one extraction holds between windows."""

    validate: Validate
    expected: list[str] = field(default_factory=list)
    recorded: dict[str, Recorded] = field(default_factory=dict)
    # Printed order: a label's place is its first record attempt, so a
    # question refused once and recorded after its neighbours keeps its place.
    order: dict[str, int] = field(default_factory=dict)
    open_label: str | None = None
    full: bool = False

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

    async def add(self, item: Any, window: set[str]) -> str:
        """Record one question; the tool result line for it."""
        new = record(item)
        if not new.label or not new.question["parts"]:
            return "A question needs its printed label and at least one part."
        key = label_key(new.label)
        self.order.setdefault(key, len(self.order))
        held = self.recorded.get(key)
        if (
            held is not None
            and key not in window
            and key != label_key(self.open_label or "")
        ):
            return (
                f"Question {new.label}: a question with this label was recorded from "
                "earlier pages. If this is another question with the same number, "
                "put its section in the label (B3)."
            )
        problem = await self.validate(_stand_ins(new.question))
        if problem:
            return f"Question {new.label}: {problem}. Fix it and record it again."
        parts, opened = self.counts(leaving_out=key)
        p, o = _counts(new.question)
        if parts + p > limits.QUIZ_PARTS_MAX or opened + o > limits.QUIZ_OPEN_PARTS_MAX:
            self.full = True
            return (
                f"Question {new.label} was not recorded: a quiz holds at most "
                f"{limits.QUIZ_PARTS_MAX} parts and {limits.QUIZ_OPEN_PARTS_MAX} open "
                "parts. Record nothing more."
            )
        if held is not None:
            new.question["id"] = held.question["id"]
        self.recorded[key] = new
        window.add(key)
        return f"Question {new.label}: recorded."

    async def extend(self, args: dict[str, Any], window: set[str]) -> str:
        label = str(args.get("label") or "")
        key = label_key(label)
        if self.open_label is None or key != label_key(self.open_label):
            return (
                f"Question {label} is not the open question; record a new question "
                "with record_question."
            )
        held = self.recorded[key]
        merged = copy.deepcopy(held)
        more = _blocks(args.get("blocks"))
        if more:
            merged.question["parts"][-1]["blocks"].extend(more)
        for raw in args.get("parts") or []:
            part_label, part = _part(raw)
            merged.question["parts"].append(part)
            merged.part_labels.append(part_label)
        merged.figures += len(args.get("figures") or [])
        problem = await self.validate(_stand_ins(merged.question))
        if problem:
            return f"Question {label}: {problem}. Fix it and continue it again."
        parts, opened = self.counts(leaving_out=key)
        p, o = _counts(merged.question)
        if parts + p > limits.QUIZ_PARTS_MAX or opened + o > limits.QUIZ_OPEN_PARTS_MAX:
            self.full = True
            return "The quiz is full: record nothing more."
        self.recorded[key] = merged
        window.add(key)
        return f"Question {label}: continued."

    def open_question(self) -> dict[str, Any] | None:
        """The open question as the next window shows it."""
        if self.open_label is None:
            return None
        held = self.recorded[label_key(self.open_label)]
        return {
            "label": held.label,
            "parts": [
                {"label": label, "blocks": part["blocks"]}
                for label, part in zip(held.part_labels, held.question["parts"])
            ],
        }

    def labels(self) -> list[str]:
        return [held.label for held in self.held()]


async def outline(pages: list[Page], *, model: ModelConfig) -> list[str]:
    """Expected question labels from the pages' indexed text; none without text."""
    texts = [
        (prompts.page_heading(p.number, p.file_name), p.text[:PAGE_TEXT_CHARS])
        for p in pages
        if p.text.strip()
    ]
    if not texts:
        return []
    message = await models.complete(
        prompts.outline_messages(texts),
        model=model,
        response_format={"type": "json_object"},
        max_tokens=OUTLINE_MAX_TOKENS,
        reasoning=False,
        call_purpose="extraction_outline",
    )
    data = extract_json(getattr(message, "content", "") or "")
    found = data.get("questions") if isinstance(data, dict) else None
    labels: list[str] = []
    for label in found if isinstance(found, list) else []:
        text = str(label).strip()
        if text and label_key(text) not in {label_key(seen) for seen in labels}:
            labels.append(text)
    return labels


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


async def parse_schemes(files: list[SchemeFile], *, model: ModelConfig) -> list[Entry]:
    """Every scheme or answer file's entries, one parse call per text piece."""

    async def one(name: str, text: str) -> list[Entry]:
        message = await models.complete(
            prompts.scheme_messages(name, text),
            model=model,
            response_format={"type": "json_object"},
            max_tokens=SCHEME_MAX_TOKENS,
            reasoning=False,
            call_purpose="extraction_scheme",
        )
        return entries_from(extract_json(getattr(message, "content", "") or ""))

    calls = [
        _attempted(functools.partial(one, f.name, piece))
        for f in files
        for piece in _chunks(f.text)
    ]
    return [entry for found in await asyncio.gather(*calls) for entry in found]


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


def _call_args(call: dict[str, Any]) -> tuple[str, dict[str, Any] | None]:
    function = call.get("function") or {}
    try:
        args = json.loads(function.get("arguments") or "{}")
    except json.JSONDecodeError:
        args = None
    return str(function.get("name") or ""), args if isinstance(args, dict) else None


async def _window(run: Run, pages: list[Page], *, model: ModelConfig) -> None:
    intro = prompts.window_intro(
        expected=run.expected, recorded=run.labels(), open_question=run.open_question()
    )
    messages = prompts.window_messages(
        intro,
        [
            (
                prompts.page_text(p.number, p.file_name, p.text[:PAGE_TEXT_CHARS]),
                await p.image(),
            )
            for p in pages
        ],
    )
    window: set[str] = set()
    for _ in range(WINDOW_STEPS):
        reply = elitellm.assistant_message_from_obj(
            await models.complete(
                messages,
                model=model,
                tools=prompts.TOOLS,
                max_tokens=WINDOW_MAX_TOKENS,
                call_purpose="extraction_window",
            )
        )
        calls = reply.get("tool_calls") or []
        if not calls:
            break
        messages.append(reply)
        for call in calls:
            name, args = _call_args(call)
            if args is None:
                result = "The arguments were not valid JSON; send the call again."
            elif name == "record_question":
                lines = [
                    await run.add(item, window) for item in args.get("questions") or []
                ]
                result = "\n".join(lines) or "No questions were given."
            elif name == "continue_question":
                result = await run.extend(args, window)
            else:
                result = f"There is no tool {name}."
            messages.append(
                {"role": "tool", "tool_call_id": call.get("id"), "content": result}
            )
        if run.full:
            break
    # The last question recorded in this window may run onto the next page.
    recorded_here = [
        held.label for held in run.held() if label_key(held.label) in window
    ]
    if recorded_here:
        run.open_label = recorded_here[-1]


def _credits_out() -> bool:
    state = accounting.current()
    return bool(state and state.credits_exhausted)


async def run(
    pages: list[Page],
    schemes: list[SchemeFile],
    *,
    model: ModelConfig,
    validate: Validate,
) -> AsyncIterator[dict[str, Any]]:
    """Events: ``questions`` after each window (every question recorded so
    far, before pairing), then ``done`` with the quiz's questions and the
    report. The scheme parse runs beside the windows."""
    scheme_task = (
        asyncio.create_task(parse_schemes(schemes, model=model)) if schemes else None
    )
    try:
        current = Run(validate=validate)
        current.expected = await _attempted(
            functools.partial(outline, pages, model=model)
        )
        stopped = ""
        windows = 0
        for start in range(0, len(pages), WINDOW_PAGES):
            if _credits_out():
                stopped = "credits"
                break
            # A retried window records again over what it recorded before.
            await _attempted(
                functools.partial(
                    _window, current, pages[start : start + WINDOW_PAGES], model=model
                )
            )
            windows += 1
            yield {
                "type": "questions",
                "questions": [held.question for held in current.held()],
            }
            if current.full:
                stopped = "quiz_full"
                break
        entries = _merged(await scheme_task) if scheme_task is not None else {}
    finally:
        if scheme_task is not None and not scheme_task.done():
            scheme_task.cancel()
        elif scheme_task is not None and not scheme_task.cancelled():
            # Retrieved, so a window's failure is the one reported.
            scheme_task.exception()
    used: set[tuple[str, str]] = set()
    saved: list[dict[str, Any]] = []
    unanswered: list[str] = []
    invalid: list[str] = []
    marks_differ: list[str] = []
    figures: list[str] = []
    for held in current.held():
        if pair(held, entries):
            question = label_key(held.label)
            used.update(key for key in entries if key[0] == question)
        if keyless(held.question):
            unanswered.append(held.label)
            continue
        # The paired keys are checked as the quiz's creation will check them;
        # a refusal leaves that question out rather than the whole quiz.
        if await validate(held.question):
            invalid.append(held.label)
            continue
        saved.append(held.question)
        parts_total = sum(part["marks"] for part in held.question["parts"])
        if held.total is not None and parts_total != held.total:
            marks_differ.append(held.label)
        if held.figures:
            figures.append(held.label)
    recorded = {label_key(label) for label in current.labels()}
    yield {
        "type": "done",
        "questions": saved,
        "report": {
            "expected": current.expected,
            "missing": [
                label for label in current.expected if label_key(label) not in recorded
            ],
            "recorded": current.labels(),
            "unanswered": unanswered,
            "invalid": invalid,
            # Saved questions whose part marks, as paired, do not add up to
            # the total printed on the page.
            "marksDiffer": marks_differ,
            "unpaired": sorted(
                {entries[key].question for key in entries if key not in used},
                key=lambda label: (len(label), label),
            ),
            # Figures were boxed but not cropped this round: these questions
            # are saved without them.
            "figures": figures,
            "stopped": stopped,
            "pages": len(pages),
            "windows": windows,
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


def _page_count(pdf: Any) -> int:
    import pymupdf

    with pymupdf.open(pdf) as doc:
        return len(doc)


async def _render(workspace_id: str, file_id: str, number: int) -> str:
    jpeg, _box, _size = await capture.render_file(
        workspace_id, file_id, number, None, cfg.capture_max_edge
    )
    return capture.data_url(jpeg)


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
        texts = page_texts(await store.file_passages(workspace_id, file_id))
        pages.extend(
            Page(
                number,
                name,
                texts.get(number, ""),
                functools.partial(_render, workspace_id, file_id, number),
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
