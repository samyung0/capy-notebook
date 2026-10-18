"""Image blocks that are not figures.

veraPDF makes an image chunk of every placed image, so rules, badges and
formulas set as pictures arrive as images
(bench/parsers/reports/2026-09-23-odl-thin-images-and-accuracy.md).

- Sliver: a side under 1 pt, or the short side under 1% of the long side (ODL's
  own "subtle" test). dvips rules drawn as 1x1 stencil masks, spacer pixels;
  dropped.
- Formula picture (unrotated pages only): at most 2.5 body lines tall, on a text
  line with text beside it (inline) or alone between two text lines (display),
  and passing the six precision tests (``_not_formula``). Retyped ``equation``:
  a display formula's text is PLACEHOLDER, an inline one is spliced into its
  paragraph by ``place_inline`` or else carries PLACEHOLDER itself.
- Repeat: the same stored image (a hash of the image object as the PDF stores
  it, palette and mask included, no pixels decoded) on REPEAT_PAGES or more pages (licence
  badges, logos, icons, chapter bars, also when each page stores its own copy).
  Kept as ``discarded`` page furniture, unless it is a glyph-sized formula
  among different words each time.

``add_vector_figures`` adds the figures ODL never sees: veraPDF makes chunks of
placed images only, so a diagram drawn with paths reached the index as its loose
labels. A cluster of drawing paths large and busy enough, sparse in text and
clear of image and table blocks becomes an ``image`` block. Text blocks inside it,
and short ones beside it, become its ``figure_labels`` (a source or note line its
``image_footnote``): indexed on the figure's line, never body text or headings. A
cluster holding a sentence, code or merged table rows is a callout, a listing's
frame, a table or a text box and stays text.
"""

from __future__ import annotations

import hashlib
import math
import re
import statistics
import struct
from collections import Counter, defaultdict

import pymupdf

from . import page_text
from .memory import out_of_memory

REPEAT_PAGES = 5
HASH_CHUNK = 1 << 16  # bytes read at a time when hashing a stored image
STORED_DEPTH = 8  # reference levels a stored image's hash follows (mask, palette)
MIN_SIDE_PT = 1.0
SUBTLE_ASPECT = 0.01
PLACEHOLDER = "[formula]"
CAPTION = re.compile(
    r"^\s*(figure|fig\.?|table|chart|graph|exhibit|diagram|abb\.?|figura|図|表)\s*[\dIVXA-Z]",
    re.IGNORECASE,
)


def _rect(block: dict, page: pymupdf.Page) -> pymupdf.Rect:
    x0, y0, x1, y1 = block["bbox"]
    w, h = page.rect.width / 1000, page.rect.height / 1000
    return pymupdf.Rect(x0 * w, y0 * h, x1 * w, y1 * h)


def _page_facts(page: pymupdf.Page) -> tuple[list, float, float, list] | None:
    """Horizontal text lines with a letter or digit, their median height, the
    median font size, and the page's words; None when the page has no such line
    (no picture there is a formula)."""
    lines, sizes = [], []
    for block in page_text.page_dict(page)["blocks"]:
        for line in block.get("lines", []):
            text = "".join(s["text"] for s in line["spans"])
            if abs(line["dir"][0] - 1) > 0.01 or not any(c.isalnum() for c in text):
                continue
            lines.append((pymupdf.Rect(line["bbox"]), text))
            sizes.extend(s["size"] for s in line["spans"] if s["text"].strip())
    if not lines:
        return None
    body = statistics.median(r.height for r, _ in lines)
    return lines, body, statistics.median(sizes), page_text.page_words(page)


def _formula_kind(
    rect: pymupdf.Rect, lines: list[pymupdf.Rect], body: float
) -> str | None:
    h = rect.height
    # MuPDF can merge a diagram's scattered labels into one tall "line"; only
    # lines of body height count, and a formula picture is at most 2.5 of them.
    if h > 2.5 * body:
        return None
    normal = [line for line in lines if line.height <= 2 * body]
    for line in normal:
        overlap = min(rect.y1, line.y1) - max(rect.y0, line.y0)
        if overlap < 0.5 * h or h > 1.8 * max(line.height, 1):
            continue
        gap = min(abs(rect.x0 - line.x1), abs(line.x0 - rect.x1))
        if gap <= 1.5 * line.height or (line.x0 <= rect.x0 and rect.x1 <= line.x1):
            return "inline"
    same = any(min(rect.y1, l.y1) - max(rect.y0, l.y0) > 0.3 * h for l in lines)
    above = any(
        0 <= rect.y0 - l.y1 <= 3 * body and l.x0 < rect.x1 and rect.x0 < l.x1
        for l in normal
    )
    below = any(
        0 <= l.y0 - rect.y1 <= 3 * body and l.x0 < rect.x1 and rect.x0 < l.x1
        for l in normal
    )
    return "display" if not same and above and below else None


