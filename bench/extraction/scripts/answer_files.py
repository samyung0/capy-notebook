"""Answer files sent to the model with the paper, in the first message, so map, copy
and solve share one cached start (Epo 2026-11-05: "dont use code for pairing, send the
files directly"). No parse and no ``pair()``. Report:
``reports/2026-11-05-answer-files.md``.

Around this branch's production ``extraction.run``: the bench only adds the answer
blocks to the map's message, the wording to its system prompt, ``marks`` to
``record_answers`` and, in code, the part's marks from that field. Nothing in the
pipeline changes.

    python -I answer_files.py make --refs <hkdse-math-compulsory>
    python -I answer_files.py run --refs <hkdse-math-compulsory> --detections <pp-plus-l-onnx.json> \
        --env-file deploy/.env.uat --jobs main:scheme:img:3 main:shuffled:txt:3 main:parse::3
    python -I answer_files.py score --refs <hkdse-math-compulsory>

Epo also asked whether a file goes in the first message or only with the solve ask:
``-onsolve`` keeps map and copy as today and puts the blocks before the solve ask.

A job is ``<selection>:<file>:<mode>:<runs>``. Selection: ``main`` (2021 P1 pages 2-8, the
gold), ``long`` (the two questions with the scheme's long numbers) or ``whole``. File: ``scheme``,
``shuffled``, ``nonumbers``, ``standin``, ``drawn`` (Epo's own JPG, ``files/drawn.jpg``),
``parse`` (today's route) or ``none`` (no answer file). Mode: ``img`` or ``txt``, plus
``thumb1``, ``thumb1q``, ``thumb2``, ``thumb2q`` are Epo's images in the ignored files/,
whole or with the question cropped out; a file there by name is its answer file, and
``nofile`` is the new wording with none. ``-lowsolve`` for solve calls at low reasoning and ``-strict`` for the file winning a
disagreement, ``-mapnum`` for a map ask that numbers an unnumbered question, ``-plain`` for no "printed"
or "handwritten" in anything the model reads. Every run's system prompt starts with a
nonce, so nothing it reads from a cache was written by another run.

Answers, the stand-in's wording and the truth are exam text, so they live only in the
ignored ``.results/answerfiles/`` (``standin.json``, ``truth.json``): nothing here quotes
one. Keys go into the process only and are never printed.
"""

from __future__ import annotations

import argparse
import asyncio
import collections
import contextvars
import copy
import functools
import io
import json
import random
import re
import secrets
import statistics
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import run as bench  # noqa: E402

OUT = bench.RESULTS / "answerfiles"
FILES = OUT / "files"
SPEND = OUT / "spend.json"
PAPER = "2021-p1"
SCHEME = "2021-ans.pdf"
DRAWN_NAME = "answers.jpg"
# The selections: pages of 2021 P1. "long" holds Q15 and Q18, whose scheme working
# carries the file's long numbers.
SELECTIONS = {
    "main": [2, 3, 4, 5, 6, 7, 8],
    "long": [16, 20],
    # The whole paper: 19 questions, so two copy threads and three solve batches, which
    # is what first message against on solve turns on. Only pages 2-8 have saved
    # detections, so a later figure takes the box call.
    "whole": list(range(2, 24)),
    # Epo's own images (2026-11-05), each one JPEG in the ignored files/: the page as
    # the paper, or the question cropped out of it.
    "thumb1": [1],
    "thumb2": [1],
    "thumb1q": [1],
    "thumb2q": [1],
}
# Q1 to Q19 on the scheme's pages 3 to 14.
SCHEME_QUESTIONS = 19
SCHEME_FIRST_PAGE = 3
SEED = 2021
PARALLEL = 3

# ------------------------------------------------------------- the wording, as shown

FIRST_END = "You see all the selected page images at once."
NEW_SENTENCE = (
    "After the question pages may come answer files: a mark scheme, an answer key or "
    "someone's own answers, in any layout, possibly handwritten."
)
# With -onsolve the file comes later, so the sentence says when.
NEW_SENTENCE_ON_SOLVE = (
    "With the ask for answers may come answer files: a mark scheme, an answer key or "
    "someone's own answers, in any layout, possibly handwritten."
)
OLD_ANSWER = (
    "Copy an answer the page prints; otherwise work it out, and never change the "
    "printed question."
)
NEW_ANSWER = (
    "Take each answer and its marks from the answer files or the page when they give "
    "them; otherwise work it out, and never change the printed question."
)
# -strict: the file wins a disagreement. All 6 stand-in runs without it replaced the two
# answers planted wrong with their own.
NEW_ANSWER_STRICT = (
    "Take each answer and its marks from the answer files or the page when they give "
    "them, even when your own working disagrees; otherwise work it out, and never "
    "change the printed question."
)
# -mapnum: the map ask for a question with no printed number (a whiteboard photo).
MAP_NUMBER_AFTER = (
    "add a section (A1, B1) only when two questions on these pages would otherwise "
    "share a number."
)
MAP_NUMBER_ADDED = "A question with no printed number takes the next number in order, starting from 1."
# -plain: "printed" and "handwritten" out of every string the model reads (Epo
# 2026-11-05: "i dont care how the quesitons is made"), longest first.
PLAIN = [
    (
        "You copy the questions printed on exam or worksheet pages into a quiz, exactly as printed.",
        "You copy the questions on the selected pages into a quiz, exactly as they appear.",
    ),
    (", in any layout, possibly handwritten.", ", in any layout."),
    ("never change the printed question", "never change the question"),
    ("exactly as printed", "exactly as they appear"),
    ("a printed dollar sign for money", "a dollar sign for money"),
    ("never simplify or reword the printed text", "never simplify or reword the text"),
    ("follow its printed labels", "follow its labels"),
    ("Text printed under (b)", "Text under (b)"),
    ("the part's printed marks", "the part's marks as shown"),
    ("only the question's total is printed", "only the question's total is shown"),
    ("give the printed total", "give that total"),
    ("An item printed without marks has 1", "An item with no marks shown has 1"),
    ("<printed part labels, or none>", "<part labels, or none>"),
    ("the question's printed number alone", "the question's number alone"),
    ("it is printed on", "it is on"),
    ("its printed part labels", "its part labels"),
    ("text: the printed text.", "text: the text."),
    ("The printed question number", "The question number"),
    ("The printed part label", "The part label"),
    ("the unit printed beside", "the unit shown beside"),
    ("a unit is printed beside", "a unit is shown beside"),
    ("the text printed under its parent", "the text under its parent"),
    ("Text printed before the first part", "Text before the first part"),
    ("The question's printed total, when only a total is printed.", "The question's total, when only a total is shown."),
    ("in printed order", "in order"),
]
MAP_NUMBER_PLAIN = "A question with no number takes the next number in order, starting from 1."


