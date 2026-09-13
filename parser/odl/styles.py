"""Native table-cell background retention from the source drawing layer."""

from __future__ import annotations

import copy

import pymupdf

from .adapter import node_text, nodes


def color_name(fill: tuple) -> str | None:
    # Only yellow is named; other colours would need their own source review.
    if len(fill) == 3 and fill[0] >= 0.85 and fill[1] >= 0.85 and fill[2] <= 0.6:
        return "yellow"
    return None


def annotate(document: pymupdf.Document, native: dict) -> tuple[dict, int]:
    """Append ``[yellow background]`` to cells painted over exactly one fill."""
    candidate = copy.deepcopy(native)
    marked = 0
    page_data: dict[int, tuple[list, list]] = {}
    for cell in nodes(candidate):
        if cell.get("type") != "table cell" or not node_text(cell).strip():
            continue
        page_number = cell.get("page number")
        if not isinstance(page_number, int) or not 1 <= page_number <= len(document):
            raise ValueError("table cell has no valid source page")
        page = document[page_number - 1]
        # Java boxes assume an ordinary unrotated PDF page.
        if (
            page.rotation
            or page.cropbox != page.mediabox
            or page.rect.x0
            or page.rect.y0
        ):
            continue
        if page_number not in page_data:
            drawings = page.get_drawings()
            has_yellow = any(
                color_name(drawing.get("fill") or ()) for drawing in drawings
            )
            page_data[page_number] = (
                drawings,
                page.get_text("words") if has_yellow else [],
            )
        drawings, words = page_data[page_number]
        if not words:
            continue
        x0, y0, x1, y1 = cell["bounding box"]
        box = pymupdf.Rect(x0, page.rect.height - y1, x1, page.rect.height - y0)
        if box.is_empty:
            continue
        selected = [
            word
            for word in words
            if box.contains(
                pymupdf.Point((word[0] + word[2]) / 2, (word[1] + word[3]) / 2)
            )
        ]
        source_text = " ".join(word[4] for word in selected)
        if "".join(source_text.split()) != "".join(node_text(cell).split()):
            continue
        matches = []
        for drawing in drawings:
            fill = drawing.get("fill")
            items = drawing.get("items", [])
            if (
                not fill
                or drawing.get("fill_opacity") != 1
                or len(items) != 1
                or items[0][0] != "re"
                or not color_name(fill)
            ):
                continue
            rectangle = drawing["rect"]
            overlap = (box & rectangle).get_area()
            if overlap < 0.8 * box.get_area() or overlap < 0.8 * rectangle.get_area():
                continue
            if any(
                other["seqno"] > drawing["seqno"]
                and other.get("fill") is not None
                and other.get("fill_opacity", 0) > 0
                and (rectangle & other["rect"]).get_area() > 0.1 * rectangle.get_area()
                for other in drawings
            ):
                continue
            matches.append(drawing)
        if len(matches) != 1:
            continue
        cell.setdefault("kids", []).append(
            {"content": f"[{color_name(matches[0]['fill'])} background]"}
        )
        marked += 1
    return candidate, marked