def _not_formula(page: pymupdf.Page, rect: pymupdf.Rect, facts: tuple) -> bool:
    """The six precision tests: a caption line just below, mostly coloured ink,
    blank, a side under 3 pt, words drawn on top, or over 45% mid-tone (key caps,
    badges)."""
    lines, _, size, words = facts
    below = [
        text
        for r, text in lines
        if 0 <= r.y0 - rect.y1 <= 3 * size
        and r.x0 < rect.x1 + 20
        and rect.x0 - 20 < r.x1
    ]
    if any(CAPTION.match(text) for text in below[:2]):
        return True
    if min(rect.width, rect.height) < 3:
        return True
    if any(rect.contains(((w[0] + w[2]) / 2, (w[1] + w[3]) / 2)) for w in words):
        return True
    zoom = max(0.5, min(3.0, 60 / max(rect.height, 1)))
    pix = page.get_pixmap(
        clip=rect,
        matrix=pymupdf.Matrix(zoom, zoom),
        alpha=False,
        colorspace=pymupdf.csRGB,
    )
    ink = nonwhite = coloured = mid = 0
    for (r, g, b), n in pix.color_count(colors=True).items():
        lum = 0.299 * r + 0.587 * g + 0.114 * b
        ink += n * (lum < 150)
        mid += n * (lum < 200)
        if lum < 235:
            nonwhite += n
            coloured += n * (max(r, g, b) - min(r, g, b) > 50)
    total = max(pix.width * pix.height, 1)
    return (
        ink / total < 0.003
        or mid / total > 0.45
        or (nonwhite / total > 0.02 and coloured / max(nonwhite, 1) > 0.35)
    )


def _words_beside(rect: pymupdf.Rect, words: list) -> tuple[str | None, str | None]:
    """The words just left and right of a picture on its line."""
    line = [
        w
        for w in words
        if min(rect.y1, w[3]) - max(rect.y0, w[1])
        >= 0.5 * min(rect.height, w[3] - w[1])
    ]
    left = max(
        (w for w in line if w[2] <= rect.x0 + 1), key=lambda w: w[2], default=None
    )
    right = min(
        (w for w in line if w[0] >= rect.x1 - 1), key=lambda w: w[0], default=None
    )
    return (left[4] if left else None), (right[4] if right else None)


def empty_table(block: dict) -> bool:
    """A table with no text in any cell and no caption: ODL's cluster method
    boxes drawn frames (tableaux, answer boxes) as such; half the tables on 49
    documents were empty."""
    body = re.sub(r"<[^>]+>", " ", str(block.get("table_body") or ""))
    return (
        block.get("type") == "table"
        and not body.split()
        and not block.get("table_caption")
    )


_REFERENCE = re.compile(r"(\d+) \d+ R")
_LENGTH = re.compile(r"/Length (?:\d+ \d+ R|\d+)")


def _stored_hash(
    document: pymupdf.Document,
    xref: int,
    memo: dict[int, bytes | None],
    depth: int = 0,
) -> bytes:
    """SHA-256 of an object as the PDF stores it, no pixels decoded: its
    dictionary without /Length, each reference replaced by the referenced
    object's own hash (a palette or soft mask counts by content, not object
    number), then its stream's still-encoded bytes read HASH_CHUNK at a time,
    so the largest image costs no more memory than the chunk. ``memo`` keeps
    a document's hashes and failures (None), so each object is read at most
    once; a reference back to an object in progress hashes as empty. Raises
    ValueError past STORED_DEPTH references or for an object that failed
    before, and whatever reading a broken object raises."""
    if xref in memo:
        if (known := memo[xref]) is None:
            raise ValueError("the object failed before")
        return known
    if depth > STORED_DEPTH:
        raise ValueError("references nest too deep")
    memo[xref] = b""
    try:
        text = _LENGTH.sub("", document.xref_object(xref, compressed=True))
        text = _REFERENCE.sub(
            lambda ref: _stored_hash(document, int(ref[1]), memo, depth + 1).hex(),
            text,
        )
        digest = hashlib.sha256(text.encode())
        if document.xref_is_stream(xref):
            mupdf = pymupdf.mupdf
            chunk = bytearray(HASH_CHUNK)
            data = mupdf.python_mutable_buffer_data(chunk)
            stream = mupdf.pdf_open_raw_stream_number(
                mupdf.pdf_document_from_fz_document(document.this), xref
            )
            while read := mupdf.ll_fz_read(stream.m_internal, data, HASH_CHUNK):
                digest.update(memoryview(chunk)[:read])
    except BaseException:
        memo[xref] = None
        raise
    memo[xref] = digest.digest()
    return memo[xref]


