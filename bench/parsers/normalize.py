"""Adapters from Marker v2 / Docling output into Evo's ``content_list`` shape.

This is the load-bearing part of any parser swap, so it lives in its own module
rather than inside the benchmark driver: if a candidate wins, this file moves to
``pipeline/pipeline/parse/`` more or less as-is.

The target shape is what ``retrieval/chunking.chunk_content_list`` and
``parse/figures.select_figures`` already consume:

    {"type": "text",     "text": str, "text_level": int|None, "page_idx": int, "bbox": [...]}
    {"type": "table",    "table_body": html, "table_caption": [str], "table_footnote": [str], ...}
    {"type": "equation", "text": latex, ...}
    {"type": "image",    "img_path": str, "image_caption": [str], ...}

Two invariants are easy to get wrong and both are silent failures:

* ``bbox`` must be ``[x0, y0, x1, y1]`` scaled onto a 1000x1000 page with the
  origin at the TOP LEFT. Marker emits page pixels; Docling emits PDF points and
  tells you per-box whether the origin is bottom-left. Get the origin wrong and
  every citation highlight in the reader lands mirrored vertically — the text is
  still correct, so no test catches it unless the test looks at coordinates.
* ``text_level`` carries heading depth, which is what builds ``section_path``.
  Neither candidate reports depth as reliably as MinerU, so both adapters fall
  back to the document's own heading hierarchy and the benchmark counts how
  often a real level was available.
"""

from __future__ import annotations

from html.parser import HTMLParser
from typing import Any

BBOX_SPACE = "mineru-1000-topleft"
_PAGE_SCALE = 1000.0

# Marker block types that carry prose. Everything not listed here and not
# handled explicitly below is dropped, which is why PageHeader/PageFooter never
# reach the index.
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


