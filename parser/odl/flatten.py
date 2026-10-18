"""Dense vector figures become one picture each, in the parse copy.

Plotting tools draw scatter markers, image pixels and smooth curves as
thousands of tiny paths. OpenDataLoader holds an object per path segment for
the whole document, so a few hundred such figures exhaust its heap (the five
largest library books did, bench/parsers/reports/2026-10-16-element-limit.md).
Before Java each dense region is rendered, its vector art is removed (text and
images stay) and the render takes its place. The upload itself is unchanged;
``pictures.flattened_figures`` folds the region's text labels into the figure.
"""

from __future__ import annotations

import math
from collections import Counter, defaultdict, deque

import pymupdf

from . import pictures

# A page is looked at from this many path segments.
PAGE_SEGMENTS = 800
# The density grid: segments of the paths centred in a CELL-point cell.
CELL = 12.0
DENSE_CELL = 15
# Segments a region of touching dense cells needs to be flattened.
REGION_SEGMENTS = 300
# A path wider and taller than this share of the page is a frame or a
# background and never joins a region.
PAGE_SIZED = 0.5
# Word area over region area above this is a table or a text box: kept.
MAX_TEXT = 0.15
DPI = 150
# Points a grown region takes in past its drawings: pymupdf's path boxes
# leave out every moveto but the first, so a marker's stroke can reach past.
MARGIN = 2.0
# A grown region may take in label text only: no whole text line of this
# many words (a caption, a sentence, code), no word of a line of text this
# long cut across (half its words with letters: a body-text column beside
# the figure; a run of axis ticks is a label), nor this many words in all.
# It stops at the outermost rectangle drawn around its core (a figure's
# frame or background), within pictures.VECTOR_GAP for the ticks drawn
# outside a frame, unless another core it takes in is outside that
# rectangle (one panel's frame of many).
GROWN_LINE_WORDS = 8
GROWN_WORDS = 30
# Regions that are flattened for Java but make no figure (``quiet``): text
# (a formula) drawn as glyph outlines: filled paths, nearly all under GLYPH
# points, in a region under VECTOR_MIN_AREA of the page with no figure-sized
# drawing reaching past it within VECTOR_LABEL_REACH (a diagram's label
# stays the diagram's). Answer blanks drawn as ticks are merged instead
# (TICK_RUN).
GLYPH = 12.0
GLYPH_SHARE = 0.9
# Ruled answer blanks some books draw as ticks: one-segment butt-capped
# strokes about as long as they are wide, side by side one width apart, so
# they paint one solid bar. A run of at least TICK_RUN such ticks becomes one
# filled rectangle before dense regions are looked for (it stays vector, makes
# no picture). A tick is at most TICK_LENGTH widths long and not zero-length
# (scatter dots), which leaves chart markers alone.
TICK_RUN = 20
TICK_LENGTH = 2.5


