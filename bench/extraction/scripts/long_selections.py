"""Make a quiz over a selection longer than the 40-page cap: one map over everything
against maps in page windows (Epo's question, 2026-11-21). Report:
``reports/2026-11-21-long-selections.md``.

    python -I long_selections.py gold
    python -I long_selections.py run --env-file deploy/.env.uat --arms one:2 w20:2 w10:2 \
        --hard-stop 4.5
    python -I long_selections.py score

The selection is a textbook a learner would pick: Advanced Waterworks Mathematics (CC BY
4.0, committed for the parser bench), units 1 to 4, question pages 6 to 115 with their
explanations, worked examples, 11 practice sets and 11 exercise sets that all number
from 1, and the book's own practice solutions, pages 285 to 313, as the answer file. The
book is born digital, so the pages go with their text layer and the answers as text, as
production sends them.

Every arm runs the production ``extraction.run``. ``one`` sends the whole selection.
``wN`` cuts the question pages into windows of N and runs ``extraction.run`` once a
window, all at once, on the window's pages plus the page before and the page after;
code keeps the map rows whose first page is the window's own, so a question that runs
over the edge is copied whole by the window it starts in, and copy repairs look only at
own pages. Every window gets the whole answer file. Copy and solve calls share one gate
of ``BATCHES_AT_ONCE`` across the windows, as one run's batches do; the maps go at once.
The merged quiz keeps each window's questions apart, so the score sees label collisions
a merge would have to resolve instead of losing them.

``--exams DATA`` runs the same arms on scans instead: six scanned HKDSE mathematics
papers picked in one run (67 pages, 165 questions, every paper numbering from 1) with
three scanned marking schemes and one key file, from the ignored data folder. A scan's
page read is its indexed text, as at ingest; arms ending in ``i`` send the marking
schemes as page images (production's for a scan), the others as their page reads.

Patched for the bench only: no layout service (no boxes, so every figure takes the box
call, production's path when the service is down), the quiz's part caps lifted so the
extraction itself is measured past them, a nonce on the system prompt so no run reads
another's cache, and the window rules above. Results stay in the ignored
``.results/long/``. Keys go into the process only and are never printed.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import collections
import contextvars
import dataclasses
import functools
import json
import re
import resource
import secrets
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from types import SimpleNamespace

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import run as bench  # noqa: E402

OUT = bench.RESULTS / "long"
BOOK = bench.ROOT / "bench/parsers/fixtures/budget/waterworks-math.pdf"
QUESTION_PAGES = list(range(6, 116))
ANSWER_PAGES = list(range(285, 314))
SET_HEADING = re.compile(r"^(Practice Problems|Exercise)\s+(\d+\.\d+[a-z]?)\b")
ITEM = re.compile(r"^(\d{1,2})\.\s+\S")
PART = re.compile(r"^([a-h])\.\s+\S")
NUMBER = re.compile(r"\d[\d,]*(?:\.\d+)?|\.\d+")
# Conversion factors the solutions write out: a model answer quoting one says nothing.
CONSTANTS = {
    1.0,
    7.48,
    8.34,
    62.4,
    1.547,
    0.646,
    325851.0,
    43560.0,
    3.14,
    0.785,
    60.0,
    24.0,
    1440.0,
    3600.0,
    86400.0,
    694.0,
    2.31,
    0.433,
    12.0,
    5280.0,
}


# Read off the solution pages by hand where the number rule can't see the key: a
# final answer that is a small whole number, and a multiple-choice part (b).
FINAL = {("P2.4", 5): [12.0]}
MCQ_KEY = {("P2.3", 8): [1]}
# Its (a) and (b) are options, not parts.
NOT_PARTS = {("P2.3", 8)}


# ------------------------------------------------------------------ gold


def _texts(pages: list[int]) -> dict[int, str]:
    import pymupdf

    with pymupdf.open(BOOK) as doc:
        return {n: doc[n - 1].get_text() for n in pages}


def _lines(text: str) -> list[str]:
    # The text layer opens with the page footer ("9 | A d v a n c e d ...").
    return [
        line.strip()
        for line in text.splitlines()
        if line.strip() and not re.match(r"^\d+ \| A d v a n c e d", line.strip())
    ]


def _plain_math(text: str) -> str:
    """LaTeX thousands separators and spaces as plain text: 1{,}000 is 1,000."""
    return re.sub(r"\\[,;! ]", "", text.replace("{,}", ","))


def _numbers(text: str) -> set[float]:
    out = set()
    for raw in NUMBER.findall(_plain_math(text)):
        try:
            out.add(float(raw.replace(",", "")))
        except ValueError:
            continue
    return out


def _figure_items(doc, number: int, items: list[dict]) -> set[int]:
    """Indexes of the page's items that a picture follows: the item whose number
    is the last above the picture's top."""
    page = doc[number - 1]
    tops = []
    for block in page.get_text("dict")["blocks"]:
        for line in block.get("lines", []):
            text = "".join(span["text"] for span in line["spans"]).strip()
            if ITEM.match(text):
                tops.append((line["bbox"][1], int(ITEM.match(text).group(1))))
    out = set()
    for info in page.get_image_info():
        top = info["bbox"][1]
        above = [n for y, n in tops if y <= top]
        if above:
            for i, item in enumerate(items):
                if item["page"] == number and item["n"] == above[-1]:
                    out.add(i)
    return out


def gold() -> dict:
    """The selection's questions from the book's text layer: each set's numbered
    items with the page each starts on, part letters, whether a picture follows it,
    and for practice items the numbers their printed solution works out."""
    import pymupdf

    texts = _texts(QUESTION_PAGES)
    items: list[dict] = []
    current, shows = None, False
    for number in QUESTION_PAGES:
        for line in _lines(texts[number]):
            heading = SET_HEADING.match(line)
            if heading:
                current = f"{'P' if heading[1].startswith('P') else 'E'}{heading[2]}"
                shows = False
                continue
            if current and not items_in(items, current) and line.startswith("Show"):
                shows = True
            if line.startswith("Example") or line.startswith("UNIT"):
                current = None
                continue
            if current is None:
                continue
            item = ITEM.match(line)
            if item:
                items.append(
                    {
                        "set": current,
                        "n": int(item[1]),
                        "page": number,
                        "parts": [],
                        "text": line,
                        "figure": False,
                        "shows": shows,
                    }
                )
                continue
            part = PART.match(line)
            if part and items and items[-1]["set"] == current:
                items[-1]["parts"].append(part[1])
            # An item's text: its own page, cut short where a set's last item
            # runs into the next section's prose.
            last = items[-1] if items else None
            if (
                last
                and last["set"] == current
                and number == last["page"]
                and not re.match(r"^\d+\.\d+\s+[A-Z]", line)
                and len(last["text"]) < 700
            ):
                last["text"] += " " + line
    for item in items:
        if (item["set"], item["n"]) in NOT_PARTS:
            item["parts"] = []
    with pymupdf.open(BOOK) as doc:
        for number in QUESTION_PAGES:
            for i in _figure_items(doc, number, items):
                items[i]["figure"] = True
    # Solutions: per practice set, per item, the numbers the working adds.
    answers = _texts(ANSWER_PAGES)
    blocks: dict[tuple[str, int], str] = {}
    current, n = None, None
    for number in ANSWER_PAGES:
        for line in _lines(answers[number]):
            heading = SET_HEADING.match(line)
            if heading:
                current, n = f"P{heading[2]}", None
                continue
            item = ITEM.match(line)
            if current and item and int(item[1]) == (n or 0) + 1:
                n = int(item[1])
            if current and n:
                key = (current, n)
                blocks[key] = blocks.get(key, "") + " " + line
    for item in items:
        block = blocks.get((item["set"], item["n"]))
        if block is None:
            continue
        # A "show how" item's answer is the value it already prints.
        item["solution"] = sorted(
            _numbers(item["text"])
            if item["shows"]
            else _numbers(block) - _numbers(item["text"]) - CONSTANTS
        )
    return {"items": items}