def plain(text: str) -> str:
    for old, new in PLAIN:
        text = text.replace(old, new)
    return text


MARKS_PROPERTY = {
    "type": "integer",
    "minimum": 1,
    "description": "The part's marks when the answer file gives them.",
}


def image_heading(image: int, number: int, name: str) -> str:
    return f"Answer file page image {image}: page {number} of {name}."


def text_heading(name: str) -> str:
    return f"Answer file {name}. Its indexed text:"


def tools_with_marks(tools: list[dict]) -> list[dict]:
    out = copy.deepcopy(tools)
    for tool in out:
        if tool["function"]["name"] == "record_answers":
            part = tool["function"]["parameters"]["properties"]["parts"]["items"]
            properties = part["properties"]
            # After label, where a reader of the schema looks for what a part gives.
            part["properties"] = {
                "label": properties["label"],
                "marks": MARKS_PROPERTY,
                **{k: v for k, v in properties.items() if k != "label"},
            }
    return out


# ------------------------------------------------------------------- the doctored files


def _page_images(pdf: Path, edge: int = 2200) -> list:
    """Each page as grey pixels, long side ``edge``."""
    import pymupdf
    from PIL import Image

    out = []
    with pymupdf.open(pdf) as doc:
        for page in doc:
            scale = edge / max(page.rect.width, page.rect.height)
            pix = page.get_pixmap(
                matrix=pymupdf.Matrix(scale, scale),
                colorspace=pymupdf.csGRAY,
                alpha=False,
            )
            out.append(Image.open(io.BytesIO(pix.tobytes("png"))).convert("L"))
    return out


def _anchors(images: list) -> list[tuple[int, int, int]]:
    """Each question number on the scheme's pages: (page index, top, bottom), by the ink
    in the number column. The header and footer are outside the rows looked at."""
    from PIL import Image

    found = []
    for index, image in enumerate(images):
        if index + 1 < SCHEME_FIRST_PAGE:
            continue
        width, height = image.size
        column = image.crop((int(width * 0.028), 0, int(width * 0.072), height))
        column = column.point(lambda value: 255 if value < 140 else 0)
        rows = list(column.resize((1, height), Image.BOX).get_flattened_data())
        top, gap = None, 0
        last = 0
        for y in range(int(height * 0.09), int(height * 0.925)):
            if rows[y]:
                if top is None:
                    top = y
                last, gap = y, 0
            elif top is not None:
                gap += 1
                if gap > 12:
                    # A number is about 18 px tall; a box's left border is far taller.
                    if 12 <= last - top <= 40:
                        found.append((index, top, last))
                    top = None
    return found


def _save_pdf(images: list, path: Path) -> None:
    """Pages from grey images, at A4 points; capture renders them as it does any PDF."""
    import pymupdf

    doc = pymupdf.open()
    for image in images:
        page = doc.new_page(width=595.2, height=842)
        buffer = io.BytesIO()
        image.save(buffer, "JPEG", quality=88)
        page.insert_image(page.rect, stream=buffer.getvalue())
    doc.save(path)
    doc.close()


def _shuffled_order() -> list[int]:
    order = list(range(1, SCHEME_QUESTIONS + 1))
    random.Random(SEED).shuffle(order)
    return order


def make_images(refs: Path) -> None:
    from PIL import Image, ImageDraw

    images = _page_images(refs / SCHEME)
    anchors = _anchors(images)
    if len(anchors) != SCHEME_QUESTIONS:
        raise SystemExit(f"found {len(anchors)} question numbers, not {SCHEME_QUESTIONS}")
    width, height = images[0].size
    # Numbers removed: white over each number, nothing else touched.
    blank = [image.copy() for image in images]
    for index, top, bottom in anchors:
        ImageDraw.Draw(blank[index]).rectangle(
            (int(width * 0.028), top - 6, int(width * 0.072), bottom + 6), fill=255
        )
    _save_pdf(blank, FILES / "nonumbers.pdf")
    # Out of order: each question's strips, cut at its number, on new pages under the
    # file's own header.
    foot = int(height * 0.925)
    head_top, head_bottom = int(height * 0.052), int(height * 0.092)
    strips: dict[int, list] = collections.defaultdict(list)
    for number, (index, top, _) in enumerate(anchors, 1):
        following = anchors[number] if number < len(anchors) else None
        same_page = following and following[0] == index
        end = following[1] - 10 if same_page else foot
        strips[number].append(images[index].crop((0, top - 10, width, end)))
        if following and following[0] > index:
            # It runs on to the pages before the next number.
            for page in range(index + 1, following[0] + 1):
                bottom = following[1] - 10 if page == following[0] else foot
                if bottom - head_bottom > 40:
                    strips[number].append(
                        images[page].crop((0, head_bottom, width, bottom))
                    )
        elif following is None:
            for page in range(index + 1, len(images)):
                strips[number].append(images[page].crop((0, head_bottom, width, foot)))
    header = images[SCHEME_FIRST_PAGE - 1].crop((0, head_top, width, head_bottom))
    pages = images[: SCHEME_FIRST_PAGE - 1]

    def new_page() -> tuple[Image.Image, int]:
        sheet = Image.new("L", (width, height), 255)
        sheet.paste(header, (0, head_top))
        return sheet, head_bottom + 10

    sheet, y = new_page()
    for number in _shuffled_order():
        for strip in strips[number]:
            # A strip about a page tall takes a fresh page rather than leaving a blank one.
            if y + strip.height > foot and y > head_bottom + 10:
                pages.append(sheet)
                sheet, y = new_page()
            sheet.paste(strip, (0, y))
            y += strip.height + 8
    pages.append(sheet)
    _save_pdf(pages, FILES / "shuffled.pdf")


