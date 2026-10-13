"""One text extraction per page for the refinement stages.

Nine stages read the same ``get_text("dict")`` of a page (heading evidence,
role correction, list headings, line geometry, picture triage, furniture,
reading order, tables) and three picture stages its words. Inside ``session``
the first read of a page is kept and later stages reuse it, until the kept
pages hold ``SPAN_BUDGET`` spans (about 950 bytes each, so 90 MiB; a word
counts as a span); pages past the budget are read again as before. A dense
1,400-page book would need 450 MiB, which the ingest host's five workers
cannot afford. The result is shared, so callers only read it.

The text trace (0.7 GiB for the same book) is never kept: ``trace_facts``
keeps only what its two readers need, hidden-layer character counts and faint
rotated runs that may be watermarks.
"""

from __future__ import annotations

import statistics
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

import pymupdf

TEXT_FLAGS = pymupdf.TEXTFLAGS_DICT & ~pymupdf.TEXT_PRESERVE_IMAGES
SPAN_BUDGET = 100_000

_session: dict | None = None


@contextmanager
def session(pdf: Path) -> Iterator[None]:
    """Keep page reads of ``pdf`` for the duration of one parse."""
    global _session
    _session = {"name": str(pdf), "pages": {}, "words": {}, "spans": 0, "traces": {}}
    try:
        yield
    finally:
        _session = None


def page_dict(page: pymupdf.Page) -> dict:
    """``page.get_text("dict", flags=TEXT_FLAGS)``, read once per page."""
    if _session is None or page.parent.name != _session["name"]:
        return page.get_text("dict", flags=TEXT_FLAGS)
    pages = _session["pages"]
    if page.number in pages:
        return pages[page.number]
    raw = page.get_text("dict", flags=TEXT_FLAGS)
    spans = sum(
        len(line["spans"]) for b in raw["blocks"] for line in b.get("lines", [])
    )
    if _session["spans"] + spans <= SPAN_BUDGET:
        pages[page.number] = raw
        _session["spans"] += spans
    return raw


def kept_or_room(page: pymupdf.Page) -> bool:
    """Whether ``page_dict`` would serve this page from, or add it to, the
    session's pages: false past the budget, where a reader with its own
    extraction (a rawdict) should not read the page twice."""
    if _session is None or page.parent.name != _session["name"]:
        return False
    return page.number in _session["pages"] or _session["spans"] < SPAN_BUDGET


def page_words(page: pymupdf.Page) -> list:
    """``page.get_text("words")``, read once per page; each word counts as a
    span against the budget."""
    if _session is None or page.parent.name != _session["name"]:
        return page.get_text("words")
    kept = _session["words"]
    if page.number in kept:
        return kept[page.number]
    words = page.get_text("words")
    if _session["spans"] + len(words) <= SPAN_BUDGET:
        kept[page.number] = words
        _session["spans"] += len(words)
    return words


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