def items_in(items: list[dict], name: str) -> bool:
    return any(i["set"] == name for i in items)


def show_gold() -> None:
    g = gold()
    by_set = collections.defaultdict(list)
    for item in g["items"]:
        by_set[item["set"]].append(item)
    for name, items in by_set.items():
        print(
            name,
            len(items),
            [
                f"{i['n']}@{i['page']}{''.join(i['parts'])}{'*' if i['figure'] else ''}"
                f"{'' if 'solution' not in i else '+' + str(len(i['solution']))}"
                for i in items
            ],
        )
    items = g["items"]
    print(
        f"{len(items)} items, {sum(i['set'][0] == 'P' for i in items)} practice, "
        f"{sum('solution' in i for i in items)} with a solution, "
        f"{sum(max(1, len(i['parts'])) for i in items)} parts, "
        f"{sum(i['figure'] for i in items)} with a figure"
    )


# ------------------------------------------------------------------ runs


@dataclass
class Window:
    index: int
    # Its own pages as (file name, page number): papers in one selection share numbers.
    own: set[tuple[str, int]]
    # The chunk arm's group: the chunk map's lines for its questions, which
    # stand in for the map call's reply.
    replay: str | None = None


def page_key(page) -> tuple[str, int]:
    return page.file_name, page.number


def resolve(rows, pages) -> list[tuple[int, int] | None]:
    """Each map row's first and last page, as indexes into ``pages``. A row gives only
    page numbers, which several files share, so a row's first page is the next page
    with its number at or after the previous row's, as the map lists in order."""
    out, cursor = [], 0
    for row in rows:
        at = next(
            (i for i in range(cursor, len(pages)) if pages[i].number == row.first),
            None,
        )
        if at is None:
            at = next((i for i, p in enumerate(pages) if p.number == row.first), None)
        if at is None:
            out.append(None)
            continue
        end = next(
            (
                i
                for i in range(at, len(pages))
                if pages[i].file_name == pages[at].file_name
                and pages[i].number == row.last
            ),
            at,
        )
        out.append((at, end))
        cursor = at
    return out


@dataclass
class State:
    nonce: str
    gate: asyncio.Semaphore
    started: float
    calls: list[dict] = field(default_factory=list)
    maps: list[dict] = field(default_factory=list)
    in_flight: int = 0
    peak: int = 0
    bytes_in_flight: int = 0
    peak_bytes: int = 0


STATE: contextvars.ContextVar[State] = contextvars.ContextVar("long_run")
WINDOW: contextvars.ContextVar[Window | None] = contextvars.ContextVar(
    "long_window", default=None
)
PURPOSE: contextvars.ContextVar[str] = contextvars.ContextVar(
    "long_purpose", default=""
)
LIVE = {"usd": 0.0, "stop": 4.5}
GATED = ("extraction_copy", "extraction_solve")


class SpendStop(Exception):
    pass


def install() -> None:
    from pipeline.elitellm import client
    from pipeline.generated import limits
    from pipeline.prompts import extraction as prompts
    from pipeline.retrieval import extraction, models

    # Measure the extraction past the quiz's part caps; the score applies them.
    limits.QUIZ_PARTS_MAX = limits.QUIZ_OPEN_PARTS_MAX = 100_000
    # The arms are the routes this bench compared, so production's own long route
    # (built from them, Epo 2026-11-21) stays off.
    extraction.THREAD_IMAGES = 100_000

    production_messages = prompts.map_messages

    def map_messages(pages, boxes, answers, *, system):
        messages = production_messages(pages, boxes, answers, system=system)
        messages[0]["content"] = f"Run {STATE.get().nonce}.\n{messages[0]['content']}"
        return messages

    prompts.map_messages = map_messages

    production_map = extraction.read_map

    async def read_map(pages, answers, boxes, *, model):
        messages, rows, output = await production_map(
            pages, answers, boxes, model=model
        )
        window = WINDOW.get()
        spans = resolve(rows, pages)
        kept = (
            rows
            if window is None
            else [
                r
                for r, span in zip(rows, spans)
                if span and page_key(pages[span[0]]) in window.own
            ]
        )
        STATE.get().maps.append(
            {
                "window": None if window is None else window.index,
                "replay": bool(window and window.replay is not None),
                "seconds": round(time.monotonic() - STATE.get().started, 1),
                "rows": [[r.label, r.first, r.last, r.parts, r.figures] for r in rows],
                "files": [span and pages[span[0]].file_name for span in spans],
                "kept": [r.label for r in kept],
            }
        )
        return messages, kept, output

    extraction.read_map = read_map

    production_uncopied = extraction.Run.uncopied

    def uncopied(self, rows, pages):
        window = WINDOW.get()
        if window is not None:
            pages = [p for p in pages if page_key(p) in window.own]
        return production_uncopied(self, rows, pages)

    extraction.Run.uncopied = uncopied

    production_complete = models.complete_response

    async def complete_response(messages, **kwargs):
        purpose = kwargs.get("call_purpose") or ""
        PURPOSE.set(purpose)
        window = WINDOW.get()
        if purpose == "extraction_map" and window and window.replay is not None:
            return SimpleNamespace(
                choices=[
                    SimpleNamespace(
                        message={"role": "assistant", "content": window.replay},
                        finish_reason="stop",
                    )
                ],
                usage=SimpleNamespace(output_tokens=0),
            )
        if purpose in GATED:
            async with STATE.get().gate:
                return await production_complete(messages, **kwargs)
        return await production_complete(messages, **kwargs)

    models.complete_response = complete_response
    production_plain = models.complete

    async def complete(messages, **kwargs):
        PURPOSE.set(kwargs.get("call_purpose") or "")
        return await production_plain(messages, **kwargs)

    models.complete = complete

    stream = client._stream_sse

    async def streamed(url, headers, body):
        state = STATE.get(None)
        if state is None:
            async for event in stream(url, headers, body):
                yield event
            return
        if LIVE["usd"] > LIVE["stop"]:
            raise SpendStop(f"${LIVE['usd']:.3f}")
        window = WINDOW.get()
        size = len(json.dumps(body))
        call = {
            "purpose": PURPOSE.get(),
            "window": None if window is None else window.index,
            "at": round(time.monotonic() - state.started, 1),
            "bytes": size,
            "cost": 0.0,
            "finish": None,
            "provider": None,
        }
        state.calls.append(call)
        state.in_flight += 1
        state.bytes_in_flight += size
        state.peak = max(state.peak, state.in_flight)
        state.peak_bytes = max(state.peak_bytes, state.bytes_in_flight)
        started = time.monotonic()
        try:
            async for event in stream(url, headers, body):
                call.setdefault("first_event_s", round(time.monotonic() - started, 2))
                call["provider"] = call["provider"] or event.get("provider")
                usage = event.get("usage")
                if usage:
                    call["cost"] = usage.get("cost") or call["cost"]
                    call["input"] = usage.get("prompt_tokens")
                    call["output"] = usage.get("completion_tokens")
                    call["cached"] = (usage.get("prompt_tokens_details") or {}).get(
                        "cached_tokens", 0
                    )
                for choice in event.get("choices") or []:
                    call["finish"] = choice.get("finish_reason") or call["finish"]
                yield event
        finally:
            state.in_flight -= 1
            state.bytes_in_flight -= size
            call["seconds"] = round(time.monotonic() - started, 2)
            LIVE["usd"] += call["cost"] or 0.0

    client._stream_sse = streamed