def classify(
    blocks: list[dict], document: pymupdf.Document, objects: dict[int, int]
) -> list[dict]:
    """``objects``: ODL's element id -> the PDF object of the image a picture
    draws (``java.image_objects``). A picture's identity for repeats is the
    hash of that object as stored (``_stored_hash``), so copies stored as
    separate objects match. An inline image or a broken object has none and
    never repeats."""
    images = {
        index
        for index, block in enumerate(blocks)
        if block.get("type") == "image" and len(block.get("bbox") or []) == 4
    }
    xrefs = {
        index: xref
        for index in images
        if (xref := objects.get(blocks[index].get("_native_id"))) is not None
    }
    memo: dict[int, bytes | None] = {}

    def stored(xref: int) -> bytes | None:
        try:
            return _stored_hash(document, xref, memo)
        except Exception as exc:
            if out_of_memory(exc):
                raise  # the parse's out-of-memory path
            return None  # a broken image object is never a repeat

    hashes = {xref: stored(xref) for xref in set(xrefs.values())}
    identity = {
        index: hashes[xref] for index, xref in xrefs.items() if hashes[xref] is not None
    }
    pages: dict[bytes, set[int]] = defaultdict(set)
    for index, key in identity.items():
        pages[key].add(blocks[index]["page_idx"])
    facts: dict[int, tuple | None] = {}

    def page_facts(page: pymupdf.Page) -> tuple | None:
        # Only the current page's text stays in memory, as in evidence.py. A
        # rotated page is skipped like the other stages do: ODL's boxes and
        # PyMuPDF's text are in different frames there.
        if page.rotation:
            return None
        if page.number not in facts:
            facts.clear()
            facts[page.number] = _page_facts(page)
        return facts[page.number]

    def repeated(index: int) -> bool:
        return index in identity and len(pages[identity[index]]) >= REPEAT_PAGES

    # A repeat with the same words beside it in most placements is furniture (a
    # licence badge after the same licence sentence); a reused formula glyph such
    # as x or dx sits among different words each time.
    contexts: dict[bytes, Counter] = defaultdict(Counter)
    for index in sorted(images):
        page = document[blocks[index]["page_idx"]]
        if repeated(index) and (page_fact := page_facts(page)):
            beside = _words_beside(_rect(blocks[index], page), page_fact[3])
            contexts[identity[index]][beside] += 1
    fixed = {
        key
        for key, seen in contexts.items()
        if seen.most_common(1)[0][1] >= 0.6 * seen.total()
    }

    out: list[dict] = []
    for index, block in enumerate(blocks):
        if index not in images:
            out.append(block)
            continue
        page = document[block["page_idx"]]
        rect = _rect(block, page)
        short, long = sorted((rect.width, rect.height))
        if short < MIN_SIDE_PT or short < SUBTLE_ASPECT * long:
            continue
        kind = None
        if page_fact := page_facts(page):
            kind = _formula_kind(rect, [r for r, _ in page_fact[0]], page_fact[1])
        if (
            kind
            and repeated(index)
            and (identity[index] in fixed or rect.height > 1.6 * page_fact[2])
        ):
            kind = None
        if kind and _not_formula(page, rect, page_fact):
            kind = None
        if kind:
            text = PLACEHOLDER if kind == "display" else ""
            block = {**block, "type": "equation", "text": text, "_picture": kind}
        elif repeated(index):
            block = {**block, "type": "discarded"}
        out.append(block)
    return out


# A figure is at least this share of the page and this many path segments.
VECTOR_MIN_AREA = 0.03
VECTOR_MIN_SEGMENTS = 12
# Paths this close (points) belong to one figure.
VECTOR_GAP = 8.0
# Grid cell side (points) for finding the clusters near a path: a hairline's
# box grown by VECTOR_GAP spans at most three cells a side.
VECTOR_CELL = 2 * VECTOR_GAP
# A cluster spanning more cells than this is not put in the grid but compared
# with every path, and a path whose grown box spans more cells than there are
# clusters is compared with all of them: few such boxes fit on a page.
VECTOR_BIG_CELLS = 64
# Steps (a grid cell read or written, a box compared) clustering may take on
# one document, a backstop: the grid keeps clustering near linear, and the
# costliest of 288 library books took 10.6 million. The page that runs out and
# every later page have no clusters: no vector figures, and heading recall
# sees no drawing there.
VECTOR_MAX_STEPS = 20_000_000
# Word area over figure area above this is a text box or a table, not a figure.
VECTOR_MAX_TEXT = 0.25
# A short text block this close (points) to a figure is its axis or callout label.
VECTOR_LABEL_REACH = 30.0
VECTOR_LABEL_WORDS = 6
# Text blocks inside a cluster of only straight axis-aligned strokes: a grid.
VECTOR_GRID_TEXTS = 6
# A figure label is never a sentence: 25 characters ending in . ? ! 。？！
_SENTENCE = re.compile(r"\S.{23,}[.?!。？！]\s*$")
# Code in a listing's frame: braces, statement ends, assignments, sends.
_CODE = re.compile(r"[{};]|:=|>>|\[\s*:\w")
_AMOUNT = re.compile(r"\(?[$€£¥]?\d[\d,.]*\)?")


def _table_row(text: str) -> bool:
    """Rows of a table ODL merged into one block: twelve tokens mixing three
    words with three amounts ("Net interest income $ 324 $ 247 ..."). A chart's
    tick run ("2000 2001 ...", "Jan Mar May ...") has one kind only."""
    tokens = text.split()
    words = sum(1 for t in tokens if t.isalpha() and len(t) > 2)
    return len(tokens) >= 12 and words >= 3 and len(_AMOUNT.findall(text)) >= 3


# A chart's source or note line is its footnote, sentence or not.
_SOURCE = re.compile(
    r"^\s*(?:(?:data )?sources?|notes?|quelle[n]?|hinweis|fuentes?|notas?|資料來源|资料来源|出典|出所|注)\s*[:：]",
    re.IGNORECASE,
)


