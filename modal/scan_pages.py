"""Cheap per-page probe: scanned raster vs a figure sitting on a digital page.

A page with a photo is not a scanned page. A scanned page is (almost) the whole
page drawn as one image, with little real text in the PDF layer. We also OCR
thin text layers (lecture slides) because those layers are too sparse to index,
even when the pictures on them are ordinary figures.

Some mistakes are fine: OCRing a photo page wastes a second; missing a scan
drops a page of words. The second one is worse, so the probe leans toward OCR.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from typing import Any

# A letter page with a real paragraph run is thousands of characters. Below this
# we no longer trust the text layer enough to skip OCR just because "some text
# exists". Lecture decks in the bench sat at 10-363 chars/page.
_GOOD_TEXT_CHARS = 800

# Near-full-page image + weak text => the page *is* the image (a scan), not a
# figure next to prose. Figures on papers are typically well under this.
_SCAN_IMAGE_COVERAGE = 0.70

# Slides and covers: not scans, but the text layer is not enough to retrieve.
_THIN_TEXT_CHARS = 400

# Pdfium image object type. Kept numeric so this module does not import pypdfium2
# at collection time (pipeline tests load the pure helper only).
_PAGEOBJ_IMAGE = 3


@dataclass(frozen=True)
class PageProbe:
    page_idx: int
    chars: int
    image_coverage: float
    needs_ocr: bool
    reason: str
    alnum_ratio: float = 1.0
    replacement_chars: int = 0


def page_needs_ocr(
    chars: int, image_coverage: float, text: str = ""
) -> tuple[bool, str]:
    """Decide from two cheap numbers. Coverage is clamped to 0..1."""
    chars = max(0, int(chars))
    coverage = min(max(float(image_coverage), 0.0), 1.0)

    quality_reason = _text_quality_reason(text)
    if quality_reason:
        return True, quality_reason

    # Lots of extractable text: this is a digital page. A large figure on it is
    # still just a figure — do not OCR the photo.
    if chars >= _GOOD_TEXT_CHARS:
        return False, "text_layer"

    # Weak text AND the raster covers most of the page: scanned page.
    if coverage >= _SCAN_IMAGE_COVERAGE:
        return True, "scan"

    # Weak text, no full-page raster: lecture slide / cover / sparse page.
    if chars < _THIN_TEXT_CHARS:
        return True, "thin_text"

    return False, "enough_text"


def job_needs_rapidocr(probes: list[PageProbe], parse_method: str) -> bool:
    """True when this document should take the slow OCR lane, not the digital lane."""
    if (parse_method or "selective_rapidocr") in {"txt", "marker_only"}:
        return False
    if parse_method == "all_rapidocr":
        return bool(probes)
    return any(page.needs_ocr for page in probes)


def probe_pages(data: bytes) -> list[PageProbe]:
    """Walk each PDF page. Non-PDFs are treated as a single scanned page."""
    if not data.lstrip().startswith(b"%PDF"):
        needs, reason = page_needs_ocr(0, 1.0)
        return [PageProbe(0, 0, 1.0, needs, reason)]

    import pypdfium2 as pdfium
    import pypdfium2.raw as pdfium_c

    image_type = int(getattr(pdfium_c, "FPDF_PAGEOBJ_IMAGE", _PAGEOBJ_IMAGE))
    probes: list[PageProbe] = []
    pdf = pdfium.PdfDocument(data)
    try:
        for index in range(len(pdf)):
            page = pdf[index]
            try:
                probes.append(_probe_one(page, index, image_type))
            finally:
                page.close()
    finally:
        pdf.close()
    return probes


def _probe_one(page: Any, index: int, image_type: int) -> PageProbe:
    width, height = _page_size(page)
    area = max(width * height, 1.0)
    text = _page_text(page)
    chars = len(text.strip())
    coverage = min(_image_area(page, image_type) / area, 1.0)
    needs, reason = page_needs_ocr(chars, coverage, text)
    visible = [char for char in text if not char.isspace()]
    alnum = sum(char.isalnum() for char in visible)
    alnum_ratio = alnum / len(visible) if visible else 0.0
    return PageProbe(
        index,
        chars,
        round(coverage, 4),
        needs,
        reason,
        round(alnum_ratio, 4),
        text.count("\ufffd"),
    )


def _page_size(page: Any) -> tuple[float, float]:
    getter = getattr(page, "get_size", None)
    if callable(getter):
        size = getter()
        return float(size[0]), float(size[1])
    return float(page.get_width()), float(page.get_height())


def _page_text(page: Any) -> str:
    textpage = page.get_textpage()
    try:
        for name in ("get_text_range", "get_text_bounded"):
            getter = getattr(textpage, name, None)
            if callable(getter):
                try:
                    text = getter() or ""
                except TypeError:
                    text = getter(0) or ""
                return str(text)
        return ""
    finally:
        closer = getattr(textpage, "close", None)
        if callable(closer):
            closer()


def _text_quality_reason(text: str) -> str:
    """Flag damaged native text layers even when they contain many glyphs."""
    if not text:
        return ""
    visible = [char for char in text if not char.isspace()]
    if not visible:
        return ""
    if "\ufffd" in text:
        return "replacement_chars"
    controls = sum(
        unicodedata.category(char) == "Cc" and char not in "\n\r\t" for char in text
    )
    if controls / max(len(text), 1) >= 0.01:
        return "control_chars"
    if len(visible) >= 100:
        alnum_ratio = sum(char.isalnum() for char in visible) / len(visible)
        if alnum_ratio < 0.30:
            return "low_alnum"
    words = re.findall(r"\S+", text)
    if len(words) >= 24:
        single = sum(len(word.strip(".,;:!?()[]{}")) == 1 for word in words)
        if single / len(words) >= 0.40:
            return "broken_spacing"
    return ""


def _image_area(page: Any, image_type: int) -> float:
    """Union-ish: sum of image boxes, so overlapping stamps can go past 1.0.

    Clamped by the caller. Recurses into Form XObjects because a scan is often
    one image wrapped in a form, not a bare image object.
    """
    total = 0.0
    try:
        objects = page.get_objects(filter=[image_type], max_depth=12)
    except TypeError:
        objects = page.get_objects(max_depth=12)
    for obj in objects:
        try:
            if int(getattr(obj, "type", image_type)) not in (
                image_type,
                _PAGEOBJ_IMAGE,
            ):
                continue
            box = _object_bounds(obj)
            if box is None:
                continue
            left, bottom, right, top = box
            total += abs(right - left) * abs(top - bottom)
        except (TypeError, ValueError, AttributeError):
            continue
    return total


def _object_bounds(obj: Any) -> tuple[float, float, float, float] | None:
    for name in ("get_bounds", "get_pos"):
        getter = getattr(obj, name, None)
        if not callable(getter):
            continue
        try:
            box = getter()
        except (TypeError, ValueError, AttributeError):
            continue
        if isinstance(box, (tuple, list)) and len(box) == 4:
            return float(box[0]), float(box[1]), float(box[2]), float(box[3])
    return None
