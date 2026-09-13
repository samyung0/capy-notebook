"""Running page furniture, decided once before source-geometry table recovery.

A running header or footer is a non-heading text block whose text recurs on
three or more pages. The chunker drops it. The decision has to be made on the
block list *before* ``tables.recover_tables`` replaces covered blocks, or a
header that sat inside one recovered region would fall below the threshold on
the remaining pages (and vice versa); the frozen texts travel to the ingest
worker in the bundle's ``refinement.json``.

The rule and the text key are those of ``pipeline.retrieval.chunking``
(``_repeated_across_pages``, ``clean_inline``, ``_normalized``). The parser
cannot import the pipeline, so they are copied here and
``pipeline/tests/test_packing.py`` pins the two copies equal.
"""

from __future__ import annotations

import re
from collections import defaultdict

import pymupdf

REPEATED_ON_PAGES = 3
REPEATABLE_TYPES = frozenset({"text", "header", "page_footnote"})

_CJK_RANGES = (
    (0x3040, 0x30FF),  # kana
    (0x3400, 0x4DBF),  # CJK ext A
    (0x4E00, 0x9FFF),  # CJK unified
    (0xF900, 0xFAFF),  # compatibility ideographs
    (0xAC00, 0xD7AF),  # hangul
)
CJK_CLASS = "[" + "".join(f"{chr(lo)}-{chr(hi)}" for lo, hi in _CJK_RANGES) + "]"
_MARKER_SUP_RE = re.compile(
    r"(^|[^\W\d_]{3}|" + CJK_CLASS + r")[∗*]?\s?<sup>\s*[\d,+*∗†‡\s]+</sup>",
    re.MULTILINE,
)
_SUB_SUP_RE = re.compile(r"</?su[bp]>")
_INLINE_MATH_RE = re.compile(r"\$([^$]+)\$")
_MATH_SPACING_RE = re.compile(r"\s*([{}^_])\s*")


def clean_inline(text: str) -> str:
    """Drop sub/superscript tags and collapse spacing inside inline LaTeX."""
    text = _MARKER_SUP_RE.sub(r"\1", text)
    text = _SUB_SUP_RE.sub("", text)
    return _INLINE_MATH_RE.sub(
        lambda m: "$" + _MATH_SPACING_RE.sub(r"\1", m.group(1)).strip() + "$", text
    )


def normalized(text: str) -> str:
    return " ".join(text.split())


def repeated_across_pages(blocks: list[dict]) -> list[str]:
    """Sorted furniture keys: ``normalized(clean_inline(text))`` of the
    non-heading prose blocks that recur on ``REPEATED_ON_PAGES`` pages."""
    pages: dict[str, set[int]] = {}
    for block in blocks:
        if block.get("type") not in REPEATABLE_TYPES:
            continue
        level = block.get("text_level")
        if isinstance(level, int) and level > 0:
            continue
        page = block.get("page_idx")
        text = normalized(clean_inline(str(block.get("text") or "")))
        if text and isinstance(page, int):
            pages.setdefault(text, set()).add(page)
    return sorted(
        text for text, seen in pages.items() if len(seen) >= REPEATED_ON_PAGES
    )


def _folio(text: str) -> tuple[str, int] | None:
    text = text.strip(" \t\n|–—-").lower()
    if re.fullmatch(r"[1-9]\d{0,3}", text):
        return "decimal", int(text)
    if not text or not re.fullmatch(
        r"m{0,3}(cm|cd|d?c{0,3})(xc|xl|l?x{0,3})(ix|iv|v?i{0,3})", text
    ):
        return None
    values = {"i": 1, "v": 5, "x": 10, "l": 50, "c": 100, "d": 500, "m": 1000}
    numbers = [values[c] for c in text]
    return "roman", sum(
        -n if i + 1 < len(numbers) and n < numbers[i + 1] else n
        for i, n in enumerate(numbers)
    )


def mark_page_numbers(blocks: list[dict], document: pymupdf.Document) -> list[dict]:
    """Classify isolated, source-matched folios with a repeated ordinal offset.

    A short value alone is insufficient. It must sit below all body lines,
    match PDF glyphs, and share font, location and page offset on three pages.
    """
    groups: dict[tuple, list[tuple[int, int]]] = defaultdict(list)
    page_lines: dict[int, list[dict]] = {}
    for index, block in enumerate(blocks):
        box, page_idx = block.get("bbox", []), block.get("page_idx")
        folio = _folio(str(block.get("text", "")))
        if (
            block.get("type") != "text"
            or len(box) != 4
            or box[1] <= 900
            or folio is None
            or type(page_idx) is not int
        ):
            continue
        page = document[page_idx]
        if page.rotation:
            continue
        lines = page_lines.setdefault(page_idx, [])
        if not lines:
            lines.extend(
                line
                for group in page.get_text(
                    "dict", flags=pymupdf.TEXTFLAGS_DICT & ~pymupdf.TEXT_PRESERVE_IMAGES
                )["blocks"]
                for line in group.get("lines", [])
                if any(s["text"].strip() for s in line["spans"])
            )
        rect = pymupdf.Rect(
            box[0] * page.rect.width / 1000,
            box[1] * page.rect.height / 1000,
            box[2] * page.rect.width / 1000,
            box[3] * page.rect.height / 1000,
        )
        matching = [
            line
            for line in lines
            if (pymupdf.Rect(line["bbox"]) & rect).get_area()
            >= pymupdf.Rect(line["bbox"]).get_area() * 0.6
        ]
        if len(matching) != 1:
            continue
        line = matching[0]
        if normalized(" ".join(s["text"] for s in line["spans"])) != normalized(
            str(block["text"])
        ):
            continue
        spans = [s for s in line["spans"] if s["text"].strip()]
        if len({(s["font"], round(s["size"], 1)) for s in spans}) != 1:
            continue
        style = spans[0]
        if any(
            other is not line and other["bbox"][3] > line["bbox"][1] - style["size"]
            for other in lines
        ):
            continue
        key = (
            folio[0],
            folio[1] - page_idx,
            round((box[0] + box[2]) / 50),
            round((box[1] + box[3]) / 20),
            style["font"],
            round(style["size"]),
        )
        groups[key].append((index, page_idx))
    classified = {
        index
        for group in groups.values()
        if len({page for _, page in group}) >= 3
        for index, _ in group
    }
    result = list(blocks)
    for index in classified:
        result[index] = {**blocks[index], "type": "page_number", "_source_folio": True}
        # Heading retention runs after packing; a proven folio must not become
        # an orphan heading again, including alphabetic Roman numerals.
        result[index].pop("text_level", None)
    return result