def scheme_text(refs: Path) -> str:
    """The scheme's indexed text as a run joins it: each page's cached page read."""
    import pymupdf

    with pymupdf.open(refs / SCHEME) as doc:
        count = len(doc)
    return "\n\n".join(
        (bench.RESULTS / "text" / f"2021-ans-{n:02d}.txt").read_text()
        for n in range(1, count + 1)
    )


def _text_blocks(text: str) -> tuple[str, dict[int, str], list[tuple[int, int, int]]]:
    """The text before Q1, each question's text, and where each number is."""
    start = text.index("Solution", text.index("General Marking"))
    found: list[tuple[int, int, int]] = []
    at = start
    for number in range(1, SCHEME_QUESTIONS + 1):
        match = re.compile(rf"(?m)^(\|\s*)?{number}\.\s").search(text, at)
        if match is None:
            raise SystemExit(f"question {number} not found in the scheme's text")
        found.append((number, match.start(), match.end()))
        at = match.end()
    blocks = {
        number: text[begin : found[i + 1][1] if i + 1 < len(found) else len(text)]
        for i, (number, begin, _) in enumerate(found)
    }
    return text[: found[0][1]], blocks, found


def make_text(refs: Path) -> None:
    text = scheme_text(refs)
    before, blocks, found = _text_blocks(text)
    (FILES / "shuffled.txt").write_text(
        before + "".join(blocks[n] for n in _shuffled_order())
    )
    out, at = [], 0
    for _, begin, end in found:
        lead = text[begin:end]
        out += [text[at:begin], "| " if lead.startswith("|") else ""]
        at = end
    out.append(text[at:])
    (FILES / "nonumbers.txt").write_text("".join(out))


def _glyphs(sheet, xy, text, font, rng, size_scale=1.0):
    """One line in a hand's wobble, a character at a time. ``^{..}`` is raised and
    smaller. The way back in x, for what follows."""
    from PIL import Image, ImageDraw, ImageFont

    x, y = xy
    parts = re.split(r"(\^\{[^}]*\})", text)
    for piece in parts:
        raised = piece.startswith("^{")
        chars = piece[2:-1] if raised else piece
        used = (
            ImageFont.truetype(font.path, int(font.size * 0.62 * size_scale))
            if raised
            else font
        )
        for char in chars:
            box = used.getbbox(char)
            glyph_w = max(box[2], 1) + 12
            glyph_h = int(used.size * 1.6)
            glyph = Image.new("L", (glyph_w, glyph_h), 0)
            ImageDraw.Draw(glyph).text((6, 2), char, fill=255, font=used)
            glyph = glyph.rotate(rng.uniform(-5, 5), resample=Image.BICUBIC, expand=False)
            dy = rng.uniform(-3, 3) + (-used.size * 0.55 if raised else 0)
            left, top = int(x - 6), int(y + dy)
            sheet.paste(38, (left, top, left + glyph_w, top + glyph_h), glyph)
            x += box[2] + rng.uniform(-0.5, 2.0) + (6 if char == " " else 0)
    return x


def make_standin() -> None:
    """A stand-in for a hand-drawn answer file: a handwriting font, each character
    wobbled, on lined paper, skewed and saved as a low-quality JPEG. Far cleaner than
    real handwriting. Its lines come from the ignored ``standin.json``: each is
    ``{"x", "y", "text"}`` with optional ``"struck"`` (crossed out) and ``"box"``."""
    from PIL import Image, ImageDraw, ImageFilter, ImageFont

    spec = json.loads((OUT / "standin.json").read_text())
    rng = random.Random(SEED)
    width, height = 1500, 2000
    sheet = Image.new("L", (width, height), 244)
    draw = ImageDraw.Draw(sheet)
    for y in range(120, height, 62):
        draw.line((0, y, width, y + rng.randint(-1, 1)), fill=214, width=2)
    draw.line((110, 0, 112, height), fill=205, width=2)
    fonts = [
        ImageFont.truetype("/System/Library/Fonts/Supplemental/Comic Sans MS.ttf", size)
        for size in (40, 44, 48)
    ]
    for item in spec["lines"]:
        font = fonts[rng.randrange(len(fonts))]
        x, y = item["x"], item["y"]
        end = _glyphs(sheet, (x, y), item["text"], font, rng)
        if item.get("struck"):
            draw.line((x - 4, y + 34, end + 4, y + 22), fill=40, width=4)
        if item.get("box"):
            draw.ellipse((x - 26, y - 8, end + 22, y + 66), outline=60, width=3)
    for mark in spec.get("arrows", []):
        draw.line(tuple(mark), fill=60, width=3)
    noise = Image.effect_noise((width, height), 7)
    sheet = Image.blend(sheet, noise, 0.04)
    sheet = sheet.rotate(1.3, resample=Image.BICUBIC, fillcolor=236)
    sheet = sheet.filter(ImageFilter.GaussianBlur(0.7))
    sheet.save(FILES / "standin.jpg", "JPEG", quality=62)


# ------------------------------------------------------------------------- the run


@dataclass
class State:
    selection: str
    file: str
    mode: str
    repeat: int
    nonce: str
    pages: list[int]
    regions: list[tuple]
    answer_blocks: list[dict] | None
    low_solve: bool
    on_solve: bool = False
    strict: bool = False
    map_number: bool = False
    plain: bool = False
    map_reply: str = ""
    started: float = 0.0
    calls: list[dict] = field(default_factory=list)
    answers_raw: list[dict] = field(default_factory=list)
    copies_raw: list[dict] = field(default_factory=list)
    part_labels: dict[str, list[str]] = field(default_factory=dict)
    sent: dict = field(default_factory=dict)
    copied: list = field(default_factory=list)
    served: dict = field(default_factory=lambda: collections.Counter())


STATE: contextvars.ContextVar[State] = contextvars.ContextVar("answer_files_job")
PURPOSE: contextvars.ContextVar[str] = contextvars.ContextVar("purpose", default="")
LIVE = {"usd": 0.0, "base": 0.0, "stop": 1.0}


class SpendStop(Exception):
    pass


