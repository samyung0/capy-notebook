"""The list-card thumbnail, rendered inside the bounded parser worker."""

import pymupdf

# The list-card thumbnail ingest stores (openwiki/thumbnails.md): page 1 this
# many pixels wide, cut from the top at twice that.
THUMBNAIL_WIDTH = 200


def page_thumbnail(pdf: bytes) -> bytes:
    """Page 1 of the PDF a parse already holds, as a PNG THUMBNAIL_WIDTH wide;
    ingest encodes the stored WebP."""
    with pymupdf.open(stream=pdf, filetype="pdf") as doc:
        page = doc[0]
        rect = page.rect
        scale = THUMBNAIL_WIDTH / rect.width
        bottom = rect.y0 + min(rect.height, 2 * THUMBNAIL_WIDTH / scale)
        clip = pymupdf.Rect(rect.x0, rect.y0, rect.x1, bottom)
        pix = page.get_pixmap(
            matrix=pymupdf.Matrix(scale, scale), clip=clip, alpha=False
        )
        return pix.tobytes("png")
