"""The import worker's header check before an import is stored (Epo
2026-10-24, Q285, Q286, Q344, Q348), the twin of the gateway's
server/internal/imagecheck: sizes read from headers only, never decoding
pixels, so it runs in the worker itself. A refusal is final and names its
code.

- An image source is a PNG, JPEG, GIF or WebP of at most
  SOURCE_IMAGE_MAX_PIXELS.
- An Office package is one contiguous zip archive, read whole within
  MAX_ENTRIES entries and MAX_INFLATED bytes inflated, part by part by
  content: no EMF, WMF, SVG or image format but PNG, JPEG or GIF anywhere, a
  PNG, JPEG or GIF within the payer's image cap and IMAGE_MAX_SIDE on each
  side, and a picture part holds nothing else.
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
_HEAD_BYTES = 4096
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


# The segments Go's decoder reads before a frame (DHT, DQT, DRI, APPn, COM);
# it refuses any other marker there, and so does this check (review r3 N1).
_JPEG_BEFORE_FRAME = {0xC4, 0xDB, 0xDD, 0xFE, *range(0xE0, 0xF0)}


def _jpeg(data: bytes) -> tuple[int, int]:
    at = 2
    while at + 1 < len(data):
        if data[at] != 0xFF:
            raise Unreadable("jpeg marker expected")
        # Any number of fill bytes may precede a marker.
        while at + 1 < len(data) and data[at + 1] == 0xFF:
            at += 1
        marker = data[at + 1]
        # Restart markers and a stuffed 0x00 carry no length; Go passes them.
        if marker == 0x00 or 0xD0 <= marker <= 0xD7:
            at += 2
            continue
        length = struct.unpack(">H", data[at + 2 : at + 4])[0]
        # Baseline, extended and progressive frames, the ones Go reads.
        if marker in (0xC0, 0xC1, 0xC2):
            height, width = struct.unpack(">HH", data[at + 5 : at + 9])
            return width, height
        if marker not in _JPEG_BEFORE_FRAME:
            raise Unreadable(f"jpeg marker {marker:#x} not read before a frame")
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


def size(data: bytes) -> tuple[str, int, int] | None:
    """An image's format, width and height from its header (PNG, JPEG, GIF or
    WebP); None for a format it does not measure. Raises Unreadable for a
    known one whose header does not parse."""
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


def other_image(head: bytes) -> bool:
    """An image format a browser may decode that an Office picture may not
    be (Q344), by signature: WebP, AVIF, HEIF, BMP, TIFF, ICO or CUR, JPEG XR
    and JPEG 2000."""
    if image_format(head) in ("webp", "avif", "heic"):
        return True
    bitmap = (
        head[:2] == b"BM"
        and len(head) >= 18
        and struct.unpack("<I", head[14:18])[0] in (12, 40, 52, 56, 64, 108, 124)
    )
    icon = (
        head[:4] in (b"\x00\x00\x01\x00", b"\x00\x00\x02\x00")
        and len(head) >= 6
        and struct.unpack("<H", head[4:6])[0] > 0
    )
    return (
        bitmap
        or icon
        or head.startswith(
            (
                b"II*\x00",
                b"MM\x00*",
                b"II\xbc\x01",
                b"\x00\x00\x00\x0cjP  \r\n\x87\n",
                b"\xff\x4f\xff\x51",
            )
        )
    )


# How far from the end of a file zip 9, the collaboration server's reader,
# looks for end records (64 KiB and 26 bytes); Go and CPython look within it.
_END_WINDOW = (1 << 16) + 26


def _end_record(data: bytes) -> tuple[int, int, int, int]:
    """The package's entries, where its central directory starts and how
    long it is, and where its end record (ZIP64 where present) starts, on a
    layout where every zip reader (Go, CPython, zip 9) picks that record and
    directory (review r3 B1). Each takes the last end record signature, zip 9
    falling back to earlier ones, so it must be the only one in _END_WINDOW
    and its comment must end the file. zip 9 follows a ZIP64 record only when
    a classic field is maxed out, Go also when the directory is 0xffff bytes
    long, CPython whenever a locator precedes the end record: a locator must
    be there exactly when a field is maxed out."""
    floor = max(0, len(data) - _END_WINDOW)
    at = data.rfind(b"PK\x05\x06", floor)
    if at < 0 or at + 22 > len(data):
        raise _unreadable("the file is not a zip package")
    comment = struct.unpack("<H", data[at + 20 : at + 22])[0]
    if data.count(b"PK\x05\x06", floor) != 1 or at + 22 + comment != len(data):
        raise _unreadable("the package is not one contiguous zip archive")
    entries, dir_size, dir_start = struct.unpack("<xxxxxxxxxxHII", data[at : at + 20])
    located = at >= 20 and data[at - 20 : at - 16] == b"PK\x06\x07"
    maxed = entries == 0xFFFF or 0xFFFFFFFF in (dir_size, dir_start)
    if maxed and located:
        return _zip64_end(data, at)
    if maxed or located:
        raise _unreadable(
            "a ZIP64 record without a maxed-out end record field, or the reverse"
        )
    return entries, dir_start, dir_size, at


def _zip64_end(data: bytes, eocd: int) -> tuple[int, int, int, int]:
    """The ZIP64 end record the locator just before ``eocd`` names. Go reads
    it where the locator points and CPython 56 bytes before the locator, so
    it must sit there, hold no extensible data, and the locator must name
    one disk."""
    _, disk, record_at, disks = struct.unpack("<IIQI", data[eocd - 20 : eocd])
    record = data[record_at : record_at + 56]
    if (
        eocd < 20 + 56
        or record_at != eocd - 20 - 56
        or (disk, disks) != (0, 1)
        or record[:4] != b"PK\x06\x06"
        or struct.unpack("<Q", record[4:12])[0] != 56 - 12
    ):
        raise _unreadable("the ZIP64 end record is not where every reader looks")
    entries, dir_size, dir_start = struct.unpack("<QQQ", record[32:56])
    return entries, dir_start, dir_size, record_at


def _contiguous(data: bytes, infos: list[zipfile.ZipInfo], end: tuple) -> bool:
    """Whether the package is one archive as Office writers lay it out
    (Q348): local entries one after another from byte 0, each followed only
    by its data and an optional data descriptor, then the central directory,
    ending where the end record starts, which counts the entries the
    directory holds. A second archive before or after it, data between
    entries, or two directory records for one entry make it False, so no zip
    reader can find other parts than the ones checked here."""
    entries, dir_start, dir_size, record_start = end
    if len(infos) != entries or dir_start + dir_size != record_start:
        return False
    by_offset = {info.header_offset: info for info in infos}
    if len(by_offset) != len(infos):
        return False
    at = 0
    for _ in infos:
        info = by_offset.get(at)
        local = data[at : at + 30]
        if info is None or len(local) < 30 or local[:4] != b"PK\x03\x04":
            return False
        name_len, extra_len = struct.unpack("<HH", local[26:30])
        at += 30 + name_len + extra_len + info.compress_size
        if info.flag_bits & 0x8:
            lengths = (16, 24) if data[at : at + 4] == b"PK\x07\x08" else (12, 20)
            following = [
                at + length
                for length in lengths
                if at + length == dir_start
                or data[at + length : at + length + 4] == b"PK\x03\x04"
            ]
            if not following:
                return False
            at = following[0]
    return at == dir_start


def check_office(data: bytes, image_max_bytes: int) -> None:
    """Refuses an Office package the check cannot read whole (not one
    contiguous zip archive, over MAX_ENTRIES, a part that does not open, or
    past MAX_INFLATED read in all), and, by content, an EMF, WMF or SVG
    picture, any image format but PNG, JPEG or GIF, a PNG, JPEG or GIF over
    ``image_max_bytes`` or IMAGE_MAX_SIDE on a side, and a picture part
    holding anything else."""
    end = _end_record(data)
    # From the end record, before the directory is loaded.
    if end[0] > MAX_ENTRIES:
        raise _unreadable(f"the package has more than {MAX_ENTRIES} entries")
    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
        infos = archive.infolist()
    except (zipfile.BadZipFile, ValueError) as exc:
        raise _unreadable("the file is not a zip package") from exc
    if not _contiguous(data, infos, end):
        raise _unreadable("the package is not one contiguous zip archive")
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
            # Never past the budget left: a byte past it refuses.
            body = read(info, MAX_INFLATED - inflated + 1)
            rels[info.filename] = body.decode("utf-8", "replace")
    pictures = picture_parts([info.filename for info in infos], rels)
    for info in infos:
        if info.is_dir():
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
        elif info.filename in pictures or other_image(head):
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