def merge_ticks(page: pymupdf.Page, drawings: list[dict]) -> bool:
    """Replace each run of answer-blank ticks (see TICK_RUN) with one filled
    rectangle of the ticks' colour: the same ink, a path each. True when the
    page changed."""
    rows: dict[tuple, list[tuple[float, float, float]]] = defaultdict(list)
    for path in drawings:
        items = path["items"]
        width = path.get("width") or 0
        cap = path.get("lineCap") or (1,)
        if (
            path.get("type") != "s"
            or len(items) != 1
            or items[0][0] != "l"
            or width <= 0
            or cap[0] != 0
            or path.get("dashes") not in (None, "[] 0")
        ):
            continue
        (x0, y0), (x1, y1) = items[0][1:]
        vertical = abs(x0 - x1) < 0.01
        if not vertical and abs(y0 - y1) >= 0.01:
            continue  # diagonal
        length = abs(y1 - y0) if vertical else abs(x1 - x0)
        if not 0 < length <= TICK_LENGTH * width:
            continue
        # Ticks of one style and one span across the run, keyed by their
        # place along it.
        lo, hi = (min(y0, y1), max(y0, y1)) if vertical else (min(x0, x1), max(x0, x1))
        key = (
            vertical,
            round(lo, 2),
            round(hi, 2),
            width,
            path.get("color"),
            path.get("stroke_opacity"),
        )
        rows[key].append(x0 if vertical else y0)
    runs = []
    for (vertical, lo, hi, width, color, opacity), places in rows.items():
        places.sort()
        start = 0
        for k in range(1, len(places) + 1):
            if k == len(places) or places[k] - places[k - 1] > 1.05 * width:
                if k - start >= TICK_RUN:
                    a, b = places[start] - width / 2, places[k - 1] + width / 2
                    rect = (
                        pymupdf.Rect(a, lo, b, hi)
                        if vertical
                        else pymupdf.Rect(lo, a, hi, b)
                    )
                    runs.append((rect, width, color, opacity))
                start = k
    if not runs:
        return False
    # MuPDF bounds a stroke with room for joins: two widths around a run
    # cover every tick of it. Overlapping boxes are merged first: of two
    # overlapping redactions MuPDF removed the paths under one only, so the
    # other run's ticks stayed under its rectangle (afdf2621 p552, two rows
    # 1.4 pt apart).
    for box in _merged([r + (-2 * w, -2 * w, 2 * w, 2 * w) for r, w, _, _ in runs]):
        page.add_redact_annot(box)
    page.apply_redactions(
        images=pymupdf.PDF_REDACT_IMAGE_NONE,
        graphics=pymupdf.PDF_REDACT_LINE_ART_REMOVE_IF_COVERED,
        text=pymupdf.PDF_REDACT_TEXT_NONE,
    )
    shape = page.new_shape()
    for rect, _, color, opacity in runs:
        shape.draw_rect(rect)
        shape.finish(color=None, fill=color, fill_opacity=opacity or 1, width=0)
    shape.commit()
    return True


