"""The import worker's image rules (Epo 2026-10-24), the twin of the
browser's src/lib/fitImage.ts and src/lib/officeImages.ts: both must agree on
e2e/fixtures/files/images/manifest.json (output format and size, not bytes).

- A picture inside an imported DOCX/PPTX/XLSX keeps both sides within
  IMAGE_MAX_SIDE and becomes JPEG at quality 85 (a photo) or PNG (transparent,
  or a flat graphic of at most 256 colours); the original stays when it needs
  no resize, is PNG/JPEG/GIF, fits the cap and is not larger than the result.
  A result over the cap is shrunk (a lossy one at 2,000 px with falling
  quality, a transparent PNG at 2,000, 1,400 and 1,000 px). Pictures nothing
  can show (EMF, WMF, SVG, other formats, ones that do not decode) are
  removed with the drawing or object that shows them (Q337).
- An imported image source keeps at most SOURCE_IMAGE_MAX_PIXELS: a PNG,
  JPEG, GIF or WebP within that stays as it is, anything else is re-saved
  with the same encodes (Q344).

``compress`` imports Pillow and runs only inside the sandboxed decode helper
(decode.py), one picture per call. ``compress_office`` rewrites the package
in the worker, which imports no decoder, handing each picture to the helper.
"""

from __future__ import annotations

import io
import math
import posixpath
import re
import warnings
import zipfile
from collections.abc import Callable
from urllib.parse import unquote

from ..generated.limits import IMAGE_MAX_SIDE

QUALITY = 85
SHRINK_SIDE = 2000
QUALITIES = (85, 80, 70, 60, 50, 40)
PNG_SIDES = (2000, 1400, 1000)
FLAT_COLOURS = 256
# The archive the import worker opens at most, as the browser does; a larger
# one is stored as it is and the header check decides.
MAX_ENTRIES = 4096
MAX_EXPANDED = 256 << 20
OFFICE_FORMATS = {"PNG", "JPEG", "GIF"}
SOURCE_FORMATS = {"PNG", "JPEG", "GIF", "WEBP"}


class TooLarge(Exception):
    """No size the image can be shrunk to fits the cap."""


class TooManyPixels(TooLarge):
    """An animated GIF source past SOURCE_IMAGE_MAX_PIXELS: a canvas keeps one
    frame, so it cannot be shrunk."""


def _round(value: float) -> int:
    """JavaScript's Math.round for a positive number."""
    return math.floor(value + 0.5)


def fit_size(width: int, height: int, side: int) -> tuple[int, int]:
    scale = min(1, side / max(width, height))
    return max(1, _round(width * scale)), max(1, _round(height * scale))


def fit_area(width: int, height: int, pixels: int) -> tuple[int, int]:
    scale = min(1, math.sqrt(pixels / (width * height)))
    return max(1, math.floor(width * scale)), max(1, math.floor(height * scale))


def _encode(image, kind: str, quality: int = QUALITY) -> bytes:
    buffer = io.BytesIO()
    if kind == "png":
        image.save(buffer, "PNG", optimize=True)
    else:
        image.convert("RGB").save(buffer, "JPEG", quality=quality, optimize=True)
    return buffer.getvalue()


