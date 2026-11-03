"""Questions read from the selected pages of an uploaded paper into a quiz
(todo-study-tracking.md §8, Make a quiz).

A fixed pipeline, like /generate, not the chat agent:

1. The outline: the question labels the selected pages' indexed text lists,
   for the completeness check at the end.
2. Page windows of up to two pages, in selected order. Each call sees the two
   page images and their text, the outline, the labels recorded so far and the
   open question (the last one recorded, which may run onto the next page),
   and records questions with ``record_question`` / ``continue_question``,
   each part with its answer key, marking points for an open part and a short
   worked solution: copied when the page prints them, otherwise worked out
   (Epo 2026-11-03). Every recorded question goes through the Go validator at
   once and a problem goes back to the model. Questions are kept outside the
   conversation as they come, so the next window carries labels and the open
   question only.
3. The mark scheme and answer files are parsed as text, each on its own and
   never beside the pages, after the windows, with the recorded questions'
   labels to name entries by. Code pairs them with the questions by label:
   their keys, marking points and solutions replace worked-out ones, a printed
   key stays, and any disagreement is named in the report.

The printed option order is kept (``add_questions`` shuffles; this does not).
No question is left out for want of a key. A worked-out solution carries an
"AI-written" label. Figures are boxed by the model but not cropped yet
(``report.figures``). Nothing links a question to its file, page or region
(§8 item 7).
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
from ..prompts.locale import normalize_locale
from ..registry import ModelConfig
from . import accounting, capture, models, store, tools
from . import limits as slots
from .workflows import extract_json

log = logging.getLogger("capy.retrieval.extraction")

# Two pages a call (Epo 2026-11-03): small enough that a window stays far under
# any context limit, large enough for a question that runs onto the next page.
WINDOW_PAGES = 2
# Model calls per window: the first records (one record_question call a
# question), the rest send again what the validator refused or what was not
# valid JSON, or what a reply cut off at the output cap left out.
WINDOW_STEPS = 6
# Thinking at medium works answers out as well as copying (Epo 2026-11-03).
WINDOW_MAX_TOKENS = 24_000
OUTLINE_MAX_TOKENS = 2_000
SCHEME_MAX_TOKENS = 12_000
# Indexed text shown per page, and scheme text per parse call.
PAGE_TEXT_CHARS = 6_000
SCHEME_CHUNK_CHARS = 12_000
# The longest mark scheme or answer file a run reads, about 60 dense pages;
# a longer one is refused rather than cut.
SCHEME_TEXT_CHARS = 200_000

# A busy, failing or silent provider costs a step one silent retry (Epo
# 2026-11-03): the outline, a window or a scheme piece runs once more before
# the run fails. A definitive client error does not retry.
ATTEMPTS = 2
ATTEMPT_WAIT_S = 20.0

PRINTED, WORKED_OUT, SCHEME = "printed", "worked_out", "scheme"
# The label a worked-out solution carries in the saved quiz, in the starter's
# language (QuestionView draws a text block's label before its text).
AI_WRITTEN = {"en": "AI-written", "zh": "AI 撰写"}

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
    """One question as recorded, every part with its key, and where each
    part's key came from: printed, worked_out, or scheme once paired."""

    label: str
    question: dict[str, Any]
    part_labels: list[str]
    sources: list[str]
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
    part: dict[str, Any] = {
        "id": str(uuid.uuid4()),
        "blocks": _blocks(raw.get("blocks")),
        "answer": answer,
        "marks": raw.get("marks"),
        "solution": _solution(
            _text(raw.get("solution"), limits.QUESTION_TEXT_MAX), source, ai_label
        ),
    }
    if answer["type"] == "open":
        part["markscheme"] = items
    return str(raw.get("label") or ""), source, part