def page_regions(
    page: pymupdf.Page,
    figures: pictures.Drawings,
    drawings: list[dict] | None = None,
) -> tuple[list[pymupdf.Rect], list[pymupdf.Rect], pymupdf.DisplayList | None]:
    """The page's dense drawing regions, in page points, those of them that
    are not figures (see ``_quiet``), and the page's display list when there
    is one: it renders every region and gives the words, so the page's
    content is run once for them all. A figure's region is the dense core
    grown to the drawing clusters it meets (``figures``); a quiet one is its
    core."""
    if drawings is None:
        drawings = page.get_cdrawings()
    if sum(len(d["items"]) for d in drawings) < PAGE_SEGMENTS:
        return [], [], None
    # Each cell's segments and the box of the paths centred in it, by hand: a
    # horizontal or vertical stroke's box is empty to pymupdf and would drop
    # out of a union.
    cells: dict[tuple[int, int], list] = {}
    sized_w, sized_h = page.rect.width * PAGE_SIZED, page.rect.height * PAGE_SIZED
    for drawing in drawings:
        x0, y0, x1, y1 = drawing["rect"]
        # A box that is not finite (content under a huge matrix) has no cell,
        # as in pictures.Drawings.
        if not all(map(math.isfinite, (x0, y0, x1, y1))):
            continue
        if x1 - x0 > sized_w and y1 - y0 > sized_h:
            continue
        key = (int((x0 + x1) / 2 // CELL), int((y0 + y1) / 2 // CELL))
        cell = cells.get(key)
        if cell is None:
            cells[key] = [len(drawing["items"]), x0, y0, x1, y1]
            continue
        cell[0] += len(drawing["items"])
        cell[1], cell[2] = min(cell[1], x0), min(cell[2], y0)
        cell[3], cell[4] = max(cell[3], x1), max(cell[4], y1)
    dense = {key for key, cell in cells.items() if cell[0] >= DENSE_CELL}
    seen: set[tuple[int, int]] = set()
    boxes: list[pymupdf.Rect] = []
    for start in dense:
        if start in seen:
            continue
        seen.add(start)
        queue, members = deque([start]), []
        while queue:
            cx, cy = queue.popleft()
            members.append(cells[(cx, cy)])
            for near in ((cx + dx, cy + dy) for dx in (-1, 0, 1) for dy in (-1, 0, 1)):
                if near in dense and near not in seen:
                    seen.add(near)
                    queue.append(near)
        if sum(m[0] for m in members) < REGION_SEGMENTS:
            continue
        box = (
            pymupdf.Rect(
                min(m[1] for m in members) - 1,
                min(m[2] for m in members) - 1,
                max(m[3] for m in members) + 1,
                max(m[4] for m in members) + 1,
            )
            & page.rect
        )
        if not box.is_empty:
            boxes.append(box)
    boxes = _merged(boxes)
    if not boxes:
        return [], [], None
    display = page.get_displaylist()
    found = pymupdf.TextPage(
        display.get_textpage(pymupdf.TEXTFLAGS_WORDS)
    ).extractWORDS()
    words = [pymupdf.Rect(w[:4]) for w in found]
    # Each word's text line (MuPDF's block and line), and the lines of text.
    lines = [(w[5], w[6]) for w in found]
    line_words = Counter(lines)
    lettered = Counter(
        line for w, line in zip(found, lines) if any(c.isalpha() for c in w[4])
    )
    text_lines = {
        line
        for line, n in line_words.items()
        if n >= GROWN_LINE_WORDS and 2 * lettered[line] >= n
    }

    def text(box: pymupdf.Rect) -> float:
        return sum(abs(w) for w in words if w in box)

    def labels_only(core: pymupdf.Rect, big: pymupdf.Rect) -> bool:
        """``big`` takes in, beyond ``core``, label text only."""
        inside = Counter(line for w, line in zip(words, lines) if w in big)
        whole = [n for line, n in inside.items() if n == line_words[line]]
        added = [line for w, line in zip(words, lines) if w in big and w not in core]
        return (
            max(whole, default=0) < GROWN_LINE_WORDS
            and len(added) < GROWN_WORDS
            and text_lines.isdisjoint(added)
        )

    boxes = [box for box in boxes if text(box) <= MAX_TEXT * abs(box)]
    # Each core grows to the drawing clusters it meets, so a chart's frame,
    # axes, titles drawn as paths and sparse points are inside it. A grown
    # box that is page-sized, text, or takes in more than labels (a frame
    # around a text box, a caption between two charts) keeps the core.
    clusters = [c for c, _, _ in figures.clusters(page, drawings)] if boxes else []
    # The rectangles growth stops at (see GROWN_LINE_WORDS).
    frames = [
        pymupdf.Rect(d["rect"])
        for d in drawings
        if len(d["items"]) == 1
        and d["items"][0][0] in ("re", "qu")
        and all(map(math.isfinite, d["rect"]))
        and not (
            d["rect"][2] - d["rect"][0] > sized_w
            and d["rect"][3] - d["rect"][1] > sized_h
        )
    ]
    gap = pictures.VECTOR_GAP
    # A quiet core grows to nothing: it is no figure, its neighbours stay.
    quiet = [box for box in boxes if _quiet(box, drawings, clusters, page)]
    grown = []
    for box in boxes:
        if box in quiet:
            grown.append(box)
            continue
        big = pymupdf.Rect(box)
        for cluster in clusters:
            if cluster.intersects(box):
                big |= cluster
        around = [f for f in frames if (f + (-1, -1, 1, 1)).contains(box)]
        if around:
            frame = max(around, key=abs) + (-gap, -gap, gap, gap)
            if all(frame.contains(b) for b in boxes if b.intersects(big)):
                big &= frame
        big = (big + (-MARGIN, -MARGIN, MARGIN, MARGIN)) & page.rect
        sized = (
            big.width > page.rect.width * PAGE_SIZED
            and big.height > page.rect.height * PAGE_SIZED
        )
        keep = sized or text(big) > MAX_TEXT * abs(big) or not labels_only(box, big)
        grown.append(box if keep else big)
    boxes = _merged(grown)
    # A quiet core a figure's region took in is the figure's.
    quiet = [box for box in boxes if box in quiet]
    return boxes, quiet, display if boxes else None


def _quiet(
    box: pymupdf.Rect,
    drawings: list[dict],
    clusters: list[pymupdf.Rect],
    page: pymupdf.Page,
) -> bool:
    """A formula drawn as outlines, not a figure: by the paths centred in
    ``box`` (see GLYPH)."""
    paths = [
        d
        for d in drawings
        if box.x0 <= (d["rect"][0] + d["rect"][2]) / 2 <= box.x1
        and box.y0 <= (d["rect"][1] + d["rect"][3]) / 2 <= box.y1
    ]
    if not paths:
        return False
    glyphs = sum(
        max(d["rect"][2] - d["rect"][0], d["rect"][3] - d["rect"][1]) < GLYPH
        for d in paths
    )
    if not (
        all(d.get("type") == "f" for d in paths)
        and glyphs >= GLYPH_SHARE * len(paths)
        and abs(box) < pictures.VECTOR_MIN_AREA * abs(page.rect)
    ):
        return False
    reach = box + (
        -pictures.VECTOR_LABEL_REACH,
        -pictures.VECTOR_LABEL_REACH,
        pictures.VECTOR_LABEL_REACH,
        pictures.VECTOR_LABEL_REACH,
    )
    near = box + (-MARGIN, -MARGIN, MARGIN, MARGIN)
    return not any(
        cluster.intersects(reach)
        and not near.contains(cluster)
        and abs(cluster) >= pictures.VECTOR_MIN_AREA * abs(page.rect)
        for cluster in clusters
    )


def _merged(boxes: list[pymupdf.Rect]) -> list[pymupdf.Rect]:
    """Overlapping boxes become one, until none overlap."""
    out: list[pymupdf.Rect] = []
    for box in boxes:
        box = pymupdf.Rect(box)
        while True:
            hit = next(
                (i for i, other in enumerate(out) if other.intersects(box)), None
            )
            if hit is None:
                break
            box |= out.pop(hit)
        out.append(box)
    return out


def _render(display: pymupdf.DisplayList, box: pymupdf.Rect) -> pymupdf.Pixmap:
    """``page.get_pixmap(dpi=DPI, clip=box)`` from the page's display list."""
    pixmap = display.get_pixmap(
        matrix=pymupdf.Matrix(DPI / 72, DPI / 72),
        colorspace=pymupdf.csRGB,
        alpha=False,
        clip=box,
    )
    pixmap.set_dpi(DPI, DPI)
    return pixmap


def flatten(
    data: bytes,
) -> tuple[bytes, dict[int, list[pymupdf.Rect]], dict[int, list[pymupdf.Rect]]]:
    """The PDF with its answer-blank ticks merged (see TICK_RUN) and its dense
    regions as pictures, those regions by page, and those of them that are
    not figures (formulas drawn as outlines), by page. A PDF without either
    is returned untouched, byte for byte."""
    regions: dict[int, list[pymupdf.Rect]] = {}
    quiet: dict[int, list[pymupdf.Rect]] = {}
    changed = False
    with pymupdf.open(stream=data, filetype="pdf") as doc:
        figures = pictures.Drawings()
        for page in doc:
            # A rotated page is flattened unrotated, so its drawings, words,
            # renders, redactions and inserted pictures share the coordinates
            # of its content; its regions are reported as the page shows them.
            rotation = page.rotation
            if rotation:
                page.set_rotation(0)
            try:
                merged, boxes, quiet_boxes = _flatten_page(page, figures)
            finally:
                if rotation:
                    page.set_rotation(rotation)
            changed = changed or merged
            if rotation:
                boxes = [box * page.rotation_matrix for box in boxes]
                quiet_boxes = [box * page.rotation_matrix for box in quiet_boxes]
            if boxes:
                regions[page.number] = boxes
            if quiet_boxes:
                quiet[page.number] = quiet_boxes
        if not regions and not changed:
            return data, {}, {}
        return doc.tobytes(garbage=1, deflate=True), regions, quiet


def _flatten_page(
    page: pymupdf.Page, figures: pictures.Drawings
) -> tuple[bool, list[pymupdf.Rect], list[pymupdf.Rect]]:
    """Merge one unrotated page's answer-blank ticks and flatten its dense
    regions: whether the ticks changed the page, the regions and the quiet
    ones among them."""
    drawings = page.get_cdrawings()
    merged = sum(len(d["items"]) for d in drawings) >= PAGE_SEGMENTS and (
        merge_ticks(page, drawings)
    )
    if merged:
        drawings = None  # the page changed: its paths are read again
    boxes, quiet, display = page_regions(page, figures, drawings)
    if not boxes:
        return merged, [], []
    renders = [(box, _render(display, box)) for box in boxes]
    display = None
    for box in boxes:
        page.add_redact_annot(box)
    page.apply_redactions(
        images=pymupdf.PDF_REDACT_IMAGE_NONE,
        graphics=pymupdf.PDF_REDACT_LINE_ART_REMOVE_IF_COVERED,
        text=pymupdf.PDF_REDACT_TEXT_NONE,
    )
    # Beneath the page's remaining content, so its text stays on top.
    for box, pixmap in renders:
        page.insert_image(box, pixmap=pixmap, overlay=False)
    return merged, boxes, quiet
