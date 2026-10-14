"""One text extraction per page for the refinement stages.

Most structure and repair stages read a page's ``get_text("dict")`` or
``get_text("rawdict")`` (heading evidence and roles, line joins, list and
layout headings, picture triage, furniture, reading order, tables, glyph
repairs, column continuations, exponents, formula structure): about six reads
per page of a 1,400-page book, most of whose cost is MuPDF building the dicts.
Inside ``session`` the first read of a page extracts its rawdict once and keeps
it in columns until the parse ends:

- integer arrays: per block its number, flags and end of its lines; per line
  its writing mode and end of its spans; per span its style and end of its
  characters; the indexes of synthetic characters;
- float32 arrays for their boxes, points, directions and sizes (MuPDF's are C
  floats, so they round-trip exactly);
- the characters as one string;
- the document's styles (font, flags, colour and the rest of a span's keys
  except its size), shared by index.

``page_dict`` and ``page_raw`` build the dicts MuPDF returns from that, key for
key, several times faster than MuPDF does; ``page_words`` keeps words the same
way. The 1,400-page book (469k spans, 2.2M characters) keeps 74 MiB where the
dicts would take about 400 MiB. Past ``CHAR_BUDGET`` kept characters
(words count theirs) pages are read from MuPDF on each call, as before the
store, so a pathological file cannot grow every parse child. Nothing
outlives the session.

The text trace (0.7 GiB for the same book) is never kept: ``trace_facts``
keeps only what its two readers need, hidden-layer character counts and faint
rotated runs that may be watermarks.
"""

from __future__ import annotations

import statistics
from array import array
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

import pymupdf

TEXT_FLAGS = pymupdf.TEXTFLAGS_DICT & ~pymupdf.TEXT_PRESERVE_IMAGES
# About 35 bytes each with their boxes and spans, so about 200 MiB; the
# densest book in the corpus would keep about 4M at the 1,400-page cap.
CHAR_BUDGET = 6_000_000
# A span's keys between its size and its text, in MuPDF's order.
STYLE_KEYS = (
    "flags",
    "bidi",
    "char_flags",
    "font",
    "color",
    "alpha",
    "ascender",
    "descender",
)

_session: dict | None = None


@contextmanager
def session(pdf: Path) -> Iterator[None]:
    """Keep page reads of ``pdf`` for the duration of one parse."""
    global _session
    _session = {
        "name": str(pdf),
        "pages": {},
        "styles": {},  # STYLE_KEYS values -> index into "spans"
        "spans": [],  # those values as a dict, per index
        "words": {},
        "chars": 0,  # kept, against CHAR_BUDGET
        "traces": {},
    }
    try:
        yield
    finally:
        _session = None


