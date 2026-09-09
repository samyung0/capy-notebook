"""Benchmark-only MinerU 3.4.5 native-text detection bypass.

Call install() before analysis. Neural layout, formulas, tables and downstream
PDF text filling stay upstream. Digital regions with trustworthy native glyphs
use pdftext line boxes; every rejected region keeps upstream OCR detection.
"""

import math
import time
import unicodedata
from collections import Counter
from contextvars import ContextVar
from functools import wraps
from itertools import pairwise
from statistics import median
from threading import Lock

SOURCE_COMMIT = "fbb1257a555a3fde78ae5aaaa931e3b3f8fb2883"
_counts = Counter()
_lock = Lock()
_pages = ContextVar("mineru_native_text_pages", default=None)
_installed = False
_attribute = "_capy_native_text"


def _count(**values):
    with _lock:
        _counts.update(values)


def stats():
    """Return cumulative, numeric counters; snapshots may be subtracted."""
    with _lock:
        return dict(_counts)


def _bbox(value):
    return tuple(float(v) for v in getattr(value, "bbox", value))


def _intersects(a, b):
    return min(a[2], b[2]) > max(a[0], b[0]) and min(a[3], b[3]) > max(a[1], b[1])


def _inside_center(inner, outer):
    return (
        outer[0] <= (inner[0] + inner[2]) / 2 <= outer[2]
        and outer[1] <= (inner[1] + inner[3]) / 2 <= outer[3]
    )


def _read_page(pdf_doc, page_index, scale):
    import ctypes

    from mineru.utils.pdf_text_tool import get_page_chars
    from mineru.utils.pdfium_guard import close_pdfium_child, pdfium_guard
    from pypdfium2 import raw

    page = textpage = None
    try:
        with pdfium_guard():
            page = pdf_doc[page_index]
            box = page.get_bbox()
            if page.get_rotation() != 0 or any(abs(v) > 0.01 for v in box[:2]):
                return {"reason": "page_geometry"}
            textpage = page.get_textpage()
            count = textpage.count_chars()
            if not 0 < count <= 65535:
                return {"reason": "no_text_or_char_limit"}
            native = get_page_chars(page, textpage=textpage, page_char_count=count)
            opaque_objects = {}
            for char in native["chars"]:
                if not char["char"].strip():
                    continue
                index = char["char_idx"]
                obj = raw.FPDFText_GetTextObject(textpage, index)
                address = ctypes.cast(obj, ctypes.c_void_p).value if obj else None
                if address not in opaque_objects:
                    mode = raw.FPDFTextObj_GetTextRenderMode(obj) if obj else -1
                    opaque = False
                    for modes, get_color in (
                        ((0, 2), raw.FPDFText_GetFillColor),
                        ((1, 2), raw.FPDFText_GetStrokeColor),
                    ):
                        if mode in modes:
                            channels = [ctypes.c_uint() for _ in range(4)]
                            if (
                                get_color(textpage, index, *channels)
                                and channels[3].value == 255
                            ):
                                opaque = True
                    opaque_objects[address] = opaque
                char["_unreliable"] = bool(
                    raw.FPDFText_HasUnicodeMapError(textpage, index)
                    or not opaque_objects[address]
                )
            image_boxes = []
            for obj in page.get_objects(filter=[raw.FPDF_PAGEOBJ_IMAGE], max_depth=30):
                try:
                    get_bounds = getattr(obj, "get_bounds", None) or obj.get_pos
                    left, bottom, right, top = get_bounds()
                    image_boxes.append(
                        (
                            left * scale,
                            (box[3] - top) * scale,
                            right * scale,
                            (box[3] - bottom) * scale,
                        )
                    )
                finally:
                    close_pdfium_child(obj)
            return {"chars": native["chars"], "images": image_boxes, "scale": scale}
    finally:
        close_pdfium_child(textpage)
        close_pdfium_child(page)