def compress(
    data: bytes, max_bytes: int, max_decoded: int, *, max_pixels: int = 0
) -> tuple[bytes, str] | None:
    """The image to store as (bytes, "png" or "jpeg"), or None to keep the
    original. Raises TooLarge when nothing fits, and Pillow's errors (or
    ValueError past ``max_decoded`` pixels) when it cannot decode."""
    from PIL import Image, ImageOps

    with warnings.catch_warnings():
        warnings.simplefilter("error", Image.DecompressionBombWarning)
        with Image.open(io.BytesIO(data)) as source:
            width, height = source.size
            if width * height <= 0 or width * height > max_decoded:
                raise ValueError("image exceeds the decoded-pixel limit")
            turned = source.getexif().get(0x0112, 1) in (5, 6, 7, 8)
            if turned:
                width, height = height, width  # Browsers draw it rotated.
            target = (
                fit_area(width, height, max_pixels)
                if max_pixels
                else fit_size(width, height, IMAGE_MAX_SIDE)
            )
            resized = target != (width, height)
            if max_pixels and not resized and source.format in SOURCE_FORMATS:
                return None
            if source.format == "GIF" and getattr(source, "is_animated", False):
                if not resized and len(data) <= max_bytes:
                    return None
                raise TooManyPixels if max_pixels else TooLarge
            original = source.format
            # Decoded at a reduced scale where the format allows (JPEG).
            source.draft("RGB", target[::-1] if turned else target)
            image = ImageOps.exif_transpose(source).convert("RGBA")
    sample = image if not resized else image.resize(target, Image.Resampling.NEAREST)
    alpha = sample.getchannel("A").getextrema()[0] < 255
    flat = not alpha and sample.convert("RGB").getcolors(FLAT_COLOURS) is not None
    full = image if not resized else image.resize(target, Image.Resampling.LANCZOS)
    kind = "png" if alpha or flat else "jpeg"
    encoded = _encode(full, kind)
    keeps = original in (SOURCE_FORMATS if max_pixels else OFFICE_FORMATS)
    if not resized and keeps and len(data) <= max_bytes and len(encoded) >= len(data):
        return None
    if len(encoded) <= max_bytes:
        return encoded, kind
    long_side = max(target)
    if alpha:
        for side in PNG_SIDES:
            if side >= long_side:
                continue
            encoded = _encode(
                image.resize(fit_size(width, height, side), Image.Resampling.LANCZOS),
                "png",
            )
            if len(encoded) <= max_bytes:
                return encoded, "png"
        raise TooLarge
    small = (
        image.resize(fit_size(width, height, SHRINK_SIDE), Image.Resampling.LANCZOS)
        if long_side > SHRINK_SIDE
        else full
    )
    for quality in QUALITIES:
        encoded = _encode(small, "jpeg", quality)
        if len(encoded) <= max_bytes:
            return encoded, "jpeg"
    raise TooLarge


# ------------------------------------------------------------ Office files

# The picture formats the compressor tries (Pillow reads them); any other
# picture is removed (Q337).
_RASTER_SIGNATURES = (
    b"\x89PNG",
    b"\xff\xd8\xff",
    b"GIF8",
    b"BM",
    b"II*\x00",
    b"MM\x00*",
)
_SVG_ROOT = re.compile(
    rb"^(?:\s|<\?[^>]*\?>|<!--.*?-->|<!DOCTYPE[^>]*>)*<svg[\s>/]", re.DOTALL
)


def is_vector(data: bytes, path: str) -> bool:
    """An EMF or WMF picture, by name or signature."""
    return (
        path.rsplit(".", 1)[-1].lower() in {"emf", "wmf", "emz", "wmz"}
        or (data[:4] == b"\x01\x00\x00\x00" and data[40:44] == b" EMF")
        or data[:4] == b"\xd7\xcd\xc6\x9a"
        or (data[:2] in (b"\x01\x00", b"\x02\x00") and data[2:4] == b"\x09\x00")
    )


def is_svg(data: bytes, path: str) -> bool:
    """An SVG picture, by name or by its root element."""
    if path.rsplit(".", 1)[-1].lower() in {"svg", "svgz"}:
        return True
    return _SVG_ROOT.match(data.removeprefix(b"\xef\xbb\xbf")) is not None


def picture_kind(data: bytes, path: str) -> str | None:
    """ "vector" (EMF or WMF), "svg", "raster" (a format the compressor
    tries) or None (anything else)."""
    if is_vector(data, path):
        return "vector"
    if is_svg(data, path):
        return "svg"
    if data.startswith(_RASTER_SIGNATURES) or (
        data[:4] == b"RIFF" and data[8:12] == b"WEBP"
    ):
        return "raster"
    return None


def resolve_target(source_dir: str, target: str) -> str:
    decoded = unquote(target)
    joined = decoded if decoded.startswith("/") else source_dir + decoded
    parts: list[str] = []
    for segment in joined.split("/"):
        if segment == "..":
            if parts:
                parts.pop()
        elif segment and segment != ".":
            parts.append(segment)
    return "/".join(parts)


_RELATIONSHIP = re.compile(r"<Relationship\b[^>]*>")
_MEDIA = re.compile(r"^(word|ppt|xl)/media/")
# The relationship types whose targets are pictures: images (pictures, fills,
# object previews, SVG) and HD Photo originals; audio and video stay media.
_PICTURE_TYPES = ("/image", "/hdphoto")


def _attribute(element: str, name: str) -> str:
    match = re.search(rf"\s{name}\s*=\s*(?:\"([^\"]*)\"|'([^']*)')", element)
    return (
        (match.group(1) if match.group(1) is not None else match.group(2))
        if match
        else ""
    )


def _source_of(rels: str) -> str:
    folder, base = posixpath.split(rels)
    return posixpath.join(
        re.sub(r"_rels$", "", folder), re.sub(r"\.rels$", "", base)
    ).lstrip("/")