def _pages(cfg, capture, extraction) -> list:
    texts = _texts(QUESTION_PAGES)
    layers = extraction.page_layers(BOOK, texts)

    async def image(number):
        jpeg, _b, _s = await asyncio.to_thread(
            capture.render, BOOK, number, None, cfg.capture_max_edge
        )
        return capture.data_url(jpeg)

    async def crop(number, box):
        jpeg, _b, size = await asyncio.to_thread(
            capture.render,
            BOOK,
            number,
            box,
            cfg.capture_max_edge,
            page_edge=extraction.FIGURE_PAGE_EDGE,
        )
        return jpeg, size

    return [
        extraction.Page(
            number,
            BOOK.name,
            texts[number],
            functools.partial(image, number),
            functools.partial(crop, number),
            layer=layers[number],
        )
        for number in QUESTION_PAGES
    ]


def _answers(extraction, numbers: list[int] | None = None) -> list:
    numbers = ANSWER_PAGES if numbers is None else numbers
    if not numbers:
        return []
    texts = _texts(numbers)
    layers = extraction.page_layers(BOOK, texts)
    assert extraction._text_goes(layers), "the answer pages would go as images"
    return [extraction.AnswerFile(BOOK.name, "\n\n".join(texts[n] for n in numbers))]


def own_answer_pages(own: list[int]) -> list[int]:
    """The oracle arm's answer pages for a window: the solution pages of the
    practice sets with an item on its own pages, which no code could know."""
    wanted = {
        i["set"] for i in gold()["items"] if i["page"] in own and i["set"][0] == "P"
    }
    texts = _texts(ANSWER_PAGES)
    out, current = [], None
    for number in ANSWER_PAGES:
        on_page = {current}
        for line in _lines(texts[number]):
            heading = SET_HEADING.match(line)
            if heading:
                current = f"P{heading[2]}"
                on_page.add(current)
        if on_page & wanted:
            out.append(number)
    return out


# --------------------------------------------------- the scanned papers' selection

# "book" (the textbook) or "exams": six scanned HKDSE mathematics papers picked in one
# run, each numbering from 1, with three scanned marking schemes and one key file.
SELECTION = "book"
DATA: Path | None = None
EXAM_PAPERS = (
    ("2021-p1", range(2, 9)),
    ("2022-p1", range(2, 9)),
    ("2024-p1", range(2, 9)),
    ("2022-p2", range(1, 17)),
    ("2021-p2", range(1, 16)),
    ("2025-p2", range(1, 16)),
)
EXAM_SCHEMES = ("2021-ans", "2022-ans", "2024-ans")


def _refs() -> Path:
    return DATA / "question-bank/references/hkdse-math-compulsory"


def _page_read(paper: str, number: int) -> str:
    """The cached page read of a scanned page: the indexed text a scan has."""
    path = DATA / "extraction-bench-results/study-extraction/text"
    return (path / f"{paper}-{number:02d}.txt").read_text()


def _scan_renderers(cfg, capture, extraction, pdf: Path):
    async def image(number):
        jpeg, _b, _s = await asyncio.to_thread(
            capture.render, pdf, number, None, cfg.capture_max_edge
        )
        return capture.data_url(jpeg)

    async def crop(number, box):
        jpeg, _b, size = await asyncio.to_thread(
            capture.render,
            pdf,
            number,
            box,
            cfg.capture_max_edge,
            page_edge=extraction.FIGURE_PAGE_EDGE,
        )
        return jpeg, size

    return image, crop


def _exam_pages(cfg, capture, extraction) -> list:
    """The papers' pages as production builds a scan's: the page read as its text,
    which the image map doesn't send, and the layer from the PDF."""
    pages = []
    for paper, numbers in EXAM_PAPERS:
        pdf = _refs() / f"{paper}.pdf"
        image, crop = _scan_renderers(cfg, capture, extraction, pdf)
        texts = {n: _page_read(paper, n) for n in numbers}
        layers = extraction.page_layers(pdf, texts)
        pages += [
            extraction.Page(
                n,
                pdf.name,
                texts[n],
                functools.partial(image, n),
                functools.partial(crop, n),
                layer=layers[n],
            )
            for n in numbers
        ]
    return pages


def _exam_answers(cfg, capture, extraction, *, images: bool) -> list:
    """The marking schemes as images (production's for a scan) or as their page
    reads, and the multiple-choice paper's key as a text file."""
    import pymupdf

    files = []
    picked = {paper for paper, _numbers in EXAM_PAPERS}
    for scheme in (s for s in EXAM_SCHEMES if f"{s[:4]}-p1" in picked):
        pdf = _refs() / f"{scheme}.pdf"
        with pymupdf.open(pdf) as doc:
            numbers = range(1, len(doc) + 1)
        texts = {n: _page_read(scheme, n) for n in numbers}
        if images:
            image, _crop = _scan_renderers(cfg, capture, extraction, pdf)
            layers = extraction.page_layers(pdf, texts)
            files.append(
                extraction.AnswerFile(
                    pdf.name,
                    images=tuple(
                        (n, functools.partial(image, n))
                        for n in numbers
                        if layers[n] != extraction.BLANK
                    ),
                )
            )
        else:
            files.append(
                extraction.AnswerFile(pdf.name, "\n\n".join(texts[n] for n in numbers))
            )
    if "2022-p2" in picked:
        key = exam_gold()["2022-p2.pdf"]
        files.append(
            extraction.AnswerFile(
                "2022-p2-answers.txt",
                "\n".join(f"{q['label']}. {q['parts'][0]['correct']}" for q in key),
            )
        )
    return files


def exam_gold() -> dict[str, list[dict]]:
    """Each paper's questions: the extraction gold where there is one (labels, parts,
    marks, keys, figures), else a multiple-choice paper's 45 one-mark items."""
    gold_dir = DATA / "extraction-bench-fixtures/fixtures/gold"
    out = {}
    for paper, _numbers in EXAM_PAPERS:
        path = gold_dir / f"{paper}.json"
        if path.exists():
            out[f"{paper}.pdf"] = json.loads(path.read_text())["questions"]
        else:
            out[f"{paper}.pdf"] = [
                {
                    "label": str(n),
                    "total": 1,
                    "figure": None,
                    "parts": [{"label": "", "type": "mcq", "marks": 1}],
                }
                for n in range(1, 46)
            ]
    return out


async def _collect(run, crops_dir: Path) -> dict:
    copied, done = [], {}
    async for event in run:
        if event["type"] == "questions":
            copied = event["questions"]
        elif event["type"] == "done":
            done = event
    crops_dir.mkdir(parents=True, exist_ok=True)
    for figure in done.get("figures", []):
        (crops_dir / f"{figure['id']}.jpg").write_bytes(
            base64.b64decode(figure["image"])
        )
    return {
        "questions": done.get("questions", []),
        "report": done.get("report", {}),
        "copied": len(copied),
        "figures": len(done.get("figures", [])),
    }


