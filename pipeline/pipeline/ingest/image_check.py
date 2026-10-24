"""The import worker's header check before an import is stored (Epo
2026-10-24, Q285, Q286), the twin of the gateway's server/internal/imagecheck:
sizes read from headers only, never decoding pixels, so it runs in the worker
itself. A refusal is final and names its code.

- An Office file may hold no EMF or WMF picture, and no raster picture over
  the payer's image cap or IMAGE_MAX_SIDE on its long side.
- An image source may hold at most SOURCE_IMAGE_MAX_PIXELS.
"""

from __future__ import annotations

import io
import struct
import zipfile

from ..generated.limits import IMAGE_MAX_SIDE, SOURCE_IMAGE_MAX_PIXELS
from .images import picture_kind

# A JPEG's frame header follows its metadata segments, each at most 64 KiB.
_HEADER_BYTES = 1 << 20
_HEIF_BRANDS = {
    b"heic",
    b"heix",
    b"heim",
    b"heis",
    b"hevc",
    b"hevx",
    b"mif1",
    b"msf1",
    b"avif",
    b"avis",
}
_JP2 = b"\x00\x00\x00\x0cjP  \r\n\x87\n"


class Refused(ValueError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class Unreadable(ValueError):
    """A known raster format whose header gives no size."""


def _jpeg(data: bytes) -> tuple[int, int]:
    at = 2
    while at + 9 < len(data):
        if data[at] != 0xFF:
            raise Unreadable("jpeg marker expected")
        marker = data[at + 1]
        if marker in (0xD8, 0x01) or 0xD0 <= marker <= 0xD7:
            at += 2
            continue
        length = struct.unpack(">H", data[at + 2 : at + 4])[0]
        if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
            height, width = struct.unpack(">HH", data[at + 5 : at + 9])
            return width, height
        at += 2 + length
    raise Unreadable("jpeg frame header not found")


def _tiff(data: bytes) -> tuple[int, int]:
    order = "<" if data[:2] == b"II" else ">"
    (offset,) = struct.unpack(order + "I", data[4:8])
    (count,) = struct.unpack(order + "H", data[offset : offset + 2])
    found: dict[int, int] = {}
    for index in range(count):
        entry = data[offset + 2 + index * 12 : offset + 14 + index * 12]
        tag, kind = struct.unpack(order + "HH", entry[:4])
        if tag in (256, 257):
            fmt = "H" if kind == 3 else "I"
            found[tag] = struct.unpack(
                order + fmt, entry[8 : 8 + struct.calcsize(fmt)]
            )[0]
    if 256 not in found or 257 not in found:
        raise Unreadable("tiff size tags missing")
    return found[256], found[257]


def _webp(data: bytes) -> tuple[int, int]:
    chunk = data[12:16]
    if chunk == b"VP8X":
        width = int.from_bytes(data[24:27], "little") + 1
        height = int.from_bytes(data[27:30], "little") + 1
        return width, height
    if chunk == b"VP8L":
        bits = int.from_bytes(data[21:25], "little")
        return (bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1
    if chunk == b"VP8 ":
        width, height = struct.unpack("<HH", data[26:30])
        return width & 0x3FFF, height & 0x3FFF
    raise Unreadable("webp chunk unknown")


def _heif(data: bytes) -> tuple[int, int]:
    best = (0, 0)

    def walk(body: bytes, depth: int) -> None:
        nonlocal best
        while len(body) >= 8 and depth < 8:
            size, kind = struct.unpack(">I4s", body[:8])
            header = 8
            if size == 1 and len(body) >= 16:
                size, header = struct.unpack(">Q", body[8:16])[0], 16
            elif size == 0:
                size = len(body)
            if size < header or size > len(body):
                return
            box = body[header:size]
            if kind == b"meta" and len(box) >= 4:
                walk(box[4:], depth + 1)
            elif kind in (b"iprp", b"ipco"):
                walk(box, depth + 1)
            elif kind == b"ispe" and len(box) >= 12:
                width, height = struct.unpack(">II", box[4:12])
                if width * height > best[0] * best[1]:
                    best = (width, height)
            body = body[size:]

    walk(data, 0)
    if not all(best):
        raise Unreadable("heif extents missing")
    return best


def _jp2(data: bytes) -> tuple[int, int]:
    at = data.find(b"ihdr")
    if at >= 4 and len(data) >= at + 12:
        height, width = struct.unpack(">II", data[at + 4 : at + 12])
        return width, height
    code = data.find(b"\xff\x4f\xff\x51")
    if code < 0:
        raise Unreadable("jpeg 2000 size missing")
    xsiz, ysiz, xoff, yoff = struct.unpack(">IIII", data[code + 8 : code + 24])
    return xsiz - xoff, ysiz - yoff


def size(data: bytes) -> tuple[int, int] | None:
    """An image's width and height from its header; None for a format it
    does not know (SVG, anything else). Raises Unreadable for a known one
    whose header does not parse."""
    head = data[:_HEADER_BYTES]
    try:
        if head[:8] == b"\x89PNG\r\n\x1a\n":
            width, height = struct.unpack(">II", head[16:24])
        elif head[:3] == b"\xff\xd8\xff":
            width, height = _jpeg(head)
        elif head[:6] in (b"GIF87a", b"GIF89a"):
            width, height = struct.unpack("<HH", head[6:10])
        elif head[:2] == b"BM":
            width, height = struct.unpack("<ii", head[18:26])
            height = abs(height)
        elif head[:4] in (b"II*\x00", b"MM\x00*"):
            width, height = _tiff(head)
        elif head[:4] == b"RIFF" and head[8:12] == b"WEBP":
            width, height = _webp(head)
        elif head[4:8] == b"ftyp" and head[8:12] in _HEIF_BRANDS:
            width, height = _heif(head)
        elif head[:12] == _JP2 or head[:4] == b"\xff\x4f\xff\x51":
            width, height = _jp2(head)
        else:
            return None
    except (struct.error, IndexError) as exc:
        raise Unreadable("image header truncated") from exc
    if width <= 0 or height <= 0:
        raise Unreadable("image size is not positive")
    return width, height


def check_source(data: bytes) -> None:
    """Refuses an image source over SOURCE_IMAGE_MAX_PIXELS, or a raster one
    whose header gives no size."""
    try:
        found = size(data)
    except Unreadable as exc:
        raise Refused("image_unreadable", str(exc)) from exc
    if found and found[0] * found[1] > SOURCE_IMAGE_MAX_PIXELS:
        raise Refused(
            "source_image_too_large",
            f"image is {found[0]}x{found[1]}, over {SOURCE_IMAGE_MAX_PIXELS} pixels",
        )


def check_office(data: bytes, image_max_bytes: int) -> None:
    """Refuses an Office file that holds an EMF or WMF picture, or a raster
    picture over ``image_max_bytes`` or IMAGE_MAX_SIDE. A file the check
    cannot open as a zip passes: the parser decides."""
    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile:
        return
    for info in archive.infolist():
        if info.is_dir() or info.filename.lower().endswith((".xml", ".rels", ".vml")):
            continue
        try:
            with archive.open(info) as part:
                head = part.read(_HEADER_BYTES)
                kind = picture_kind(head, info.filename)
                rest = (
                    part.read(image_max_bytes + 1 - min(len(head), image_max_bytes + 1))
                    if kind == "raster"
                    else b""
                )
        except (zipfile.BadZipFile, NotImplementedError, RuntimeError):
            # A part the check cannot read (an unknown method, encrypted):
            # the parser decides.
            continue
        if kind == "vector":
            raise Refused(
                "office_vector_image", f"{info.filename} is an EMF or WMF picture"
            )
        if kind != "raster":
            continue
        total = len(head) + len(rest)
        try:
            found = size(head)
        except Unreadable:
            found = None
        if total > image_max_bytes or found is None or max(found) > IMAGE_MAX_SIDE:
            raise Refused(
                "office_image_too_large",
                f"{info.filename} is over {image_max_bytes} bytes or {IMAGE_MAX_SIDE} px, or has no readable size",
            )