def _relationships(rels: str, xml: str) -> list[dict]:
    source_dir = posixpath.dirname(_source_of(rels))
    source_dir = source_dir + "/" if source_dir else ""
    out = []
    for match in _RELATIONSHIP.finditer(xml):
        element = match.group(0)
        target = _attribute(element, "Target")
        out.append(
            {
                "element": element,
                "id": _attribute(element, "Id"),
                "part": None
                if _attribute(element, "TargetMode") == "External"
                else resolve_target(source_dir, target),
                "target": target,
                "type": _attribute(element, "Type"),
            }
        )
    return out


def picture_parts(paths: list[str], rels: dict[str, str]) -> set[str]:
    """The parts a package shows as pictures: an image relationship's
    targets, and media parts no other relationship targets. ``rels`` maps
    each relationships part to its XML."""
    pictures: set[str] = set()
    other: set[str] = set()
    for path, xml in rels.items():
        for rel in _relationships(path, xml):
            if not rel["part"]:
                continue
            if rel["type"].endswith(_PICTURE_TYPES):
                pictures.add(rel["part"])
            else:
                other.add(rel["part"])
    pictures.update(path for path in paths if _MEDIA.match(path) and path not in other)
    return pictures


def _containers(path: str) -> list[str] | None:
    if path.endswith(".vml"):
        return ["v:shape"]
    if not path.endswith(".xml"):
        return None
    if re.match(r"^(word|ppt|xl)/(charts|diagrams)/", path):
        return ["a:blipFill"]
    if path.startswith("word/"):
        return ["w:drawing", "w:pict", "w:object"]
    if path.startswith("ppt/"):
        return ["p:pic", "a:blipFill", "p:graphicFrame"]
    if path.startswith("xl/drawings/"):
        return ["xdr:twoCellAnchor", "xdr:oneCellAnchor", "xdr:absoluteAnchor"]
    if path.startswith("xl/worksheets/"):
        return ["oleObject"]
    return None


def _last(stack: list[str], name: str, before: int) -> int:
    for index in range(before - 1, -1, -1):
        if stack[index] == name:
            return index
    return -1


def _pick(names: list[str], stack: list[str]) -> int:
    # An SVG or HD Photo beside a picture's own blip: only the extension
    # holding it goes, and the picture stays.
    if stack[-1].endswith((":svgBlip", ":imgLayer")):
        for index in range(len(stack) - 2, -1, -1):
            if stack[index].endswith(":ext"):
                return index
    at = next((i for i in range(len(stack) - 1, -1, -1) if stack[i] in names), -1)
    if at < 0:
        return -1
    obj = _last(stack, "w:object", at)
    if obj >= 0 and "w:txbxContent" not in stack[obj:at]:
        at = obj
    ole = _last(stack, "p:oleObj", at)
    if stack[at] != "p:graphicFrame" and ole >= 0:
        at = _last(stack, "p:graphicFrame", ole)
        if at < 0:
            return -1
    if (
        stack[at] == "a:blipFill"
        and at >= 2
        and stack[at - 1] == "p:bgPr"
        and stack[at - 2] == "p:bg"
    ):
        at -= 2
    if (
        stack[at] in ("p:graphicFrame", "oleObject")
        and at >= 2
        and stack[at - 2] == "mc:AlternateContent"
        and stack[at - 1] in ("mc:Choice", "mc:Fallback")
    ):
        at -= 2
    return at


_REFERENCE = re.compile(
    r"\s[\w.-]+:(?:embed|link|id|pict|relid)\s*=\s*(?:\"([^\"]*)\"|'([^']*)')"
)
_MARKUP = re.compile(
    r"<!--.*?-->|<!\[CDATA\[.*?\]\]>|<[?!].*?>"
    r"|<(/?)([A-Za-z_][\w.:-]*)((?:[^>\"']|\"[^\"]*\"|'[^']*')*?)(/?)>",
    re.DOTALL,
)
_EMPTY_EXTENSIONS = re.compile(r"<([\w.-]+:)?extLst\b[^>]*>\s*</\1extLst>")


def _references(xml: str) -> list[str]:
    return [a if a is not None else b for a, b in _REFERENCE.findall(xml)]