async def _chunk_arm(
    limit: int, pages, answers, model, validate, crops: Path, *, reletter: bool
) -> list:
    """One map over every page's chunk text and no image (production's text-paper
    map), then the map's questions grouped by page into runs of at most ``limit``
    page images, each replaying the map's lines for its questions. With
    ``reletter``, code letters a label two files share by its file first."""
    from pipeline.retrieval import extraction

    text_pages = [dataclasses.replace(p, image=None, crop=None) for p in pages]
    _messages, rows, _output = await extraction._attempted(
        functools.partial(extraction.read_map, text_pages, answers, {}, model=model)
    )
    spans = resolve(rows, pages)
    if reletter:
        rows = relettered(rows, [s and pages[s[0]].file_name for s in spans])
    groups: list[tuple[list, set[int]]] = []
    for row, span in zip(rows, spans):
        if span is None:
            continue
        indexes = set(range(span[0], span[1] + 1))
        if not groups or len(groups[-1][1] | indexes) > limit:
            groups.append(([], set()))
        groups[-1][0].append(row)
        groups[-1][1].update(indexes)

    async def group(index: int, kept: list, indexes: set[int]) -> dict:
        lines = "\n".join(
            f"{r.label} | pages {r.first}-{r.last} | parts {', '.join(r.parts) or 'none'} "
            "| figures none"
            for r in kept
        )
        sent = [pages[i] for i in sorted(indexes)]
        WINDOW.set(Window(index, {page_key(p) for p in sent}, replay=lines))
        try:
            result = await _collect(
                extraction.run(sent, answers, model=model, validate=validate),
                crops / f"g{index}",
            )
        except Exception as exc:  # A group that fails is a finding.
            result = {"failed": repr(exc)[:300], "questions": [], "report": {}}
        return {"index": index, "own": _ids(sent), "sent": _ids(sent), **result}

    return await asyncio.gather(
        *(group(i, kept, indexes) for i, (kept, indexes) in enumerate(groups))
    )


def relettered(rows, files: list[str | None]) -> list:
    """A label that rows of two files share, lettered by its file's place in the
    selection (A for the first file): 1 in the second paper becomes B1."""
    from pipeline.retrieval.extraction import label_key

    order = list(dict.fromkeys(f for f in files if f))
    owners = collections.defaultdict(set)
    for row, file in zip(rows, files):
        owners[label_key(row.label)].add(file)
    return [
        dataclasses.replace(row, label=f"{chr(65 + order.index(file))}{row.label}")
        if file and len(owners[label_key(row.label)]) > 1
        else row
        for row, file in zip(rows, files)
    ]


def _ids(pages) -> list:
    """Pages as a run's record names them: numbers for the book, file:number for the
    papers."""
    if SELECTION == "book":
        return [p.number for p in pages]
    return [f"{p.file_name}:{p.number}" for p in pages]


async def one(arm: str, repeat: int, model, validate) -> dict:
    from pipeline import elitellm, obs
    from pipeline.config import cfg
    from pipeline.registry import bind_request_llm
    from pipeline.retrieval import capture, extraction, limits

    state = State(
        secrets.token_hex(6),
        asyncio.Semaphore(extraction.BATCHES_AT_ONCE),
        time.monotonic(),
    )
    STATE.set(state)
    if SELECTION == "book":
        pages = _pages(cfg, capture, extraction)
        answers = _answers(extraction)
    else:
        pages = _exam_pages(cfg, capture, extraction)
        answers = _exam_answers(cfg, capture, extraction, images=arm.endswith("i"))
    elitellm.bind_route_slot("extraction")
    bind_request_llm("mid")
    limits.bind_call_slots(limits.CallSlotPolicy(wait_s=limits.CHAT_SLOT_WAIT_S))
    usage = obs.start_usage()
    cpu = resource.getrusage(resource.RUSAGE_SELF)
    crops = OUT / "crops" / f"{arm}-{repeat}"
    windows: list[dict] = []
    size = int(arm[1:].rstrip("oir")) if arm != "one" else 0
    if arm.startswith("c"):
        windows = await _chunk_arm(
            size, pages, answers, model, validate, crops, reletter=arm.endswith("r")
        )
    elif arm == "one":
        result = await _collect(
            extraction.run(pages, answers, model=model, validate=validate), crops
        )
        windows.append({"index": 0, "own": _ids(pages), "sent": _ids(pages), **result})
    else:

        async def window(index: int, start: int) -> dict:
            own = pages[start : start + size]
            sent = pages[max(0, start - 1) : start + size + 1]
            WINDOW.set(Window(index, {page_key(p) for p in own}))
            mine = (
                _answers(extraction, own_answer_pages([p.number for p in own]))
                if arm.endswith("o")
                else answers
            )
            try:
                result = await _collect(
                    extraction.run(sent, mine, model=model, validate=validate),
                    crops / f"w{index}",
                )
            except Exception as exc:  # A window that fails is a finding.
                result = {"failed": repr(exc)[:300], "questions": [], "report": {}}
            return {"index": index, "own": _ids(own), "sent": _ids(sent), **result}

        windows = await asyncio.gather(
            *(window(i, start) for i, start in enumerate(range(0, len(pages), size)))
        )
    after = resource.getrusage(resource.RUSAGE_SELF)
    rates = bench.CAPTIONING[2]
    micros = (
        (usage.input_tokens - usage.cached_read_tokens) * rates[0]
        + usage.cached_read_tokens * rates[1]
        + usage.output_tokens * rates[2]
    )
    maps_done = max((m["seconds"] for m in state.maps if not m["replay"]), default=None)
    return {
        "arm": arm,
        "repeat": repeat,
        "seconds": round(time.monotonic() - state.started, 1),
        "maps_done_s": maps_done,
        "cpu_s": round(
            after.ru_utime + after.ru_stime - cpu.ru_utime - cpu.ru_stime, 1
        ),
        "billed_usd": round(sum(c["cost"] or 0 for c in state.calls), 5),
        "credits": round(micros / 1_000_000, 2),
        "tokens": {
            "input": usage.input_tokens,
            "cached": usage.cached_read_tokens,
            "output": usage.output_tokens,
        },
        "peak_in_flight": state.peak,
        "peak_mb_in_flight": round(state.peak_bytes / 1e6, 1),
        "calls": state.calls,
        "maps": state.maps,
        "windows": windows,
    }


def _pick_exams(args) -> None:
    """--exams DATA: the scanned papers' selection, from the ignored data folder;
    --papers keeps a smoke test to a few of them, apart from the measured runs."""
    global OUT, SELECTION, DATA, EXAM_PAPERS
    if not args.exams:
        return
    SELECTION, DATA, OUT = "exams", Path(args.exams), OUT / "exams"
    if args.papers:
        EXAM_PAPERS = tuple(p for p in EXAM_PAPERS if p[0] in args.papers)
        OUT = OUT / f"smoke-{'-'.join(args.papers)}"