def _axis_aligned(item: tuple) -> bool:
    if item[0] == "re":
        return True
    if item[0] == "l":
        (x0, y0), (x1, y1) = item[1], item[2]
        return abs(x0 - x1) < 0.5 or abs(y0 - y1) < 0.5
    return False


class Drawings:
    """One document's drawing clusters: each page's computed once, within
    VECTOR_MAX_STEPS for the document. Only clusters of at least
    VECTOR_MIN_SEGMENTS segments are kept: vector figures and heading recall
    read no others."""

    def __init__(self, steps: int = VECTOR_MAX_STEPS) -> None:
        self.steps = self.left = steps
        self.pages: dict[int, list[tuple[pymupdf.Rect, int, int]]] = {}
        # The page where the steps ran out, for the parse's log line.
        self.stopped_at: int | None = None

    @property
    def spent(self) -> int:
        return self.steps - self.left

    def clusters(
        self, page: pymupdf.Page, paths: list[dict] | None = None
    ) -> list[tuple[pymupdf.Rect, int, int]]:
        """``paths``: the page's ``get_cdrawings()`` when the caller holds it."""
        if page.number not in self.pages:
            found = _figure_clusters(page, self, paths) if self.left >= 0 else []
            if self.left < 0 and self.stopped_at is None:
                self.stopped_at = page.number
            self.pages[page.number] = [
                cluster for cluster in found if cluster[1] >= VECTOR_MIN_SEGMENTS
            ]
        return self.pages[page.number]

    def spend(self, steps: int) -> bool:
        """False once the document's steps are spent; they stay spent."""
        self.left -= steps
        return self.left >= 0