class _Columns:
    """One page's rawdict in columns (see the module docstring)."""

    __slots__ = (
        "block_boxes",
        "blocks",
        "char_boxes",
        "height",
        "line_boxes",
        "lines",
        "span_boxes",
        "spans",
        "synthetic",
        "text",
        "width",
    )

    def __init__(self, raw: dict, styles: dict, spans: list[dict]) -> None:
        self.width, self.height = raw["width"], raw["height"]
        # Lists while reading, then arrays of exactly their size.
        blocks, block_boxes, lines, line_boxes = [], [], [], []
        spans_, span_boxes, char_boxes, text, synthetic = [], [], [], [], []
        for block in raw["blocks"]:
            for line in block["lines"]:
                for span in line["spans"]:
                    values = tuple(span[k] for k in STYLE_KEYS)
                    if values not in styles:
                        styles[values] = len(spans)
                        spans.append(dict(zip(STYLE_KEYS, values)))
                    for char in span["chars"]:
                        if char["synthetic"]:
                            synthetic.append(len(text))
                        text.append(char["c"])
                        char_boxes += char["origin"]
                        char_boxes += char["bbox"]
                    spans_ += (styles[values], len(text))
                    span_boxes.append(span["size"])
                    span_boxes += span["origin"]
                    span_boxes += span["bbox"]
                lines += (line["wmode"], len(spans_) // 2)
                line_boxes += line["dir"]
                line_boxes += line["bbox"]
            blocks += (block["number"], block["flags"], len(lines) // 2)
            block_boxes += block["bbox"]
        self.blocks, self.block_boxes = array("i", blocks), array("f", block_boxes)
        self.lines, self.line_boxes = array("i", lines), array("f", line_boxes)
        self.spans, self.span_boxes = array("i", spans_), array("f", span_boxes)
        self.char_boxes = array("f", char_boxes)
        self.text = "".join(text)
        self.synthetic = array("i", synthetic)

    def dicts(self, styles: list[dict], raw: bool) -> dict:
        """The page's ``get_text("rawdict" if raw else "dict")``."""
        text = self.text
        if raw:
            g = iter(self.char_boxes.tolist())
            chars = [
                {"origin": (a, b), "bbox": (x0, y0, x1, y1), "c": c, "synthetic": False}
                for c, a, b, x0, y0, x1, y1 in zip(text, g, g, g, g, g, g)
            ]
            for i in self.synthetic:
                chars[i]["synthetic"] = True
        key = "chars" if raw else "text"
        blocks, lines, spans = self.blocks, self.lines, self.spans
        block_boxes = self.block_boxes.tolist()
        line_boxes = self.line_boxes.tolist()
        span_boxes = self.span_boxes.tolist()
        out = []
        line = span = start = 0
        for b in range(0, len(blocks), 3):
            line_dicts = []
            while line < blocks[b + 2]:
                span_dicts = []
                while span < lines[2 * line + 1]:
                    end, f = spans[2 * span + 1], 7 * span
                    span_dicts.append(
                        {
                            "size": span_boxes[f],
                            **styles[spans[2 * span]],
                            key: chars[start:end] if raw else text[start:end],
                            "origin": (span_boxes[f + 1], span_boxes[f + 2]),
                            "bbox": tuple(span_boxes[f + 3 : f + 7]),
                        }
                    )
                    start = end
                    span += 1
                f = 6 * line
                line_dicts.append(
                    {
                        "spans": span_dicts,
                        "wmode": lines[2 * line],
                        "dir": (line_boxes[f], line_boxes[f + 1]),
                        "bbox": tuple(line_boxes[f + 2 : f + 6]),
                    }
                )
                line += 1
            f = 4 * b // 3
            out.append(
                {
                    "type": 0,
                    "number": blocks[b],
                    "flags": blocks[b + 1],
                    "bbox": tuple(block_boxes[f : f + 4]),
                    "lines": line_dicts,
                }
            )
        return {"width": self.width, "height": self.height, "blocks": out}


def _columns(page: pymupdf.Page) -> _Columns | None:
    """The page's columns, extracted on first use; None outside the session
    or once the budget is spent."""
    if _session is None or page.parent.name != _session["name"]:
        return None
    pages = _session["pages"]
    if page.number not in pages:
        if _session["chars"] >= CHAR_BUDGET:
            return None
        pages[page.number] = _Columns(
            page.get_text("rawdict", flags=TEXT_FLAGS),
            _session["styles"],
            _session["spans"],
        )
        _session["chars"] += len(pages[page.number].text)
    return pages[page.number]


def page_dict(page: pymupdf.Page) -> dict:
    """``page.get_text("dict", flags=TEXT_FLAGS)``, extracted once per page;
    a new dict each call."""
    columns = _columns(page)
    if columns is None:
        return page.get_text("dict", flags=TEXT_FLAGS)
    return columns.dicts(_session["spans"], raw=False)


def page_raw(page: pymupdf.Page) -> dict:
    """``page.get_text("rawdict", flags=TEXT_FLAGS)``, extracted once per page;
    a new dict each call."""
    columns = _columns(page)
    if columns is None:
        return page.get_text("rawdict", flags=TEXT_FLAGS)
    return columns.dicts(_session["spans"], raw=True)


def kept_characters(page: pymupdf.Page) -> int:
    """Non-space characters of the page's kept extraction, 0 when no stage
    read the page: a lower bound for its plain text (``get_text()``, same
    flags), which holds each of them."""
    if _session is None or page.parent.name != _session["name"]:
        return 0
    columns = _session["pages"].get(page.number)
    return 0 if columns is None else len("".join(columns.text.split()))


class _Words:
    """One page's words: boxes as float32, (block, line, word) numbers as ints,
    the texts as one string with their ends."""

    __slots__ = ("boxes", "ends", "numbers", "text")

    def __init__(self, words: list[tuple]) -> None:
        self.boxes, self.numbers, self.ends = array("f"), array("i"), array("i")
        texts, end = [], 0
        for x0, y0, x1, y1, text, *numbers in words:
            self.boxes.extend((x0, y0, x1, y1))
            self.numbers.extend(numbers)
            texts.append(text)
            end += len(text)
            self.ends.append(end)
        self.text = "".join(texts)

    def tuples(self) -> list[tuple]:
        b, n = iter(self.boxes.tolist()), iter(self.numbers)
        starts = [0, *self.ends[:-1]]
        return [
            (x0, y0, x1, y1, self.text[start:end], block, line, word)
            for x0, y0, x1, y1, block, line, word, start, end in zip(
                b, b, b, b, n, n, n, starts, self.ends
            )
        ]


def page_words(page: pymupdf.Page) -> list:
    """``page.get_text("words")``, extracted once per page; a new list each
    call."""
    if _session is None or page.parent.name != _session["name"]:
        return page.get_text("words")
    words = _session["words"]
    if page.number not in words:
        if _session["chars"] >= CHAR_BUDGET:
            return page.get_text("words")
        words[page.number] = _Words(page.get_text("words"))
        _session["chars"] += len(words[page.number].text)
    return words[page.number].tuples()


def trace_facts(page: pymupdf.Page) -> dict:
    """Character counts (all, and invisible: render mode 3 or zero opacity),
    the median size of horizontal opaque runs (None without any), and the
    faint (opacity at most 0.2) rotated runs."""
    cached = _session is not None and page.parent.name == _session["name"]
    if cached and page.number in _session["traces"]:
        return _session["traces"][page.number]
    spans = page.get_texttrace()
    sizes = [
        s["size"]
        for s in spans
        if abs(s["dir"][1]) < 0.01 and s.get("opacity", 1) > 0.5
    ]
    facts = {
        "characters": sum(len(s["chars"]) for s in spans),
        "hidden_characters": sum(
            len(s["chars"]) for s in spans if s["type"] == 3 or s["opacity"] == 0
        ),
        "ordinary_size": statistics.median(sizes) if sizes else None,
        "faint_rotated": [
            s for s in spans if abs(s["dir"][1]) > 0.25 and s.get("opacity", 1) <= 0.2
        ],
    }
    if cached:
        _session["traces"][page.number] = facts
    return facts
