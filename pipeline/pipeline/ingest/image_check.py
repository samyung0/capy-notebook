"""The import worker's header check before an import is stored (Epo
2026-10-24, Q285, Q286, Q344, Q348), the twin of the gateway's
server/internal/imagecheck: sizes read from headers only, never decoding
pixels, so it runs in the worker itself. A refusal is final and names its
code.

- An image source is a PNG, JPEG, GIF or WebP of at most
  SOURCE_IMAGE_MAX_PIXELS.
- An Office package is read whole within MAX_ENTRIES entries, MAX_INFLATED
  bytes inflated and no overlapping entries, part by part by content: no
  EMF, WMF or SVG anywhere, a PNG, JPEG or GIF within the payer's image cap
  and IMAGE_MAX_SIDE on each side, and a picture part holds nothing else.
"""

from __future__ import annotations

import io
import struct
import zipfile

from ..generated.limits import IMAGE_MAX_SIDE, SOURCE_IMAGE_MAX_PIXELS
from .images import MAX_ENTRIES, MAX_EXPANDED, is_svg, is_vector, picture_parts

MAX_INFLATED = MAX_EXPANDED
# A JPEG's frame header follows its metadata segments, each at most 64 KiB.
_HEADER_BYTES = 1 << 20
# A part that is no picture is read this far.
_HEAD_BYTES = 512
_HEIF_BRANDS = {b"heic", b"heix", b"heim", b"heis", b"hevc", b"hevx", b"mif1", b"msf1"}
SOURCE_FORMATS = {"png", "jpeg", "gif", "webp"}
OFFICE_FORMATS = {"png", "jpeg", "gif"}