def _reliable_char(char):
    text = char["char"]
    box = _bbox(char["bbox"])
    return (
        not char.get("_unreliable")
        and all(math.isfinite(v) for v in box)
        and box[2] > box[0]
        and box[3] > box[1]
        and abs(float(char.get("rotation", 0))) < math.radians(0.1)
        and bool(char.get("font", {}).get("name"))
        and all(
            unicodedata.category(c) not in {"Cc", "Cs", "Co", "Cn"} and c != "\ufffd"
            for c in text
        )
    )


def _unexplained_ink(image, region, covered):
    """Require native glyph/formula boxes to account for visible region ink."""
    import cv2
    import numpy as np

    height, width = image.shape[:2]
    x0, y0 = max(0, math.floor(region[0])), max(0, math.floor(region[1]))
    x1, y1 = min(width, math.ceil(region[2])), min(height, math.ceil(region[3]))
    if x1 <= x0 or y1 <= y0:
        return True
    crop = image[y0:y1, x0:x1]
    # A raster object can cover a white region without contributing visible ink.
    # Keep pale/colored strokes and thin components in this stricter v3 check.
    residual = (np.min(crop[:, :, :3], axis=2) < 245).astype(np.uint8)
    for box in covered:
        left = max(0, math.floor(box[0]) - x0 - 1)
        top = max(0, math.floor(box[1]) - y0 - 1)
        right = min(x1 - x0, math.ceil(box[2]) - x0 + 1)
        bottom = min(y1 - y0, math.ceil(box[3]) - y0 + 1)
        if right > left and bottom > top:
            residual[top:bottom, left:right] = 0
    if not residual.any():
        return False
    _, _, components, _ = cv2.connectedComponentsWithStats(residual, connectivity=8)
    return any(c[4] >= 4 for c in components[1:])


def _visible_line(image, box):
    import numpy as np

    height, width = image.shape[:2]
    x0, y0 = max(0, math.floor(box[0])), max(0, math.floor(box[1]))
    x1, y1 = min(width, math.ceil(box[2])), min(height, math.ceil(box[3]))
    return (
        x1 > x0
        and y1 > y0
        and np.count_nonzero(np.min(image[y0:y1, x0:x1, :3], axis=2) < 245) >= 4
    )


def _plain_fill_matches(native, chars, boxes, formulas, image_size=None):
    """Replay upstream fill after its exact pixel-to-PDF integer conversion."""
    from mineru.utils.bbox_utils import normalize_to_int_bbox
    from mineru.utils.span_pre_proc import (
        _classify_char_script_roles,
        _get_char_bbox_metrics_list,
        _get_chars_for_span_fill,
        calculate_char_in_span,
        chars_to_content,
        fill_char_in_spans,
    )

    scale = native["scale"]
    spans = []
    for box in boxes:
        pixel_box = normalize_to_int_bbox(box, image_size=image_size)
        if pixel_box is None:
            return "native_fill_small_box"
        bbox = [int(v / scale) for v in pixel_box]
        width, height = bbox[2] - bbox[0], bbox[3] - bbox[1]
        if width <= 2 or height <= 2:
            return "native_fill_small_box"
        spans.append(
            {"bbox": bbox, "width": width, "height": height, "chars": [], "content": ""}
        )
    expected_chars = [[] for _ in spans]
    for char in chars:
        if char["char"] in {"\r", "\n"}:
            continue
        char_box = _bbox(char["bbox"])
        if any(
            _intersects(tuple(v * scale for v in char_box), f["bbox"]) for f in formulas
        ):
            continue
        owners = [
            i
            for i, span in enumerate(spans)
            if calculate_char_in_span(char_box, span["bbox"], char["char"])
        ]
        if char["char"].strip() and len(owners) != 1:
            return "native_fill_coverage"
        if len(owners) == 1:
            expected_chars[owners[0]].append(char)
    expected = []
    for assigned in expected_chars:
        if not any(c["char"].strip() for c in assigned):
            return "native_fill_empty"
        roles = _classify_char_script_roles(
            assigned, _get_char_bbox_metrics_list(assigned)
        )
        if any(role != "body" for role in roles):
            return "native_fill_scripts"
        reference = {"chars": assigned, "content": ""}
        chars_to_content(reference)
        expected.append(reference["content"])
    if "fill_chars" not in native:
        native["fill_chars"] = _get_chars_for_span_fill(native)
    if fill_char_in_spans(
        spans, native["fill_chars"], median(s["height"] for s in spans)
    ):
        return "native_fill_needs_ocr"
    if [s["content"] for s in spans] != expected:
        return "native_fill_mismatch"
    return None