def record(item: Any, ai_label: str) -> Recorded:
    """A ``record_question`` item as a quiz question in paper layout."""
    item = item if isinstance(item, dict) else {}
    parsed = [_part(p, ai_label) for p in item.get("parts") or []]
    labels = [label for label, _, _ in parsed]
    first = next((label for label in labels if label), "")
    return Recorded(
        label=str(item.get("label") or "").strip(),
        question={
            "id": str(uuid.uuid4()),
            "stem": _blocks(item.get("stem")),
            "parts": [part for _, _, part in parsed],
            "layout": "paper",
            "labels": "numbers" if first[:1].isdigit() else "letters",
        },
        part_labels=labels,
        sources=[source for _, source, _ in parsed],
        figures=len(item.get("figures") or []),
        total=_whole(item.get("total_marks")),
    )


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
    """What one extraction holds between windows."""

    validate: Validate
    ai_label: str
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

    def _fits(self, key: str, question: dict[str, Any]) -> bool:
        parts, opened = self.counts(leaving_out=key)
        p, o = _counts(question)
        return (
            parts + p <= limits.QUIZ_PARTS_MAX
            and opened + o <= limits.QUIZ_OPEN_PARTS_MAX
        )

    async def add(self, item: Any, window: set[str]) -> str:
        """Record one question; the tool result line for it."""
        new = record(item, self.ai_label)
        if not new.label or not new.question["parts"]:
            return (
                "A question needs its printed label and at least one part, given "
                "as the call's arguments themselves."
            )
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
        problem = _unsourced(new) or await self.validate(new.question)
        if problem:
            return f"Question {new.label}: {problem}. Fix it and record it again."
        if not self._fits(key, new.question):
            self.full = True
            return (
                f"Question {new.label} was not recorded: a quiz holds at most "
                f"{limits.QUIZ_PARTS_MAX} parts and {limits.QUIZ_OPEN_PARTS_MAX} "
                "AI-marked parts. Record nothing more."
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
        merged = copy.deepcopy(self.recorded[key])
        more = _blocks(args.get("blocks"))
        if more:
            merged.question["parts"][-1]["blocks"].extend(more)
        for raw in args.get("parts") or []:
            part_label, source, part = _part(raw, self.ai_label)
            merged.question["parts"].append(part)
            merged.part_labels.append(part_label)
            merged.sources.append(source)
        merged.figures += len(args.get("figures") or [])
        problem = _unsourced(merged) or await self.validate(merged.question)
        if problem:
            return f"Question {label}: {problem}. Fix it and continue it again."
        if not self._fits(key, merged.question):
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


async def parse_schemes(
    files: list[SchemeFile],
    *,
    model: ModelConfig,
    labels: list[tuple[str, list[str]]],
) -> list[Entry]:
    """Every scheme or answer file's entries, one parse call per text piece.
    ``labels`` are the recorded questions' labels with their part labels, so
    entries are named as the questions are (Epo 2026-11-03: 2024 Q3(b) was
    read as b(ii))."""

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
        response = await models.complete_response(
            messages,
            model=model,
            tools=prompts.TOOLS,
            max_tokens=WINDOW_MAX_TOKENS,
            call_purpose="extraction_window",
        )
        if response.choices[0].finish_reason == "length":
            # Cut off at the output cap, its calls unfinished (the bench lost
            # two windows of a paper this way): ask again for smaller calls.
            messages.append({"role": "user", "content": prompts.CUT_OFF})
            continue
        reply = elitellm.assistant_message_from_obj(
            elitellm.message_from_response(response)
        )
        calls = reply.get("tool_calls") or []
        if not calls:
            break
        messages.append(reply)
        for call in calls:
            name, args = _call_args(call)
            if isinstance(args, str):
                result = args
            elif name == "record_question":
                result = await run.add(args, window)
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
    locale: str | None,
) -> AsyncIterator[dict[str, Any]]:
    """Events: ``questions`` after each window (every question recorded so
    far, before pairing), then ``done`` with the quiz's questions and the
    report."""
    current = Run(validate=validate, ai_label=AI_WRITTEN[normalize_locale(locale)])
    current.expected = await _attempted(functools.partial(outline, pages, model=model))
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
    held = current.held()
    entries = (
        _merged(
            await parse_schemes(
                schemes,
                model=model,
                labels=[(h.label, h.part_labels) for h in held],
            )
        )
        if schemes and held
        else {}
    )
    used: set[tuple[str, str]] = set()
    saved: list[dict[str, Any]] = []
    worked_out: list[str] = []
    disagreements: list[str] = []
    refused: list[str] = []
    marks_differ: list[str] = []
    figures: list[str] = []
    for question in held:
        paired = pair(question, entries)
        if paired.matched:
            key = label_key(question.label)
            used.update(k for k in entries if k[0] == key)
            disagreements.extend(paired.disagreed)
            # The scheme's version is checked as the quiz's creation will
            # check it; a refusal keeps the page's keys rather than losing the
            # question.
            if await validate(paired.held.question):
                refused.append(question.label)
            else:
                question = paired.held
        saved.append(question.question)
        if WORKED_OUT in question.sources:
            worked_out.append(question.label)
        parts_total = sum(part["marks"] for part in question.question["parts"])
        if question.total is not None and parts_total != question.total:
            marks_differ.append(question.label)
        if question.figures:
            figures.append(question.label)
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
            # Figures are boxed but not cropped yet: these questions are saved
            # without them.
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