class Refused(ValueError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class Unreadable(ValueError):
    """A known format whose header gives no size."""


def image_format(head: bytes) -> str:
    """png, jpeg, gif, webp, avif, heic (any other HEIF brand) or ""."""
    if head[:8] == b"\x89PNG\r\n\x1a\n":
        return "png"
    if head[:3] == b"\xff\xd8\xff":
        return "jpeg"
    if head[:6] in (b"GIF87a", b"GIF89a"):
        return "gif"
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "webp"
    if head[4:8] == b"ftyp":
        if head[8:12] in (b"avif", b"avis"):
            return "avif"
        if head[8:12] in _HEIF_BRANDS:
            return "heic"
    return ""


def _jpeg(data: bytes) -> tuple[int, int]:
    at = 2
    while at + 1 < len(data):
        if data[at] != 0xFF:
            raise Unreadable("jpeg marker expected")
        # Any number of fill bytes may precede a marker.
        while at + 1 < len(data) and data[at + 1] == 0xFF:
            at += 1
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


def _gif(data: bytes) -> tuple[int, int]:
    """The logical screen, widened to the first frame, which may claim more."""
    width, height, flags = struct.unpack("<HHB", data[6:11])
    at = 13 + (3 << ((flags & 7) + 1) if flags & 0x80 else 0)
    while at < len(data):
        kind = data[at]
        if kind == 0x2C:
            left, top, frame_w, frame_h = struct.unpack("<HHHH", data[at + 1 : at + 9])
            return max(width, left + frame_w), max(height, top + frame_h)
        if kind != 0x21:
            break
        at += 2
        while data[at]:
            at += data[at] + 1
        at += 1
    raise Unreadable("gif frame not found")


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


def size(data: bytes) -> tuple[str, int, int] | None:
    """An image's format, width and height from its header; None for a format
    it does not measure. Raises Unreadable for a known one whose header does
    not parse."""
    head = data[:_HEADER_BYTES]
    found = image_format(head)
    try:
        if found == "png":
            width, height = struct.unpack(">II", head[16:24])
        elif found == "jpeg":
            width, height = _jpeg(head)
        elif found == "gif":
            width, height = _gif(head)
        elif found == "webp":
            width, height = _webp(head)
        elif found in ("avif", "heic"):
            width, height = _heif(head)
        else:
            return None
    except (struct.error, IndexError) as exc:
        raise Unreadable("image header truncated") from exc
    if width <= 0 or height <= 0:
        raise Unreadable("image size is not positive")
    return found, width, height


def check_source(data: bytes) -> None:
    """Refuses an image source over SOURCE_IMAGE_MAX_PIXELS, or anything but a
    PNG, JPEG, GIF or WebP whose header gives its size (Q344)."""
    try:
        found = size(data)
    except Unreadable as exc:
        raise Refused("image_unreadable", str(exc)) from exc
    if found is None or found[0] not in SOURCE_FORMATS:
        raise Refused("image_unreadable", "image is not a PNG, JPEG, GIF or WebP")
    if found[1] * found[2] > SOURCE_IMAGE_MAX_PIXELS:
        raise Refused(
            "source_image_too_large",
            f"image is {found[1]}x{found[2]}, over {SOURCE_IMAGE_MAX_PIXELS} pixels",
        )


def _unreadable(message: str) -> Refused:
    return Refused("office_unreadable", message)


def _overlapping(data: bytes, infos: list[zipfile.ZipInfo]) -> bool:
    """Whether two entries' data share bytes: a bomb points many directory
    records at one compressed stream."""
    spans = []
    for info in infos:
        local = data[info.header_offset : info.header_offset + 30]
        if len(local) < 30 or local[:4] != b"PK\x03\x04":
            raise _unreadable(f"{info.filename} cannot be read")
        name_len, extra_len = struct.unpack("<HH", local[26:30])
        start = info.header_offset + 30 + name_len + extra_len
        if info.compress_size:
            spans.append((start, start + info.compress_size))
    spans.sort()
    return any(spans[i][0] < spans[i - 1][1] for i in range(1, len(spans)))


def check_office(data: bytes, image_max_bytes: int) -> None:
    """Refuses an Office package the check cannot read whole (not a zip, over
    MAX_ENTRIES, overlapping entries, a part that does not open, or past
    MAX_INFLATED read in all), and, by content, an EMF, WMF or SVG picture, a
    PNG, JPEG or GIF over ``image_max_bytes`` or IMAGE_MAX_SIDE on a side,
    and a picture part holding anything else."""
    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
        infos = archive.infolist()
    except (zipfile.BadZipFile, ValueError) as exc:
        raise _unreadable("the file is not a zip package") from exc
    if len(infos) > MAX_ENTRIES:
        raise _unreadable(f"the package has more than {MAX_ENTRIES} entries")
    if _overlapping(data, infos):
        raise _unreadable("the package has overlapping entries")
    inflated = 0

    def read(info: zipfile.ZipInfo, limit: int) -> bytes:
        nonlocal inflated
        try:
            with archive.open(info) as part:
                body = part.read(limit)
        except (
            zipfile.BadZipFile,
            NotImplementedError,
            RuntimeError,
            OSError,
            EOFError,
        ) as exc:
            raise _unreadable(f"{info.filename} cannot be read") from exc
        inflated += len(body)
        if inflated > MAX_INFLATED:
            raise _unreadable(f"the package inflates past {MAX_INFLATED} bytes")
        return body

    rels = {}
    for info in infos:
        if not info.is_dir() and info.filename.endswith(".rels"):
            rels[info.filename] = read(info, MAX_INFLATED).decode("utf-8", "replace")
    pictures = picture_parts([info.filename for info in infos], rels)
    for info in infos:
        if info.is_dir() or info.filename.endswith(".rels"):
            continue
        head = read(info, _HEAD_BYTES)
        found = image_format(head)
        if is_vector(head, info.filename):
            raise Refused(
                "office_vector_image", f"{info.filename} is an EMF or WMF picture"
            )
        if is_svg(head, info.filename):
            raise Refused(
                "office_image_unsupported", f"{info.filename} is an SVG picture"
            )
        if found in OFFICE_FORMATS:
            # Read again from its start, up to a byte past the cap.
            _check_raster(
                info.filename, read(info, image_max_bytes + 1), image_max_bytes
            )
        elif info.filename in pictures:
            raise Refused(
                "office_image_unsupported",
                f"{info.filename} is not a PNG, JPEG or GIF picture",
            )


def _check_raster(name: str, body: bytes, image_max_bytes: int) -> None:
    try:
        found = size(body)
    except Unreadable:
        found = None
    if found is None:
        raise Refused("office_image_unsupported", f"{name} has no readable size")
    if len(body) > image_max_bytes or max(found[1:]) > IMAGE_MAX_SIDE:
        raise Refused(
            "office_image_too_large",
            f"{name} is over {image_max_bytes} bytes or {IMAGE_MAX_SIDE} px on a side",
        )