def install() -> None:
    from pipeline.elitellm import client
    from pipeline.prompts import extraction as prompts
    from pipeline.registry import bind_request_llm
    from pipeline.retrieval import extraction, models

    tools = tools_with_marks(prompts.TOOLS)
    tools_plain = json.loads(plain(json.dumps(tools)))
    if re.search(r"(?i)\bprint", json.dumps(tools_plain)):
        raise AssertionError("printed left in the tools")
    production_messages = prompts.map_messages

    def map_messages(pages, boxes, *, with_text):
        state = STATE.get()
        messages = production_messages(pages, boxes, with_text=with_text)
        system = messages[0]["content"]
        if state.answer_blocks is not None:
            if FIRST_END not in system or OLD_ANSWER not in system or with_text:
                raise AssertionError("the wording shown does not fit this prompt")
            sentence = NEW_SENTENCE_ON_SOLVE if state.on_solve else NEW_SENTENCE
            system = system.replace(FIRST_END, f"{FIRST_END} {sentence}", 1)
            system = system.replace(
                OLD_ANSWER, NEW_ANSWER_STRICT if state.strict else NEW_ANSWER, 1
            )
            if not state.on_solve:
                # After the boxes, so the figures paragraph's "After the pages comes
                # what it found" holds, and before the ask.
                content = messages[1]["content"]
                content[-1:-1] = state.answer_blocks
        if state.plain:
            system = plain(system)
            ask = messages[1]["content"][-1]
            ask["text"] = plain(ask["text"]).replace(
                MAP_NUMBER_AFTER, f"{MAP_NUMBER_AFTER} {MAP_NUMBER_PLAIN}", 1
            )
            for text in (system, ask["text"]):
                if re.search(r"(?i)\bprint|handwrit", text):
                    raise AssertionError(f"left in: {text[:200]}")
        messages[0]["content"] = f"Run {state.nonce}.\n{system}"
        if state.map_number:
            ask = messages[1]["content"][-1]
            if MAP_NUMBER_AFTER not in ask["text"]:
                raise AssertionError("the map ask does not fit")
            ask["text"] = ask["text"].replace(
                MAP_NUMBER_AFTER, f"{MAP_NUMBER_AFTER} {MAP_NUMBER_ADDED}", 1
            )
        state.sent = {
            "system": messages[0]["content"],
            "blocks": [
                block["text"]
                for block in messages[1]["content"]
                if block["type"] == "text"
            ],
            "images": sum(
                1 for block in messages[1]["content"] if block["type"] == "image_url"
            ),
        }
        return messages

    prompts.map_messages = map_messages

    async def read_regions(images):
        return STATE.get().regions

    extraction.layout.read_regions = read_regions

    complete_response = models.complete_response

    async def response(messages, **kwargs):
        state = STATE.get()
        purpose = kwargs.get("call_purpose", "")
        PURPOSE.set(purpose)
        if state.answer_blocks is not None and kwargs.get("tools"):
            kwargs["tools"] = tools_plain if state.plain else tools
        if state.low_solve and purpose == "extraction_solve":
            bind_request_llm("low")
        if state.on_solve and purpose == "extraction_solve":
            # The blocks before the ask, in the message the solve batch just added; a
            # later round of the same thread finds it already holds them.
            for message in messages:
                if (
                    message["role"] == "user"
                    and isinstance(message["content"], str)
                    and message["content"].startswith("Give the answers")
                ):
                    ask = {"type": "text", "text": message["content"]}
                    message["content"] = [*state.answer_blocks, ask]
        reply = await complete_response(messages, **kwargs)
        if purpose == "extraction_map":
            state.map_reply = str(reply.choices[0].message.content or "")[:2000]
        return reply

    models.complete_response = response

    stream = client._stream_sse

    async def streamed(url, headers, body):
        state = STATE.get(None)
        if state is None:
            async for event in stream(url, headers, body):
                yield event
            return
        if LIVE["base"] + LIVE["usd"] > LIVE["stop"]:
            raise SpendStop(f"${LIVE['base'] + LIVE['usd']:.3f}")
        started = time.monotonic()
        call = {
            "purpose": PURPOSE.get(),
            "at": round(started - state.started, 2),
            "reasoning_sent": body.get("reasoning"),
            "max_tokens_sent": body.get("max_tokens"),
            "route_sent": (body.get("provider") or {}).get("order"),
            "body_bytes": len(json.dumps(body)),
            "provider": None,
            "cost": 0.0,
            "finish": None,
        }
        state.calls.append(call)
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
                    call["reasoning"] = (
                        usage.get("completion_tokens_details") or {}
                    ).get("reasoning_tokens", 0)
                for choice in event.get("choices") or []:
                    call["finish"] = choice.get("finish_reason") or call["finish"]
                yield event
        finally:
            call["seconds"] = round(time.monotonic() - started, 2)
            LIVE["usd"] += call["cost"] or 0.0

    client._stream_sse = streamed

    copy_question = extraction.Run.copy_question
    record_answers = extraction.Run.record_answers
    label_key = extraction.label_key

    async def copied(self, item, pages):
        state = STATE.get()
        result = await copy_question(self, item, pages)
        key = label_key(str(item.get("label") or ""))
        state.copies_raw.append(
            {
                "label": item.get("label"),
                "result": result,
                "marks": [p.get("marks") for p in item.get("parts") or []],
                "types": [(p.get("answer") or {}).get("type") for p in item.get("parts") or []],
                "total": item.get("total_marks"),
            }
        )
        if result.endswith("recorded."):
            state.part_labels[key] = [
                str(p.get("label") or "") for p in item.get("parts") or []
            ]
        return result

    async def answered(self, args, pages):
        """Production's, with the part's marks from the new field when it gives them.
        A refusal leaves the copy as it was, so the next try starts clean."""
        state = STATE.get()
        key = label_key(str(args.get("label") or ""))
        kept = self.copies.get(key)
        before = copy.deepcopy(kept)
        if kept is not None and state.answer_blocks is not None:
            by_part = {label_key(str(p.get("label") or "")): p for p in kept["parts"]}
            for given in args.get("parts") or []:
                given = given if isinstance(given, dict) else {}
                part = by_part.get(label_key(str(given.get("label") or "")))
                marks = extraction._whole(given.get("marks"))
                if part is not None and marks is not None and marks >= 1:
                    part["marks"] = marks
        result = await record_answers(self, args, pages)
        if kept is not None and not result.endswith("recorded."):
            self.copies[key] = before
        state.answers_raw.append(
            {
                "label": args.get("label"),
                "result": result,
                "parts": [
                    {
                        "label": p.get("label"),
                        "marks": p.get("marks"),
                        "accepted": p.get("accepted"),
                        "correct": p.get("correct"),
                        "points": p.get("points"),
                        "solution": p.get("solution"),
                    }
                    for p in args.get("parts") or []
                    if isinstance(p, dict)
                ],
            }
        )
        return result

    extraction.Run.copy_question = copied
    extraction.Run.record_answers = answered


