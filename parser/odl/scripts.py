"""Rebuild formula structure from the text layer's geometry, as plain linear math.

OpenDataLoader flattens what the page draws in two dimensions: ``ft³`` becomes
``ft3``, a stacked fraction becomes numerator and denominator run together (often
in separate blocks), ``0.09`` with stacked error bars becomes interleaved
digits. The page itself proves the structure:

- a script is a smaller glyph run raised or lowered against its line's baseline,
  hugging a base glyph: ``x^2``, ``x^{n+1}``, ``H_2O``, ``0.09^{+0.03}_{−0.04}``;
- a fraction is a drawn horizontal bar with text centred directly above and
  below it: ``(num)/(den)``, parentheses only around compound parts;
- a root is a bar whose left end meets a drawn radical stroke (or a ``√``
  glyph) with text below only: ``√(…)``.

Two rewrites, both abstaining unless the match is proved:

- Display rows (a fraction, root or big operator with stacked limits, plus the
  glyphs chained to it on its axis) replace the ODL text that holds exactly
  those glyphs: whole blocks, or one window of one block, when the multiset of
  non-space characters matches.
- Script words elsewhere replace their flattened form in the block text when
  every occurrence of that flattened form on the page is the same scripted
  word, and ODL holds exactly as many occurrences.

Superscript digits after prose words or punctuation are footnote and citation
markers and stay untouched; see ``_accept_sup``.
"""

from __future__ import annotations

import bisect
import copy
import functools
import itertools
import math
import re
import statistics
import unicodedata
from collections import Counter
from dataclasses import dataclass, field

import pymupdf

from .page_text import page_dict, page_raw

SLOT_TYPES = {"text", "list", "equation"}
SCRIPT_RATIO = 0.85  # a script glyph is at most this fraction of its base size
SUP_SHIFT = 0.12  # baseline rise, in base ems
SUB_SHIFT = 0.08  # baseline drop, in base ems
WORD_GAP = 0.2  # ems; a wider gap separates words
ROW_GAP = 2.0  # ems; glyphs chained to a display structure along its axis
MAX_STROKES = 5000  # drawn segments on a page past which bars are not read
ROW_CELL = 16.0  # points; reader lines are indexed by the grid cells they cover
ROW_INDEX = 500  # lines on a page from which they are indexed; fewer are scanned

MATH_CHARS = set("=+×÷−±∓<>≤≥≠≈≡∝∑∏∫∮√∞∂∇→←↔⇌⇒⇔·∈∉⊂⊃∪∩")
BIG_OPS = set("∑∏∫∮")
DELIMS = {
    **dict.fromkeys("⎛⎜⎝", "("),
    **dict.fromkeys("⎞⎟⎠", ")"),
    **dict.fromkeys("⎡⎢⎣", "["),
    **dict.fromkeys("⎤⎥⎦", "]"),
    **dict.fromkeys("⎧⎨⎩⎪", "{"),
    **dict.fromkeys("⎫⎬⎭", "}"),
}
# Computer Modern's extension font has no ToUnicode; its codes are fixed.
CMEX = {
    "P": "∑", "X": "∑", "Q": "∏", "Y": "∏", "R": "∫", "Z": "∫", "H": "∮", "I": "∮",
    "p": "√", "q": "√", "r": "√", "s": "√", "t": "√", "v": "√",
    # 0x20 is left out: readers also report their synthesised spaces as " ".
    **dict.fromkeys("\x00\x10\x12", "("), **dict.fromkeys("\x01\x11\x13\x21", ")"),
    **dict.fromkeys("\x02\x14\x22", "["), **dict.fromkeys("\x03\x15\x23", "]"),
    **dict.fromkeys("\x08\x1a\x28", "{"), **dict.fromkeys("\x09\x1b\x29", "}"),
}  # fmt: skip
UNITS = {
    "m", "cm", "mm", "km", "µm", "μm", "nm", "ft", "in", "yd", "mi", "s", "sec", "min",
    "h", "hr", "kg", "g", "mg", "µg", "μg", "lb", "lbs", "l", "L", "mL", "ml", "gal",
    "cf", "ha", "Pa", "kPa", "J", "kJ", "W", "kW", "V", "A", "K", "mol",
}  # fmt: skip
FOOTNOTE_MARKS = re.compile(r"[*†‡§¶#]+|\d+(?:\s*[,–-]\s*\d+)+")
ACCENTS = set("˜˙¯ˆˇ´`¨")
ORDINALS = {
    "st",
    "nd",
    "rd",
    "th",
    "d",
    "e",
    "er",
    "re",
    "ers",
    "res",
    "ème",
    "o",
    "a",
    "os",
    "as",
}
PRIMES = set("′″‴'’∗*")
ORDINAL_PUNCT = set(".,;:!?\"'“”‘’")


class _Unproven(Exception):
    """The glyphs do not form one line of mathematics."""


@dataclass(eq=False)
class Glyph:
    c: str  # rendered character
    x0: float
    y0: float
    x1: float
    y1: float
    size: float
    base: float  # origin y
    compare: bool = True  # counts in the character multiset ODL must hold
    math_font: bool = False
    spaced: bool = False  # the text layer has a space before it
    extensible: bool = False  # a TeX extension-font piece: its origin is not a baseline
    cx: float = field(init=False)
    cy: float = field(init=False)

    def __post_init__(self) -> None:
        self.cx = (self.x0 + self.x1) / 2
        self.cy = (self.y0 + self.y1) / 2


@dataclass(eq=False)
class Atom:
    """A base-level piece: one glyph, or a composite rendered from glyphs."""

    text: str
    x0: float
    x1: float
    y0: float
    y1: float
    size: float
    glyph: Glyph | None = None
    sups: list[Glyph] = field(default_factory=list)
    subs: list[Glyph] = field(default_factory=list)


@dataclass(eq=False)
class Bar:
    x0: float
    x1: float
    y: float
    kind: str = ""  # "frac" or "root" once proven
    upper: list[Glyph] = field(default_factory=list)
    lower: list[Glyph] = field(default_factory=list)

    @property
    def width(self) -> float:
        return self.x1 - self.x0


# ---------------------------------------------------------------- characters


@functools.lru_cache(maxsize=2048)
def _norm_char(ch: str) -> str:
    out = ""
    for n in unicodedata.normalize("NFKC", ch):
        if n.isspace() or ord(n) < 0x20 or 0xE000 <= ord(n) <= 0xF8FF or n == "\ufffd":
            continue
        out += "-" if n == "−" else n
    return out


def _norm(text: str) -> list[str]:
    """Characters as compared with ODL text: NFKC, no spaces, control or
    private-use characters, minus as hyphen."""
    return [n for ch in text for n in _norm_char(ch)]


@functools.lru_cache(maxsize=4096)
def _compact(text: str) -> tuple[str, tuple[int, ...]]:
    """Normalised non-space characters of ``text`` and their source indexes."""
    chars, index = [], []
    for i, ch in enumerate(text):
        if ch.isascii():
            if ch > " ":
                chars.append(ch)
                index.append(i)
            continue
        for n in _norm_char(ch):
            chars.append(n)
            index.append(i)
    return "".join(chars), tuple(index)


@functools.lru_cache(maxsize=4096)
def _charset(text: str) -> frozenset[str]:
    return frozenset(_compact(text)[0])


