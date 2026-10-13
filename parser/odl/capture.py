"""Render one temporary Office conversion inside the bounded parser worker."""

import base64

import pymupdf

# The list-card thumbnail ingest stores (openwiki/thumbnails.md): page 1 this
# many pixels wide, cut from the top at twice that, and its WebP quality
# (pipeline/ingest/thumbnail.py WEBP_QUALITY).
THUMBNAIL_WIDTH = 200
THUMBNAIL_WEBP_QUALITY = 60


def _page_one(pdf: bytes) -> pymupdf.Pixmap:
    with pymupdf.open(stream=pdf, filetype="pdf") as doc:
        page = doc[0]
        rect = page.rect
        scale = THUMBNAIL_WIDTH / rect.width
        bottom = rect.y0 + min(rect.height, 2 * THUMBNAIL_WIDTH / scale)
        clip = pymupdf.Rect(rect.x0, rect.y0, rect.x1, bottom)
        return page.get_pixmap(
            matrix=pymupdf.Matrix(scale, scale), clip=clip, alpha=False
        )


def page_thumbnail(pdf: bytes) -> bytes:
    """Page 1 of the PDF a parse already holds, as a PNG THUMBNAIL_WIDTH wide;
    ingest encodes the stored WebP."""
    return _page_one(pdf).tobytes("png")


def page_thumbnail_webp(pdf: bytes) -> bytes:
    """Page 1 as the WebP ingest would store from page_thumbnail, for the
    server capture of an Office file an agent turn edited (/page_thumbnail),
    which the API stores itself."""
    return _page_one(pdf).pil_tobytes(format="WEBP", quality=THUMBNAIL_WEBP_QUALITY)


def capture_page(
    pdf: bytes, page: int, bbox: list[float] | None, max_edge: int
) -> dict:
    box = bbox if bbox is not None else [0, 0, 1000, 1000]
    with pymupdf.open(stream=pdf, filetype="pdf") as doc:
        if not 1 <= page <= len(doc):
            raise ValueError(f"page must be between 1 and {len(doc)}")
        pg = doc[page - 1]
        area = pg.rect
        clip = pymupdf.Rect(
            area.x0 + area.width * box[0] / 1000,
            area.y0 + area.height * box[1] / 1000,
            area.x0 + area.width * box[2] / 1000,
            area.y0 + area.height * box[3] / 1000,
        )
        scale = max_edge / max(clip.width, clip.height)
        pix = pg.get_pixmap(matrix=pymupdf.Matrix(scale, scale), clip=clip, alpha=False)
        jpeg = pix.tobytes("jpeg", jpg_quality=80)
        return {
            "jpeg": base64.b64encode(jpeg).decode(),
            "box": box,
            "size": [pix.width, pix.height],
        }
