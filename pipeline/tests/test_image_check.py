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


def gif_header(screen: tuple[int, int], frame: tuple[int, int, int, int]) -> bytes:
    """A GIF whose logical screen and first frame (left, top, width,
    height) claim their own sizes."""
    return (
        b"GIF89a"
        + struct.pack("<HHBBB", *screen, 0x80, 0, 0)
        + b"\0\0\0\xff\xff\xff"
        + b"\x21\xf9\x04\0\0\0\0\0"
        + b"\x2c"
        + struct.pack("<HHHHB", *frame, 0)
        + b"\x02\x02\x44\x01\x00\x3b"
    )


def heif(brand: bytes, width: int, height: int) -> bytes:
    def box(kind: bytes, *body: bytes) -> bytes:
        payload = b"".join(body)
        return struct.pack(">I", 8 + len(payload)) + kind + payload

    def ispe(w: int, h: int) -> bytes:
        return box(b"ispe", b"\0" * 4, struct.pack(">II", w, h))

    return box(b"ftyp", brand, b"\0" * 4, b"mif1" + brand) + box(
        b"meta",
        b"\0" * 4,
        box(b"iprp", box(b"ipco", ispe(320, 240), ispe(width, height))),
    )


def encoded(image: Image.Image, kind: str) -> bytes:
    buffer = io.BytesIO()
    image.save(buffer, kind)
    return buffer.getvalue()


@pytest.mark.parametrize(
    ("data", "found"),
    [
        (png_header(2401, 10), ("png", 2401, 10)),
        (heif(b"avif", 4032, 3024), ("avif", 4032, 3024)),
        (heif(b"heic", 4032, 3024), ("heic", 4032, 3024)),
        ((FIXTURES / "photo.jpg").read_bytes(), ("jpeg", 3000, 2000)),
        (encoded(Image.new("RGB", (31, 17)), "GIF"), ("gif", 31, 17)),
        (encoded(Image.new("RGB", (31, 17)), "WEBP"), ("webp", 31, 17)),
        (encoded(Image.new("RGBA", (31, 17)), "WEBP"), ("webp", 31, 17)),
        # Security regression (Q348, review S9): a frame larger than the
        # screen it claims gives the size.
        (gif_header((1, 1), (10, 20, 60000, 50000)), ("gif", 60010, 50020)),
        # Fill bytes before a JPEG marker (review N3).
        (
            b"\xff\xd8\xff\xff\xc0\x00\x11\x08\x00\x10\x00\x20" + b"\0" * 20,
            ("jpeg", 32, 16),
        ),
    ],
    ids=[
        "png",
        "avif",
        "heic",
        "jpeg",
        "gif",
        "webp",
        "webp-alpha",
        "gif-frame",
        "jpeg-fill",
    ],
)
def test_size_reads_headers(data, found):
    assert image_check.size(data) == found


@pytest.mark.parametrize(
    "data",
    [
        (FIXTURES / "photo.tif").read_bytes(),
        (FIXTURES / "photo.jp2").read_bytes(),
        encoded(Image.new("RGB", (31, 17)), "BMP"),
        b"<svg/>",
    ],
    ids=["tiff", "jp2", "bmp", "svg"],
)
def test_other_formats_are_not_measured(data):
    assert image_check.size(data) is None


def _refused(call) -> str:
    with pytest.raises(image_check.Refused) as refused:
        call()
    return refused.value.code


def test_source_is_png_jpeg_gif_or_webp_within_five_megapixels():
    """Security regression (Q344, review S4): anything else is refused by its
    content."""
    image_check.check_source(png_header(2500, 2000))
    image_check.check_source(gif_header((2500, 2000), (0, 0, 10, 10)))
    for data in (png_header(2610, 1955), gif_header((1, 1), (0, 0, 2610, 1955))):
        assert (
            _refused(lambda data=data: image_check.check_source(data))
            == "source_image_too_large"
        )
    for data in (
        b"\x89PNG\r\n\x1a\nbroken",
        b"<svg/>",
        heif(b"heic", 100, 100),
        (FIXTURES / "photo.tif").read_bytes(),
        b"8BPS\x00\x01",
    ):
        assert (
            _refused(lambda data=data: image_check.check_source(data))
            == "image_unreadable"
        )


def office(parts: dict[str, bytes]) -> bytes:
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, data in parts.items():
            archive.writestr(name, data)
    return out.getvalue()


def rels(*targets: str) -> bytes:
    body = "".join(
        f'<Relationship Id="rId{i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/{kind}" Target="{target}"/>'
        for i, (kind, target) in enumerate(t.split(" ") for t in targets)
    )
    return (
        '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + body
        + "</Relationships>"
    ).encode()


