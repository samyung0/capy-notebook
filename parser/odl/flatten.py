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
from collections import deque

import pymupdf

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


def page_regions(
    page: pymupdf.Page,
) -> tuple[list[pymupdf.Rect], pymupdf.DisplayList | None]:
    """The page's dense drawing regions, in page points, and the page's
    display list when there is one: it renders every region and gives the
    words, so the page's content is run once for them all."""
    drawings = page.get_cdrawings()
    if sum(len(d["items"]) for d in drawings) < PAGE_SEGMENTS:
        return [], None
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
        return [], None
    display = page.get_displaylist()
    words = [
        pymupdf.Rect(w[:4])
        for w in pymupdf.TextPage(
            display.get_textpage(pymupdf.TEXTFLAGS_WORDS)
        ).extractWORDS()
    ]
    boxes = [
        box
        for box in boxes
        if sum(abs(w) for w in words if w in box) <= MAX_TEXT * abs(box)
    ]
    return boxes, display if boxes else None


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


def flatten(data: bytes) -> tuple[bytes, dict[int, list[pymupdf.Rect]]]:
    """The PDF with its dense regions as pictures, and those regions by page.
    A PDF without one is returned untouched, byte for byte."""
    regions: dict[int, list[pymupdf.Rect]] = {}
    with pymupdf.open(stream=data, filetype="pdf") as doc:
        for page in doc:
            # Rotated pages are skipped like the other stages do.
            if page.rotation:
                continue
            boxes, display = page_regions(page)
            if not boxes:
                continue
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
            regions[page.number] = boxes
        if not regions:
            return data, {}
        return doc.tobytes(garbage=1, deflate=True), regions
