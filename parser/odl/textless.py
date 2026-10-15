"""Pages without a text layer, and the renders the ingest worker's VLM reads.

A page with fewer than 40 kept characters is text-less, blank pages included.
The parse lists them and puts one grey JPEG per page in the bundle
(``vlm/<page>.jpg``); the worker reads them with the captioning-slot VLM
(bench/parsers/reports/2026-10-15-glm-ocr.md: 1,280 px read as well as
2,048 px for 60% fewer input tokens).
"""

from __future__ import annotations

import io

import pymupdf
from PIL import Image

from . import page_text

TEXTLESS_CHARS = 40
RENDER_EDGE, RENDER_QUALITY = 1280, 80


def textless_pages(document: pymupdf.Document) -> list[int]:
    # The plain text holds every character a stage's read kept, so a page
    # with enough of them needs no second read.
    return [
        page.number
        for page in document
        if page_text.kept_characters(page) < TEXTLESS_CHARS
        and len(page.get_text().strip()) < TEXTLESS_CHARS
    ]


def render_jpeg(page: pymupdf.Page) -> bytes:
    """The page as a grey JPEG whose long edge is ``RENDER_EDGE`` pixels."""
    scale = RENDER_EDGE / max(page.rect.width, page.rect.height)
    pix = page.get_pixmap(
        matrix=pymupdf.Matrix(scale, scale), colorspace=pymupdf.csGRAY
    )
    image = Image.frombytes("L", (pix.width, pix.height), pix.samples)
    buffer = io.BytesIO()
    image.save(buffer, "JPEG", quality=RENDER_QUALITY)
    return buffer.getvalue()
