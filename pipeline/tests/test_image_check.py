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
        heif(b"avif", 4032, 3024),
        heif(b"heic", 4032, 3024),
    ],
    ids=["tiff", "jp2", "bmp", "svg", "avif", "heic"],
)
def test_other_formats_are_not_measured(data):
    assert image_check.size(data) is None


def test_jpeg_frames_go_does_not_read_are_unreadable():
    """Review r2 N2: lossless, hierarchical and arithmetic frames are refused
    as the gateway refuses them."""
    for marker in (0xC3, 0xC5, 0xC9, 0xCF):
        data = (
            b"\xff\xd8\xff"
            + bytes([marker])
            + b"\x00\x11\x08\x00\x10\x00\x20"
            + b"\0" * 20
        )
        with pytest.raises(image_check.Unreadable):
            image_check.size(data)


def test_jpeg_markers_go_refuses_before_the_frame_are_unreadable():
    """Review r3 N1: before its frame, a JPEG holds only the segments Go
    reads (DHT, DQT, DRI, APPn, COM, restart markers, a stuffed 0x00); any
    other marker is refused as the gateway refuses it."""
    frame = b"\xff\xc0\x00\x11\x08\x00\x10\x00\x20" + b"\0" * 20
    for marker in (0xC8, 0xCC, 0xDC, 0xDE, 0xDF, 0xF0, 0xFD, 0xD8, 0x01, 0x02):
        data = b"\xff\xd8\xff" + bytes([marker]) + b"\x00\x04\x00\x00" + frame
        with pytest.raises(image_check.Unreadable):
            image_check.size(data)
    for segment in (
        b"\xff\xc4\x00\x04\x00\x00",
        b"\xff\xdb\x00\x04\x00\x00",
        b"\xff\xdd\x00\x04\x00\x00",
        b"\xff\xe1\x00\x04\x00\x00",
        b"\xff\xfe\x00\x04\x00\x00",
        b"\xff\xd0\xff\x00",
    ):
        assert image_check.size(b"\xff\xd8" + segment + frame) == ("jpeg", 32, 16)


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
        # Review r2 S1: any other image format, wherever it sits.
        (
            {
                "word/_rels/document.xml.rels": rels("image pics\\a.webp"),
                "word/pics/a.webp": b"RIFF\0\0\0\0WEBPVP8L\0\0\0\0",
            },
            "office_image_unsupported",
        ),
        (
            {"word/embeddings/x.bin": b"BM" + b"\0" * 12 + b"\x28\0\0\0"},
            "office_image_unsupported",
        ),
        ({"word/x.dat": b"II*\x00\x08\x00\x00\x00"}, "office_image_unsupported"),
        ({"word/x.dat": b"\x00\x00\x01\x00\x01\x00"}, "office_image_unsupported"),
        (
            {"word/x.dat": b"\x00\x00\x00\x0cjP  \r\n\x87\n"},
            "office_image_unsupported",
        ),
        # Review r2 N1: a part named as relationships is checked too.
        (
            {
                "word/_rels/document.xml.rels": rels("image media/a.rels"),
                "word/media/a.rels": b"<svg/>",
            },
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
        "webp-backslash-target",
        "bmp-outside-pictures",
        "tiff-outside-pictures",
        "ico-outside-pictures",
        "jp2-outside-pictures",
        "svg-named-rels",
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
    with pytest.raises(image_check.Refused, match="one contiguous") as overlap:
        check(_overlapped(), 2 * MB)
    assert overlap.value.code == "office_unreadable"
    under = png_header(800, 600) + b"\0" * (2 * MB - 100)
    big = office({f"word/media/image{i}.png": under for i in range(130)})
    assert _refused(lambda: check(big, 2 * MB)) == "office_unreadable"


def test_office_check_refuses_anything_but_one_archive():
    """Security regression (Q348, review r2 B2): two archives in one file,
    whichever comes last, data before the archive, or an end record that
    miscounts the directory are refused, so no zip reader that falls back to
    another archive finds parts the check never read."""
    clean = office({"word/document.xml": b"<w:document/>"})
    hidden = office({"word/media/image1.emf": EMF})
    miscounted = bytearray(clean)
    end = miscounted.rindex(b"PK\x05\x06")
    struct.pack_into("<HH", miscounted, end + 8, 2, 2)
    for data in (
        hidden + clean,
        clean + hidden,
        b"MZ\x90\x00" + clean,
        bytes(miscounted),
    ):
        assert (
            _refused(lambda data=data: image_check.check_office(data, 2 * MB))
            == "office_unreadable"
        )
    image_check.check_office(clean, 2 * MB)


def _with_zip64(classic: bytes, twice: bool, edit) -> bytes:
    """A classic package with a ZIP64 end record and its locator before the
    end record, which ``edit`` then changes. With ``twice``, the record's
    extensible data holds a copy of the directory and a second fixed record
    naming it, which CPython reads (56 bytes before the locator) where Go
    reads the first (where the locator points)."""
    end = classic.rindex(b"PK\x05\x06")
    eocd = bytearray(classic[end:])
    on_disk, count, size, start = struct.unpack("<HHII", eocd[8:20])

    def fixed(length: int, at: int) -> bytes:
        return struct.pack(
            "<4sQHHIIQQQQ",
            b"PK\x06\x06",
            length,
            45,
            45,
            0,
            0,
            on_disk,
            count,
            size,
            at,
        )

    record = fixed(44, start)
    if twice:
        directory = classic[start:end]
        record = (
            fixed(44 + len(directory) + 56, start) + directory + fixed(44, end + 56)
        )
    locator = struct.pack("<4sIQI", b"PK\x06\x07", 0, end, 1)
    edit(eocd)
    return classic[:end] + record + locator + bytes(eocd)


def test_office_check_reads_the_end_record_every_reader_picks():
    """Security regression (Q348, review r3 B1): every zip reader (Go,
    CPython, zip 9) must pick the end record and directory the check reads.
    Refused: a second archive stored as the last part (zip 9 falls back to its
    end record), an end record after the one that ends the file (the readers
    take the last), bytes after the end record, a ZIP64 locator while no end
    record field is maxed out (CPython follows it anyway), the same with a
    65,535-byte directory (Go follows it too), and a ZIP64 record with
    extensible data (Go and CPython read it at different places). A ZIP64
    package laid out the one way passes."""
    document = b"<w:document/>"
    clean = office({"word/document.xml": document})
    end = clean.rindex(b"PK\x05\x06")

    nested = io.BytesIO()
    with zipfile.ZipFile(nested, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("word/document.xml", document)
        archive.writestr(
            "word/embeddings/package.bin",
            office({"word/media/image1.emf": EMF}),
            zipfile.ZIP_STORED,
        )

    trailing = bytearray(clean)
    struct.pack_into("<H", trailing, end + 20, 22 + 1)
    trailing += clean[end:] + b"x"

    def grow(by: int):
        def edit(eocd: bytearray) -> None:
            size = struct.unpack_from("<I", eocd, 12)[0]
            struct.pack_into("<I", eocd, 12, size + by)

        return edit

    # A directory that, with the ZIP64 record and locator it covers, is
    # 65,535 bytes: one entry's comment fills it.
    directory = end - struct.unpack_from("<I", clean, end + 16)[0]
    info = zipfile.ZipInfo("word/document.xml")
    info.compress_type = zipfile.ZIP_DEFLATED
    info.comment = b"c" * (0xFFFF - 76 - directory)
    long = io.BytesIO()
    with zipfile.ZipFile(long, "w") as archive:
        archive.writestr(info, document)
    sized = _with_zip64(long.getvalue(), False, grow(76))
    assert struct.unpack_from("<I", sized, len(sized) - 22 + 12)[0] == 0xFFFF

    def maxed(eocd: bytearray) -> None:
        struct.pack_into("<I", eocd, 16, 0xFFFFFFFF)

    for data in (
        nested.getvalue(),
        bytes(trailing),
        clean + b"junk",
        _with_zip64(clean, False, grow(76)),
        sized,
        _with_zip64(clean, True, maxed),
    ):
        assert (
            _refused(lambda data=data: image_check.check_office(data, 2 * MB))
            == "office_unreadable"
        )
    image_check.check_office(_with_zip64(clean, False, maxed), 2 * MB)


def test_relationships_are_read_within_the_budget_left(monkeypatch):
    """Review r2 S2: each relationships part is read only a byte past what is
    left of the budget, so the check inflates at most that much before it
    refuses, never a whole budget per part."""
    budget = 64 << 10
    monkeypatch.setattr(image_check, "MAX_INFLATED", budget)
    inflated = []
    original = zipfile.ZipExtFile.read

    def counted(self, n=-1):
        body = original(self, n)
        inflated.append(len(body))
        return body

    monkeypatch.setattr(zipfile.ZipExtFile, "read", counted)
    padding = b" " * (40 << 10)
    big = office(
        {
            "word/_rels/document.xml.rels": b"<Relationships>" + padding,
            "ppt/_rels/presentation.xml.rels": b"<Relationships>" + padding,
        }
    )
    assert (
        _refused(lambda: image_check.check_office(big, 2 * MB)) == "office_unreadable"
    )
    assert sum(inflated) <= budget + 1
