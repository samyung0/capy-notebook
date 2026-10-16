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


def page_regions(page: pymupdf.Page) -> list[pymupdf.Rect]:
    """The page's dense drawing regions, in page points."""
    drawings = page.get_cdrawings()
    if sum(len(d["items"]) for d in drawings) < PAGE_SEGMENTS:
        return []
    cells: dict[tuple[int, int], list[tuple]] = {}
    weight: dict[tuple[int, int], int] = {}
    sized_w, sized_h = page.rect.width * PAGE_SIZED, page.rect.height * PAGE_SIZED
    for drawing in drawings:
        x0, y0, x1, y1 = drawing["rect"]
        if x1 - x0 > sized_w and y1 - y0 > sized_h:
            continue
        key = (int((x0 + x1) / 2 // CELL), int((y0 + y1) / 2 // CELL))
        cells.setdefault(key, []).append((x0, y0, x1, y1))
        weight[key] = weight.get(key, 0) + len(drawing["items"])
    dense = {key for key, segments in weight.items() if segments >= DENSE_CELL}
    seen: set[tuple[int, int]] = set()
    boxes: list[pymupdf.Rect] = []
    for start in dense:
        if start in seen:
            continue
        seen.add(start)
        queue, members = deque([start]), []
        while queue:
            cx, cy = queue.popleft()
            members.append((cx, cy))
            for near in ((cx + dx, cy + dy) for dx in (-1, 0, 1) for dy in (-1, 0, 1)):
                if near in dense and near not in seen:
                    seen.add(near)
                    queue.append(near)
        if sum(weight[m] for m in members) < REGION_SEGMENTS:
            continue
        # Min and max by hand: a horizontal or vertical stroke's box is empty
        # to pymupdf and would drop out of a union.
        rects = [r for m in members for r in cells[m]]
        box = (
            pymupdf.Rect(
                min(r[0] for r in rects) - 1,
                min(r[1] for r in rects) - 1,
                max(r[2] for r in rects) + 1,
                max(r[3] for r in rects) + 1,
            )
            & page.rect
        )
        if not box.is_empty:
            boxes.append(box)
    boxes = _merged(boxes)
    if boxes:
        words = [pymupdf.Rect(w[:4]) for w in page.get_text("words")]
        boxes = [
            box
            for box in boxes
            if sum(abs(w) for w in words if w in box) <= MAX_TEXT * abs(box)
        ]
    return boxes


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


def flatten(data: bytes) -> tuple[bytes, dict[int, list[pymupdf.Rect]]]:
    """The PDF with its dense regions as pictures, and those regions by page.
    A PDF without one is returned untouched, byte for byte."""
    regions: dict[int, list[pymupdf.Rect]] = {}
    with pymupdf.open(stream=data, filetype="pdf") as doc:
        for page in doc:
            # Rotated pages are skipped like the other stages do.
            if page.rotation or not (boxes := page_regions(page)):
                continue
            renders = [(box, page.get_pixmap(dpi=DPI, clip=box)) for box in boxes]
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