async def one_job(job: dict, args, validate, model, detections: dict) -> dict:
    from pipeline import elitellm, obs
    from pipeline.config import cfg
    from pipeline.prompts.sources import source_block
    from pipeline.registry import bind_request_llm
    from pipeline.retrieval import capture, extraction, layout, limits

    refs = Path(args.refs)
    pdf = refs / f"{PAPER}.pdf"
    numbers = SELECTIONS[job["selection"]]
    photo = FILES / f"{job['selection']}.jpg" if job["selection"].startswith("thumb") else None

    async def image(number: int) -> str:
        if photo:
            return capture.data_url(_jpeg_for_model(photo, cfg, capture))
        jpeg, _box, _size = capture.render(pdf, number, None, cfg.capture_max_edge)
        return capture.data_url(jpeg)

    async def crop(number: int, box: list[float]):
        if photo:
            from PIL import Image

            with Image.open(photo) as whole:
                width, height = whole.size
                cut = whole.crop(
                    (
                        int(box[0] * width / 1000),
                        int(box[1] * height / 1000),
                        int(box[2] * width / 1000),
                        int(box[3] * height / 1000),
                    )
                )
                buffer = io.BytesIO()
                cut.save(buffer, "JPEG", quality=capture.JPEG_QUALITY)
                return buffer.getvalue(), cut.size
        jpeg, _box, size = capture.render(
            pdf, number, box, cfg.capture_max_edge, extraction.FIGURE_PAGE_EDGE
        )
        return jpeg, size

    # An image upload counts as a scan, as in production.
    layers = (
        {number: extraction.SCAN for number in numbers}
        if photo
        else extraction.page_layers(pdf, {n: "" for n in numbers})
    )
    pages = [
        extraction.Page(
            number,
            f"{job['selection'] if photo else PAPER}.{'jpg' if photo else 'pdf'}",
            "",
            functools.partial(image, number),
            functools.partial(crop, number),
            layer=layers[number],
        )
        for number in numbers
    ]
    regions = [
        tuple(
            layout.Region(r["label"], r["score"], r["box"])
            for r in detections.get(f"{PAPER}-p{number:02d}", [])
        )
        for number in numbers
    ]
    blocks = answer_blocks(job, refs, cfg, capture, source_block)
    state = State(
        selection=job["selection"],
        file=job["file"],
        mode=job["mode"],
        repeat=job["repeat"],
        nonce=secrets.token_hex(6),
        pages=numbers,
        regions=regions,
        answer_blocks=blocks,
        low_solve=job["low_solve"],
        on_solve=job["on_solve"],
        strict=job["strict"],
        map_number=job["map_number"],
        plain=job["plain"],
    )
    STATE.set(state)
    elitellm.bind_route_slot("extraction")
    bind_request_llm("mid")
    limits.bind_call_slots(limits.CallSlotPolicy(wait_s=limits.CHAT_SLOT_WAIT_S))
    usage = obs.start_usage()
    # Today's route on each file: parse-shuffled reads the doctored text, as it would.
    parsed = {
        "parse": lambda: (SCHEME, scheme_text(refs)),
        "parse-shuffled": lambda: (SCHEME, (FILES / "shuffled.txt").read_text()),
        "parse-nonumbers": lambda: (SCHEME, (FILES / "nonumbers.txt").read_text()),
        "parse-standin": lambda: (DRAWN_NAME, (FILES / "standin.caption.txt").read_text()),
    }.get(job["file"])
    schemes = [extraction.SchemeFile(*parsed())] if parsed else []
    state.started = time.monotonic()
    done: dict = {}
    async for event in extraction.run(pages, schemes, model=model, validate=validate):
        if event["type"] == "questions":
            state.copied = copy.deepcopy(event["questions"])
        else:
            done = event
    seconds = time.monotonic() - state.started
    rates = bench.CAPTIONING[2]
    micros = (
        (usage.input_tokens - usage.cached_read_tokens) * rates[0]
        + usage.cached_read_tokens * rates[1]
        + usage.output_tokens * rates[2]
    )
    return {
        "job": {
            k: job[k]
            for k in (
                "selection",
                "file",
                "mode",
                "repeat",
                "low_solve",
                "on_solve",
                "strict",
                "map_number",
                "plain",
            )
        },
        "nonce": state.nonce,
        "seconds": round(seconds, 1),
        "usage": usage.as_dict(),
        "credits": round(micros / 1_000_000, 2),
        "billed_usd": round(sum(c["cost"] or 0 for c in state.calls), 5),
        "providers": dict(collections.Counter(c["provider"] for c in state.calls)),
        "calls": state.calls,
        "sent": state.sent,
        "map_reply": state.map_reply,
        "copied": state.copied,
        "questions": done["questions"],
        "report": done["report"],
        "part_labels": state.part_labels,
        "answers_raw": state.answers_raw,
        "copies_raw": state.copies_raw,
    }


def _jpeg_for_model(path: Path, cfg, capture) -> bytes:
    """An image as a page image: production's edge and quality."""
    from PIL import Image

    with Image.open(path) as image:
        image = image.convert("RGB")
        image.thumbnail((cfg.capture_max_edge, cfg.capture_max_edge))
        buffer = io.BytesIO()
        image.save(buffer, "JPEG", quality=capture.JPEG_QUALITY)
    return buffer.getvalue()