async def run_arms(args) -> None:
    global OUT, QUESTION_PAGES
    _pick_exams(args)
    if args.pages:
        # A smoke test on a few pages, kept apart from the measured runs.
        first, last = map(int, args.pages.split("-"))
        QUESTION_PAGES = list(range(first, last + 1))
        OUT = OUT / f"pages-{first}-{last}"
    bench.load_env(args.env_file)
    OUT.mkdir(parents=True, exist_ok=True)
    spend = bench.RESULTS / "long" / "spend.json"
    LIVE["usd"] = json.loads(spend.read_text())["usd"] if spend.exists() else 0.0
    LIVE["stop"] = args.hard_stop
    install()
    validate = bench.validator(bench.quizcheck())
    provider, slug, name, rates = bench.MODELS["v41-1017"]
    model = bench.spec(provider, slug, name, rates, "low")
    try:
        for text in args.arms:
            arm, runs = text.split(":")
            for repeat in range(1, int(runs) + 1):
                path = OUT / f"{arm}-{repeat}.json"
                if path.exists():
                    continue
                if LIVE["usd"] > LIVE["stop"] * 0.92:
                    print(f"skip {path.name}: at the budget", flush=True)
                    continue
                try:
                    result = await one(arm, repeat, model, validate)
                except Exception as exc:  # A run that fails is a finding.
                    print(f"FAILED {path.name}: {exc!r}"[:400], flush=True)
                    path.with_suffix(".failed").write_text(repr(exc))
                    continue
                path.write_text(json.dumps(result, ensure_ascii=False))
                saved = sum(len(w["questions"]) for w in result["windows"])
                print(
                    f"{path.name}: {result['seconds']} s (maps {result['maps_done_s']} s), "
                    f"${result['billed_usd']:.4f}, {result['credits']} credits, "
                    f"{saved} questions, peak {result['peak_in_flight']} calls / "
                    f"{result['peak_mb_in_flight']} MB, total ${LIVE['usd']:.4f}",
                    flush=True,
                )
                spend.write_text(json.dumps({"usd": round(LIVE["usd"], 5)}))
    finally:
        spend.write_text(json.dumps({"usd": round(LIVE["usd"], 5)}))
    print(f"spent ${LIVE['usd']:.4f}", flush=True)


# ------------------------------------------------------------------ score


def _label_key(label: str) -> str:
    from pipeline.retrieval.extraction import label_key

    return label_key(label)


def _answer_numbers(text: str) -> list[float]:
    """The numbers in a model answer. An exponent (ft^2) can't match: the gold
    leaves out small whole numbers unless one is the answer."""
    return sorted(_numbers(str(text)))


def _agrees(values: list[float], solution: list[float], shows: bool = False) -> bool:
    return any(_agrees_one(v, solution, shows) for v in values)


def _agrees_one(value: float, solution: list[float], shows: bool) -> bool:
    # Million gallons and gallons are the same answer (24.9 MG, 24,900,000 gal).
    return any(
        _close(scaled, solution, shows) for scaled in (value, value / 1e6, value * 1e6)
    )


def _close(value: float, solution: list[float], shows: bool) -> bool:
    large = [n for n in solution if shows or not (n.is_integer() and n <= 12)]
    for n in large or solution:
        if n == 0:
            if value == 0:
                return True
        elif abs(value - n) / abs(n) <= 0.015:
            return True
    return False


def _tokens(text: str) -> set[str]:
    plain = _plain_math(text).lower().replace(",", "")
    return set(re.findall(r"[a-z]+|\d+(?:\.\d+)?", plain))


def _question_text(question: dict) -> str:
    out = []
    for block in _blocks(question):
        out.append(block.get("text") or "")
        out += [" ".join(row) for row in block.get("rows") or []]
    for part in question["parts"]:
        out += [str(o) for o in (part.get("answer") or {}).get("options") or []]
    return " ".join(out)


def _blocks(question: dict) -> list[dict]:
    return [
        *question.get("stem", []),
        *(b for p in question["parts"] for b in p["blocks"]),
    ]


def score_run(result: dict, gold_items: list[dict]) -> dict:
    """One run against the gold: questions found, lost, extra and duplicated,
    label collisions a merge would resolve, parts, marks, keys, figures and cost."""
    from pipeline.generated import limits

    saved = []
    for window in result["windows"]:
        kept = next(
            (
                m
                for m in result["maps"]
                if m["window"] == (None if result["arm"] == "one" else window["index"])
            ),
            {"rows": [], "kept": []},
        )
        first = {_label_key(r[0]): r[1] for r in kept["rows"] if r[0] in kept["kept"]}
        for label, question in zip(
            window["report"].get("recorded", []), window["questions"]
        ):
            saved.append(
                {
                    "window": window["index"],
                    "own": window["own"],
                    "label": label,
                    "key": _label_key(label),
                    "page": first.get(_label_key(label)),
                    "question": question,
                }
            )
    from pipeline.retrieval.extraction import _number

    # By text, not label: a window may number a set its own way.
    gold_tokens = [_tokens(re.sub(r"^\d{1,2}\.\s*", "", g["text"])) for g in gold_items]
    pairs = []
    for qi, q in enumerate(saved):
        mine = _tokens(_question_text(q["question"]))
        for gi, theirs in enumerate(gold_tokens):
            page = gold_items[gi]["page"]
            if (abs(page - q["page"]) > 1) if q["page"] else page not in q["own"]:
                continue
            # Overlap, not Jaccard: a set's instruction rides in the stem.
            least = min(len(mine), len(theirs))
            similarity = len(mine & theirs) / least if least else 0.0
            if _number(q["label"]) == gold_items[gi]["n"]:
                similarity += 0.01
            if similarity >= 0.5:
                pairs.append((similarity, qi, gi))
    pairs.sort(reverse=True)
    matched: dict[int, list[dict]] = collections.defaultdict(list)
    taken: set[int] = set()
    for similarity, qi, gi in pairs:
        if qi in taken or (matched.get(gi) and similarity < 0.8):
            continue
        taken.add(qi)
        matched[gi].append(saved[qi])
    # Then by text alone, for a map whose pages drifted: counted apart.
    drifted = 0
    late = []
    for qi, q in enumerate(saved):
        if qi in taken:
            continue
        mine = _tokens(_question_text(q["question"]))
        for gi, theirs in enumerate(gold_tokens):
            if gi in matched:
                continue
            least = min(len(mine), len(theirs))
            similarity = len(mine & theirs) / least if least else 0.0
            if similarity >= 0.8:
                late.append((similarity, qi, gi))
    for similarity, qi, gi in sorted(late, reverse=True):
        if qi in taken or gi in matched:
            continue
        taken.add(qi)
        matched[gi].append(saved[qi])
        drifted += 1
    extras = [q for qi, q in enumerate(saved) if qi not in taken]

    relabelled = [
        f"{gold_items[gi]['set']}#{gold_items[gi]['n']} as {q['label']}"
        for gi, qs in matched.items()
        for q in qs[:1]
        if _number(q["label"]) != gold_items[gi]["n"]
    ]
    by_key = collections.defaultdict(set)
    for q in saved:
        by_key[q["key"]].add(q["window"])
    collisions = sum(len(w) - 1 for w in by_key.values() if len(w) > 1)
    within = sum(
        c - 1
        for m in result["maps"]
        if not m.get("replay")
        for c in collections.Counter(_label_key(r) for r in m["kept"]).values()
        if c > 1
    )
    parts_right = marks_right = keys_total = keys_agree = numbers_right = 0
    numbers_wrong = []
    answered = no_answer = figures_found = figures_extra = 0
    types = collections.Counter()
    disagree = []
    for i, qs in matched.items():
        g, q = gold_items[i], qs[0]["question"]
        parts = q["parts"]
        # Less 1 to 3, which the text layer also prints as superscripts (ft2).
        printed = {
            n
            for n in _numbers(re.sub(r"^\d{1,2}\.\s*", "", g["text"]))
            if not (n.is_integer() and n <= 3)
        }
        if printed <= _numbers(_question_text(q)):
            numbers_right += 1
        else:
            numbers_wrong.append(f"{g['set']}#{g['n']} as {qs[0]['label']}")
        parts_right += len(parts) == max(1, len(g["parts"]))
        marks_right += all(p.get("marks") == 1 for p in parts)
        has_figure = any(b.get("type") == "image" for b in _blocks(q))
        figures_found += has_figure and g["figure"]
        figures_extra += has_figure and not g["figure"]
        for p in parts:
            answer = p.get("answer") or {}
            types[answer.get("type")] += 1
            accepted = [a for a in answer.get("accepted") or [] if str(a).strip()]
            if accepted or answer.get("correct") or p.get("markscheme"):
                answered += 1
            else:
                no_answer += 1
            key = (g["set"], g["n"])
            if g.get("solution") or key in MCQ_KEY:
                keys_total += 1
                if key in MCQ_KEY:
                    # Typed as choice, or as text naming the option's letter.
                    letter = "abcdefgh"[MCQ_KEY[key][0]]
                    right = (
                        answer.get("correct") == MCQ_KEY[key]
                        or any(
                            re.match(rf"^\(?{letter}\b", str(a).strip().lower())
                            for a in accepted
                        )
                        or any(
                            _agrees(_answer_numbers(a), g["solution"]) for a in accepted
                        )
                    )
                else:
                    values = FINAL.get(key, g["solution"])
                    right = any(
                        _agrees(_answer_numbers(a), values, g["shows"] or key in FINAL)
                        for a in accepted
                    )
                if right:
                    keys_agree += 1
                else:
                    disagree.append(f"{g['set']}#{g['n']}: {str(accepted)[:80]}")
    # The quiz's caps, in printed order: how many questions one quiz would hold.
    ordered = sorted(
        (q for qs in matched.values() for q in qs[:1]), key=lambda q: q["page"] or 0
    )
    held = parts_n = open_n = 0
    for q in ordered:
        p = len(q["question"]["parts"])
        o = sum(
            (x.get("answer") or {}).get("type") == "open"
            for x in q["question"]["parts"]
        )
        if (
            parts_n + p > limits.QUIZ_PARTS_MAX
            or open_n + o > limits.QUIZ_OPEN_PARTS_MAX
        ):
            break
        held, parts_n, open_n = held + 1, parts_n + p, open_n + o
    lost = [g for i, g in enumerate(gold_items) if i not in matched]
    return {
        "arm": result["arm"],
        "repeat": result["repeat"],
        "saved": len(saved),
        "found": len(matched),
        "lost": [f"{g['set']}#{g['n']}@{g['page']}" for g in lost],
        "duplicated": sum(len(qs) - 1 for qs in matched.values()),
        "extras": [f"w{q['window']}:{q['label']}@{q['page']}" for q in extras],
        "relabelled": relabelled,
        "pages_off": drifted,
        "collisions": collisions,
        "within_collisions": within,
        "parts_right": parts_right,
        "numbers_right": numbers_right,
        "numbers_wrong": numbers_wrong,
        "marks_right": marks_right,
        "types": dict(types),
        "keys": [keys_agree, keys_total],
        "disagree": disagree,
        "answered": answered,
        "no_answer": no_answer,
        "figures": [figures_found, sum(g["figure"] for g in gold_items), figures_extra],
        "one_quiz_holds": held,
        "failed_windows": sum(1 for w in result["windows"] if w.get("failed")),
        "stopped": sorted(
            {w["report"].get("stopped", "") for w in result["windows"]} - {""}
        ),
        **_costs(result, len(saved)),
    }