def _greek(ch: str) -> bool:
    return 0x370 <= ord(ch) <= 0x3FF or 0x1D6A8 <= ord(ch) <= 0x1D7CB


# ---------------------------------------------------------------- page source


def _glyphs(raw: dict) -> list[list[Glyph]]:
    """Non-space glyphs of horizontal lines, grouped by the reader's lines."""
    lines = []
    for group in raw["blocks"]:
        for line in group.get("lines", []):
            if abs(line["dir"][0] - 1) > 0.01 or abs(line["dir"][1]) > 0.01:
                continue
            row = []
            spaced = False
            for span in line["spans"]:
                size = span["size"]
                if size <= 0:
                    continue
                font = span["font"]
                cmex = "CMEX" in font
                math_font = any(k in font for k in ("CMMI", "CMSY", "Math", "MT Extra"))
                for ch in span["chars"]:
                    c = ch["c"]
                    if cmex:
                        if c not in CMEX:
                            continue
                        c = CMEX[c]
                    elif not c or c.isspace():
                        spaced = True
                        continue
                    elif ord(c) < 0x20:
                        continue  # an unmapped code, not a character
                    x0, y0, x1, y1 = ch["bbox"]
                    if x1 - x0 <= 0:
                        continue
                    row.append(
                        Glyph(
                            c, x0, y0, x1, y1, size, ch["origin"][1],
                            compare=not cmex, math_font=math_font or cmex, spaced=spaced,
                            extensible=cmex,
                        )
                    )  # fmt: skip
                    spaced = False
            if row:
                lines.append(row)
    return lines


def _needs_page(text: dict) -> tuple[bool, bool]:
    """(script candidates, stacked short lines) from the page's text dict."""
    lines = []
    scripts = False
    for block in text["blocks"]:
        for line in block.get("lines", []):
            spans = [s for s in line["spans"] if s["text"].strip()]
            if not spans:
                continue
            big = max(s["size"] for s in spans)
            if not scripts:
                scripts = any(_script_span(spans, k, big) for k in range(len(spans)))
            text = "".join(s["text"] for s in spans).strip()
            lines.append((line["bbox"], big, len(text)))
    if not scripts:
        # A script set as its own line beside a bigger line.
        index = _box_index([box for box, _, _ in lines])
        reach = max((size for _, size, _ in lines), default=0)
        for box, size, n in lines:
            # The lines a line's start lies beside, within the other's size.
            span = (box[0] - reach, box[1], box[0] + reach, box[3])
            if n <= 12 and any(
                size <= SCRIPT_RATIO * other
                and box[1] < ob[3]
                and ob[1] < box[3]
                and ob[0] - other <= box[0] <= ob[2] + other
                for ob, other, _ in (lines[k] for k in _beside(index, span, len(lines)))
            ):
                scripts = True
                break
    return scripts, _stacked(lines)


def _stacked(lines: list[tuple]) -> bool:
    """Two short lines centred over each other with a third line beside the
    gap between them: a numerator and denominator on either side of an axis
    ("v =" or the prose around an inline fraction). Table cells and plot
    labels stack without the line beside."""
    short = [(b, s) for b, s, n in lines if n <= 40]
    for i, (b1, s1) in enumerate(short):
        for b2, _ in short[i + 1 : i + 12]:
            if not -0.3 * s1 < b2[1] - b1[3] < 1.0 * s1:
                continue
            w = max(b1[2] - b1[0], b2[2] - b2[0])
            if abs((b1[0] + b1[2]) - (b2[0] + b2[2])) / 2 > 0.25 * w + 0.5 * s1:
                continue
            middle = (b1[3] + b2[1]) / 2
            if any(
                b[1] < middle < b[3]
                and (b[2] <= min(b1[0], b2[0]) + 1 or b[0] >= max(b1[2], b2[2]) - 1)
                and min(abs(b[2] - min(b1[0], b2[0])), abs(b[0] - max(b1[2], b2[2])))
                < 3 * s1
                for b, _, _ in lines
            ):
                return True
    return False


def _is_mark(text: str) -> bool:
    text = text.strip()
    return text.isdigit() or bool(FOOTNOTE_MARKS.fullmatch(text))


def _script_span(spans: list[dict], k: int, big: float) -> bool:
    """Could span ``k`` of a line be a script worth reading glyphs for? A
    raised marker after a prose word or punctuation is a footnote mark."""
    span = spans[k]
    if span["size"] > SCRIPT_RATIO * big:
        return False
    base = max(s["origin"][1] for s in spans if s["size"] > SCRIPT_RATIO * big)
    shift = (base - span["origin"][1]) / big
    if -SUB_SHIFT < shift < SUP_SHIFT:
        return False  # small capitals, or a smaller word on the baseline
    if shift < 0:
        return True  # lowered
    if k == 0:
        return not _is_mark(span["text"])  # a footnote's own label
    before = spans[k - 1]["text"].rstrip()
    if not _is_mark(span["text"]) or not before:
        return True
    word = re.split(r"\s", before)[-1]
    if before[-1] in ORDINAL_PUNCT:
        return False
    return not (len(word) >= 3 and word.isalpha() and word not in UNITS)