def answer_blocks(job, refs: Path, cfg, capture, source_block) -> list[dict] | None:
    """The blocks the map's message carries for this job's answer file. None keeps
    production's wording; ``nofile`` is the new wording with no answer file."""
    if job["file"].startswith("parse") or job["file"] == "none":
        return None
    if job["file"] == "nofile":
        return []
    name, source = {
        "scheme": (SCHEME, refs / SCHEME),
        "shuffled": (SCHEME, FILES / "shuffled.pdf"),
        "nonumbers": (SCHEME, FILES / "nonumbers.pdf"),
    }.get(job["file"], (DRAWN_NAME, FILES / f"{job['file']}.jpg"))
    if job["mode"] == "txt":
        text = {
            "scheme": lambda: scheme_text(refs),
            "shuffled": lambda: (FILES / "shuffled.txt").read_text(),
            "nonumbers": lambda: (FILES / "nonumbers.txt").read_text(),
        }.get(job["file"], lambda: (FILES / f"{job['file']}.caption.txt").read_text())()
        return [{"type": "text", "text": f"{text_heading(name)}\n{source_block(text)}"}]
    blocks: list[dict] = []
    if source.suffix == ".pdf":
        import pymupdf

        with pymupdf.open(source) as doc:
            count = len(doc)
        for number in range(1, count + 1):
            jpeg, _box, _size = capture.render(
                source, number, None, cfg.capture_max_edge
            )
            blocks.append(
                {"type": "text", "text": image_heading(number, number, name)}
            )
            blocks.append(
                {"type": "image_url", "image_url": {"url": capture.data_url(jpeg)}}
            )
        return blocks
    jpeg = _jpeg_for_model(source, cfg, capture)
    return [
        {"type": "text", "text": image_heading(1, 1, name)},
        {"type": "image_url", "image_url": {"url": capture.data_url(jpeg)}},
    ]


def parse_job(text: str) -> tuple[dict, int]:
    selection, file, mode, runs = text.split(":")
    flags = mode.split("-")
    return (
        {
            "selection": selection,
            "file": file,
            "mode": flags[0],
            "low_solve": "lowsolve" in flags,
            "on_solve": "onsolve" in flags,
            "strict": "strict" in flags,
            "map_number": "mapnum" in flags,
            "plain": "plain" in flags,
            "name": f"{selection}-{file}-{mode or 'base'}",
        },
        int(runs),
    )


def spend_so_far() -> float:
    return json.loads(SPEND.read_text())["usd"] if SPEND.exists() else 0.0


async def run_jobs(args) -> None:
    from pipeline.config import cfg  # noqa: F401

    bench.load_env(args.env_file)
    LIVE["base"], LIVE["stop"] = spend_so_far(), args.hard_stop
    install()
    validate = bench.validator(bench.quizcheck())
    provider, slug, name, rates = bench.MODELS["v41-1017"]
    model = bench.spec(provider, slug, name, rates, "low")
    detections: dict = {}
    for path in args.detections:
        for page in json.loads(Path(path).read_text())["pages"]:
            detections[page["page"]] = page["regions"]
    pending: list[dict] = []
    for text in args.jobs:
        job, runs = parse_job(text)
        for repeat in range(1, runs + 1):
            path = OUT / f"{job['name']}-{repeat}.json"
            if not path.exists():
                pending.append({**job, "repeat": repeat, "path": path})
    print(f"{len(pending)} runs to do, ${LIVE['base']:.4f} spent so far", flush=True)
    gate = asyncio.Semaphore(args.parallel)

    async def guarded(job: dict) -> None:
        async with gate:
            if LIVE["base"] + LIVE["usd"] > LIVE["stop"] - 0.03:
                print(f"skip {job['path'].name}: at the budget", flush=True)
                return
            try:
                result = await asyncio.create_task(
                    one_job(job, args, validate, model, detections)
                )
            except Exception as exc:  # A run that fails is a finding; the rest go on.
                print(f"FAILED {job['path'].name}: {exc!r}"[:400], flush=True)
                (job["path"].with_suffix(".failed")).write_text(repr(exc))
                return
            job["path"].write_text(json.dumps(result))
            print(
                f"{job['path'].name}: {result['seconds']} s, ${result['billed_usd']:.4f}, "
                f"{result['credits']} credits, total ${LIVE['base'] + LIVE['usd']:.4f}",
                flush=True,
            )

    try:
        await asyncio.gather(*(guarded(job) for job in pending))
    finally:
        SPEND.write_text(json.dumps({"usd": round(LIVE["base"] + LIVE["usd"], 5)}))
    print(f"spent ${LIVE['base'] + LIVE['usd']:.4f}", flush=True)


async def caption(args) -> None:
    """A JPG's indexed text: production's image caption call, with its prompt."""
    from pipeline import elitellm  # noqa: F401
    from pipeline.config import cfg
    from pipeline.prompts.captioning import IMAGE_PROMPT
    from pipeline.registry import JobPins, set_job_pins
    from pipeline.retrieval import capture, models
    from PIL import Image

    bench.load_env(args.env_file)
    set_job_pins(
        JobPins(
            captioning=bench.spec(
                *bench.CAPTIONING[:2], "1017", bench.CAPTIONING[2], "instant"
            )
        )
    )
    source = FILES / f"{args.name}.jpg"
    with Image.open(source) as image:
        image = image.convert("RGB")
        image.thumbnail((cfg.capture_max_edge, cfg.capture_max_edge))
        buffer = io.BytesIO()
        image.save(buffer, "JPEG", quality=capture.JPEG_QUALITY)
    served = bench.pin_openrouter(bench.CAPTIONING[1], None)
    elitellm.bind_route_slot("captioning")
    started = time.monotonic()
    text = await models.caption_image(capture.data_url(buffer.getvalue()), IMAGE_PROMPT)
    (FILES / f"{args.name}.caption.txt").write_text(text or "")
    print(
        f"{args.name}: {len(text or '')} characters of caption, "
        f"{time.monotonic() - started:.1f} s, ${served[-1]['cost']}"
    )
    # What the page read costs a scanned answer file (Epo: "so we dont need to overload
    # the ocr"). Its text is not kept: the runs use the cached reads.
    if args.refs:
        for number in (3, 12):
            jpeg, _box, _size = capture.render(
                Path(args.refs) / SCHEME, number, None, 1280
            )
            started = time.monotonic()
            read = await models.read_page(capture.data_url(jpeg), credit_micros=0)
            print(
                f"page read, scheme page {number}: {len(read or '')} characters, "
                f"{time.monotonic() - started:.1f} s, ${served[-1]['cost']}"
            )
    total = sum(call["cost"] or 0 for call in served)
    SPEND.write_text(json.dumps({"usd": round(spend_so_far() + total, 5)}))


# ------------------------------------------------------------------------ the score


