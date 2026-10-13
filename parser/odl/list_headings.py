"""Numbered headings ODL folded into list items (parser v13).

ODL reads a numbered section heading ("1.5 Noise models", "5.10 Examine system
telemetry data", "（3）社会教育施設…", "Artículo 18. Organización.") as a list
item, alone or with the paragraphs after it, so every later chunk keeps the
previous section's path. A source line inside a list block that starts with
section numbering and is set in a heading style (larger than the page's body
text, or bold where the body is not) splits the list there: the items before it
stay a list, the heading becomes a heading block, and the text after it, up to
the next such heading, a paragraph. A heading whose text cannot be found in the
items leaves the list as it was.
"""

from __future__ import annotations

import re
from collections import Counter
from itertools import pairwise

import pymupdf

from . import page_text

# The numbering that opens a section heading: "1.5", "34.", "（3）", "Artículo 18",
# "§ 2-110(2)", "C.", "IV.". A bare integer ("3 Anaphase I") is too often a
# figure step or a contents page number, a lower-case letter an exercise part.
NUMBERING = re.compile(
    r"^(?:\d{1,3}(?:\.\d{1,3}){1,4}\.?(?=\s)"
    r"|\d{1,3}\.(?=\s)"
    r"|[（(]\d{1,3}[）)]"
    r"|(?:art[íi]culo|article|artikel|section|§)\s*\d[\w().-]*"
    r"|(?-i:[A-H]|[IVX]{1,5})\.(?=\s))",
    re.IGNORECASE,
)
_KEYWORD = re.compile(r"^(?:art[íi]culo|article|artikel|section|§)", re.IGNORECASE)
_LEADER = re.compile(r"\.{4,}|(?:\.\s){3,}|…{2,}")
MAX_WORDS = 10
MAX_HEADING = 120
PROSE = 80  # characters: an item at least this long is running text


def numbered_heading(text: str) -> bool:
    """Numbering followed by a short title: not a question, an instruction
    ("1. Define healthcare management."), a run-in label, a contents entry with
    leaders, a number ("0.000 1.00", "76 %"), or a lower-case run-on."""
    m = NUMBERING.match(text)
    if not m or "?" in text or "？" in text or _LEADER.search(text):
        return False
    title = text[m.end() :].strip()
    words = [w for w in title.split() if any(c.isalpha() for c in w)]
    if not title or _KEYWORD.match(text):
        return len(words) <= MAX_WORDS and bool(_KEYWORD.match(text))
    if (
        len(words) > MAX_WORDS
        or (len(words) >= 3 and title.endswith("."))
        or re.search(r"\.\s+\S", title)  # a run-in label: "9.4. Corollary. Under…"
    ):
        return False
    first = title.split()[0]
    cjk = ord(title[0]) >= 0x2E80
    letters = sum(c.isalpha() for c in first)
    return title[0].isalpha() and not title[0].islower() and (cjk or letters >= 2)


def _kind(text: str) -> str:
    """The numbering family, so a split heading takes a sibling's level."""
    text = text.strip()
    if re.match(r"[（(]\d", text):
        return "paren"
    if m := re.match(r"\d{1,3}((?:\.\d{1,3})*)", text):
        return f"dotted{m[1].count('.')}"
    if re.match(r"[IVX]{1,5}\.", text):
        return "roman"
    if re.match(r"[A-H]\.", text):
        return "upper"
    return re.split(r"\s", text.casefold(), maxsplit=1)[0]


def _compact(text: str) -> tuple[str, list[int]]:
    """Text without whitespace, casefolded, and each character's index."""
    chars, where = [], []
    for index, ch in enumerate(text):
        if not ch.isspace():
            folded = ch.casefold()  # "ß" folds to two characters
            chars.append(folded)
            where.extend([index] * len(folded))
    return "".join(chars), where


