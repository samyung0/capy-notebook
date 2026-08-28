"""Flatten Marker JSON into the ``content_list`` shape the rest of ingest eats.

bbox is ``[x0, y0, x1, y1]`` on a 1000x1000 page, origin at the TOP LEFT — the
same space ``retrieval/chunking.py`` records as ``mineru-1000-lefttop``. Marker
emits page pixels; we scale. Get the origin wrong and every citation highlight
lands upside down while the text still looks fine.
"""

from __future__ import annotations

import base64
import io
import os
import re
from html.parser import HTMLParser
from typing import Any

_PAGE_SCALE = 1000.0
_FULL_PAGE_AREA = 0.70 * _PAGE_SCALE * _PAGE_SCALE

_MARKER_TEXT_BLOCKS = {
    "Text",
    "TextInlineMath",
    "ListItem",
    "Code",
    "Footnote",
    "Caption",
    "Reference",
    "TableOfContents",
    "Handwriting",
    "Form",
    "ComplexRegion",
}
_MARKER_SKIP_BLOCKS = {"PageHeader", "PageFooter"}
_IMAGE_KINDS = {"Figure", "Picture", "Diagram"}

_WS_RE = re.compile(r"\s+")


class _TextExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self._parts: list[str] = []

    def handle_data(self, data: str) -> None:
        self._parts.append(data)

    def handle_starttag(self, tag: str, attrs: Any) -> None:
        if tag in ("br", "p", "div", "li", "tr"):
            self._parts.append("\n")

    def text(self) -> str:
        lines = [line.strip() for line in "".join(self._parts).splitlines()]
        return "\n".join(line for line in lines if line).strip()


def html_to_text(html: str) -> str:
    if not html:
        return ""
    parser = _TextExtractor()
    try:
        parser.feed(html)
        parser.close()
    except Exception:  # noqa: BLE001
        return html.strip()
    return parser.text()


def _scaled_bbox(
    x0: float, y0: float, x1: float, y1: float, width: float, height: float
) -> list[float] | None:
    if width <= 0 or height <= 0:
        return None
    sx, sy = _PAGE_SCALE / width, _PAGE_SCALE / height
    box = [
        min(x0, x1) * sx,
        min(y0, y1) * sy,
        max(x0, x1) * sx,
        max(y0, y1) * sy,
    ]
    return [round(min(max(value, 0.0), _PAGE_SCALE), 2) for value in box]


def image_filename(block_id: str) -> str:
    stem = str(block_id or "img").strip("/").replace("/", "_") or "img"
    return f"{stem}.jpg"


def _marker_page_size(block: dict[str, Any]) -> tuple[float, float]:
    bbox = block.get("bbox")
    if isinstance(bbox, list) and len(bbox) == 4:
        try:
            return float(bbox[2]) - float(bbox[0]), float(bbox[3]) - float(bbox[1])
        except (TypeError, ValueError):
            pass
    return 0.0, 0.0


def _marker_heading_level(block: dict[str, Any]) -> int | None:
    for key in ("heading_level", "level"):
        value = block.get(key)
        if isinstance(value, int) and value > 0:
            return min(value, 6)
    hierarchy = block.get("section_hierarchy")
    if isinstance(hierarchy, dict) and hierarchy:
        depths = [int(k) for k in hierarchy if str(k).isdigit()]
        if depths:
            return min(max(depths), 6)
    return None


def _strip_data_uri(value: str) -> str:
    if value.startswith("data:") and "," in value:
        return value.split(",", 1)[1]
    return value