def _costs(result: dict, saved: int) -> dict:
    """A run's time, spend, calls and upload, in all and by purpose."""
    calls = result["calls"]
    by_purpose = collections.defaultdict(lambda: collections.Counter())
    for c in calls:
        row = by_purpose[c["purpose"]]
        row["calls"] += 1
        row["input"] += c.get("input") or 0
        row["cached"] += c.get("cached") or 0
        row["output"] += c.get("output") or 0
        row["usd"] += c.get("cost") or 0
        row["mb"] += c["bytes"] / 1e6
        row["max_input"] = max(row["max_input"], c.get("input") or 0)
        row["max_s"] = max(row["max_s"], c.get("seconds") or 0)
    rates = bench.CAPTIONING[2]
    map_credits = sum(
        ((c.get("input") or 0) - (c.get("cached") or 0)) * rates[0] / 1e6
        + (c.get("cached") or 0) * rates[1] / 1e6
        + (c.get("output") or 0) * rates[2] / 1e6
        for c in calls
        if c["purpose"] == "extraction_map"
    )
    return {
        "seconds": result["seconds"],
        "maps_done_s": result["maps_done_s"],
        "cpu_s": result["cpu_s"],
        "billed_usd": result["billed_usd"],
        "credits": result["credits"],
        "map_credits": round(map_credits, 1),
        "credits_per_question": round(result["credits"] / max(1, saved), 2),
        "calls": len(calls),
        "upload_mb": round(sum(c["bytes"] for c in calls) / 1e6, 1),
        "peak_in_flight": result["peak_in_flight"],
        "peak_mb_in_flight": result["peak_mb_in_flight"],
        "cut_off": sum(c["finish"] == "length" for c in calls),
        "providers": dict(collections.Counter(c["provider"] for c in calls)),
        "by_purpose": {
            k: {
                kk: round(vv, 4) if isinstance(vv, float) else vv
                for kk, vv in v.items()
            }
            for k, v in by_purpose.items()
        },
    }


def _spread(values: list[float], digits: int = 0) -> str:
    def fmt(v: float) -> str:
        return f"{v:.{digits}f}"

    mean = sum(values) / len(values)
    if len(values) == 1:
        return fmt(mean)
    return f"{fmt(mean)} ({fmt(min(values))}-{fmt(max(values))})"


def _by_arm(rows: list[dict], gold_count: int) -> None:
    """Means per arm, lowest and highest in brackets."""
    arms: dict[str, list[dict]] = collections.defaultdict(list)
    for r in rows:
        arms[r["arm"]].append(r)
    print(
        "| Arm | Runs | Found | Map pages off | Extra | Relabelled | Collide | Numbers right | Keys | "
        "No answer | Figures | "
        "Wall s | Map s | Billed | Credits | Credits a question | Peak calls | Upload MB |"
    )
    print("|" + "---|" * 18)
    for arm, rs in arms.items():
        print(
            f"| {arm} | {len(rs)} | {', '.join(str(r['found']) for r in rs)} of {gold_count} | "
            f"{', '.join(str(r['pages_off']) for r in rs)} | "
            f"{', '.join(str(len(r['extras'])) for r in rs)} | "
            f"{', '.join(str(len(r['relabelled'])) for r in rs)} | "
            f"{', '.join(str(r['collisions'] + r['within_collisions']) for r in rs)} | "
            f"{', '.join(str(r['numbers_right']) for r in rs)} | "
            f"{', '.join(str(r['keys'][0]) + '/' + str(r['keys'][1]) for r in rs)} | "
            f"{', '.join(str(r['no_answer']) for r in rs)} | "
            f"{', '.join(str(r['figures'][0]) for r in rs)} of {rs[0]['figures'][1]} | "
            f"{_spread([r['seconds'] for r in rs])} | {_spread([r['maps_done_s'] for r in rs])} | "
            f"${_spread([r['billed_usd'] for r in rs], 3)} | {_spread([r['credits'] for r in rs])} | "
            f"{_spread([r['credits_per_question'] for r in rs], 2)} | "
            f"{_spread([r['peak_in_flight'] for r in rs])} | {_spread([r['upload_mb'] for r in rs])} |"
        )