class _Strokes:
    """Straight non-horizontal strokes, found by their end points, and the
    vertical walls (lines and box sides) a rule may run into."""

    def __init__(self, strokes: list[tuple], walls: list[tuple] = ()) -> None:
        self.cells: dict[tuple[int, int], list[tuple]] = {}
        for stroke in strokes:
            for x, y in ((stroke[0], stroke[1]), (stroke[2], stroke[3])):
                self.cells.setdefault((int(x // 2), int(y // 2)), []).append(stroke)
        self.walls: dict[int, list[tuple]] = {}
        for x, y0, y1 in walls:
            self.walls.setdefault(int(x // 2), []).append((x, y0, y1))

    def near(self, x: float, y: float) -> list[tuple]:
        cx, cy = int(x // 2), int(y // 2)
        return [
            s
            for i in (-1, 0, 1)
            for j in (-1, 0, 1)
            for s in self.cells.get((cx + i, cy + j), [])
        ]

    def wall(self, x: float, y: float) -> bool:
        """A vertical line or box side passes through (x, y)."""
        return any(
            abs(wx - x) <= 1.5 and y0 - 1 <= y <= y1 + 1
            for i in (-1, 0, 1)
            for wx, y0, y1 in self.walls.get(int(x // 2) + i, [])
        )


def _segments(page: pymupdf.Page) -> tuple[list[Bar], _Strokes]:
    """Horizontal bars, and the other straight strokes (for radical signs)."""
    bars, strokes, walls = [], [], []
    paths = page.get_cdrawings()
    if sum(len(p["items"]) for p in paths) > MAX_STROKES:
        return [], _Strokes([])  # a plot or map, not typeset mathematics
    for path in paths:
        for item in path["items"]:
            if item[0] == "l":
                (px, py), (qx, qy) = item[1], item[2]
                if abs(py - qy) <= 0.5 and abs(px - qx) >= 2.5:
                    bars.append(Bar(min(px, qx), max(px, qx), (py + qy) / 2))
                else:
                    strokes.append((px, py, qx, qy))
                    if abs(px - qx) <= 0.5:
                        walls.append((px, min(py, qy), max(py, qy)))
            elif item[0] == "re":
                x0, y0, x1, y1 = item[1]
                if y1 - y0 <= 1.2 and x1 - x0 >= 2.5 and path.get("fill") is not None:
                    bars.append(Bar(x0, x1, (y0 + y1) / 2))
                elif y1 - y0 > 1.2:
                    walls += [(x0, y0, y1), (x1, y0, y1)]
    # The same rule is often painted more than once.
    unique: list[Bar] = []
    for bar in sorted(bars, key=lambda b: (round(b.y, 1), b.x0)):
        if not any(
            abs(u.y - bar.y) <= 1
            and abs(u.x0 - bar.x0) <= 1
            and abs(u.x1 - bar.x1) <= 1
            for u in unique[-4:]
        ):
            unique.append(bar)
    return unique, _Strokes(strokes, walls)


# ---------------------------------------------------------------- structures


def _stack(glyphs: list[Glyph], bar: Bar, above: bool, bars: list[Bar]) -> list[Glyph]:
    """Glyphs stacked directly above (or below) ``bar`` within its width:
    the nearest line, then whatever overlaps it (scripts) or sits across a
    nested bar from it."""
    inside = [g for g in glyphs if bar.x0 - 0.5 <= g.cx <= bar.x1 + 0.5]
    if above:
        first = [g for g in inside if g.base < bar.y + 0.1 and bar.y - g.base < g.size]
    else:
        first = [
            g
            for g in inside
            if g.base > bar.y and -0.25 * g.size < g.y0 - bar.y < 0.8 * g.size
        ]
    if not first:
        return []
    chosen = set(first)
    grew = True
    while grew:
        grew = False
        top = min(g.y0 for g in chosen)
        bottom = max(g.y1 for g in chosen)
        for g in inside:
            if g in chosen or (g.cy >= bar.y if above else g.cy <= bar.y):
                continue
            overlaps = (
                g.y1 > top + 0.05 * g.size if above else g.y0 < bottom - 0.05 * g.size
            )
            gap = top - g.y1 if above else g.y0 - bottom
            nested = gap < 0.6 * g.size and any(
                inner is not bar
                and inner.x0 - 0.5 <= g.cx <= inner.x1 + 0.5
                and (
                    g.y1 - 1 <= inner.y <= top + 1
                    if above
                    else bottom - 1 <= inner.y <= g.y0 + 1
                )
                for inner in bars
            )
            if overlaps or nested:
                chosen.add(g)
                grew = True
    return [g for g in inside if g in chosen]


def _row_band(glyphs: list[Glyph], bar: Bar, above: bool) -> list[Glyph]:
    """Glyphs on the first line directly above or below the bar, any x."""
    if above:
        return [g for g in glyphs if g.base < bar.y + 0.1 and bar.y - g.base < g.size]
    return [
        g
        for g in glyphs
        if g.base > bar.y and -0.25 * g.size < g.y0 - bar.y < 0.8 * g.size
    ]


def _tight(row: list[Glyph]) -> bool:
    row = sorted(row, key=lambda g: g.x0)
    return all(
        b.x0 - a.x1 <= 1.5 * max(a.size, b.size) for a, b in itertools.pairwise(row)
    )


def _fraction(
    bar: Bar, glyphs: list[Glyph], strokes: _Strokes, bars: list[Bar]
) -> bool:
    upper, lower = _stack(glyphs, bar, True, bars), _stack(glyphs, bar, False, bars)
    if not upper or not lower:
        return False
    em = statistics.median(g.size for g in upper + lower)
    # Table rules and underlines have text straddling their ends.
    for g in _row_band(glyphs, bar, True) + _row_band(glyphs, bar, False):
        if g.c in DELIMS or g.c in BIG_OPS:
            continue
        if g.x0 < bar.x0 - 0.2 * em < g.x1 or g.x0 < bar.x1 + 0.2 * em < g.x1:
            return False
    # Grid lines and box sides meet a table rule or a box divider at its
    # ends; nothing meets a fraction bar.
    for end in (bar.x0, bar.x1):
        if strokes.wall(end, bar.y):
            return False
        for x0, y0, x1, y1 in strokes.near(end, bar.y):
            for x, y in ((x0, y0), (x1, y1)):
                if abs(y - bar.y) <= 1 and abs(x - end) <= 1:
                    return False
    for part in (upper, lower):
        first = [g for g in part if abs(g.base - part[0].base) < 0.3 * em] or part
        x0, x1 = min(g.x0 for g in part), max(g.x1 for g in part)
        if x1 - x0 > bar.width + 0.6 * em:
            return False
        if abs((x0 + x1) / 2 - (bar.x0 + bar.x1) / 2) > 0.15 * bar.width + 0.4 * em:
            return False
        if not _tight(first):
            return False
    widest = max(
        max(g.x1 for g in part) - min(g.x0 for g in part) for part in (upper, lower)
    )
    if bar.width > 1.1 * widest + 1.5 * em:
        return False
    bar.kind, bar.upper, bar.lower = "frac", upper, lower
    return True


def _root(bar: Bar, glyphs: list[Glyph], strokes: _Strokes, bars: list[Bar]) -> bool:
    """A bar whose left end meets a stroke rising from below (a drawn radical)
    or the top right of a ``√`` glyph, with text under it and none on it."""
    # The long stroke of a radical slants up to the bar from the lower left;
    # an axis or a box edge meets it vertically.
    drawn = any(
        abs(xa - bar.x0) <= 1.5
        and abs(ya - bar.y) <= 1.5
        and yb - ya > 3
        and 0.1 <= (xa - xb) / (yb - ya) <= 1.0
        for x0, y0, x1, y1 in strokes.near(bar.x0, bar.y)
        for (xa, ya), (xb, yb) in (((x0, y0), (x1, y1)), ((x1, y1), (x0, y0)))
    )
    sign = [
        g
        for g in glyphs
        if g.c == "√" and abs(g.x1 - bar.x0) <= 2 and g.y0 - 2 <= bar.y <= g.cy
    ]
    if not drawn and not sign:
        return False
    lower = [g for g in _stack(glyphs, bar, False, bars) if g not in sign]
    if not lower or _stack(glyphs, bar, True, bars):
        return False
    em = statistics.median(g.size for g in lower)
    x0, x1 = min(g.x0 for g in lower), max(g.x1 for g in lower)
    if (
        x1 > bar.x1 + 0.5 * em
        or x0 < bar.x0 - 0.5 * em
        or bar.width > x1 - x0 + 1.5 * em
    ):
        return False
    if not _tight(lower):
        return False
    bar.kind, bar.lower = "root", lower + sign
    return True


# ---------------------------------------------------------------- rendering


def _group(text: str) -> str:
    return text if len(text) == 1 else "{" + text + "}"


def _paren(text: str) -> str:
    compound = re.search(r"[\s+\-−×·*/=<>±≤≥,]", text)
    return f"({text})" if compound else text


def _script_text(glyphs: list[Glyph]) -> str:
    out, last = "", None
    for g in sorted(glyphs, key=lambda g: g.x0):
        if last is not None and g.x0 - last.x1 > 0.3 * g.size:
            out += " "
        out += g.c
        last = g
    return out


def _limits(op: Glyph, glyphs: list[Glyph]) -> tuple[list[Glyph], list[Glyph]]:
    """Limits of a display operator (taller than a line): smaller glyphs
    stacked over or under it, or set at its top or bottom right, with the
    glyphs that continue them. Heights are read against the baseline of the
    text beside the operator; an extension font's own boxes are unreliable."""
    h = op.y1 - op.y0
    if h < 1.5 * op.size:
        return [], []
    beside = [
        g
        for g in glyphs
        if g.size > SCRIPT_RATIO * op.size
        and not g.extensible
        and g.c not in BIG_OPS
        and op.y0 + 0.2 * h <= g.cy <= op.y1 - 0.2 * h
        and (g.x1 <= op.x0 + 1 or g.x0 >= op.x1 - 1)
        and min(abs(g.x0 - op.x1), abs(op.x0 - g.x1)) < 2 * op.size
    ]
    if not beside:
        return [], []
    ref = statistics.median(g.base for g in beside)
    small = [
        g for g in glyphs if g is not op and g.size <= SCRIPT_RATIO * op.size + 0.01
    ]
    over, under = [], []
    for g in small:
        rise = (ref - g.base) / op.size
        stacked = op.x0 - 2 <= g.cx <= op.x1 + 2
        right = op.x1 - 0.3 * op.size <= g.x0 <= op.x1 + 0.6 * op.size
        if (stacked and 0.5 <= rise <= 2.5) or (right and 0.2 <= rise <= 2.5):
            over.append(g)
        elif (stacked and -2.5 <= rise <= -0.3) or (right and -2.5 <= rise <= -0.1):
            under.append(g)
    # Only the nearest line on each side: a display below has limits too.
    over = (
        [g for g in over if g.base >= max(o.base for o in over) - 0.15 * g.size]
        if over
        else []
    )
    under = (
        [g for g in under if g.base <= min(u.base for u in under) + 0.15 * g.size]
        if under
        else []
    )
    for part in (over, under):
        if not part:
            continue
        line = part[0].base
        reach = max(g.x1 for g in part)
        for g in sorted(small, key=lambda g: g.x0):
            if (
                g not in part
                and abs(g.base - line) <= 0.15 * g.size
                and 0 <= g.x0 - reach <= 0.3 * g.size
            ):
                part.append(g)
                reach = g.x1
    return over, under


def _merge_delims(glyphs: list[Glyph]) -> list[Atom]:
    """Stacked bracket pieces (⎛ ⎜ ⎝) become one base-level bracket."""
    pieces = sorted((g for g in glyphs if g.c in DELIMS), key=lambda g: g.x0)
    atoms: list[Atom] = []
    for g in pieces:
        last = atoms[-1] if atoms else None
        if last and last.text == DELIMS[g.c] and g.x0 < last.x1 and last.x0 < g.x1:
            last.y0, last.y1 = min(last.y0, g.y0), max(last.y1, g.y1)
            continue
        atoms.append(Atom(DELIMS[g.c], g.x0, g.x1, g.y0, g.y1, g.size))
    return atoms


def _baseline(glyphs: list[Glyph]) -> tuple[float, float]:
    plain = [
        g
        for g in glyphs
        if g.c not in BIG_OPS and g.c not in DELIMS and not g.extensible
    ]
    if not plain:
        plain = glyphs
    size = max(g.size for g in plain)
    base = statistics.median(g.base for g in plain if g.size >= SCRIPT_RATIO * size)
    return size, base


def _kind(g: Glyph, size: float, base: float) -> str:
    if g.c in BIG_OPS or g.c in DELIMS or g.extensible or g.size > SCRIPT_RATIO * size:
        return ""
    shift = (base - g.base) / size
    if shift >= SUP_SHIFT:
        return "sup"
    if shift <= -SUB_SHIFT:
        return "sub"
    return ""


def _linear(
    atoms: list[Atom], glyphs: list[Glyph], *, math: bool | None
) -> list[list[Atom]]:
    """Attach script glyphs to base atoms and split into words.

    ``math`` None means decide footnote markers per line (prose); True means
    the glyphs are proven mathematics (inside a display structure)."""
    if not atoms and not glyphs:
        return []
    size, base = _baseline(glyphs) if glyphs else (max(a.size for a in atoms), 0.0)
    scripts: list[Glyph] = []
    for g in glyphs:
        if _kind(g, size, base) or (
            g.size <= SCRIPT_RATIO * size and not g.extensible and g.c not in BIG_OPS
        ):
            scripts.append(g)
        else:
            atoms.append(Atom(g.c, g.x0, g.x1, g.y0, g.y1, g.size, glyph=g))
    atoms.sort(key=lambda a: (a.x0, a.y0))
    scripts.sort(key=lambda g: g.x0)
    # Each script attaches to the last base atom starting before it, when it
    # hugs that atom or the scripts already attached to it. Raised or lowered
    # is read against the base glyph itself: a reader line may hold two rows.
    for g in scripts:
        host = None
        for a in atoms:
            if a.x0 < g.x0 + 0.1 * size:
                host = a
        kind = _kind(g, size, base)
        if host is not None and host.glyph is not None and not host.glyph.extensible:
            kind = _kind(g, host.glyph.size, host.glyph.base)
        if (
            kind
            and host is not None
            and _scriptable(host)
            and host.x1 <= g.x1 + 0.2 * size
        ):
            reach = max([host.x1] + [s.x1 for s in host.sups + host.subs])
            if g.x0 - reach <= 0.45 * size:
                (host.sups if kind == "sup" else host.subs).append(g)
                continue
        if not kind:
            atoms.append(Atom(g.c, g.x0, g.x1, g.y0, g.y1, g.size, glyph=g))
            atoms.sort(key=lambda a: (a.x0, a.y0))
            continue
        if math:
            raise _Unproven(f"a script without a base: {g.c!r} at {g.x0:.1f}")
        atoms.append(Atom(g.c, g.x0, g.x1, g.y0, g.y1, g.size, glyph=g))
        atoms.sort(key=lambda a: (a.x0, a.y0))
    if math:
        level = [
            a.glyph.base
            for a in atoms
            if a.glyph
            and a.glyph.size >= SCRIPT_RATIO * size
            and a.text not in BIG_OPS
            and not a.glyph.extensible
        ]
        if level and max(level) - min(level) > 0.25 * size:
            raise _Unproven("more than one text line")
    words: list[list[Atom]] = []
    reach = None
    for a in atoms:
        if (
            reach is None
            or a.x0 - reach > WORD_GAP * size
            or (a.glyph and a.glyph.spaced and a.x0 - reach > 0.08 * size)
        ):
            words.append([])
        words[-1].append(a)
        reach = max([a.x1] + [s.x1 for s in a.sups + a.subs])
    if math is not True:
        line_math = any(
            a.text in MATH_CHARS
            or _greek(a.text)
            or (a.glyph and a.glyph.math_font)
            or a.subs
            for w in words
            for a in w
        )
        for wi, word in enumerate(words):
            for ai, a in enumerate(word):
                if a.sups and not _accept_sup(words, wi, ai, line_math):
                    # Leave the marker as plain text, in reading position.
                    for g in a.sups:
                        word.append(Atom(g.c, g.x0, g.x1, g.y0, g.y1, g.size, glyph=g))
                    a.sups = []
            word.sort(key=lambda a: a.x0)
    # A small glyph left over beside attached scripts (an inline fraction or
    # nested script) means the word's structure is not what we read.
    for word in words:
        if any(a.sups or a.subs for a in word) and any(
            a.glyph and a.glyph.size <= SCRIPT_RATIO * size for a in word
        ):
            if math:
                raise _Unproven("scripts beside unattached small glyphs")
            for a in [a for a in word if a.sups or a.subs]:
                for g in a.sups + a.subs:
                    word.append(Atom(g.c, g.x0, g.x1, g.y0, g.y1, g.size, glyph=g))
                a.sups, a.subs = [], []
            word.sort(key=lambda a: a.x0)
    return words


def _scriptable(atom: Atom) -> bool:
    """Scripts hang on letters, digits, closing brackets, primes and accents,
    and on built structures; never on operators or opening brackets."""
    if atom.glyph is None:
        return True
    ch = atom.text[-1]
    return ch.isalnum() or _greek(ch) or ch in ")]}|′″‴'’*∗˜˙¯^⊙∞∂∇"


def _token(word: list[Atom], ai: int) -> str:
    """The number or the letters ending at atom ``ai`` (accents skipped),
    after the last atom that carries scripts."""
    start = max([k + 1 for k in range(ai) if word[k].sups or word[k].subs], default=0)
    text = "".join(c for a in word[start : ai + 1] for c in a.text if c not in ACCENTS)
    match = re.search(r"(?:\d[\d.,]*\d|\d|[^\W\d_]+)$", text)
    return match[0] if match else ""


def _accept_sup(words: list[list[Atom]], wi: int, ai: int, line_math: bool) -> bool:
    """Is this raised run an exponent or charge, not a footnote or citation
    marker? Markers are digits, digit lists and ranges or symbols after a prose
    word or punctuation; exponents sit on units after numbers, single-letter
    variables, numbers and brackets in a line that holds mathematics."""
    word, atom = words[wi], words[wi][ai]
    run = _script_text(atom.sups).strip()
    base = atom.text[-1:]
    if not run or not base:
        return False
    token = _token(word, ai)
    stacked = atom.subs and min(g.x0 for g in atom.subs) < max(g.x1 for g in atom.sups)
    if stacked and (len(token) <= 3 or re.fullmatch(r"[\d.,]+", token)):
        return True  # stacked over a subscript: error bars, tensors, ions
    if base in ORDINAL_PUNCT:
        return False
    if FOOTNOTE_MARKS.fullmatch(run):
        return False
    prev = "".join(a.text for a in words[wi - 1]) if wi else ""
    if any(ch in "+−-" for ch in run):  # charges, signed exponents, error bars
        if run == "+" and len(token) >= 3 and token.isupper():
            return False  # an alpha citation key with many authors: [MJS+00]
        return base.isalnum() or base in ")]}|" or _greek(base)
    if run.isalpha():
        if (base.isdigit() and run.lower() in ORDINALS) or run in {"TM", "SM"}:
            return False  # ordinals (1st, 2e), marks
        return line_math and (len(token) <= 2 or base in ")]}")
    if not re.fullmatch(r"[\d.,()]+", run):
        return line_math and (len(token) <= 2 or base in ")]}")
    # Digits only.
    if token in UNITS:
        return bool(re.search(r"\d\)?$", prev)) or line_math or token[:1].isdigit()
    if base in ")]}|":
        return line_math
    if re.fullmatch(r"[^\W\d_]", token) or (len(token) == 1 and _greek(token)):
        return line_math or bool(atom.glyph and atom.glyph.math_font)
    if re.fullmatch(r"[\d.,]+", token):
        return line_math
    return False


def _render_word(word: list[Atom]) -> str:
    out = ""
    for a in word:
        out += a.text
        sup, sub = _script_text(a.sups), _script_text(a.subs)
        if sup and all(c in PRIMES for c in sup):
            out += sup  # f′, R∗: a prime is already a raised mark
            sup = ""
        if sup and sub:
            stacked = min(g.x0 for g in a.sups) < max(g.x1 for g in a.subs) and min(
                g.x0 for g in a.subs
            ) < max(g.x1 for g in a.sups)
            if stacked or a.sups[0].x0 <= a.subs[0].x0:
                out += "^" + _group(sup) + "_" + _group(sub)
            else:
                out += "_" + _group(sub) + "^" + _group(sup)
        elif sup:
            out += "^" + _group(sup)
        elif sub:
            out += "_" + _group(sub)
    return out


def _render(glyphs: list[Glyph], bars: list[Bar]) -> str:
    """Linear text for a set of glyphs, building any fractions and roots whose
    parts all lie inside the set."""
    pool = set(glyphs)
    atoms: list[Atom] = []
    for bar in sorted(bars, key=lambda b: -b.width):
        parts = bar.upper + bar.lower
        if not parts or not all(g in pool for g in parts):
            continue
        pool.difference_update(parts)
        inner = [b for b in bars if b is not bar]
        if bar.kind == "frac":
            text = (
                _paren(_render(bar.upper, inner))
                + "/"
                + _paren(_render(bar.lower, inner))
            )
        else:
            body = _render([g for g in bar.lower if g.c != "√"], inner)
            text = "√" + (body if re.fullmatch(r"\w+", body) else f"({body})")
        x0 = min([bar.x0] + [g.x0 for g in parts])
        x1 = max([bar.x1] + [g.x1 for g in parts])
        size = max(g.size for g in parts)
        atoms.append(
            Atom(text, x0, x1, min(g.y0 for g in parts), max(g.y1 for g in parts), size)
        )
    rest = [g for g in glyphs if g in pool]
    # Display operators take their limits, stacked or set to their right.
    for op in [g for g in rest if g.c in BIG_OPS]:
        if op not in pool:
            continue
        over, under = _limits(op, [g for g in rest if g in pool])
        if not over and not under:
            continue
        pool.difference_update(over + under + [op])
        text = op.c
        if under:
            text += "_{" + _render(under, []) + "}"
        if over:
            text += "^{" + _render(over, []) + "}"
        x1 = max([op.x1] + [g.x1 for g in over + under])
        atoms.append(Atom(text, op.x0, x1, op.y0, op.y1, op.size))
    rest = [g for g in rest if g in pool]
    atoms.extend(_merge_delims(rest))
    rest = [g for g in rest if g.c not in DELIMS]
    words = _linear(atoms, rest, math=True)
    return " ".join(_render_word(w) for w in words)


# ---------------------------------------------------------------- block text


def _slots(block: dict):
    for key in ("text", "list_items"):
        value = block.get(key)
        if isinstance(value, str):
            yield key, None, value
        elif isinstance(value, list):
            for i, item in enumerate(value):
                if isinstance(item, str):
                    yield key, i, item


def _native(block: dict, page: pymupdf.Page) -> pymupdf.Rect:
    b = block["bbox"]
    w, h = page.rect.width, page.rect.height
    return pymupdf.Rect(
        b[0] * w / 1000, b[1] * h / 1000, b[2] * w / 1000, b[3] * h / 1000
    )


def _boundary(text: str, start: int, end: int) -> bool:
    """The span does not cut a number or a word: no digit (or decimal point
    or separator inside a number) continues a digit, no letter a letter."""

    def joined(a: str, b: str) -> bool:
        return (a.isdigit() and b.isdigit()) or (a.isalpha() and b.isalpha())

    if start and joined(text[start - 1], text[start]):
        return False
    if end < len(text) and joined(text[end - 1], text[end]):
        return False
    if (
        start >= 2
        and text[start - 1] in ".,"
        and text[start - 2].isdigit()
        and text[start].isdigit()
    ):
        return False
    return not (
        end + 1 < len(text)
        and text[end] in ".,"
        and text[end + 1].isdigit()
        and text[end - 1].isdigit()
    )


def _windows(text: str, need: Counter) -> list[tuple[int, int]]:
    """Spans of ``text`` whose non-space characters are exactly ``need``."""
    chars, index = _compact(text)
    n = sum(need.values())
    if n == 0 or n > len(chars):
        return []
    have = Counter(chars[:n])
    found = []
    for i in range(len(chars) - n + 1):
        if i:
            have[chars[i - 1]] -= 1
            have[chars[i + n - 1]] += 1
        if +have == need:
            start, end = index[i], index[i + n - 1] + 1
            if _boundary(text, start, end):
                found.append((start, end))
    return found


def _pattern(word: list[Atom]) -> tuple:
    """A scripted word as ordered base runs and script multisets: ODL keeps
    base characters in order but may interleave stacked scripts."""
    parts: list[tuple[str, object]] = []
    for a in word:
        seq = "".join(_norm(a.text))
        if parts and parts[-1][0] == "seq":
            parts[-1] = ("seq", parts[-1][1] + seq)
        elif seq:
            parts.append(("seq", seq))
        bag = "".join(sorted(_norm("".join(g.c for g in a.sups + a.subs))))
        if bag:
            parts.append(("bag", bag))
    return tuple(parts)


def _match_at(chars: str, i: int, parts: tuple) -> int | None:
    for kind, value in parts:
        if kind == "seq":
            if not chars.startswith(value, i):
                return None
        elif "".join(sorted(chars[i : i + len(value)])) != value:
            return None
        i += len(value)
    return i


def _find(text: str, parts: tuple) -> list[tuple[int, int]]:
    chars, index = _compact(text)
    kind, first = parts[0]
    found, i = [], 0
    while i < len(chars):
        if kind == "seq":
            i = chars.find(first, i)
            if i < 0:
                break
        elif chars[i] not in first:
            i += 1
            continue
        end = _match_at(chars, i, parts)
        if end is not None and end > i:
            start, stop = index[i], index[end - 1] + 1
            if _boundary(text, start, stop):
                found.append((start, stop))
                i = end
                continue
        i += 1
    return found


# ---------------------------------------------------------------- the stage


def _rows(
    lines: list[list[Glyph]], bars: list[Bar]
) -> list[tuple[list[Glyph], list[Bar]]]:
    """Display rows: proven structures plus the glyphs chained to them along
    their axis, with each row's own bars."""
    glyphs = [g for line in lines for g in line]
    claimed: set[Glyph] = set()
    seeds: list[list[Glyph]] = []
    axes: list[float] = []
    for bar in sorted(bars, key=lambda b: -b.width):
        parts = bar.upper + bar.lower
        if not claimed.intersection(parts):
            seeds.append(list(parts))
            # A root's bar is its top; its axis is the middle of what it covers.
            axes.append(
                bar.y if bar.kind == "frac" else statistics.median(g.cy for g in parts)
            )
        claimed.update(parts)
    # Display operators with limits.
    for op in glyphs:
        if op.c not in BIG_OPS or op in claimed:
            continue
        over, under = _limits(op, [g for g in glyphs if g not in claimed])
        if over or under:
            claimed.update(over + under + [op])
            seeds.append(over + under + [op])
            axes.append(op.cy)
    rows = []
    taken: set[int] = set()
    for i, seed in enumerate(seeds):
        if i in taken:
            continue
        taken.add(i)
        members = list(seed)
        member_set = set(members)
        row_axes = [axes[i]]
        grew = True
        while grew:
            grew = False
            em = statistics.median(g.size for g in members)
            top = max(g.size for g in members)
            x0, x1 = min(g.x0 for g in members), max(g.x1 for g in members)
            y0, y1 = min(g.y0 for g in members), max(g.y1 for g in members)
            for j, other in enumerate(seeds):
                if j in taken:
                    continue
                axis = (min(g.y0 for g in other) + max(g.y1 for g in other)) / 2
                a0, a1 = min(g.x0 for g in other), max(g.x1 for g in other)
                if (
                    y0 <= axis <= y1
                    and a0 - x1 <= ROW_GAP * em
                    and x0 - a1 <= ROW_GAP * em
                ):
                    taken.add(j)
                    members += other
                    member_set.update(other)
                    row_axes.append(axes[j])
                    grew = True
            if grew:
                continue
            pool = [
                g
                for g in glyphs
                if g not in claimed
                and g not in member_set
                and y0 <= g.cy <= y1
                # On the row's axis, not on a text line beside the stack.
                and any(
                    g.y0 - 0.5 * top <= axis <= g.y1 + 0.5 * top for axis in row_axes
                )
            ]
            pool.sort(key=lambda g: g.x0)
            reach_right, reach_left = x1, x0
            for g in pool:
                if (
                    g.x1 >= x0 - ROW_GAP * em
                    and g.x0 <= reach_right + ROW_GAP * em
                    and g.x0 >= x0
                ):
                    members.append(g)
                    member_set.add(g)
                    reach_right = max(reach_right, g.x1)
                    grew = True
            for g in reversed(pool):
                if g in member_set:
                    continue
                if g.x1 >= reach_left - ROW_GAP * em and g.x0 < x0:
                    members.append(g)
                    member_set.add(g)
                    reach_left = min(reach_left, g.x0)
                    grew = True
        claimed.update(members)
        own = set(members)
        rows.append((members, [b for b in bars if set(b.upper + b.lower) <= own]))
    return rows


def restore_structure(blocks: list[dict], document: pymupdf.Document) -> list[dict]:
    """Rewrite text/list/equation blocks where the page geometry proves
    scripts, fractions or roots. Returns a new list; abstains on ambiguity."""
    pages: dict[int, list[int]] = {}
    for i, block in enumerate(blocks):
        if block.get("type") in SLOT_TYPES and len(block.get("bbox", [])) == 4:
            pages.setdefault(block.get("page_idx"), []).append(i)
    revised = list(blocks)
    replaced: dict[
        int, list[dict] | None
    ] = {}  # block index -> new blocks, None drops it
    for page_index, indexes in sorted(pages.items()):
        if page_index is None or not 0 <= page_index < len(document):
            continue
        page = document[page_index]
        if page.rotation:
            continue
        edited, dropped = _restore_page(blocks, indexes, page, page_index)
        replaced.update(dropped)
        _commit(revised, edited, replaced)
    # The caches hold whole block texts and their index tuples; kept past this
    # stage they pin the allocator's arenas in the persistent parse child.
    for cache in (_norm_char, _compact, _charset):
        cache.cache_clear()
    if not replaced:
        return revised
    out = []
    for i, b in enumerate(revised):
        if i in replaced:
            out.extend(replaced[i] or [])
        else:
            out.append(b)
    return out


def _restore_page(
    blocks: list[dict], indexes: list[int], page: pymupdf.Page, page_index: int
) -> tuple[dict[int, dict], dict[int, list[dict] | None]]:
    """One page: the blocks it edits in place, and those it replaces or drops."""
    replaced: dict[int, list[dict] | None] = {}
    scripts, stacked = _needs_page(page_dict(page))
    bars, strokes = _segments(page) if stacked else ([], _Strokes([]))
    if not scripts and not bars:
        return {}, {}
    lines = _glyphs(page_raw(page))
    glyphs = [g for line in lines for g in line]
    if bars:
        by_y = sorted(glyphs, key=lambda g: g.cy)
        keys = [g.cy for g in by_y]
        for bar in bars:
            # Stacks reach a few lines from their bar at most.
            lo = bisect.bisect_left(keys, bar.y - 60)
            window = by_y[lo : bisect.bisect_right(keys, bar.y + 60)]
            local = [
                b
                for b in bars
                if abs(b.y - bar.y) < 60 and b.x0 < bar.x1 and bar.x0 < b.x1
            ]
            _fraction(bar, window, strokes, local) or _root(bar, window, strokes, local)
        bars = [b for b in bars if b.kind]
    edited: dict[int, dict] = {}

    def block(i: int) -> dict:
        if i not in edited:
            edited[i] = copy.deepcopy(blocks[i])
        return edited[i]

    boxes = {i: _native(blocks[i], page) for i in indexes}
    done_glyphs: set[Glyph] = set()
    # Display rows first.
    rows = []
    for members, inside in _rows(lines, bars):
        if not any(g.compare for g in members):
            continue
        box = pymupdf.Rect(
            min(g.x0 for g in members), min(g.y0 for g in members),
            max(g.x1 for g in members), max(g.y1 for g in members),
        )  # fmt: skip
        need = Counter(n for g in members if g.compare for n in _norm(g.c))
        rows.append((members, inside, box, need))
    rows.sort(key=lambda r: (r[2].y0, r[2].x0))
    slot_info = []
    for i in indexes if rows else []:
        for key, item, text in _slots(blocks[i]):
            slot_info.append((i, key, item, Counter(_compact(text)[0])))
    consumed: set[int] = set()
    spans: dict[int, list[tuple[int, int, str]]] = {}  # windows in original slot text

    def self_apply(rs: list[int]) -> bool:
        """Rewrite the ODL text holding exactly the glyphs of rows ``rs``."""
        rs = sorted(set(rs), key=lambda r: (rows[r][2].y0, rows[r][2].x0))
        need = _need(rows, rs)
        candidates = _near(near, rs) - consumed
        full = [s for s in candidates if not slot_info[s][3] - need]
        have = sum((slot_info[s][3] for s in full), Counter())
        if have - need:
            return False
        try:
            texts = [_render(rows[r][0], rows[r][1]) for r in rs]
        except _Unproven:
            return False
        rest = need - have
        if rest:
            if any(slot_info[f][1:3] != ("text", None) for f in full):
                return False
            hits = []
            for s in candidates:
                if s in full:
                    continue
                i, key, item, _ = slot_info[s]
                text = blocks[i][key] if item is None else blocks[i][key][item]
                hits += [
                    (s, w)
                    for w in _windows(text, rest)
                    if not any(w[0] < e and b < w[1] for b, e, _ in spans.get(s, []))
                ]
            if len(hits) != 1:
                return False
            s, (start, end) = hits[0]
            spans.setdefault(s, []).append((start, end, " ".join(texts)))
            for f in full:
                replaced[slot_info[f][0]] = None
        elif len(full) == 1:
            i, key, item, _ = slot_info[full[0]]
            target = block(i)
            if item is None:
                target[key] = "\n".join(texts)
            else:
                target[key][item] = "\n".join(texts)
        elif full and all(slot_info[f][1:3] == ("text", None) for f in full):
            order = sorted(slot_info[f][0] for f in full)
            w, h = page.rect.width, page.rect.height
            new = []
            for r, text in zip(rs, texts):
                b = rows[r][2]
                new.append(
                    {
                        "type": "text",
                        "page_idx": page_index,
                        "bbox": [
                            round(b.x0 * 1000 / w, 3), round(b.y0 * 1000 / h, 3),
                            round(b.x1 * 1000 / w, 3), round(b.y1 * 1000 / h, 3),
                        ],
                        "text": text,
                    }
                )  # fmt: skip
            replaced[order[0]] = new
            for i in order[1:]:
                replaced[i] = None
        else:
            return False
        consumed.update(full)
        for r in rs:
            done_glyphs.update(rows[r][0])
        return True

    # Rows are joined through ODL slots that hold nothing but their glyphs
    # (a fraction shredded into several blocks); prose slots never join rows.
    near = []
    for members, inside, box, need in rows:
        near.append(
            {
                s
                for s, (i, key, item, have) in enumerate(slot_info)
                if boxes[i].intersects(box + (-2, -2, 2, 2)) and have & need
            }
        )
    groups = [[r] for r in range(len(rows))]
    joined = True
    while joined:
        joined = False
        for a, b in itertools.combinations(range(len(groups)), 2):
            need = _need(rows, groups[a] + groups[b])
            shared = _near(near, groups[a]) & _near(near, groups[b])
            if any(not slot_info[s][3] - need for s in shared):
                groups[a] += groups.pop(b)
                joined = True
                break
    # A window can be ambiguous until a neighbouring row claims its part.
    pending = sorted(groups, key=lambda rs: min(rows[r][2].y0 for r in rs))
    progress = True
    while progress and pending:
        progress = False
        for rs in list(pending):
            if self_apply(rs):
                pending.remove(rs)
                progress = True
    # Rows ODL interleaved inside one prose slot: try runs of neighbours.
    for size in (2, 3, 4):
        for start in range(len(pending) - size + 1):
            run = pending[start : start + size]
            if all(run) and self_apply([r for rs in run for r in rs]):
                for k in range(start, start + size):
                    pending[k] = []
    for s, edits in spans.items():
        i, key, item, _ = slot_info[s]
        target = block(i)
        text = target[key] if item is None else target[key][item]
        for start, end, value in sorted(edits, reverse=True):
            text = text[:start] + value + text[end:]
        if item is None:
            target[key] = text
        else:
            target[key][item] = text
    # Script words in the remaining text.
    words_by_line = []
    plain_words: list[str] = []
    for line in _lines_for_words(lines, done_glyphs):
        big = max(g.size for g in line)
        if any(g.size <= SCRIPT_RATIO * big for g in line):
            words_by_line.extend(_linear([], line, math=None))
        else:
            plain_words.extend(_plain_words(line))
    excluded = [
        _native(b, page)
        for b in blocks
        if b.get("page_idx") == page_index and b.get("type") not in SLOT_TYPES
    ]
    seen = []  # (flat source text, rendered) of every word ODL should hold
    posting: dict[str, list[int]] = {}  # character -> words holding it
    events: dict[str, tuple] = {}
    for word in words_by_line:
        center = pymupdf.Point(
            (word[0].x0 + word[-1].x1) / 2, (word[0].y0 + word[0].y1) / 2
        )
        if any(r.contains(center) for r in excluded) and not any(
            boxes[i].contains(center) for i in indexes
        ):
            continue
        rendered = _render_word(word)
        flat = "".join(a.text + "".join(g.c for g in a.sups + a.subs) for a in word)
        for ch in _charset(flat):
            posting.setdefault(ch, []).append(len(seen))
        seen.append((flat, rendered))
        if any(a.sups or a.subs for a in word):
            parts = _pattern(word)
            key = repr(parts)
            if key in events and events[key][1] != rendered:
                events[key] = (parts, None)
            elif key not in events:
                events[key] = (parts, rendered)
    for flat in plain_words:
        for ch in _charset(flat):
            posting.setdefault(ch, []).append(len(seen))
        seen.append((flat, flat))
    live_slots = [
        (i, key, item)
        for i in indexes
        if i not in replaced
        for key, item, _ in _slots(blocks[i])
    ]
    # Shorter forms first: "ft^2" also fixes the "(ft2)" around it.
    for parts, render in sorted(
        events.values(), key=lambda e: sum(map(len, (v for _, v in e[0])))
    ):
        if render is None:
            continue
        # Every source occurrence of the flattened form, also inside
        # longer words, must carry the same structure.
        needed = _charset("".join(v for _, v in parts))
        n = consistent = 0
        shortest = min((posting.get(ch, []) for ch in needed), key=len)
        for w in shortest:
            flat, rendered = seen[w]
            if not needed <= _charset(flat):
                continue
            k = len(_find(flat, parts))
            n += k
            consistent += min(k, rendered.count(render))
        if n != consistent:
            continue
        hits = []
        for i, key, item in live_slots:
            target = edited.get(i, blocks[i])
            text = target[key] if item is None else target[key][item]
            if needed <= _charset(text):
                hits.extend((i, key, item, span) for span in _find(text, parts))
        if len(hits) != n:
            continue
        for i, key, item, (start, end) in sorted(hits, key=lambda h: -h[3][0]):
            target = block(i)
            text = target[key] if item is None else target[key][item]
            value = text[:start] + render + text[end:]
            if item is None:
                target[key] = value
            else:
                target[key][item] = value
    return edited, replaced


def _need(rows: list[tuple], rs: list[int]) -> Counter:
    return sum((rows[r][3] for r in rs), Counter())


def _near(near: list[set[int]], rs: list[int]) -> set[int]:
    return set().union(*(near[r] for r in rs))


def _commit(revised: list[dict], edited: dict[int, dict], replaced: dict) -> None:
    for i, b in edited.items():
        if i in replaced and replaced[i] is not None:
            continue
        revised[i] = b


def _plain_words(line: list[Glyph]) -> list[str]:
    """Words of a line without scripts, split as ``_linear`` splits them."""
    words, reach = [], None
    for g in sorted(line, key=lambda g: g.x0):
        if (
            reach is None
            or g.x0 - reach > WORD_GAP * g.size
            or (g.spaced and g.x0 - reach > 0.08 * g.size)
        ):
            words.append("")
        words[-1] += g.c
        reach = g.x1 if reach is None else max(reach, g.x1)
    return words


def _cells(a: float, b: float) -> range | None:
    """The ROW_CELL cells from ``a`` to ``b`` (either order) along one axis,
    or None when the two are not finite or lie further apart than a page."""
    if not (math.isfinite(a) and math.isfinite(b)) or abs(b - a) > 64 * ROW_CELL:
        return None
    return range(int(min(a, b) // ROW_CELL), int(max(a, b) // ROW_CELL) + 1)


def _box_index(
    boxes: list[tuple[float, float, float, float]],
) -> tuple[dict[tuple[int, int], list[int]], list[int]] | None:
    """Boxes (x0, y0, x1, y1) by the grid cells they cover, and apart the
    boxes without cells, which ``_beside`` returns for every query. None for
    fewer than ROW_INDEX boxes: scanning them all is cheaper."""
    if len(boxes) < ROW_INDEX:
        return None
    cells: dict[tuple[int, int], list[int]] = {}
    unbound: list[int] = []
    for i, (x0, y0, x1, y1) in enumerate(boxes):
        xs, ys = _cells(x0, x1), _cells(y0, y1)
        if xs is None or ys is None:
            unbound.append(i)
            continue
        for cell in itertools.product(xs, ys):
            cells.setdefault(cell, []).append(i)
    return cells, unbound


def _beside(
    index: tuple[dict[tuple[int, int], list[int]], list[int]] | None,
    box: tuple[float, float, float, float],
    count: int,
) -> list[int] | range:
    """In ascending order, the indexed boxes that may meet ``box`` (edges
    included): every one that does, and others; all ``count`` without an
    index or when ``box`` has no cells."""
    if index is None:
        return range(count)
    cells, unbound = index
    xs, ys = _cells(box[0], box[2]), _cells(box[1], box[3])
    if xs is None or ys is None:
        return range(count)
    found = set(unbound)
    for cell in itertools.product(xs, ys):
        found.update(cells.get(cell, ()))
    return sorted(found)


def _lines_for_words(lines: list[list[Glyph]], done: set[Glyph]) -> list[list[Glyph]]:
    """Reader lines with misplaced scripts moved to the line of their base.

    A reader may file a script as its own small line, or as the start of the
    next line (a subscript hanging below its base), so the leading run of
    small glyphs of each line goes to the line holding a bigger glyph that
    ends where the run starts and overlaps it vertically."""
    rows = [
        sorted((g for g in line if g not in done), key=lambda g: g.x0) for line in lines
    ]
    rows = [r for r in rows if r]
    owner = {g: i for i, row in enumerate(rows) for g in row}
    spans = [(min(g.y0 for g in row), max(g.y1 for g in row)) for row in rows]
    biggest = max((g.size for row in rows for g in row), default=0)
    # A page of plot markers set as text holds thousands of rows: a run is
    # compared only with the rows that reach the gap a base may leave.
    index = _box_index(
        [
            (min(g.x0 for g in row), y0, max(g.x1 for g in row), y1)
            for row, (y0, y1) in zip(rows, spans)
        ]
    )
    for i, row in enumerate(rows):
        size = max(g.size for g in row)
        run = []
        for g in row:
            if g.size > SCRIPT_RATIO * size:
                break
            run.append(g)
        if not run and size < biggest:
            run = row  # a whole line of small glyphs
        if not run or len(run) > 12:
            continue
        head = run[0]
        best = None
        gap = (head.x0 - 0.45 * biggest, head.y0, head.x0, head.y1)
        for j in _beside(index, gap, len(rows)):
            other = rows[j]
            if j == i or spans[j][0] > head.y1 or spans[j][1] < head.y0:
                continue
            for h in other:
                if h.size * SCRIPT_RATIO < head.size or not (
                    h.y0 < head.y1 and head.y0 < h.y1
                ):
                    continue
                gap = head.x0 - h.x1
                if (
                    -0.3 * h.size <= gap <= 0.45 * h.size
                    and h.x0 < head.x0
                    and (best is None or abs(gap) < best[0])
                ):
                    best = (abs(gap), j)
        if best is not None:
            for g in run:
                owner[g] = best[1]
    out: dict[int, list[Glyph]] = {}
    for g, i in owner.items():
        out.setdefault(i, []).append(g)
    return list(out.values())