def collect_marker_images(rendered: dict[str, Any]) -> dict[str, str]:
    """Pull base64 crops Marker stashed on leaf blocks."""
    images: dict[str, str] = {}

    def walk(block: dict[str, Any]) -> None:
        raw = block.get("images") or {}
        if isinstance(raw, dict):
            for key, value in raw.items():
                if not isinstance(value, str) or not value:
                    continue
                images[image_filename(str(key))] = _strip_data_uri(value)
        kind = str(block.get("block_type") or "")
        if kind in _IMAGE_KINDS:
            # Some dumps key the crop by the block id rather than a nested map.
            own = block.get("image") or block.get("image_b64")
            if isinstance(own, str) and own:
                images[image_filename(str(block.get("id") or ""))] = _strip_data_uri(
                    own
                )
        for child in block.get("children") or []:
            if isinstance(child, dict):
                walk(child)

    if isinstance(rendered, dict):
        walk(rendered)
    return images


def from_marker(rendered: dict[str, Any]) -> list[dict[str, Any]]:
    """Flatten Marker's JSON block tree into ``content_list`` order."""
    items: list[dict[str, Any]] = []

    def walk(block: dict[str, Any], page_idx: int, size: tuple[float, float]) -> None:
        kind = str(block.get("block_type") or "")
        children = block.get("children") or []

        if kind == "Page":
            raw_id = str(block.get("id") or "")
            parts = raw_id.strip("/").split("/")
            own_page = page_idx
            if len(parts) >= 2 and parts[0] == "page" and parts[1].isdigit():
                own_page = int(parts[1])
            own_size = _marker_page_size(block)
            for child in children:
                if isinstance(child, dict):
                    walk(child, own_page, own_size)
            return

        if kind in _MARKER_SKIP_BLOCKS:
            return

        if kind.endswith("Group") or kind in ("Document", ""):
            for child in children:
                if isinstance(child, dict):
                    walk(child, page_idx, size)
            return

        bbox = None
        raw_bbox = block.get("bbox")
        if isinstance(raw_bbox, list) and len(raw_bbox) == 4:
            try:
                bbox = _scaled_bbox(
                    float(raw_bbox[0]),
                    float(raw_bbox[1]),
                    float(raw_bbox[2]),
                    float(raw_bbox[3]),
                    size[0],
                    size[1],
                )
            except (TypeError, ValueError):
                bbox = None

        html = str(block.get("html") or "")
        base = {"page_idx": page_idx, "bbox": bbox}

        if kind == "SectionHeader":
            text = html_to_text(html)
            if text:
                items.append(
                    {
                        "type": "text",
                        "text": text,
                        "text_level": _marker_heading_level(block) or 1,
                        **base,
                    }
                )
        elif kind == "Table":
            if html:
                items.append({"type": "table", "table_body": html, **base})
        elif kind == "Equation":
            text = html_to_text(html)
            if text:
                items.append({"type": "equation", "text": text, **base})
        elif kind in _IMAGE_KINDS:
            items.append(
                {
                    "type": "image",
                    "img_path": f"images/{image_filename(str(block.get('id') or ''))}",
                    "image_caption": [],
                    **base,
                }
            )
        elif kind in _MARKER_TEXT_BLOCKS:
            text = html_to_text(html)
            if text:
                items.append({"type": "text", "text": text, **base})
        else:
            for child in children:
                if isinstance(child, dict):
                    walk(child, page_idx, size)
            return

        if kind in ("Table", *_IMAGE_KINDS):
            for child in children:
                if isinstance(child, dict) and child.get("block_type") == "Caption":
                    caption = html_to_text(str(child.get("html") or ""))
                    if not caption or not items:
                        continue
                    key = "table_caption" if kind == "Table" else "image_caption"
                    items[-1].setdefault(key, []).append(caption)

    root = rendered if isinstance(rendered, dict) else {}
    children = root.get("children") or []
    if children:
        for index, child in enumerate(children):
            if isinstance(child, dict):
                walk(child, index, _marker_page_size(child))
    else:
        walk(root, 0, _marker_page_size(root))
    return items


def _norm_line(text: str) -> str:
    return _WS_RE.sub(" ", (text or "").strip().lower())


def _bbox_area(bbox: list[float] | None) -> float:
    if not bbox or len(bbox) != 4:
        return 0.0
    return abs(bbox[2] - bbox[0]) * abs(bbox[3] - bbox[1])