def norm(text: str) -> str:
    """An answer as compared: LaTeX spacing, delimiters and $ signs aside."""
    out = str(text)
    for old, new in (
        ("\\left", ""),
        ("\\right", ""),
        ("\\dfrac", "\\frac"),
        ("\\tfrac", "\\frac"),
        ("\\,", ""),
        ("\\ ", ""),
        ("\\;", ""),
        ("\\!", ""),
        ("^{\\circ}", "°"),
        ("^\\circ", "°"),
        ("\\leqslant", "\\le"),
        ("\\leq", "\\le"),
        ("≤", "\\le"),
        ("−", "-"),
        ("\\$", "$"),
    ):
        out = out.replace(old, new)
    out = re.sub(r"\\(?:text|mathrm)\{([^{}]*)\}", r"\1", out)
    out = out.replace("$", "").replace("{", "").replace("}", "")
    return re.sub(r"\s+", "", out).rstrip(".").lower()


def load_runs() -> dict[str, list[dict]]:
    runs: dict[str, list[dict]] = collections.defaultdict(list)
    for path in sorted(OUT.glob("*.json")):
        if not re.match(r"(main|long|whole|thumb)", path.name):
            continue
        result = json.loads(path.read_text())
        job = result["job"]
        mode = (
            job["mode"]
            + ("-lowsolve" if job["low_solve"] else "")
            + ("-onsolve" if job.get("on_solve") else "")
            + ("-strict" if job.get("strict") else "")
            + ("-mapnum" if job.get("map_number") else "")
            + ("-plain" if job.get("plain") else "")
        )
        runs[f"{job['selection']}:{job['file']}:{mode}"].append(result)
    return runs


def _saved_parts(result: dict) -> list[tuple[str, str, dict]]:
    """Every saved part: question label, part label, the part."""
    out = []
    labels = result["part_labels"]
    from_key = re.compile(r"[a-z]+|\d+")
    for label, question in zip(result["report"]["recorded"], result["questions"]):
        key = ".".join(from_key.findall(label.lower()))
        names = labels.get(key) or [""] * len(question["parts"])
        for name, part in zip(names, question["parts"]):
            out.append((label, name, part))
    return out


def _part_key(label: str, name: str) -> str:
    return f"{label}({name})" if name else label


def _answer_text(part: dict) -> str:
    answer = part["answer"]
    return " | ".join(str(v) for v in answer.get("accepted") or [])


def judge(result: dict, truth: dict, judged: dict, file: str) -> dict:
    """Parts right against the truth's answers: an answer holding one of a part's forms,
    or a reading judged by hand from the scheme's page."""
    overrides = truth.get("planted", {}) if file.endswith("standin") else {}
    right, wrong, unknown, followed, corrected = 0, [], [], [], []
    for label, name, part in _saved_parts(result):
        key = _part_key(label, name)
        forms = truth["answers"].get(key)
        if forms is None:
            continue
        given = norm(_answer_text(part))
        planted = overrides.get(key)
        if planted:
            if any(norm(form) in given for form in planted):
                followed.append(key)
            elif any(norm(form) in given for form in forms):
                corrected.append(key)
            continue
        verdict = judged.get(key, {}).get(given)
        if verdict is None and any(norm(form) in given for form in forms):
            verdict = True
        if verdict is True:
            right += 1
        elif verdict is False:
            wrong.append(key)
        else:
            unknown.append((key, _answer_text(part)))
    return {
        "right": right,
        "wrong": wrong,
        "unknown": unknown,
        "followed": followed,
        "corrected": corrected,
    }


def marks_of(result: dict) -> dict[str, int]:
    return {
        _part_key(label, name): part["marks"] for label, name, part in _saved_parts(result)
    }


def spread(values: list[float], places: int = 0) -> str:
    if not values:
        return "-"
    fmt = f"{{:.{places}f}}"
    mean = fmt.format(statistics.mean(values))
    return f"{mean} ({fmt.format(min(values))}-{fmt.format(max(values))})"