def score(args) -> None:
    items = gold()["items"]
    rows = []
    for path in sorted(OUT.glob("*-[0-9]*.json")):
        rows.append(score_run(json.loads(path.read_text()), items))
    if args.json:
        Path(args.json).write_text(json.dumps(rows, indent=1, ensure_ascii=False))
    print(
        "| Run | Saved | Found | Lost | Dup | Extra | Collide | Parts | Marks | Keys | "
        "No answer | Figures | One quiz | s | Maps s | Billed | Credits | Cr/q | Calls | "
        "Upload MB | Peak calls | Peak MB |"
    )
    print("|" + "---|" * 23)
    for r in rows:
        print(
            f"| {r['arm']}-{r['repeat']} | {r['saved']} | {r['found']}/{len(items)} | "
            f"{len(r['lost'])} | {r['duplicated']} | {len(r['extras'])} | {len(r['relabelled'])} | "
            f"{r['collisions']} (+{r['within_collisions']}) | {r['parts_right']} | "
            f"{r['marks_right']} | {r['keys'][0]}/{r['keys'][1]} | {r['no_answer']} | "
            f"{r['figures'][0]}/{r['figures'][1]} +{r['figures'][2]} | {r['one_quiz_holds']} | "
            f"{r['seconds']:.0f} | {r['maps_done_s']} | ${r['billed_usd']:.3f} | "
            f"{r['credits']:.0f} | {r['credits_per_question']} | {r['calls']} | "
            f"{r['upload_mb']:.0f} | {r['peak_in_flight']} | {r['peak_mb_in_flight']} |"
        )
    print()
    _by_arm(rows, len(items))
    if args.detail:
        for r in rows:
            print(
                f"\n{r['arm']}-{r['repeat']}: lost {r['lost']}\n  extras {r['extras']}"
                f"\n  relabelled {r['relabelled'][:30]}"
                f"\n  types {r['types']} stopped {r['stopped']} cut off {r['cut_off']} "
                f"providers {r['providers']}\n  disagree {r['disagree'][:12]}"
            )
            for k, v in r["by_purpose"].items():
                print(f"  {k}: {v}")


def score_exam_run(result: dict, gold: dict[str, list[dict]]) -> dict:
    """One run over the scanned papers: each saved question is placed on its paper
    by its map row's first page and matched by its printed number. A copy whose
    label no map row of its thread gives, or rows of two papers give, is placed by
    its text against the page reads of the pages its thread sent (``by_text``)."""
    from pipeline.generated import limits

    wanted = {(f, _label_key(g["label"])): g for f, qs in gold.items() for g in qs}
    saved, by_text = [], []
    for window in result["windows"]:
        index = None if result["arm"] == "one" else window["index"]
        record = next(
            (m for m in result["maps"] if m["window"] == index),
            {"rows": [], "files": [], "kept": []},
        )
        files = collections.defaultdict(set)
        for r, f in zip(record["rows"], record["files"]):
            if r[0] in record["kept"]:
                files[_label_key(r[0])].add(f)
        reads = {}
        for sent in window["sent"]:
            name, number = sent.rsplit(":", 1)
            reads[name, int(number)] = _tokens(
                _page_read(name.removesuffix(".pdf"), int(number))
            )
        for label, question in zip(
            window["report"].get("recorded", []), window["questions"]
        ):
            numbers = re.findall(r"\d+", label)
            owners = files.get(_label_key(label), set())
            if len(owners) == 1:
                file = next(iter(owners))
            else:
                mine = _tokens(_question_text(question))
                file = max(
                    reads, key=lambda k: len(mine & reads[k]) / max(1, len(mine))
                )[0]
                by_text.append(f"w{window['index']}:{label}@{file}")
            saved.append(
                {
                    "window": window["index"],
                    "label": label,
                    "key": (file, numbers[-1] if numbers else ""),
                    "question": question,
                }
            )
    seen: dict[tuple, dict] = {}
    extras, duplicated = [], 0
    for q in saved:
        if q["key"] not in wanted:
            extras.append(f"w{q['window']}:{q['label']}@{q['key'][0]}")
        elif q["key"] in seen:
            duplicated += 1
        else:
            seen[q["key"]] = q
    structure = marks = keys = keys_total = figures = figures_gold = 0
    answered = no_answer = 0
    by_paper = collections.Counter()
    for key, g in wanted.items():
        figures_gold += bool(g.get("figure"))
        q = seen.get(key)
        if q is None:
            continue
        by_paper[key[0]] += 1
        parts = q["question"]["parts"]
        types = [(p.get("answer") or {}).get("type") for p in parts]
        structure += types == [gp["type"] for gp in g["parts"]]
        marks += [p.get("marks") for p in parts] == [gp["marks"] for gp in g["parts"]]
        figures += bool(g.get("figure")) and any(
            b.get("type") == "image" for b in _blocks(q["question"])
        )
        for p, gp in zip(parts, g["parts"]):
            answer = p.get("answer") or {}
            accepted = [a for a in answer.get("accepted") or [] if str(a).strip()]
            if accepted or answer.get("correct") or p.get("markscheme"):
                answered += 1
            else:
                no_answer += 1
            if gp.get("correct"):
                keys_total += 1
                keys += answer.get("correct") == [ord(gp["correct"]) - ord("A")]
    held = parts_n = open_n = 0
    for q in saved:
        p = len(q["question"]["parts"])
        o = sum(
            (x.get("answer") or {}).get("type") == "open"
            for x in q["question"]["parts"]
        )
        if (
            parts_n + p > limits.QUIZ_PARTS_MAX
            or open_n + o > limits.QUIZ_OPEN_PARTS_MAX
        ):
            break
        held, parts_n, open_n = held + 1, parts_n + p, open_n + o
    return {
        "arm": result["arm"],
        "repeat": result["repeat"],
        "saved": len(saved),
        "found": len(seen),
        "by_paper": dict(by_paper),
        "lost": [f"{f}#{label}" for f, label in wanted if (f, label) not in seen],
        "duplicated": duplicated,
        "extras": extras,
        "by_text": by_text,
        "parts_right": structure,
        "marks_right": marks,
        "keys": [keys, keys_total],
        "answered": answered,
        "no_answer": no_answer,
        "figures": [figures, figures_gold],
        "one_quiz_holds": held,
        "threads": len(result["windows"]),
        "failed_windows": sum(1 for w in result["windows"] if w.get("failed")),
        "stopped": sorted(
            {w["report"].get("stopped", "") for w in result["windows"]} - {""}
        ),
        **_costs(result, len(saved)),
    }


def score_exams(args) -> None:
    gold = exam_gold()
    total = sum(len(qs) for qs in gold.values())
    rows = [
        score_exam_run(json.loads(path.read_text()), gold)
        for path in sorted(OUT.glob("*-[0-9]*.json"))
    ]
    if args.json:
        Path(args.json).write_text(json.dumps(rows, indent=1, ensure_ascii=False))
    print(
        "| Arm | Runs | Found | Extra | Duplicated | Parts right | Marks right | Keys | "
        "No answer | Figures | Threads | Wall s | Map s | Billed | Credits a question | "
        "Peak calls | Upload MB |"
    )
    print("|" + "---|" * 17)
    by_arm = collections.defaultdict(list)
    for r in rows:
        by_arm[r["arm"]].append(r)
    for arm, rs in sorted(by_arm.items()):

        def both(f):
            return ", ".join(str(f(r)) for r in rs)

        def keyed(r):
            return "{}/{}".format(*r["keys"])

        print(
            f"| `{arm}` | {len(rs)} | {both(lambda r: r['found'])} of {total} | "
            f"{both(lambda r: len(r['extras']))} | {both(lambda r: r['duplicated'])} | "
            f"{both(lambda r: r['parts_right'])} | {both(lambda r: r['marks_right'])} | "
            f"{both(keyed)} | {both(lambda r: r['no_answer'])} | "
            f"{both(lambda r: r['figures'][0])} of {rs[0]['figures'][1]} | "
            f"{both(lambda r: r['threads'])} | "
            f"{_spread([r['seconds'] for r in rs])} | "
            f"{_spread([r['maps_done_s'] or 0 for r in rs])} | "
            f"${_spread([r['billed_usd'] for r in rs], 3)} | "
            f"{_spread([r['credits_per_question'] for r in rs], 2)} | "
            f"{_spread([r['peak_in_flight'] for r in rs])} | "
            f"{_spread([r['upload_mb'] for r in rs])} |"
        )
    if args.detail:
        for r in rows:
            print(
                f"\n{r['arm']}-{r['repeat']}: by paper {r['by_paper']}\n  lost {r['lost']}"
                f"\n  extras {r['extras']}\n  placed by text {r['by_text']}\n  stopped {r['stopped']} failed "
                f"{r['failed_windows']} cut off {r['cut_off']} providers {r['providers']}"
            )
            for k, v in r["by_purpose"].items():
                print(f"  {k}: {v}")