def _figure_clusters(
    page: pymupdf.Page, drawings: Drawings, paths: list[dict] | None = None
) -> list[tuple[pymupdf.Rect, int, int]]:
    """Drawing clusters with their segment counts and how many of those are
    axis-aligned lines or boxes. Page-wide rules and frames, hairline specks
    and white fills are left out first. Each path in turn joins every cluster
    whose box meets its own box grown by VECTOR_GAP; then clusters whose boxes
    meet merge until none do. Clusters come in the order of the cluster each
    one began as, as a list of them appended to on every merge would hold.

    A grid of VECTOR_CELL cells holds each cluster in the cells its box covers,
    on the page or off it (big clusters stay out, see VECTOR_BIG_CELLS), so a
    path compares only the clusters in the cells its grown box covers, and union-find lets a merged cluster be found from the
    cells of the clusters it took in. Boxes are
    float tuples with pymupdf's own tests and union (``_meets``, ``_union``).
    Empty once ``drawings`` has spent its steps."""
    width, height = page.rect.width, page.rect.height
    parent: list[int] = []
    boxes: list[tuple[float, float, float, float]] = []
    spans: list = []  # each cluster's span
    segments: list[int] = []
    aligned: list[int] = []
    grid: dict[tuple[int, int], list[int]] = defaultdict(list)
    live: set[int] = set()  # the clusters now
    big: set[int] = set()  # clusters wider than VECTOR_BIG_CELLS, held here only

    def span(box: tuple) -> tuple[int, int, int, int]:
        """The cells a box (finite, see the path loop) covers."""
        return (
            int(box[0] // VECTOR_CELL),
            int(box[1] // VECTOR_CELL),
            int(box[2] // VECTOR_CELL),
            int(box[3] // VECTOR_CELL),
        )

    def find(node: int) -> int:
        while parent[node] != node:
            parent[node] = parent[parent[node]]
            node = parent[node]
        return node

    def near(area: tuple[int, int, int, int]) -> set[int] | None:
        """The clusters in the cells of ``area`` (each cell's list cut to its
        clusters) and the big ones, or every cluster when there are fewer
        than cells to read; None once the steps are spent. The cells are paid
        for before they are read."""
        cells = _cells(area)
        if cells > len(live):
            found = set(live)
            return found if drawings.spend(2 * len(found)) else None
        roots = {find(node) for node in big}
        big.clear()
        big.update(roots)
        found = set(roots)
        if not drawings.spend(len(roots) + cells):
            return None
        steps = 0
        for x in range(area[0], area[2] + 1):
            for y in range(area[1], area[3] + 1):
                held = grid.get((x, y))
                if held:
                    roots = {find(node) for node in held}
                    if len(roots) < len(held):
                        grid[(x, y)] = list(roots)
                    found |= roots
                    steps += len(held)
        return found if drawings.spend(steps + len(found)) else None

    def merge(node: int, others: list[int], held: tuple | None) -> tuple | None:
        """Merge ``others`` into ``node``. Returns the widest span already
        finding ``node``: ``held`` (its own, if in the grid) or an other's."""
        for other in others:
            parent[other] = node
            live.discard(other)
            boxes[node] = _union(boxes[node], boxes[other])
            segments[node] += segments[other]
            aligned[node] += aligned[other]
            if held is None or _cells(spans[other]) > _cells(held):
                held = spans[other]
        spans[node] = span(boxes[node])
        return held

    def hold(node: int, held: tuple | None) -> bool:
        """Put ``node`` in the cells of its span outside ``held`` (a span
        inside it): the rows above and below ``held``, then the columns
        either side of it. The cells are paid for before they are filled."""
        x0, y0, x1, y1 = spans[node]
        if _cells(spans[node]) > VECTOR_BIG_CELLS:
            big.add(node)
            return drawings.spend(1)
        if not drawings.spend(_cells(spans[node]) - (_cells(held) if held else 0)):
            return False
        hx0, hy0, hx1, hy1 = held or (x1 + 1, y1 + 1, x1, y1)
        rows = [*range(y0, hy0), *range(hy1 + 1, y1 + 1)]
        cells = [(x, y) for y in rows for x in range(x0, x1 + 1)]
        if x0 < hx0 or hx1 < x1:
            columns = [*range(x0, hx0), *range(hx1 + 1, x1 + 1)]
            cells += [(x, y) for y in range(hy0, hy1 + 1) for x in columns]
        for at in cells:
            grid[at].append(node)
        return True

    for path in page.get_cdrawings() if paths is None else paths:
        x0, y0, x1, y1 = path["rect"]
        w, h = x1 - x0, y1 - y0
        if (w < 0.5 and h < 0.5) or (w >= 0.9 * width and h >= 0.9 * height):
            continue
        if (h <= 1.5 and w >= 0.3 * width) or (w <= 1.5 and h >= 0.3 * height):
            continue
        if path.get("fill") == (1.0, 1.0, 1.0) and not path.get("color"):
            continue
        # A straight line's rect has no area, and pymupdf skips empty rects in
        # unions and intersections: give it a hairline's thickness.
        rect = (
            float(x0),
            float(y0),
            float(max(x1, x0 + 0.5)),
            float(max(y1, y0 + 0.5)),
        )
        # A NaN or infinite box (content under a huge matrix) meets nothing,
        # as pymupdf's rects never did, and has no cells.
        if not all(map(math.isfinite, rect)):
            continue
        grown = (
            rect[0] - VECTOR_GAP,
            rect[1] - VECTOR_GAP,
            rect[2] + VECTOR_GAP,
            rect[3] + VECTOR_GAP,
        )
        candidates = near(span(grown))
        if candidates is None:
            return []
        items = path.get("items") or ()
        node = len(parent)
        parent.append(node)
        live.add(node)
        boxes.append(rect)
        spans.append(None)  # set by merge
        segments.append(len(items) or 1)
        aligned.append(sum(map(_axis_aligned, items)))
        hits = [c for c in candidates if _meets(boxes[c], grown)]
        if not hold(node, merge(node, hits, None)):
            return []
    # One more pass: merging can make clusters overlap that did not before.
    # Merging them until no two boxes meet gives the same grouping in any
    # order; a merged cluster keeps the earliest place among its parts.
    order = list(range(len(parent)))
    work = [node for node in reversed(order) if parent[node] == node]
    while work:
        node = work.pop()
        if parent[node] != node:
            continue
        candidates = near(spans[node])
        if candidates is None:
            return []
        hits = [c for c in candidates if c != node and _meets(boxes[c], boxes[node])]
        if hits:
            order[node] = min(order[c] for c in [node, *hits])
            if not hold(node, merge(node, hits, spans[node])):
                return []
            work.append(node)
    roots = sorted(
        (n for n in range(len(parent)) if parent[n] == n), key=order.__getitem__
    )
    return [(pymupdf.Rect(boxes[n]), segments[n], aligned[n]) for n in roots]


def _cells(area: tuple[int, int, int, int]) -> int:
    return (area[2] - area[0] + 1) * (area[3] - area[1] + 1)


_INFINITE = (
    pymupdf.FZ_MIN_INF_RECT,
    pymupdf.FZ_MIN_INF_RECT,
    pymupdf.FZ_MAX_INF_RECT,
    pymupdf.FZ_MAX_INF_RECT,
)
_C_FLOATS = struct.Struct("4f")


def _empty(box: tuple) -> bool:
    return box[0] >= box[2] or box[1] >= box[3]


def _inverted(box: tuple) -> bool:
    return box[0] > box[2] or box[1] > box[3]


def _meets(a: tuple, b: tuple) -> bool:
    """``pymupdf.Rect(a).intersects(b)``."""
    return (
        not (_empty(a) or a == _INFINITE or _empty(b) or b == _INFINITE)
        and a[0] < b[2]
        and b[0] < a[2]
        and a[1] < b[3]
        and b[1] < a[3]
    )


def _union(a: tuple, b: tuple) -> tuple:
    """``pymupdf.Rect(a) | b``: pymupdf's own checks, then MuPDF's union of
    the two as C floats."""
    if a == _INFINITE or b == _INFINITE:
        return _INFINITE
    if _empty(b):
        return a
    if _empty(a):
        return b
    a, b = _C_FLOATS.unpack(_C_FLOATS.pack(*a)), _C_FLOATS.unpack(_C_FLOATS.pack(*b))
    # MuPDF's own test: only an inverted box is empty there.
    if _inverted(b) or a == _INFINITE:
        return a
    if _inverted(a) or b == _INFINITE:
        return b
    return (min(a[0], b[0]), min(a[1], b[1]), max(a[2], b[2]), max(a[3], b[3]))


def add_vector_figures(
    blocks: list[dict], document: pymupdf.Document, drawings: Drawings | None = None
) -> list[dict]:
    drawings = drawings or Drawings()
    by_page: dict[int, list[int]] = defaultdict(list)
    for index, block in enumerate(blocks):
        if len(block.get("bbox") or []) == 4:
            by_page[block["page_idx"]].append(index)
    inserts: dict[int, dict] = {}  # block index -> figure placed before it
    labels: set[int] = set()  # text blocks folded into a figure
    tail: dict[int, list[dict]] = defaultdict(list)  # page -> figures after its blocks
    for page in document:
        if page.rotation:
            continue
        indices = by_page.get(page.number, [])
        taken = [
            _rect(blocks[i], page)
            for i in indices
            if blocks[i].get("type") in ("image", "equation")
            or (blocks[i].get("type") == "table" and not empty_table(blocks[i]))
        ]
        words = None
        area = page.rect.width * page.rect.height
        for rect, segments, aligned in drawings.clusters(page):
            if rect.width * rect.height < VECTOR_MIN_AREA * area:
                continue
            if any(abs(rect & t) > 0.5 * min(abs(rect), abs(t)) for t in taken):
                continue
            if words is None:
                words = [pymupdf.Rect(w[:4]) for w in page_text.page_words(page)]
            text = sum(abs(w & rect) for w in words)
            if text > VECTOR_MAX_TEXT * abs(rect):
                continue
            w, h = page.rect.width / 1000, page.rect.height / 1000
            figure = {
                "type": "image",
                "bbox": [rect.x0 / w, rect.y0 / h, rect.x1 / w, rect.y1 / h],
                "page_idx": page.number,
                "_source_role": "vector-figure",
            }
            drawing = pymupdf.Rect(rect)
            reach = rect + (
                -VECTOR_LABEL_REACH,
                -VECTOR_LABEL_REACH,
                VECTOR_LABEL_REACH,
                VECTOR_LABEL_REACH,
            )
            inside = []
            for i in indices:
                if blocks[i].get("type") not in ("text", "title") or i in labels:
                    continue
                box, text = _rect(blocks[i], page), str(blocks[i].get("text", ""))
                # Short text beside the drawing is an axis or callout label;
                # a formula set beside it ("Gain = dV/dV") stays in the body.
                # Against the drawing itself, not the box labels have grown,
                # so absorbing one label never pulls in the text past it.
                if abs(box & drawing) >= 0.8 * abs(box) or (
                    box in reach
                    and len(text.split()) <= VECTOR_LABEL_WORDS
                    and "=" not in text
                ):
                    inside.append(i)
                    rect |= box
            # Ruled rows of text: a table ODL did not recognise, not a figure.
            if aligned >= 0.9 * segments and len(inside) >= VECTOR_GRID_TEXTS:
                continue
            # A sentence inside: a shaded callout, a code listing's frame or a
            # text box, not a figure.
            texts = [str(blocks[i].get("text", "")).strip() for i in inside]
            if any(
                not _SOURCE.match(t)
                and (_SENTENCE.search(t) or len(_CODE.findall(t)) >= 2 or _table_row(t))
                for t in texts
            ):
                continue
            figure["bbox"] = [rect.x0 / w, rect.y0 / h, rect.x1 / w, rect.y1 / h]
            figure["figure_labels"] = [t for t in texts if t and not _SOURCE.match(t)]
            if notes := [t for t in texts if _SOURCE.match(t)]:
                figure["image_footnote"] = notes
            labels.update(inside)
            following = [
                i
                for i in indices
                if _rect(blocks[i], page).y0 >= rect.y0 and i not in labels
            ]
            anchor = min(inside or following, default=None)
            if anchor is None or anchor in inserts:
                tail[page.number].append(figure)
                continue
            inserts[anchor] = figure
    if not inserts and not tail:
        return blocks
    out: list[dict] = []
    last_on_page = {page: max(indices) for page, indices in by_page.items()}
    for index, block in enumerate(blocks):
        if index in inserts:
            out.append(inserts[index])
        if index not in labels:
            out.append(block)
        if index == last_on_page.get(block.get("page_idx")):
            out.extend(tail.pop(block["page_idx"], []))
    for figures in tail.values():  # pages without any block
        out.extend(figures)
    return out


def _off_centre(rect: pymupdf.Rect, region: pymupdf.Rect) -> bool:
    """``rect`` is above or below ``region`` but not centred on it: a section
    heading at the margin, where a chart's title or axis title is centred."""
    if rect.x1 <= region.x0 or rect.x0 >= region.x1:
        return False  # beside it: a vertical axis title
    centre, middle = (rect.x0 + rect.x1) / 2, (region.x0 + region.x1) / 2
    return abs(centre - middle) > 0.25 * region.width


def _quiet_kind(
    page: pymupdf.Page, rect: pymupdf.Rect, facts: tuple | None
) -> str | None:
    """How a quiet region (a formula drawn as outlines, flatten.py) carries
    PLACEHOLDER: "inline" where classify's rule finds it in a text line, to be
    spliced by ``place_inline``, else "display", its own block; None on a page
    without text lines or where the precision tests (``_not_formula``) find no
    formula. Words over it are no test here: a quiet region's words belong to
    its formula, not to a badge drawn under them."""
    if facts is None:
        return None
    lines, body, size, _ = facts
    if _not_formula(page, rect, (lines, body, size, [])):
        return None
    inline = _formula_kind(rect, [r for r, _ in lines], body) == "inline"
    return "inline" if inline else "display"


def flattened_figures(
    blocks: list[dict],
    document: pymupdf.Document,
    regions: dict[int, list[pymupdf.Rect]],
    quiet: dict[int, list[pymupdf.Rect]] | None = None,
) -> list[dict]:
    """One figure per flattened region (flatten.py), in the region's box: ODL's
    picture of the render, or a new one. Pieces of it ODL read as pictures or
    formulas go; the text inside and short labels beside it join the figure as
    its labels, like a vector figure's; a sentence stays in the body. A region
    in ``quiet`` (a formula drawn as outlines) loses its pieces and makes no
    figure: its text stays in the body, and a formula block carrying
    PLACEHOLDER takes the place of its first piece (``_quiet_kind``), or comes
    after the table it sits in."""
    quiet = quiet or {}
    if not regions:
        return blocks
    by_page: dict[int, list[int]] = defaultdict(list)
    for index, block in enumerate(blocks):
        if len(block.get("bbox") or []) == 4:
            by_page[block["page_idx"]].append(index)
    gone: set[int] = set()
    inserts: dict[int, list[dict]] = defaultdict(list)  # before a block
    after: dict[int, list[dict]] = defaultdict(list)
    tail: dict[int, list[dict]] = defaultdict(list)
    for number, boxes in regions.items():
        page = document[number]
        w, h = page.rect.width / 1000, page.rect.height / 1000
        facts: tuple | None = None  # classify's page facts, read once if needed
        for region in boxes:
            pieces, inside = [], []
            reach = region + (
                -VECTOR_LABEL_REACH,
                -VECTOR_LABEL_REACH,
                VECTOR_LABEL_REACH,
                VECTOR_LABEL_REACH,
            )
            for i in by_page.get(number, []):
                if i in gone:
                    continue
                block, rect = blocks[i], _rect(blocks[i], page)
                if block.get("type") in ("image", "discarded") or (
                    block.get("type") == "equation" and block.get("_picture")
                ):
                    if abs(rect & region) >= 0.5 * abs(rect):
                        pieces.append(i)
                elif block.get("type") in ("text", "title"):
                    text = str(block.get("text", "")).strip()
                    if _SENTENCE.search(text):
                        continue
                    # Inside, or a short label beside it, as for vector figures.
                    if abs(rect & region) >= 0.8 * abs(rect) or (
                        rect in reach
                        and len(text.split()) <= VECTOR_LABEL_WORDS
                        and "=" not in text
                        and not (block.get("text_level") and _off_centre(rect, region))
                    ):
                        inside.append(i)
            if region in quiet.get(number, []):
                gone.update(pieces)
                if facts is None:
                    # Rotated pages are skipped as in classify.
                    facts = () if page.rotation else (_page_facts(page) or ())
                kind = _quiet_kind(page, region, facts or None)
                if kind is None:
                    continue
                centre = ((region.x0 + region.x1) / 2, (region.y0 + region.y1) / 2)
                table = next(
                    (
                        i
                        for i in by_page.get(number, [])
                        if blocks[i].get("type") == "table"
                        and _rect(blocks[i], page).contains(centre)
                    ),
                    None,
                )
                # Inside a table no paragraph can take it: its own block.
                kind = "display" if table is not None else kind
                formula = {
                    "type": "equation",
                    "text": PLACEHOLDER if kind == "display" else "",
                    "_picture": kind,
                    "bbox": [
                        region.x0 / w,
                        region.y0 / h,
                        region.x1 / w,
                        region.y1 / h,
                    ],
                    "page_idx": number,
                }
                if table is not None:
                    after[table].append(formula)
                elif pieces:
                    inserts[min(pieces)].append(formula)
                else:
                    tail[number].append(formula)
                continue
            base = next((blocks[i] for i in pieces if blocks[i]["type"] == "image"), {})
            texts = [str(blocks[i].get("text", "")).strip() for i in inside]
            figure = {
                **base,
                "type": "image",
                "bbox": [region.x0 / w, region.y0 / h, region.x1 / w, region.y1 / h],
                "page_idx": number,
                "_source_role": "flattened-figure",
                "figure_labels": [t for t in texts if t and not _SOURCE.match(t)],
            }
            if notes := [t for t in texts if _SOURCE.match(t)]:
                figure["image_footnote"] = notes
            gone.update(pieces, inside)
            anchor = min(pieces + inside, default=None)
            if anchor is None:
                tail[number].append(figure)
            else:
                inserts[anchor].append(figure)
    out: list[dict] = []
    last_on_page = {page: max(indices) for page, indices in by_page.items()}
    for index, block in enumerate(blocks):
        out.extend(inserts.get(index, ()))
        if index not in gone:
            out.append(block)
        out.extend(after.get(index, ()))
        if index == last_on_page.get(block.get("page_idx")):
            out.extend(tail.pop(block["page_idx"], []))
    for figures in tail.values():  # pages without any block
        out.extend(figures)
    return out


def place_inline(blocks: list[dict], document: pymupdf.Document) -> list[dict]:
    """Splice PLACEHOLDER into the paragraph holding each inline formula picture,
    between the words on either side of it when that pair occurs once there.

    An unplaced picture carries PLACEHOLDER as its own block: right after its one
    host paragraph, or where it sits in reading order when it has no single host
    (a table cell, a diagram)."""
    words: dict[int, list] = {}
    after: dict[int, list[dict]] = defaultdict(list)  # id(host) -> its pictures
    for picture in [b for b in blocks if b.get("_picture") == "inline"]:
        number = picture["page_idx"]
        x = (picture["bbox"][0] + picture["bbox"][2]) / 2
        y = (picture["bbox"][1] + picture["bbox"][3]) / 2
        hosts = [
            b
            for b in blocks
            if b.get("page_idx") == number
            and b.get("type") in ("text", "list")
            and not b.get("text_level")
            and len(b.get("bbox") or []) == 4
            and b["bbox"][0] - 3 <= x <= b["bbox"][2] + 3
            and b["bbox"][1] - 3 <= y <= b["bbox"][3] + 3
        ]
        if len(hosts) != 1:
            picture["text"] = PLACEHOLDER
            continue
        host = hosts[0]
        page = document[number]
        if number not in words:
            words.clear()  # only the current page, as in classify
            words[number] = page_text.page_words(page)
        left, right = _words_beside(_rect(picture, page), words[number])
        # Whole words only: the pair never matches inside a longer word.
        pattern = rf"(?<!\S){re.escape(left or '')}(\s*){re.escape(right or '')}(?!\S)"
        field = "text" if host["type"] == "text" else "list_items"
        values = (
            [host["text"]] if field == "text" else list(host.get("list_items") or [])
        )
        hits = [(i, m) for i, v in enumerate(values) for m in re.finditer(pattern, v)]
        if len(hits) != 1 or (left is None and right is None):
            picture["text"] = PLACEHOLDER
            after[id(host)].append(picture)
            continue
        i, m = hits[0]
        head, tail = values[i][: m.start(1)].rstrip(" "), values[i][m.end(1) :]
        values[i] = " ".join(p for p in (head, PLACEHOLDER, tail.lstrip(" ")) if p)
        host[field] = values[0] if field == "text" else values
    moved = {id(p) for pictures in after.values() for p in pictures}
    out: list[dict] = []
    for block in blocks:
        if id(block) not in moved:
            out.append(block)
            out.extend(after.get(id(block), ()))
    return out


# A figure caption: its label and number ("Figure 4.2:", "Fig. 3", "Abbildung 2",
# "圖 2.1"); the table caption rule is in context.py.
FIGURE_CAPTION = re.compile(
    r"^(?:(?:figure|abbildung|figura|chart|graph|exhibit|plate|map|рисунок)\s+"
    r"|(?:fig|abb|рис)\.\s*)(?:[a-z]?[-.]?\d+[a-z]?(?:[.-]\d+)*|[ivxlc]{1,6})"
    # Punctuation, a capital or the end follows; "Figure 2.18 illustrates…"
    # is a sentence about the figure.
    r"(?=$|[.:：)](?!\d)|\s+(?-i:[^a-z\s]))|^[图圖図]\s*\d",
    re.IGNORECASE,
)
CAPTION_GAP = 60  # of 1000: how far a caption sits from its figure


def attach_captions(blocks: list[dict]) -> list[dict]:
    """Move a "Figure N" paragraph next to a picture into its ``image_caption``.

    ODL attached no caption to any of 5,841 pictures on 49 documents while 782
    "Figure N" paragraphs sat beside one. The caption is the paragraph right
    after the picture in reading order (or right before it when nothing
    follows), on its page, at most CAPTION_GAP below (or above) it and
    overlapping it horizontally. The chunker indexes it on the picture's line.
    """
    taken: set[int] = set()
    captions: dict[int, str] = {}
    for index, block in enumerate(blocks):
        if block.get("type") != "image" or block.get("image_caption"):
            continue
        box = block.get("bbox") or []
        for other, below in ((index + 1, True), (index - 1, False)):
            if not 0 <= other < len(blocks) or other in taken:
                continue
            candidate = blocks[other]
            bounds = candidate.get("bbox") or []
            if len(box) != 4 or len(bounds) != 4:
                continue
            text = " ".join(str(candidate.get("text") or "").split())
            gap = bounds[1] - box[3] if below else box[1] - bounds[3]
            if (
                candidate.get("type") == "text"
                and not candidate.get("text_level")
                and candidate.get("page_idx") == block.get("page_idx")
                and -5 <= gap <= CAPTION_GAP
                and min(box[2], bounds[2]) > max(box[0], bounds[0])
                and FIGURE_CAPTION.match(text)
            ):
                captions[index] = text
                taken.add(other)
                break
    return [
        {**block, "image_caption": [captions[index]]} if index in captions else block
        for index, block in enumerate(blocks)
        if index not in taken
    ]