class _TextExtractor(HTMLParser):
    """Collapse an HTML fragment to plain text, keeping block boundaries."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self._parts: list[str] = []

    def handle_data(self, data: str) -> None:
        self._parts.append(data)

    def handle_starttag(self, tag: str, attrs: Any) -> None:
        if tag in ("br", "p", "div", "li", "tr"):
            self._parts.append("\n")

    def text(self) -> str:
        joined = "".join(self._parts)
        lines = [line.strip() for line in joined.splitlines()]
        return "\n".join(line for line in lines if line).strip()


def html_to_text(html: str) -> str:
    if not html:
        return ""
    parser = _TextExtractor()
    try:
        parser.feed(html)
        parser.close()
    except Exception:  # noqa: BLE001 — malformed markup falls back to raw text
        return html.strip()
    return parser.text()


def _scaled_bbox(
    x0: float, y0: float, x1: float, y1: float, width: float, height: float
) -> list[float] | None:
    """Scale a top-left-origin box onto the 0..1000 page, clamped."""
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


# --------------------------------------------------------------------- marker


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
    # Fall back to how deep this header sits in the running hierarchy Marker
    # attaches to each block. Not as good as an explicit level, but far better
    # than flattening every heading to h1 and losing section_path entirely.
    hierarchy = block.get("section_hierarchy")
    if isinstance(hierarchy, dict) and hierarchy:
        depths = [int(k) for k in hierarchy if str(k).isdigit()]
        if depths:
            return min(max(depths), 6)
    return None


def from_marker(rendered: dict[str, Any]) -> list[dict[str, Any]]:
    """Flatten Marker's JSON block tree into ``content_list`` order."""
    items: list[dict[str, Any]] = []

    def walk(block: dict[str, Any], page_idx: int, size: tuple[float, float]) -> None:
        kind = str(block.get("block_type") or "")
        children = block.get("children") or []

        if kind == "Page":
            # Marker ids look like "/page/3/Text/12"; the page number in the id
            # is authoritative, the array position is not.
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

        # Group blocks (FigureGroup, TableGroup, ListGroup, PictureGroup) and
        # the Document root are containers only.
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
                        "_level_inferred": _marker_heading_level(block) is None,
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
        elif kind in ("Figure", "Picture"):
            items.append(
                {
                    "type": "image",
                    "img_path": f"images/{str(block.get('id') or '').strip('/').replace('/', '_')}.png",
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

        # A Table/Figure may still contain a Caption child worth indexing.
        if kind in ("Table", "Figure", "Picture"):
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


# -------------------------------------------------------------------- docling


def _docling_bbox(
    prov: Any, page_height: float, page_width: float
) -> list[float] | None:
    bbox = getattr(prov, "bbox", None)
    if bbox is None:
        return None
    try:
        left, right = float(bbox.l), float(bbox.r)
        top, bottom = float(bbox.t), float(bbox.b)
    except (AttributeError, TypeError, ValueError):
        return None

    origin = str(getattr(bbox, "coord_origin", "") or "")
    if "BOTTOM" in origin.upper():
        # In bottom-left space a larger y is higher on the page, so the top edge
        # is the *larger* value. Flipping is not optional here.
        top, bottom = page_height - top, page_height - bottom
    return _scaled_bbox(left, top, right, bottom, page_width, page_height)


# --------------------------------------------------------------------- mineru

_MINERU_TYPES = {"text", "table", "equation", "image"}


def from_mineru(content_list: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Validate MinerU's own ``content_list`` — it is already the target shape.

    This is deliberately a near-passthrough, and that is the point of including
    MinerU in the comparison: it needs no adapter, no bbox conversion and no
    heading-level guessing, so it is the only candidate that carries zero
    contract risk. The only work here is asserting the invariants the other two
    adapters have to construct, so a regression upstream shows up as a metric
    change rather than as silently wrong citations.
    """
    items: list[dict[str, Any]] = []
    for raw in content_list:
        if not isinstance(raw, dict) or raw.get("type") not in _MINERU_TYPES:
            continue
        item = dict(raw)

        page = item.get("page_idx")
        item["page_idx"] = int(page) if isinstance(page, int) else None

        bbox = item.get("bbox")
        coords: list[float] | None = None
        if isinstance(bbox, list) and len(bbox) == 4:
            try:
                values = [float(v) for v in bbox]
            except (TypeError, ValueError):
                values = []
            # MinerU already normalizes to 1000x1000 top-left. Anything outside
            # that range means the upstream convention moved and every stored
            # citation region would be wrong, so drop it rather than rescale a
            # box whose real space we no longer know.
            if len(values) == 4 and all(-1.0 <= v <= _PAGE_SCALE + 1.0 for v in values):
                coords = [round(v, 2) for v in values]
        item["bbox"] = coords

        if isinstance(item.get("text_level"), int) and item["text_level"] > 0:
            item["_level_inferred"] = False
        items.append(item)
    return items


def _docling_table_html(item: Any, document: Any) -> str:
    """Docling's table HTML, tolerating signature drift across versions."""
    exporter = getattr(item, "export_to_html", None)
    if not callable(exporter):
        return ""
    try:
        return str(exporter(doc=document) or "")
    except TypeError:
        # Older releases take no document argument.
        try:
            return str(exporter() or "")
        except Exception:  # noqa: BLE001 — a missing table body is not fatal
            return ""
    except Exception:  # noqa: BLE001 — same
        return ""


def _docling_captions(item: Any, document: Any) -> list[str]:
    getter = getattr(item, "caption_text", None)
    if not callable(getter):
        return []
    try:
        caption = str(getter(document) or "").strip()
    except Exception:  # noqa: BLE001 — captions are a bonus, never a failure
        return []
    return [caption] if caption else []


def from_docling(document: Any) -> list[dict[str, Any]]:
    """Flatten a ``DoclingDocument`` into ``content_list`` order."""
    items: list[dict[str, Any]] = []

    sizes: dict[int, tuple[float, float]] = {}
    for page_no, page in (getattr(document, "pages", {}) or {}).items():
        size = getattr(page, "size", None)
        if size is not None:
            try:
                sizes[int(page_no)] = (float(size.width), float(size.height))
            except (AttributeError, TypeError, ValueError):
                continue

    for item, level in document.iterate_items():
        label = str(getattr(item, "label", "") or "")
        provs = list(getattr(item, "prov", []) or [])
        page_idx, bbox = None, None
        if provs:
            try:
                page_no = int(getattr(provs[0], "page_no", 0))
                # Docling pages are 1-based; content_list is 0-based.
                page_idx = max(0, page_no - 1)
                width, height = sizes.get(page_no, (0.0, 0.0))
                bbox = _docling_bbox(provs[0], height, width)
            except (TypeError, ValueError):
                page_idx = None

        base = {"page_idx": page_idx, "bbox": bbox}
        text = str(getattr(item, "text", "") or "").strip()

        if label in ("section_header", "title"):
            if text:
                explicit = getattr(item, "level", None)
                items.append(
                    {
                        "type": "text",
                        "text": text,
                        "text_level": int(explicit)
                        if isinstance(explicit, int) and explicit > 0
                        else max(1, int(level)),
                        "_level_inferred": not isinstance(explicit, int),
                        **base,
                    }
                )
        elif label == "table":
            body = _docling_table_html(item, document)
            if body:
                items.append(
                    {
                        "type": "table",
                        "table_body": body,
                        "table_caption": _docling_captions(item, document),
                        "table_footnote": [],
                        **base,
                    }
                )
        elif label == "formula":
            if text:
                items.append({"type": "equation", "text": text, **base})
        elif label in ("picture", "chart"):
            ref = str(getattr(item, "self_ref", "") or "").strip("#/").replace("/", "_")
            items.append(
                {
                    "type": "image",
                    "img_path": f"images/{ref}.png",
                    "image_caption": _docling_captions(item, document),
                    **base,
                }
            )
        elif (
            label in ("text", "paragraph", "list_item", "code", "caption", "footnote")
            and text
        ):
            items.append({"type": "text", "text": text, **base})

    return items
