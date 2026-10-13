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
- Repeat: the same image (MuPDF's digest of the image the box shows) on
  REPEAT_PAGES or more pages (licence badges, logos, icons, chapter bars). Kept as ``discarded`` page furniture,
  unless it is a glyph-sized formula among different words each time.

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

import re
import statistics
from collections import Counter, defaultdict

import pymupdf

from . import page_text

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


def _image_digests(
    blocks: list[dict],
    images: set[int],
    document: pymupdf.Document,
    objects: dict[int, int],
) -> dict[int, str]:
    """Each picture's image digest. A picture whose image object ODL reported
    (``objects``, by ``_native_id``) takes the digest of that object, decoded
    once; the rest (inline images, objects MuPDF cannot decode) are matched
    by box to MuPDF's list of the page's images (overlap at least half the
    union), which replays the page. ODL no longer writes image files: decoding
    and encoding them was 85% of its time on a figure-heavy textbook."""
    by_object: dict[int, str | None] = {}
    digests: dict[int, str] = {}
    by_page: dict[int, list[int]] = defaultdict(list)
    for index in images:
        xref = objects.get(blocks[index].get("_native_id"))
        if xref is not None and xref not in by_object:
            try:
                by_object[xref] = pymupdf.Pixmap(document, xref).digest.hex()
            except (RuntimeError, ValueError):
                by_object[xref] = None
            _drop_decoded()
        if xref is not None and by_object[xref]:
            digests[index] = by_object[xref]
        else:
            by_page[blocks[index]["page_idx"]].append(index)
    for number, indexes in sorted(by_page.items()):
        page = document[number]
        placed = [
            (pymupdf.Rect(info["bbox"]), info["digest"].hex())
            for info in page.get_image_info(hashes=True)
            if info.get("digest")
        ]
        _drop_decoded()
        # ODL's box is the image's placement: an exact key (the first image in
        # page order, as the best share would pick) answers almost every
        # picture; the rest search the cells they cover.
        exact: dict[tuple[float, ...], str] = {}
        grid: dict[tuple[int, int], list[int]] = defaultdict(list)
        for k, (box, digest) in enumerate(placed):
            exact.setdefault(_key(box), digest)
            for cell in _cells(box & page.rect):  # an off-page part overlaps nothing
                grid[cell].append(k)
        for index in indexes:
            rect = _rect(blocks[index], page)
            if (digest := exact.get(_key(rect))) is not None:
                digests[index] = digest
                continue

            def union_share(image: tuple, rect: pymupdf.Rect = rect) -> float:
                overlap = abs(image[0] & rect)
                return overlap / max(abs(image[0]) + abs(rect) - overlap, 1e-9)

            cells = _cells(rect & page.rect)
            near = sorted({k for cell in cells for k in grid.get(cell, ())})
            # A page-wide background overlaps every picture on it; the share
            # of the union picks the image the picture is.
            best = max((placed[k] for k in near), key=union_share, default=None)
            if best and union_share(best) >= 0.5:
                digests[index] = best[1]
    return digests


def _drop_decoded() -> None:
    """Empty MuPDF's store, where decoding just left the image(s): it fills to
    256 MiB (120 page scans do) under the parse's peak, and the persistent
    child keeps it after the document; nothing reads the images again."""
    pymupdf.TOOLS.store_shrink(100)


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


def _key(rect: pymupdf.Rect) -> tuple[float, ...]:
    return tuple(round(v, 1) for v in rect)


def _cells(rect: pymupdf.Rect, size: float = 50.0) -> list[tuple[int, int]]:
    """The size-pt grid cells a box covers (none for an empty box)."""
    if rect.is_empty:
        return []
    xs = range(int(rect.x0 // size), int(rect.x1 // size) + 1)
    ys = range(int(rect.y0 // size), int(rect.y1 // size) + 1)
    return [(x, y) for x in xs for y in ys]


def classify(
    blocks: list[dict], document: pymupdf.Document, objects: dict[int, int]
) -> list[dict]:
    images = {
        index
        for index, block in enumerate(blocks)
        if block.get("type") == "image" and len(block.get("bbox") or []) == 4
    }
    digests = _image_digests(blocks, images, document, objects)
    pages: dict[str, set[int]] = defaultdict(set)
    for index, digest in digests.items():
        pages[digest].add(blocks[index]["page_idx"])
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
        return index in digests and len(pages[digests[index]]) >= REPEAT_PAGES

    # A repeat with the same words beside it in most placements is furniture (a
    # licence badge after the same licence sentence); a reused formula glyph such
    # as x or dx sits among different words each time.
    contexts: dict[str, Counter] = defaultdict(Counter)
    for index in sorted(images):
        page = document[blocks[index]["page_idx"]]
        if repeated(index) and (page_fact := page_facts(page)):
            beside = _words_beside(_rect(blocks[index], page), page_fact[3])
            contexts[digests[index]][beside] += 1
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
            and (digests[index] in fixed or rect.height > 1.6 * page_fact[2])
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


def _figure_clusters(page: pymupdf.Page) -> list[tuple[pymupdf.Rect, int, int]]:
    """Drawing clusters with their segment counts and how many of those are
    axis-aligned lines or boxes. Page-wide rules and frames, hairline specks
    and white fills are left out first."""
    width, height = page.rect.width, page.rect.height
    clusters: list[list] = []  # [rect, segments, axis-aligned segments]
    for path in page.get_cdrawings():
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
        rect = pymupdf.Rect(x0, y0, max(x1, x0 + 0.5), max(y1, y0 + 0.5))
        grown = rect + (-VECTOR_GAP, -VECTOR_GAP, VECTOR_GAP, VECTOR_GAP)
        hits = [c for c in clusters if c[0].intersects(grown)]
        items = path.get("items") or ()
        merged = [rect, len(items) or 1, sum(map(_axis_aligned, items))]
        for cluster in hits:
            merged[0] |= cluster[0]
            merged[1] += cluster[1]
            merged[2] += cluster[2]
            clusters.remove(cluster)
        clusters.append(merged)
    # One more pass: merging can make clusters overlap that did not before.
    changed = True
    while changed:
        changed = False
        for a in clusters:
            for b in clusters:
                if a is not b and a[0].intersects(b[0]):
                    a[0] |= b[0]
                    a[1] += b[1]
                    a[2] += b[2]
                    clusters.remove(b)
                    changed = True
                    break
            if changed:
                break
    return [tuple(cluster) for cluster in clusters]


def add_vector_figures(blocks: list[dict], document: pymupdf.Document) -> list[dict]:
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
        for rect, segments, aligned in _figure_clusters(page):
            if (
                segments < VECTOR_MIN_SEGMENTS
                or rect.width * rect.height < VECTOR_MIN_AREA * area
            ):
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