def _weight(span: dict) -> int:
    """Font weight from the bold flag or the font name (CMBX, -Medium, -DeBold)."""
    name = span["font"].casefold()
    if span["flags"] & 16 or re.search(r"bold|black|heavy|cmbx|demi", name):
        return 3
    if "medium" in name:
        return 2
    if re.search(r"light|thin", name):
        return 0
    return 1


def _italic(span: dict) -> bool:
    return bool(span["flags"] & 2) or bool(
        re.search(r"italic|oblique|cmti", span["font"].casefold())
    )


def _body_style(lines: list[dict]) -> tuple[float, int, bool]:
    """The page's most common size, weight and slant, by characters."""
    weight: Counter = Counter()
    for line in lines:
        for span in line["spans"]:
            weight[round(span["size"], 1), _weight(span), _italic(span)] += len(
                span["text"]
            )
    return weight.most_common(1)[0][0] if weight else (0.0, 1, False)


def _rows(lines: list[dict]) -> list[dict]:
    """Lines on one baseline joined left to right: a number set apart from its
    title ("1.5" then "Noise models…") is one row."""
    rows: list[dict] = []
    for line in sorted(lines, key=lambda line: (line["bbox"][1], line["bbox"][0])):
        box = pymupdf.Rect(line["bbox"])
        last = rows[-1] if rows else None
        if (
            last
            and box.x0 >= last["rect"].x1 - 1
            and min(box.y1, last["rect"].y1) - max(box.y0, last["rect"].y0)
            >= 0.5 * min(box.height, last["rect"].height)
        ):
            last["spans"] = [*last["spans"], {**line["spans"][0], "text": " "}]
            last["spans"] += line["spans"]
            last["rect"] |= box
        else:
            rows.append({"spans": list(line["spans"]), "rect": box})
    return rows


def _heading_lines(lines: list[dict], body: tuple[float, int, bool]) -> list[dict]:
    """Numbered rows set in a heading style, a wrapped heading's second row
    (same style, no number) joined to it. The numbering must be larger or
    heavier than the body; the rest of the row may also be italic
    ("Artículo 18. Organización.")."""
    size, weight, italic = body

    def emphasised(span: dict) -> bool:
        return span["size"] >= size + 0.8 or _weight(span) > weight

    found: list[dict] = []
    previous = None
    for row in _rows(lines):
        spans = [s for s in row["spans"] if s["text"].strip()]
        text = " ".join("".join(s["text"] for s in row["spans"]).split())
        if not spans or len(text) > MAX_HEADING:
            previous = None
            continue
        styled = sum(
            len(s["text"])
            for s in spans
            if emphasised(s) or (_italic(s) and not italic)
        )
        heading = styled >= 0.8 * sum(len(s["text"]) for s in spans)
        if heading and emphasised(spans[0]) and NUMBERING.match(text):
            previous = {"text": text, "rect": row["rect"]}
            found.append(previous)
        elif heading and previous is not None and not NUMBERING.match(text):
            previous["text"] += " " + text
            previous["rect"] |= row["rect"]
        else:
            previous = None
    return [head for head in found if numbered_heading(head["text"])]


def split_headings(blocks: list[dict], document: pymupdf.Document) -> list[dict]:
    out: list[dict] = []
    levels: dict[str, int] = {}
    page_cache: dict[int, tuple[list[dict], tuple[float, int, bool]]] = {}
    for block in blocks:
        level = block.get("text_level")
        if isinstance(level, int) and level > 0:
            levels[_kind(str(block.get("text", "")))] = level
            levels["last"] = level
        page_index = block.get("page_idx")
        if (
            block.get("type") != "list"
            or len(block.get("bbox") or []) != 4
            or type(page_index) is not int
            or document[page_index].rotation
        ):
            out.append(block)
            continue
        page = document[page_index]
        if page_index not in page_cache:
            lines = [
                line
                for group in page_text.page_dict(page)["blocks"]
                for line in group.get("lines", [])
                if abs(line["dir"][0] - 1) < 0.01
            ]
            page_cache = {page_index: (lines, _body_style(lines))}
        lines, body = page_cache[page_index]
        w, h = page.rect.width / 1000, page.rect.height / 1000
        x0, y0, x1, y1 = block["bbox"]
        area = pymupdf.Rect(x0 * w, y0 * h, x1 * w, y1 * h)
        inside = [
            line
            for line in lines
            if pymupdf.Rect(line["bbox"]).intersects(area)
            and area.contains(
                pymupdf.Point(
                    (line["bbox"][0] + line["bbox"][2]) / 2,
                    (line["bbox"][1] + line["bbox"][3]) / 2,
                )
            )
        ]
        heads = _heading_lines(inside, body)
        pieces = _split(block, heads, w, h, levels)
        out.extend(pieces)
        for piece in pieces:
            if piece.get("text_level"):
                levels[_kind(piece["text"])] = piece["text_level"]
                levels["last"] = piece["text_level"]
    return out


