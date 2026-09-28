"""Image blocks that are not figures, judged before image files enter the bundle.

veraPDF makes an image chunk of every placed image and ODL writes them all, so
rules, badges and formulas set as pictures arrive as images
(bench/parsers/reports/2026-09-23-odl-thin-images-and-accuracy.md).

- Sliver: a side under 1 pt, or the short side under 1% of the long side (ODL's
  own "subtle" test). dvips rules drawn as 1x1 stencil masks, spacer pixels;
  dropped.
- Formula picture: at most 2.5 body lines tall, on a text line with text beside
  it (inline) or alone between two text lines (display), and passing the six
  precision tests (``_not_formula``). Retyped ``equation``: a display formula's
  text is PLACEHOLDER, an inline one is spliced into its paragraph by
  ``place_inline``.
- Repeat: the same rendered picture on REPEAT_PAGES or more pages (licence
  badges, logos, icons, chapter bars). Kept as ``discarded`` page furniture,
  unless it is a glyph-sized formula among different words each time.
"""

from __future__ import annotations

import hashlib
import re
import statistics
from collections import Counter, defaultdict
from pathlib import Path

import pymupdf

REPEAT_PAGES = 5
MIN_SIDE_PT = 1.0
SUBTLE_ASPECT = 0.01
PLACEHOLDER = "[formula]"
TEXT_FLAGS = pymupdf.TEXTFLAGS_DICT & ~pymupdf.TEXT_PRESERVE_IMAGES
CAPTION = re.compile(
    r"^\s*(figure|fig\.?|table|chart|graph|exhibit|diagram|abb\.?|figura|図|表)\s*[\dIVXA-Z]",
    re.IGNORECASE,
)


def _rect(block: dict, page: pymupdf.Page) -> pymupdf.Rect:
    x0, y0, x1, y1 = block["bbox"]
    w, h = page.rect.width / 1000, page.rect.height / 1000
    return pymupdf.Rect(x0 * w, y0 * h, x1 * w, y1 * h)


def _page_facts(page: pymupdf.Page) -> tuple[list, float, float, list]:
    """Horizontal text lines with a letter or digit, their median height, the
    median font size, and the page's words."""
    lines, sizes = [], []
    for block in page.get_text("dict", flags=TEXT_FLAGS)["blocks"]:
        for line in block.get("lines", []):
            text = "".join(s["text"] for s in line["spans"])
            if abs(line["dir"][0] - 1) > 0.01 or not any(c.isalnum() for c in text):
                continue
            lines.append((pymupdf.Rect(line["bbox"]), text))
            sizes.extend(s["size"] for s in line["spans"] if s["text"].strip())
    body = statistics.median(r.height for r, _ in lines) if lines else 12.0
    size = statistics.median(sizes) if sizes else 10.0
    return lines, body, size, page.get_text("words")


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


def classify(
    blocks: list[dict], document: pymupdf.Document, native_dir: Path
) -> list[dict]:
    images = {
        index
        for index, block in enumerate(blocks)
        if block.get("type") == "image" and len(block.get("bbox") or []) == 4
    }
    digests: dict[int, str] = {}
    pages: dict[str, set[int]] = defaultdict(set)
    for index in images:
        path = native_dir / str(blocks[index].get("img_path") or "")
        if path.is_file():
            digests[index] = hashlib.sha1(path.read_bytes()).hexdigest()
            pages[digests[index]].add(blocks[index]["page_idx"])
    facts: dict[int, tuple] = {}

    def page_facts(number: int) -> tuple:
        if number not in facts:
            facts[number] = _page_facts(document[number])
        return facts[number]

    def repeated(index: int) -> bool:
        return index in digests and len(pages[digests[index]]) >= REPEAT_PAGES

    # A repeat with the same words beside it in most placements is furniture (a
    # licence badge after the same licence sentence); a reused formula glyph such
    # as x or dx sits among different words each time.
    contexts: dict[str, Counter] = defaultdict(Counter)
    for index in sorted(images):
        if repeated(index):
            number = blocks[index]["page_idx"]
            rect = _rect(blocks[index], document[number])
            contexts[digests[index]][_words_beside(rect, page_facts(number)[3])] += 1
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
        page_fact = page_facts(block["page_idx"])
        kind = _formula_kind(rect, [r for r, _ in page_fact[0]], page_fact[1])
        if repeated(index) and (
            digests[index] in fixed or rect.height > 1.6 * page_fact[2]
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


def place_inline(blocks: list[dict], document: pymupdf.Document) -> list[dict]:
    """Splice PLACEHOLDER into the paragraph holding each inline formula picture,
    between the words on either side of it when that pair occurs once there. An
    unplaced picture stays an empty ``equation`` block."""
    words: dict[int, list] = {}
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
            continue
        host = hosts[0]
        page = document[number]
        if number not in words:
            words[number] = page.get_text("words")
        left, right = _words_beside(_rect(picture, page), words[number])
        if left is None and right is None:
            continue
        pattern = re.escape(left or "") + r"(\s*)" + re.escape(right or "")
        field = "text" if host["type"] == "text" else "list_items"
        values = (
            [host["text"]] if field == "text" else list(host.get("list_items") or [])
        )
        hits = [(i, m) for i, v in enumerate(values) for m in re.finditer(pattern, v)]
        if len(hits) != 1:
            continue
        i, m = hits[0]
        spliced = values[i][: m.start(1)] + f" {PLACEHOLDER} " + values[i][m.end(1) :]
        values[i] = re.sub(r"  +", " ", spliced)
        host[field] = values[0] if field == "text" else values
    return blocks