def _region_boxes(native, region, formulas, image):
    from mineru.utils.ocr_utils import update_det_boxes
    from mineru.utils.pdf_text_tool import get_lines_from_chars

    if "reason" in native:
        return None, native["reason"]
    raster_overlap = any(_intersects(region, box) for box in native["images"])
    scale = native["scale"]
    unscaled_region = tuple(v / scale for v in region)
    chars = [
        c for c in native["chars"] if _inside_center(_bbox(c["bbox"]), unscaled_region)
    ]
    visible = [c for c in chars if c["char"].strip()]
    if not visible:
        return None, "empty_region"
    if not all(_reliable_char(c) for c in visible):
        return None, "unreliable_chars"
    glyph_boxes = [tuple(v * scale for v in _bbox(c["bbox"])) for c in visible]
    if _unexplained_ink(image, region, glyph_boxes + [f["bbox"] for f in formulas]):
        return None, "raster_unexplained_ink" if raster_overlap else "unexplained_ink"
    # Generated CR/LF may lie beyond a neural region's right edge. Cropping
    # characters before grouping deletes those breaks and joins different rows.
    if "lines" not in native:
        native["lines"] = get_lines_from_chars(native["chars"])
    selected = {char["char_idx"]: char for char in chars}
    lines = []
    for source_line in native["lines"]:
        line_chars = [
            selected[c["char_idx"]]
            for span in source_line["spans"]
            for c in span["chars"]
            if c["char_idx"] in selected
        ]
        line_visible = [c for c in line_chars if c["char"].strip()]
        if not line_visible:
            continue
        glyphs = [_bbox(c["bbox"]) for c in line_visible]
        line_box = (
            min(b[0] for b in glyphs),
            min(b[1] for b in glyphs),
            max(b[2] for b in glyphs),
            max(b[3] for b in glyphs),
        )
        has_scripts = any(
            (span.get("superscript") or span.get("subscript"))
            and any(c["char_idx"] in selected for c in span["chars"])
            for span in source_line["spans"]
        )
        lines.append(
            {
                "bbox": line_box,
                "rotation": source_line["rotation"],
                "has_scripts": has_scripts,
            }
        )
    # pdftext can emit an exponent as a separate, unflagged line. Keep the
    # detector whenever native lines overlap vertically or explicitly use scripts.
    if any(line["has_scripts"] for line in lines):
        return None, "inline_scripts"
    line_boxes = sorted((_bbox(line["bbox"]) for line in lines), key=lambda box: box[1])
    if any(current[1] < previous[3] for previous, current in pairwise(line_boxes)):
        return None, "overlapping_native_lines"
    boxes = []
    for line in lines:
        if abs(float(line["rotation"])) >= math.radians(0.1):
            return None, "line_rotation"
        x0, y0, x1, y1 = (v * scale for v in _bbox(line["bbox"]))
        if x1 <= x0 or y1 <= y0:
            continue
        if not _visible_line(image, (x0, y0, x1, y1)):
            return None, "invisible_native_line"
        boxes.append([[x0, y0], [x1, y0], [x1, y1], [x0, y1]])
    boxes = update_det_boxes(boxes, formulas) if formulas else boxes
    if not boxes:
        return None, "empty_lines"
    fill_reason = _plain_fill_matches(native, chars, boxes, formulas, image.shape[:2])
    if fill_reason:
        return None, fill_reason
    return boxes, "accepted_raster_overlap" if raster_overlap else "accepted"