def test_office_check_passes_a_compressed_file():
    image_check.check_office(
        office(
            {
                "word/document.xml": b"<w:document/>",
                "word/_rels/document.xml.rels": rels(
                    "image media/image1.png", "video media/clip.mp4"
                ),
                "word/media/image1.png": png_header(800, 600) + b"\0" * 1000,
                "word/media/clip.mp4": b"\0\0\0\x18ftypmp42",
                "word/embeddings/a.bin": b"\xd0\xcf\x11\xe0",
            }
        ),
        2 * MB,
    )


EMF = b"\x01\x00\x00\x00" + b"\0" * 36 + b" EMF" + b"\0" * 20


@pytest.mark.parametrize(
    ("parts", "code"),
    [
        (
            {"word/media/image1.png": png_header(800, 600) + b"\0" * (2 * MB)},
            "office_image_too_large",
        ),
        ({"ppt/media/x.bin": png_header(10, 2401)}, "office_image_too_large"),
        # A decompression bomb: refused from its header alone.
        ({"ppt/media/bomb.png": png_header(50000, 50000)}, "office_image_too_large"),
        (
            {
                "word/_rels/document.xml.rels": rels("image media/image1.xml"),
                "word/media/image1.xml": png_header(6000, 4000),
            },
            "office_image_too_large",
        ),
        (
            {"word/media/a.gif": gif_header((1, 1), (0, 0, 60000, 60000))},
            "office_image_too_large",
        ),
        ({"xl/media/image2.bin": EMF}, "office_vector_image"),
        ({"word/embeddings/x.dat": EMF}, "office_vector_image"),
        ({"word/media/eq.wmf": b"\0\0"}, "office_vector_image"),
        ({"word/media/logo.svg": b"<svg/>"}, "office_image_unsupported"),
        ({"word/embeddings/icon.svg": b"<svg/>"}, "office_image_unsupported"),
        (
            {
                "word/_rels/document.xml.rels": rels("image media/image3.png"),
                "word/media/image3.png": b"<?xml version='1.0'?><svg width='9'/>",
            },
            "office_image_unsupported",
        ),
        ({"word/media/image1.bmp": b"BM\0\0\0\0"}, "office_image_unsupported"),
        (
            {"word/media/hdphoto1.wdp": b"II\xbc\x01" + b"\0" * 8},
            "office_image_unsupported",
        ),
    ],
    ids=[
        "over-cap",
        "short-side",
        "bomb",
        "png-named-xml",
        "gif-frame",
        "emf",
        "emf-outside-media",
        "wmf-by-name",
        "svg",
        "svg-outside-pictures",
        "svg-named-png",
        "bmp",
        "jpeg-xr",
    ],
)
def test_office_check_refuses_pictures_by_content(parts, code):
    """Security regression (Q344, Q337, Q348; review S2): parts are checked by
    their content, a picture part holds only PNG, JPEG or GIF, and EMF, WMF
    and SVG are refused."""
    assert _refused(lambda: image_check.check_office(office(parts), 2 * MB)) == code


def _overlapped() -> bytes:
    """One deflated picture under two directory records."""
    raw = office({"word/media/image1.png": png_header(10, 10)})
    cd, end = raw.index(b"PK\x01\x02"), raw.index(b"PK\x05\x06")
    record = raw[cd:end]
    second = record[:46] + b"word/media/image2.png" + record[46 + 21 :]
    eocd = bytearray(raw[end:])
    struct.pack_into("<HHI", eocd, 8, 2, 2, 2 * len(record))
    return raw[:cd] + record + second + bytes(eocd)


def test_office_check_refuses_packages_it_cannot_read_whole():
    """Security regression (Q348, review B1, S2): not a zip, over 4,096
    entries, overlapping entries, or past 256 MiB inflated in all."""
    check = image_check.check_office
    assert (
        _refused(lambda: check(b"PK\x03\x04 not really", 2 * MB)) == "office_unreadable"
    )
    many = office({f"word/p{i}.xml": b"<p/>" for i in range(4097)})
    assert _refused(lambda: check(many, 2 * MB)) == "office_unreadable"
    # Refused by the check itself, before CPython's own read would refuse it.
    with pytest.raises(image_check.Refused, match="overlapping entries") as overlap:
        check(_overlapped(), 2 * MB)
    assert overlap.value.code == "office_unreadable"
    under = png_header(800, 600) + b"\0" * (2 * MB - 100)
    big = office({f"word/media/image{i}.png": under for i in range(130)})
    assert _refused(lambda: check(big, 2 * MB)) == "office_unreadable"