def _bbox_overlap_ratio(left: list[float] | None, right: list[float] | None) -> float:
    """Return intersection area as a fraction of the smaller rectangle."""
    if not left or len(left) != 4 or not right or len(right) != 4:
        return 0.0
    x1, y1 = max(left[0], right[0]), max(left[1], right[1])
    x2, y2 = min(left[2], right[2]), min(left[3], right[3])
    intersection = max(0.0, x2 - x1) * max(0.0, y2 - y1)
    smaller = min(_bbox_area(left), _bbox_area(right))
    return intersection / smaller if smaller else 0.0


def drop_scan_rasters(
    content_list: list[dict[str, Any]], ocr_pages: set[int]
) -> list[dict[str, Any]]:
    """Drop near-full-page pictures on pages we OCR'd — those are the scan.

    Leaving them in would send a whole newspaper page to Gemini as a 'figure'.
    Smaller pictures on the same page stay.
    """
    if not ocr_pages:
        return content_list
    kept: list[dict[str, Any]] = []
    for item in content_list:
        page = item.get("page_idx")
        if (
            item.get("type") == "image"
            and isinstance(page, int)
            and page in ocr_pages
            and _bbox_area(item.get("bbox")) >= _FULL_PAGE_AREA
        ):
            continue
        kept.append(item)
    return kept


def merge_ocr_lines(
    content_list: list[dict[str, Any]],
    ocr_pages: dict[int, list[dict[str, Any]]],
) -> list[dict[str, Any]]:
    """Append RapidOCR lines onto flagged pages, skipping near-duplicate text.

    Marker already kept headings/equations from the text layer; we only fill in
    what the layer missed.
    """
    if not ocr_pages:
        return content_list

    existing: dict[int, list[tuple[str, list[float] | None]]] = {}
    for item in content_list:
        page = item.get("page_idx")
        if not isinstance(page, int):
            continue
        blob = " ".join(
            str(part)
            for part in (
                item.get("text"),
                item.get("table_body"),
                " ".join(item.get("image_caption") or []),
            )
            if part
        )
        norm = _norm_line(html_to_text(blob) if "<" in blob else blob)
        if norm:
            existing.setdefault(page, []).append((norm, item.get("bbox")))

    extra: list[dict[str, Any]] = []
    for page, lines in ocr_pages.items():
        known = existing.setdefault(page, [])
        for line in lines:
            text = str(line.get("text") or "").strip()
            if not text:
                continue
            norm = _norm_line(text)
            if not norm:
                continue
            bbox = line.get("bbox")
            if any(
                (norm == known_text or norm in known_text or known_text in norm)
                and (
                    not bbox
                    or not known_bbox
                    or _bbox_overlap_ratio(bbox, known_bbox) >= 0.65
                )
                for known_text, known_bbox in known
                if known_text
            ):
                continue
            known.append((norm, bbox))
            extra.append(
                {
                    "type": "text",
                    "text": text,
                    "page_idx": page,
                    "bbox": bbox,
                }
            )

    if not extra:
        return content_list
    # Keep reading order roughly page-then-y, so OCR lines sit with the page
    # they came from instead of all piling up at the end.
    merged = content_list + extra

    def sort_key(item: dict[str, Any]) -> tuple[int, float]:
        page = item.get("page_idx")
        bbox = item.get("bbox") or [0, 0, 0, 0]
        y = float(bbox[1]) if isinstance(bbox, list) and len(bbox) > 1 else 0.0
        return (int(page) if isinstance(page, int) else 10**9, y)

    merged.sort(key=sort_key)
    return merged


def _plain_poly(value: Any) -> Any:
    if isinstance(value, (str, bytes, int, float)):
        return value
    to_list = getattr(value, "tolist", None)
    if callable(to_list) and not isinstance(value, (list, tuple)):
        try:
            return to_list()
        except (TypeError, ValueError):
            pass
    if isinstance(value, (list, tuple)):
        return [_plain_poly(item) for item in value]
    return value