# ------------------------------------------------------------ scanned maps

SCANS = ("2021-p1", "2022-p1", "2024-p1", "2022-p2")


async def scan_maps(args) -> None:
    """The chunk map's risk on scans: each HKDSE gold paper (scans with no text
    layer) mapped twice, as production maps it (images, no text) and from the
    ingest page reads alone (the chunks a scan has), with no answer file."""
    from pipeline import elitellm, obs
    from pipeline.config import cfg
    from pipeline.registry import bind_request_llm
    from pipeline.retrieval import capture, extraction, limits

    bench.load_env(args.env_file)
    install()
    provider, slug, name, rates = bench.MODELS["v41-1017"]
    model = bench.spec(provider, slug, name, rates, "low")
    out = bench.RESULTS / "long" / "scan-maps"
    out.mkdir(parents=True, exist_ok=True)
    for paper in SCANS:
        gold = json.loads((Path(args.gold) / f"{paper}.json").read_text())
        pdf = Path(args.refs) / gold["pdf"]

        async def image(number, source=pdf):
            jpeg, _b, _s = capture.render(source, number, None, cfg.capture_max_edge)
            return capture.data_url(jpeg)

        pages = [
            extraction.Page(
                n,
                pdf.name,
                (Path(args.text_cache) / f"{paper}-{n:02d}.txt").read_text(),
                functools.partial(image, n),
                None,
                layer=extraction.SCAN,
            )
            for n in gold["pages"]
        ]
        for mode in ("image", "text"):
            path = out / f"{paper}-{mode}-{args.repeat}.json"
            if path.exists():
                continue
            state = State(secrets.token_hex(6), asyncio.Semaphore(4), time.monotonic())
            STATE.set(state)
            elitellm.bind_route_slot("extraction")
            bind_request_llm("mid")
            limits.bind_call_slots(
                limits.CallSlotPolicy(wait_s=limits.CHAT_SLOT_WAIT_S)
            )
            obs.start_usage()
            sent = (
                pages
                if mode == "image"
                else [dataclasses.replace(p, image=None) for p in pages]
            )
            _m, rows, _o = await extraction._attempted(
                functools.partial(extraction.read_map, sent, [], {}, model=model)
            )
            path.write_text(
                json.dumps(
                    {
                        "rows": [[r.label, r.first, r.last, r.parts] for r in rows],
                        "calls": state.calls,
                    }
                )
            )
            print(
                f"{path.name}: {len(rows)} rows, ${state.calls[-1]['cost']:.4f}",
                flush=True,
            )


def score_scan_maps(args) -> None:
    out = bench.RESULTS / "long" / "scan-maps"
    print(
        "| Paper | Map | Runs | Labels right | Parts right | Same pages as the image map | Input tokens | Billed |"
    )
    print("|---|---|---|---|---|---|---|---|")
    for paper in SCANS:
        gold = json.loads((Path(args.gold) / f"{paper}.json").read_text())
        want = {
            _label_key(q["label"]): [
                _label_key(p["label"]) for p in q["parts"] if p["label"]
            ]
            for q in gold["questions"]
        }
        runs: dict[str, list[dict]] = collections.defaultdict(list)
        for path in sorted(out.glob(f"{paper}-*-*.json")):
            runs[path.stem.split("-")[2]].append(json.loads(path.read_text()))
        image_pages = [
            {_label_key(r[0]): (r[1], r[2]) for r in run["rows"]}
            for run in runs["image"]
        ]
        for mode in ("image", "text"):
            labels, parts, same, tokens, cost = [], [], [], [], []
            for i, run in enumerate(runs[mode]):
                got = {
                    _label_key(r[0]): [_label_key(x) for x in r[3]] for r in run["rows"]
                }
                labels.append(
                    sum(k in got for k in want) - sum(k not in want for k in got)
                )
                parts.append(sum(got.get(k) == v for k, v in want.items()))
                pages = {_label_key(r[0]): (r[1], r[2]) for r in run["rows"]}
                ref = image_pages[i % len(image_pages)] if image_pages else {}
                same.append(sum(pages.get(k) == v for k, v in ref.items()))
                tokens.append(run["calls"][-1].get("input") or 0)
                cost.append(run["calls"][-1].get("cost") or 0)
            n = len(want)
            print(
                f"| {paper} | {mode} | {len(runs[mode])} | "
                f"{', '.join(str(x) for x in labels)} of {n} | "
                f"{', '.join(str(x) for x in parts)} of {n} | "
                f"{'—' if mode == 'image' else ', '.join(str(x) for x in same) + f' of {n}'} | "
                f"{_spread(tokens)} | ${_spread(cost, 4)} |"
            )


def main() -> None:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("gold")
    scans = sub.add_parser("scan-maps")
    scans.add_argument("--env-file")
    scans.add_argument("--refs", required=True)
    scans.add_argument("--gold", required=True)
    scans.add_argument("--text-cache")
    scans.add_argument("--repeat", type=int, default=1)
    scans.add_argument("--score", action="store_true")
    scored = sub.add_parser("score")
    scored.add_argument("--pages", help="first-last question pages of a smoke test")
    scored.add_argument("--json", help="write the scores here")
    scored.add_argument("--detail", action="store_true")
    scored.add_argument("--exams", help="the data folder: score the scanned papers")
    scored.add_argument("--papers", nargs="+")
    ran = sub.add_parser("run")
    ran.add_argument("--env-file", required=True)
    ran.add_argument("--arms", nargs="+", required=True)
    ran.add_argument("--hard-stop", type=float, default=4.5)
    ran.add_argument("--pages", help="first-last question pages, for a smoke test")
    ran.add_argument("--exams", help="the data folder: run the scanned papers")
    ran.add_argument("--papers", nargs="+", help="a smoke test's papers")
    args = parser.parse_args()
    if args.command == "gold":
        show_gold()
    elif args.command == "score":
        global OUT, QUESTION_PAGES
        if args.pages:
            first, last = map(int, args.pages.split("-"))
            QUESTION_PAGES = list(range(first, last + 1))
            OUT = OUT / f"pages-{first}-{last}"
        _pick_exams(args)
        score_exams(args) if args.exams else score(args)
    elif args.command == "scan-maps":
        if args.score:
            score_scan_maps(args)
        else:
            asyncio.run(scan_maps(args))
    elif args.command == "run":
        asyncio.run(run_arms(args))


if __name__ == "__main__":
    main()