def _filter_regions(native, ocr_enable, image, layout, regions, formulas):
    from mineru.utils.bbox_utils import normalize_to_int_bbox

    _count(pages=1, regions=len(regions))
    if ocr_enable or native is None:
        reason = "ocr_page" if ocr_enable else "missing_metadata"
        _count(
            pages_fallback=1, regions_fallback=len(regions), **{reason: len(regions)}
        )
        return regions
    remaining = []
    bypassed = 0
    # ponytail: OCR layout lists are small; index these only if this scan becomes costly.
    ambiguous = {
        id(region)
        for region in regions
        if any(
            other is not region and _intersects(region["bbox"], other["bbox"])
            for other in regions
        )
    }
    for region in regions:
        if "images" in native and any(
            _intersects(region["bbox"], box) for box in native["images"]
        ):
            _count(regions_raster_overlap=1)
        if id(region) in ambiguous:
            remaining.append(region)
            _count(regions_fallback=1, overlapping_layout_regions=1)
            continue
        boxes, reason = _region_boxes(native, region["bbox"], formulas, image)
        if boxes is None:
            remaining.append(region)
            _count(regions_fallback=1, **{reason: 1})
            continue
        native_lines = []
        for box in boxes:
            bbox = normalize_to_int_bbox(box, image_size=image.shape[:2])
            if bbox is not None:
                native_lines.append(
                    {"label": "ocr_text", "bbox": bbox, "score": 1.0, "text": ""}
                )
        if not native_lines:
            remaining.append(region)
            _count(regions_fallback=1, empty_lines=1)
            continue
        layout.extend(native_lines)
        bypassed += 1
        _count(
            regions_bypassed=1,
            native_lines=len(native_lines),
            **{
                "regions_raster_bypassed"
                if reason == "accepted_raster_overlap"
                else "regions_no_raster_bypassed": 1
            },
        )
    _count(pages_bypassed=int(bypassed > 0), pages_fallback=int(bool(remaining)))
    return remaining


def install():
    """Install process-local hooks once, before starting parser worker threads."""
    global _installed
    if _installed:
        return
    import numpy as np
    from mineru.backend.pipeline import batch_analyze, pipeline_analyze
    from mineru.version import __version__
    from pypdfium2 import PdfiumError

    if __version__ != "3.4.5":
        raise RuntimeError(
            f"Native-text experiment requires MinerU 3.4.5, got {__version__}"
        )
    load_images = pipeline_analyze.load_images_from_pdf_doc
    analyze = batch_analyze.BatchAnalyze.__call__
    get_regions = batch_analyze.get_res_list_from_layout_res

    @wraps(load_images)
    def load_with_native(pdf_doc, *args, **kwargs):
        images = load_images(pdf_doc, *args, **kwargs)
        start = kwargs.get("start_page_id", args[1] if len(args) > 1 else 0)
        started = time.perf_counter()
        for index, item in enumerate(images, start):
            if "img_pil" not in item:
                continue
            try:
                native = _read_page(pdf_doc, index, item["scale"])
            except (PdfiumError, ValueError, OverflowError):
                _count(native_read_errors=1)
                native = {"reason": "native_read_error"}
            setattr(item["img_pil"], _attribute, native)
        _count(native_read_seconds=time.perf_counter() - started)
        return images

    @wraps(analyze)
    def analyze_with_native(self, images):
        token = _pages.set(iter(images))
        try:
            return analyze(self, images)
        finally:
            _pages.reset(token)
            for image, _, _ in images:
                if hasattr(image, _attribute):
                    delattr(image, _attribute)

    @wraps(get_regions)
    def native_regions(layout, *args, **kwargs):
        regions, tables, formulas = get_regions(layout, *args, **kwargs)
        pages = _pages.get()
        if pages is None:
            return regions, tables, formulas
        image, ocr_enable, _ = next(pages)
        started = time.perf_counter()
        remaining = _filter_regions(
            getattr(image, _attribute, None),
            ocr_enable,
            np.asarray(image),
            layout,
            regions,
            formulas,
        )
        _count(native_region_seconds=time.perf_counter() - started)
        return remaining, tables, formulas

    pipeline_analyze.load_images_from_pdf_doc = load_with_native
    batch_analyze.BatchAnalyze.__call__ = analyze_with_native
    batch_analyze.get_res_list_from_layout_res = native_regions
    _installed = True
