"""The import worker's header check (image_check.py): sizes from headers
only, the twin of the gateway's server/internal/imagecheck."""

from __future__ import annotations

import io
import struct
import zipfile
import zlib
from pathlib import Path

import pytest
from PIL import Image

from pipeline.ingest import image_check

FIXTURES = Path(__file__).parents[2] / "e2e/fixtures/files/images"
MB = 1 << 20


def png_header(width: int, height: int) -> bytes:
    """A PNG signature and an IHDR claiming width x height, no pixels."""
    body = b"IHDR" + struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + struct.pack(">I", 13)
        + body
        + struct.pack(">I", zlib.crc32(body))
    )


def heic(width: int, height: int) -> bytes:
    def box(kind: bytes, *body: bytes) -> bytes:
        payload = b"".join(body)
        return struct.pack(">I", 8 + len(payload)) + kind + payload

    def ispe(w: int, h: int) -> bytes:
        return box(b"ispe", b"\0" * 4, struct.pack(">II", w, h))

    return box(b"ftyp", b"heic", b"\0" * 4, b"mif1heic") + box(
        b"meta",
        b"\0" * 4,
        box(b"iprp", box(b"ipco", ispe(320, 240), ispe(width, height))),
    )


def encoded(image: Image.Image, kind: str) -> bytes:
    buffer = io.BytesIO()
    image.save(buffer, kind)
    return buffer.getvalue()


@pytest.mark.parametrize(
    ("data", "size"),
    [
        (png_header(2401, 10), (2401, 10)),
        (heic(4032, 3024), (4032, 3024)),
        ((FIXTURES / "photo.heic").read_bytes(), (3000, 2000)),
        ((FIXTURES / "photo.jp2").read_bytes(), (3000, 2000)),
        ((FIXTURES / "photo.tif").read_bytes(), (3000, 2000)),
        ((FIXTURES / "photo.jpg").read_bytes(), (3000, 2000)),
        (encoded(Image.new("RGB", (31, 17)), "GIF"), (31, 17)),
        (encoded(Image.new("RGB", (31, 17)), "BMP"), (31, 17)),
        (encoded(Image.new("RGB", (31, 17)), "WEBP"), (31, 17)),
        (encoded(Image.new("RGBA", (31, 17)), "WEBP"), (31, 17)),
    ],
    ids=[
        "png",
        "heic-boxes",
        "heic",
        "jp2",
        "tiff",
        "jpeg",
        "gif",
        "bmp",
        "webp",
        "webp-alpha",
    ],
)
def test_size_reads_headers(data, size):
    assert image_check.size(data) == size


def test_source_refused_past_five_megapixels():
    image_check.check_source(png_header(2500, 2000))
    image_check.check_source(b"<svg/>")
    for data in (png_header(2610, 1955), heic(2610, 1955)):
        with pytest.raises(image_check.Refused) as refused:
            image_check.check_source(data)
        assert refused.value.code == "source_image_too_large"
    with pytest.raises(image_check.Refused) as refused:
        image_check.check_source(b"\x89PNG\r\n\x1a\nbroken")
    assert refused.value.code == "image_unreadable"


def office(parts: dict[str, bytes]) -> bytes:
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, data in parts.items():
            archive.writestr(name, data)
    return out.getvalue()


def test_office_check():
    image_check.check_office(
        office(
            {
                "word/document.xml": b"<w:document/>",
                "word/media/image1.png": png_header(800, 600) + b"\0" * 1000,
                "word/media/chart.svg": b"<svg/>",
            }
        ),
        2 * MB,
    )
    emf = b"\x01\x00\x00\x00" + b"\0" * 36 + b" EMF" + b"\0" * 20
    for parts, code in (
        (
            {"word/media/image1.png": png_header(800, 600) + b"\0" * (2 * MB)},
            "office_image_too_large",
        ),
        ({"ppt/media/x.bin": png_header(2401, 2)}, "office_image_too_large"),
        # A decompression bomb: refused from its header alone.
        ({"ppt/media/bomb.png": png_header(50000, 50000)}, "office_image_too_large"),
        ({"xl/media/image2.bin": emf}, "office_vector_image"),
        ({"word/media/eq.wmf": b"\0\0"}, "office_vector_image"),
    ):
        with pytest.raises(image_check.Refused) as refused:
            image_check.check_office(office(parts), 2 * MB)
        assert refused.value.code == code