def remove_pictures(path: str, xml: str, ids: set[str]) -> tuple[str, list[str], int]:
    """The part without each container that refers to one of ``ids``, the
    ids the removed elements referred to, and how many were removed where
    they show (none inside mc:Fallback, in a VML part, or an extension beside
    a picture that stays)."""
    names = _containers(path)
    if not names:
        return xml, [], 0
    stack: list[dict] = []
    spans: list[tuple[int, int, bool]] = []
    for match in _MARKUP.finditer(xml):
        close, name, attrs, self_closing = match.groups()
        if not name:
            continue
        start, end = match.span()
        if close:
            if stack:
                opened = stack.pop()
                if opened["remove"]:
                    spans.append((opened["start"], end, opened["counted"]))
            continue
        entry = {"counted": False, "name": name, "remove": False, "start": start}
        stack.append(entry)
        if any(ref in ids for ref in _references(attrs)):
            open_names = [opened["name"] for opened in stack]
            at = _pick(names, open_names)
            if at >= 0:
                stack[at]["remove"] = True
                stack[at]["counted"] = (
                    not path.endswith(".vml")
                    and not stack[at]["name"].endswith(":ext")
                    and not any(
                        opened["name"] == "mc:Fallback" for opened in stack[:at]
                    )
                )
        if self_closing:
            stack.pop()
            if entry["remove"]:
                spans.append((start, end, entry["counted"]))
    if not spans:
        return xml, [], 0
    spans.sort()
    out, cursor, count, refs = [], 0, 0, []
    for start, end, counted in spans:
        if start < cursor:
            continue
        out.append(xml[cursor:start])
        refs.extend(_references(xml[start:end]))
        count += counted
        cursor = end
    out.append(xml[cursor:])
    result = re.sub(r"<oleObjects>\s*</oleObjects>", "", "".join(out))
    return _EMPTY_EXTENSIONS.sub("", result), refs, count