def _prose(piece: dict, last: bool) -> bool:
    """Running text: a long item, or after the last heading a single short
    paragraph that continues in the next column or block."""
    entries = piece.get("list_items") or piece.get("_entries") or []
    return any(len(str(e)) >= PROSE for e in entries) or (last and len(entries) == 1)


def _split(
    block: dict, heads: list[dict], w: float, h: float, levels: dict[str, int]
) -> list[dict]:
    if not heads:
        return [block]
    x0, y0, x1, y1 = block["bbox"]
    common = {k: v for k, v in block.items() if k not in ("list_items", "bbox", "type")}
    pieces: list[dict] = []
    items: list[str] = []
    top = y0
    pending = list(heads)
    after: list[str] = []  # text after the last heading, a paragraph

    def flush_list(bottom: float) -> None:
        nonlocal items
        if items:
            pieces.append(
                {
                    **common,
                    "type": "list",
                    "list_items": items,
                    "bbox": [x0, top, x1, bottom],
                }
            )
        items = []

    def flush_after(bottom: float) -> None:
        nonlocal after
        if after:
            text = " ".join(after)
            pieces.append(
                {
                    **common,
                    "type": "text",
                    "text": text,
                    "bbox": [x0, top, x1, bottom],
                    "_entries": after,
                }
            )
        after = []

    current = items
    for item in block.get("list_items") or []:
        rest = item
        while pending:
            compact, where = _compact(rest)
            needle, _ = _compact(pending[0]["text"])
            start = compact.find(needle)
            if not needle or start < 0:
                break
            head = pending.pop(0)
            end = where[start + len(needle) - 1] + 1
            before, text = rest[: where[start]].strip(), rest[where[start] : end]
            rest = rest[end:].strip()
            hy0, hy1 = head["rect"].y0 / h, head["rect"].y1 / h
            if before:
                current.append(before)
            if current is items:
                flush_list(hy0)
            else:
                flush_after(hy0)
            level = levels.get(_kind(head["text"]))
            if level is None:
                kind = _kind(head["text"])
                level = (
                    int(kind[6:]) + 1
                    if kind.startswith("dotted")
                    else levels.get("last", 0) + 1
                )
            pieces.append(
                {
                    **common,
                    "type": "text",
                    "text": " ".join(text.split()),
                    "text_level": level,
                    "bbox": [head["rect"].x0 / w, hy0, head["rect"].x1 / w, hy1],
                    "_source_role": "list-heading",
                }
            )
            levels[_kind(head["text"])] = level
            top = hy1
            current = after
        if rest:
            current.append(rest)
    if current is items:
        flush_list(y1)
    else:
        flush_after(y1)
    if pending:  # a heading the items never spelled: leave the list whole
        return [block]
    # A heading followed by another, or by short entries only, is a contents
    # list or a bold numbered list, not a section start.
    for index, (piece, following) in enumerate(pairwise(pieces)):
        if piece.get("text_level") and (
            following.get("text_level")
            or not _prose(following, index + 2 == len(pieces))
        ):
            return [block]
    for piece in pieces:
        piece.pop("_entries", None)
    return pieces