def ocr_line_bbox(
    poly: Any, image_width: float, image_height: float
) -> list[float] | None:
    """Scale a RapidOCR polygon (pixel space, top-left) onto the 1000 page."""
    # RapidOCR 3 hands back numpy arrays, not lists. Without this, every OCR
    # line lands in content_list with bbox=null and citations cannot highlight.
    poly = _plain_poly(poly)
    xs: list[float] = []
    ys: list[float] = []
    if isinstance(poly, (list, tuple)) and poly:
        if isinstance(poly[0], (list, tuple)) and len(poly[0]) >= 2:
            for point in poly:
                try:
                    xs.append(float(point[0]))
                    ys.append(float(point[1]))
                except (TypeError, ValueError, IndexError):
                    continue
        elif len(poly) >= 4:
            try:
                xs = [float(poly[0]), float(poly[2])]
                ys = [float(poly[1]), float(poly[3])]
            except (TypeError, ValueError):
                return None
    if not xs or not ys:
        return None
    return _scaled_bbox(min(xs), min(ys), max(xs), max(ys), image_width, image_height)


def content_list_to_md(content_list: list[dict[str, Any]]) -> str:
    lines: list[str] = []
    for item in content_list:
        kind = item.get("type")
        if kind == "text":
            text = str(item.get("text") or "").strip()
            if not text:
                continue
            level = item.get("text_level")
            if isinstance(level, int) and level > 0:
                lines.append("#" * min(level, 6) + " " + text)
            else:
                lines.append(text)
        elif kind == "equation":
            text = str(item.get("text") or "").strip()
            if text:
                lines.append(f"$$\n{text}\n$$")
        elif kind == "table":
            body = str(item.get("table_body") or "").strip()
            if body:
                lines.append(body)
    return "\n\n".join(lines)


def encode_jpeg(image: Any, quality: int = 85) -> str:
    buf = io.BytesIO()
    rgb = image.convert("RGB") if hasattr(image, "convert") else image
    rgb.save(buf, format="JPEG", quality=quality, optimize=True)
    return base64.b64encode(buf.getvalue()).decode("ascii")


def crop_missing_images(
    pdf_bytes: bytes,
    content_list: list[dict[str, Any]],
    images: dict[str, str],
) -> dict[str, str]:
    """If Marker did not embed a crop, cut it from the page with pypdfium2."""
    missing = [
        item
        for item in content_list
        if item.get("type") == "image"
        and isinstance(item.get("bbox"), list)
        and len(item.get("bbox") or []) == 4
        and os.path.basename(str(item.get("img_path") or "")) not in images
    ]
    if not missing or not pdf_bytes.lstrip().startswith(b"%PDF"):
        return images

    import pypdfium2 as pdfium

    filled = dict(images)
    pdf = pdfium.PdfDocument(pdf_bytes)
    try:
        by_page: dict[int, list[dict[str, Any]]] = {}
        for item in missing:
            page_idx = item.get("page_idx")
            if not isinstance(page_idx, int):
                continue
            by_page.setdefault(page_idx, []).append(item)
        for page_idx, items in by_page.items():
            if page_idx < 0 or page_idx >= len(pdf):
                continue
            page = pdf[page_idx]
            try:
                bitmap = page.render(scale=2.0)
                pil = bitmap.to_pil().convert("RGB")
            finally:
                page.close()
            width, height = pil.size
            for item in items:
                name = os.path.basename(str(item.get("img_path") or ""))
                if not name or name in filled:
                    continue
                x0, y0, x1, y1 = (float(v) / _PAGE_SCALE for v in item["bbox"])
                box = (
                    max(0, int(x0 * width)),
                    max(0, int(y0 * height)),
                    min(width, int(x1 * width)),
                    min(height, int(y1 * height)),
                )
                if box[2] - box[0] < 8 or box[3] - box[1] < 8:
                    continue
                filled[name] = encode_jpeg(pil.crop(box))
    finally:
        pdf.close()
    return filled