def score(args) -> None:
    truth = json.loads((OUT / "truth.json").read_text())
    judged_path = OUT / "judged.json"
    judged = json.loads(judged_path.read_text()) if judged_path.exists() else {}
    gold = json.loads((bench.GOLD / f"{PAPER}.json").read_text())
    gold_marks = {
        _part_key(q["label"], p["label"]): p["marks"]
        for q in gold["questions"]
        for p in q["parts"]
    }
    questions = {q["label"]: [p["label"] for p in q["parts"]] for q in gold["questions"]}
    runs = load_runs()
    unknown: dict[str, collections.Counter] = collections.defaultdict(collections.Counter)
    print(
        "| Set | Runs | Wall s | Credits | Billed | Calls | Body MB, all calls | First call MB "
        "| Answers right of 19 | Marks right of 19 | Questions with all marks right of 10 "
        "| Q4 split 3, 1 | Q7 split 1, 1, 2 | Rows off the map's 10 | Refusals | No answer |"
    )
    print("|---|---:|---|---|---|---:|---|---|---|---|---|---:|---:|---:|---:|---:|")
    for name in sorted(runs):
        results = runs[name]
        if not name.startswith("main:"):
            continue
        file = name.split(":")[1]
        right, marks_right, whole, q4, q7, extra, refused, missing = [], [], [], 0, 0, [], [], []
        for result in results:
            verdict = judge(result, truth, judged, file)
            right.append(verdict["right"])
            for key, text in verdict["unknown"]:
                unknown[key][text] += 1
            marks = marks_of(result)
            marks_right.append(sum(marks.get(k) == v for k, v in gold_marks.items()))
            whole.append(
                sum(
                    all(
                        marks.get(_part_key(label, part)) == gold_marks[_part_key(label, part)]
                        for part in parts
                    )
                    for label, parts in questions.items()
                )
            )
            q4 += (marks.get("4(a)"), marks.get("4(b)")) == (3, 1)
            q7 += (marks.get("7(a)"), marks.get("7(b)"), marks.get("7(c)")) == (1, 1, 2)
            extra.append(len([x for x in result["report"]["expected"] if x not in questions]))
            refused.append(
                sum(
                    not r["result"].endswith("recorded.")
                    for r in [*result["answers_raw"], *result["copies_raw"]]
                )
            )
            missing.append(len(result["report"].get("answersMissing") or []))
        print(
            f"| {name} | {len(results)} | {spread([r['seconds'] for r in results])} "
            f"| {spread([r['credits'] for r in results], 1)} "
            f"| ${statistics.mean(r['billed_usd'] for r in results):.4f} "
            f"| {statistics.mean(len(r['calls']) for r in results):.1f} "
            f"| {statistics.mean(sum(c['body_bytes'] for c in r['calls']) for r in results) / 1e6:.1f} "
            f"| {statistics.mean(r['calls'][0]['body_bytes'] for r in results) / 1e6:.2f} "
            f"| {', '.join(map(str, right))} | {', '.join(map(str, marks_right))} "
            f"| {', '.join(map(str, whole))} | {q4} of {len(results)} | {q7} of {len(results)} "
            f"| {sum(extra)} | {sum(refused)} | {sum(missing)} |"
        )
    print()
    for name in sorted(runs):
        if "standin" in name:
            for result in runs[name]:
                verdict = judge(result, truth, judged, name.split(":")[1])
                print(name, "followed", verdict["followed"], "corrected", verdict["corrected"])
    print("\nReadings no form matched, to judge from the scheme's page:")
    for key in sorted(unknown):
        for text, count in unknown[key].most_common():
            print(f"  {key} x{count}: {text[:160]}")
    print("\nMarks that differ from gold, by set:")
    for name in sorted(runs):
        if not name.startswith("main:"):
            continue
        off: collections.Counter = collections.Counter()
        for result in runs[name]:
            marks = marks_of(result)
            for key, value in gold_marks.items():
                if marks.get(key) != value:
                    off[f"{key}={marks.get(key)}"] += 1
        print(f"  {name}: {dict(off)}")
    print("\nMarks as copied right of 19, and parts whose marks the solve changed:")
    for name in sorted(runs):
        if not name.startswith("main:"):
            continue
        copied, moved = [], []
        for result in runs[name]:
            first: dict[str, int] = {}
            for row in result["copies_raw"]:
                if row["result"].endswith("recorded."):
                    labels = result["part_labels"].get(str(row["label"]), [])
                    for part, marks in zip(labels, row["marks"]):
                        first[_part_key(str(row["label"]), part)] = marks
            copied.append(sum(first.get(k) == v for k, v in gold_marks.items()))
            final = marks_of(result)
            moved.append(sum(first.get(k) != final.get(k) for k in gold_marks))
        print(f"  {name}: copied {copied}, moved {moved}")
    print("\nCache: the lowest cached share on calls after the first, by set:")
    for name in sorted(runs):
        shares = [
            (call.get("cached") or 0) / max(call.get("input") or 1, 1)
            for result in runs[name]
            for call in result["calls"][1:]
            if call["purpose"] not in ("extraction_scheme", "extraction_figures")
        ]
        finish = collections.Counter(
            call["finish"] for result in runs[name] for call in result["calls"]
        )
        longest = max(
            (call.get("output") or 0 for result in runs[name] for call in result["calls"]),
            default=0,
        )
        providers = collections.Counter(
            call["provider"] for result in runs[name] for call in result["calls"]
        )
        print(
            f"  {name}: {min(shares, default=0):.3f}, finish {dict(finish)}, longest reply "
            f"{longest}, {dict(providers)}"
        )
    print("\nBy stage, mean a run:")
    for name in sorted(runs):
        stages: dict[str, list] = collections.defaultdict(lambda: [0, 0, 0, 0.0])
        for result in runs[name]:
            for call in result["calls"]:
                stage = stages[call["purpose"].replace("extraction_", "")]
                stage[0] += call.get("input") or 0
                stage[1] += call.get("output") or 0
                stage[2] += call.get("reasoning") or 0
                stage[3] += call.get("cost") or 0.0
        count = len(runs[name])
        cells = ", ".join(
            f"{stage} in {v[0] // count} out {v[1] // count} reasoning {v[2] // count} ${v[3] / count:.4f}"
            for stage, v in stages.items()
        )
        print(f"  {name}: {cells}")
    long_numbers(runs, truth)


def long_numbers(runs: dict[str, list[dict]], truth: dict) -> None:
    """Each long number of the scheme's working: does the run's saved text hold it digit
    for digit? Parts' answers, marking points and solutions, spacing aside."""
    numbers = truth.get("long_numbers") or []
    if not numbers:
        return
    print("\nLong numbers held, of", len(numbers), ":")
    for name in sorted(runs):
        if not name.startswith("long:"):
            continue
        held: list[int] = []
        others: collections.Counter = collections.Counter()
        for result in runs[name]:
            text = re.sub(
                r"[\s\\]|\{|\}",
                "",
                json.dumps(result["questions"], ensure_ascii=False),
            )
            held.append(sum(re.sub(r"\s", "", n) in text for n in numbers))
            allowed = {re.sub(r"\s", "", n) for n in numbers}
            others.update(
                n
                for n in re.findall(r"\d+\.\d{5,}|\d(?:,?\d{3}){2,}", text)
                if n.replace(",", "") not in allowed
            )
        seconds = [r["seconds"] for r in runs[name]]
        print(
            f"  {name}: {held}, {spread(seconds)} s, "
            f"${statistics.mean(r['billed_usd'] for r in runs[name]):.4f}, other long numbers "
            f"{dict(others)}"
        )


def main() -> None:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    make = sub.add_parser("make")
    make.add_argument("--refs", required=True)
    make.add_argument("--only", choices=["images", "text", "standin"])
    run = sub.add_parser("run")
    run.add_argument("--refs", required=True)
    run.add_argument("--detections", nargs="*", default=[])
    run.add_argument("--env-file", required=True)
    run.add_argument("--jobs", nargs="+", required=True)
    run.add_argument("--parallel", type=int, default=PARALLEL)
    run.add_argument("--hard-stop", type=float, default=1.0)
    cap = sub.add_parser("caption")
    cap.add_argument("--env-file", required=True)
    cap.add_argument("--name", default="standin")
    cap.add_argument("--refs")
    scored = sub.add_parser("score")
    scored.add_argument("--refs", required=True)
    args = parser.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    FILES.mkdir(parents=True, exist_ok=True)
    if args.command == "make":
        refs = Path(args.refs)
        if args.only in (None, "images"):
            make_images(refs)
        if args.only in (None, "text"):
            make_text(refs)
        if args.only in (None, "standin"):
            make_standin()
    elif args.command == "run":
        asyncio.run(run_jobs(args))
    elif args.command == "caption":
        asyncio.run(caption(args))
    else:
        score(args)


if __name__ == "__main__":
    main()