def compress_office(
    data: bytes, picture: Callable[[bytes], tuple[bytes, str] | str]
) -> tuple[bytes | None, int]:
    """The package with its pictures compressed by ``picture`` (one picture's
    bytes to (bytes, "png" or "jpeg"), or "keep", "unreadable" or
    "too_large") and the pictures nothing can show removed with what shows
    them (Q337): EMF, WMF, SVG (its PNG fallback stays), formats the
    compressor does not try and pictures it cannot decode. Vector parts
    nothing refers to and EMF/WMF document thumbnails go too, uncounted, and
    an SVG part outside the pictures, counted when nothing showed it.
    Returns None when nothing changed, and how many pictures were removed
    where they show."""
    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
        infos = archive.infolist()
    except (zipfile.BadZipFile, ValueError):
        return None, 0
    if len(infos) > MAX_ENTRIES or sum(info.file_size for info in infos) > MAX_EXPANDED:
        return None, 0
    parts: dict[str, bytes] = {}
    try:
        for info in infos:
            parts[info.filename] = archive.read(info)
    except (zipfile.BadZipFile, ValueError, NotImplementedError, OSError):
        return None, 0
    stored = {
        info.filename for info in infos if info.compress_type == zipfile.ZIP_STORED
    }

    def text(path: str) -> str:
        return parts[path].decode("utf-8", "replace")

    rels = {
        path: _relationships(path, text(path))
        for path in parts
        if path.endswith(".rels")
    }

    def targeted(part: str) -> bool:
        return any(rel["part"] == part for listed in rels.values() for rel in listed)

    pictures = picture_parts(
        list(parts), {path: text(path) for path in parts if path.endswith(".rels")}
    )
    kinds = {path: picture_kind(parts[path], path) for path in pictures}
    changed = False
    removed = 0
    deleted: set[str] = set()

    # Rasters first: one the compressor cannot decode joins the removals.
    # An SVG outside the picture parts goes too (review r2 N12), counted
    # below when no relationship showed it.
    stray_svgs = {
        path for path in parts if path not in pictures and is_svg(parts[path], path)
    }
    shown = {rel["part"] for listed in rels.values() for rel in listed}
    gone = stray_svgs | {
        path
        for path in parts
        if (path in pictures and kinds[path] != "raster")
        or (not path.endswith((".xml", ".rels")) and is_vector(parts[path], path))
    }
    renames: dict[str, tuple[str, str]] = {}
    for path in sorted(pictures):
        if kinds[path] != "raster":
            continue
        result = picture(parts[path])
        if result == "unreadable":
            gone.add(path)
            continue
        if not isinstance(result, tuple):
            # Kept, or one nothing fits: the check decides.
            continue
        encoded, kind = result
        parts[path] = encoded
        changed = True
        ext = path.rsplit(".", 1)[-1].lower()
        wanted = ["png"] if kind == "png" else ["jpeg", "jpg"]
        if ext in wanted:
            continue
        stem = path.rsplit(".", 1)[0]
        renamed = f"{stem}.{wanted[0]}"
        number = 1
        taken = {new for new, _ in renames.values()}
        while renamed in parts or renamed in taken:
            renamed = f"{stem}-{number}.{wanted[0]}"
            number += 1
        renames[path] = (renamed, "image/png" if kind == "png" else "image/jpeg")

    if gone:
        dropped: list[str] = []
        for rels_path, listed in list(rels.items()):
            ids = {rel["id"] for rel in listed if rel["part"] in gone}
            if not ids:
                continue
            source = _source_of(rels_path)
            rels_xml = text(rels_path)
            # Every relationship nothing refers to any more goes: those of the
            # removed elements, and those of a removed picture no part shows
            # (a document thumbnail's, uncounted, among them).
            refs: list[str] = list(ids)
            left: set[str] = set()
            if source in parts:
                xml, found, count = remove_pictures(source, text(source), ids)
                if xml != text(source):
                    parts[source] = xml.encode()
                    removed += count
                    changed = True
                refs.extend(found)
                left = set(_references(xml))
            dead = {ref for ref in refs if ref not in left}
            kept = []
            for rel in listed:
                if rel["id"] in dead:
                    rels_xml = rels_xml.replace(rel["element"], "", 1)
                    if rel["part"]:
                        dropped.append(rel["part"])
                else:
                    kept.append(rel)
            if dead:
                rels[rels_path] = kept
                parts[rels_path] = rels_xml.encode()
                changed = True
        for part in {*dropped, *gone}:
            if part in parts and not targeted(part):
                deleted.add(part)
                if part in stray_svgs and part not in shown:
                    removed += 1
                folder, base = posixpath.split(part)
                own = posixpath.join(folder, "_rels", base + ".rels")
                if own in parts:
                    deleted.add(own)
                changed = True
    for part in deleted:
        renames.pop(part, None)
    if not changed:
        return None, 0

    for rels_path, listed in rels.items():
        rels_xml = text(rels_path)
        for rel in listed:
            rename = renames.get(rel["part"]) if rel["part"] else None
            if not rename:
                continue
            old = posixpath.basename(rel["part"])
            target = (
                rel["target"][: -len(old)] + posixpath.basename(rename[0])
                if rel["target"].endswith(old)
                else "/" + rename[0]
            )
            element = re.sub(
                r"(\sTarget\s*=\s*)([\"'])[^\"']*\2",
                lambda match, target=target: (
                    f"{match.group(1)}{match.group(2)}{target}{match.group(2)}"
                ),
                rel["element"],
                count=1,
            )
            rels_xml = rels_xml.replace(rel["element"], element, 1)
        if rels_xml != text(rels_path):
            parts[rels_path] = rels_xml.encode()
    if "[Content_Types].xml" in parts:
        types = text("[Content_Types].xml")
        for part in deleted:
            types = re.sub(
                rf"<Override\b[^>]*PartName\s*=\s*[\"']/{re.escape(part)}[\"'][^>]*>",
                "",
                types,
                count=1,
                flags=re.IGNORECASE,
            )
        for path, (renamed, content_type) in renames.items():
            types = re.sub(
                rf"<Override\b[^>]*PartName\s*=\s*[\"']/{re.escape(path)}[\"'][^>]*>",
                f'<Override PartName="/{renamed}" ContentType="{content_type}"/>',
                types,
                count=1,
                flags=re.IGNORECASE,
            )
            ext = renamed.rsplit(".", 1)[-1]
            if not re.search(
                rf"<Default\b[^>]*Extension\s*=\s*[\"']{ext}[\"']", types, re.IGNORECASE
            ):
                types = re.sub(
                    r"<Types\b[^>]*>",
                    lambda match, ext=ext, content_type=content_type: (
                        f'{match.group(0)}<Default Extension="{ext}" ContentType="{content_type}"/>'
                    ),
                    types,
                    count=1,
                )
        parts["[Content_Types].xml"] = types.encode()

    out = io.BytesIO()
    with zipfile.ZipFile(out, "w") as rebuilt:
        for info in infos:
            path = info.filename
            if path in deleted:
                continue
            method = (
                zipfile.ZIP_STORED
                if path in stored or path in renames
                else zipfile.ZIP_DEFLATED
            )
            rebuilt.writestr(
                renames.get(path, (path,))[0], parts[path], compress_type=method
            )
    return out.getvalue(), removed
