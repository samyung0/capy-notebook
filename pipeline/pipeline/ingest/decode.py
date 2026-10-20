"""Decoding of uploaded bytes for the ingest worker, in a sandboxed helper.

The worker process holds the database, Redis, bucket and provider secrets, so
it never imports MuPDF or Pillow: each decode runs this module as a child
through capy_sandbox (human/deployment-runbook.md, 2026-10-20 S0) with only
its Python path in its environment, its input file the one file it reads
beyond its own code, no network and no new processes, 768 MiB of data, 120 s
of CPU and a 120 s deadline. It answers one JSON object on stdout, which the
worker reads up to ``_MAX_ANSWER`` bytes and checks against the mode's shape:
anything else is a failed decode.

- ``evidence``: a PDF's page texts and the candidate headings its glyphs
  prove visible, for retrieval/headings.py and confidence.py (the parser
  freezes the same evidence for Office files, parser/odl/evidence.py).
- ``caption``: an image as the JPEG the caption model reads.
- ``thumbnail``: an image's first frame as the list card's WebP.
- ``page``: the parser's page-1 PNG from the bundle as the card's WebP.
"""

from __future__ import annotations

import base64
import binascii
import io
import json
import math
import os
import re
import subprocess
import sys
import unicodedata
import warnings
from pathlib import Path

import capy_sandbox

_LIMITS = {"DATA": 768 << 20, "CPU": 120, "NOFILE": 64, "FSIZE": 0, "CORE": 0}
_TIMEOUT_S = 120
# The largest answer is a PDF's page texts. Measured: 4 MiB of JSON for the
# largest real document (1,475 pages) and 22 KiB for the densest page
# (Korean), so 32 MiB holds that page density over 1,400 pages.
_MAX_ANSWER = 32 << 20
_SYSTEM = ("/usr", "/lib", "/lib64", "/etc/ld.so.cache")
# The card thumbnail: 200 px wide, cropped from the top at twice that (the
# parser's page1.png follows the same rule, parser/odl/capture.py).
THUMBNAIL_WIDTH = 200
_THUMBNAIL_MAX_HEIGHT = 2 * THUMBNAIL_WIDTH
_WEBP_QUALITY = 60


class DecodeFailed(RuntimeError):
    """The helper failed: an unreadable file, or past its memory or time."""


class PixelLimit(ValueError):
    """The image is past the decoded-pixel limit."""


# ------------------------------------------------------------ worker side


def _policy(source: Path | None) -> capy_sandbox.Policy:
    """The helper's sandbox: its interpreter and code, plus ``source``."""
    return capy_sandbox.Policy(
        limits=_LIMITS,
        blocked=frozenset({"setsid", "setpgid", "fork"}),
        read=(
            *capy_sandbox.python_paths(),
            *_SYSTEM,
            *([str(source)] if source is not None else []),
        ),
        env={key: os.environ[key] for key in ("PYTHONPATH",) if key in os.environ},
        timeout_s=_TIMEOUT_S,
    )


def _texts(value: object) -> bool:
    return type(value) is list and all(type(item) is str for item in value)


def _indices(value: object) -> bool:
    return type(value) is list and all(type(item) is int for item in value)


def _string(value: object) -> bool:
    return type(value) is str


def _true(value: object) -> bool:
    return value is True


# Each mode's possible answers: their keys and what each key holds.
_ANSWERS = {
    "evidence": ({"page_texts": _texts, "visible_headings": _indices},),
    "caption": ({"limit": _string}, {"raw": _true}, {"jpeg": _string}),
    "thumbnail": ({"none": _true}, {"webp": _string}),
    "page": ({"webp": _string},),
}


def _decode(
    mode: str, *args: object, source: Path | None = None, data: bytes | None = None
) -> dict:
    argv = [sys.executable, "-m", __name__, mode, *map(str, args)]
    try:
        completed = capy_sandbox.run(
            argv, _policy(source), input=data, max_output=_MAX_ANSWER
        )
    except subprocess.TimeoutExpired:
        raise DecodeFailed(f"{mode} decode exceeded {_TIMEOUT_S} seconds") from None
    except capy_sandbox.OutputLimit:
        raise DecodeFailed(f"{mode} decode answered over {_MAX_ANSWER} bytes") from None
    if completed.returncode != 0:
        detail = completed.stderr.decode(errors="replace").strip()[-500:]
        raise DecodeFailed(f"{mode} decode exited {completed.returncode}: {detail}")
    try:
        answer = json.loads(completed.stdout)
    except ValueError:
        raise DecodeFailed(f"{mode} decode answered no JSON") from None
    if type(answer) is not dict or not any(
        answer.keys() == shape.keys()
        and all(check(answer[key]) for key, check in shape.items())
        for shape in _ANSWERS[mode]
    ):
        raise DecodeFailed(f"{mode} decode answered an unexpected shape")
    return answer


def _bytes(answer: dict, key: str) -> bytes:
    try:
        return base64.b64decode(answer[key], validate=True)
    except binascii.Error:
        raise DecodeFailed(f"the decode's {key} is not base64") from None


def page_evidence(pdf: Path, blocks: list[dict]) -> dict:
    """``{"page_texts": [...], "visible_headings": [block index, ...]}`` for
    the heading blocks of ``blocks`` the PDF's glyphs confirm."""
    candidates = [
        [index, block["page_idx"], block["bbox"], block.get("text", "")]
        for index, block in enumerate(blocks)
        if block.get("text_level")
        and len(block.get("bbox", [])) == 4
        and isinstance(block.get("page_idx"), int)
        and any(c.isalpha() for c in block.get("text", ""))
    ]
    return _decode("evidence", pdf, source=pdf, data=json.dumps(candidates).encode())


def caption_jpeg(path: Path, *, max_edge: int, max_pixels: int) -> bytes | None:
    """The image as the caption model's JPEG, or None when Pillow cannot
    decode it (the caller sends the original bytes)."""
    answer = _decode("caption", path, max_edge, max_pixels, source=path)
    if "limit" in answer:
        raise PixelLimit(answer["limit"])
    return None if "raw" in answer else _bytes(answer, "jpeg")


def thumbnail_webp(path: Path, format_name: str, *, max_pixels: int) -> bytes | None:
    """The image's card WebP, or None for a format this Pillow cannot read."""
    answer = _decode("thumbnail", path, format_name, max_pixels, source=path)
    return None if "none" in answer else _bytes(answer, "webp")


def page_webp(png: bytes) -> bytes:
    """The parser's page-1 PNG as the card WebP."""
    return _bytes(_decode("page", data=png), "webp")


# ------------------------------------------------------------ helper side


def _canonical(text: str) -> str:
    text = unicodedata.normalize("NFKC", text).replace("\xad", "")
    text = re.sub(r"(?<=[^\W\d_])-[ \t]*\n\s*(?=[a-zäöüß])", "", text)
    return "".join(text.split())


def _evidence(pdf: str, candidates: list[list]) -> dict:
    """A candidate is visible when the text inside its box is its text and
    enough of those glyphs are drawn opaque and upright."""
    import pymupdf

    def inside(box, area) -> bool:
        return area.contains(
            pymupdf.Point((box[0] + box[2]) / 2, (box[1] + box[3]) / 2)
        )

    def disjoint(box, area) -> bool:
        return (
            box[0] > area.x1 or box[2] < area.x0 or box[1] > area.y1 or box[3] < area.y0
        )

    flags = pymupdf.TEXTFLAGS_RAWDICT & ~pymupdf.TEXT_PRESERVE_IMAGES
    headings = []
    with pymupdf.open(pdf) as document:
        texts = [page.get_text() for page in document]
        pages: dict[int, tuple[list[dict], list[dict]]] = {}
        for index, number, box, text in candidates:
            if not 0 <= number < len(document):
                continue
            page = document[number]
            if page.rotation:
                continue
            if number not in pages:
                pages.clear()  # Only the current page's glyphs stay in memory.
                pages[number] = (
                    page.get_text("rawdict", flags=flags)["blocks"],
                    page.get_texttrace(),
                )
            groups, traces = pages[number]
            area = pymupdf.Rect(
                box[0] * page.rect.width / 1000,
                box[1] * page.rect.height / 1000,
                box[2] * page.rect.width / 1000,
                box[3] * page.rect.height / 1000,
            )
            source = "\n".join(
                "".join(
                    char["c"]
                    for span in line["spans"]
                    if not disjoint(span["bbox"], area)
                    for char in span["chars"]
                    if inside(char["bbox"], area)
                )
                for group in groups
                if not disjoint(group["bbox"], area)
                for line in group.get("lines", [])
                if abs(line["dir"][0] - 1) < 0.01 and abs(line["dir"][1]) < 0.01
            )
            if _canonical(source) != _canonical(text):
                continue
            visible = sum(
                1
                for span in traces
                if span["opacity"] >= 0.99
                and span["type"] != 3
                and span["dir"][0] > 0.99
                for char in span["chars"]
                if chr(char[0]).isalpha() and inside(char[3], area)
            )
            if visible >= sum(c.isalpha() for c in text):
                headings.append(index)
    return {"page_texts": texts, "visible_headings": headings}


def _frame_indices(frame_count: int, maximum: int = 9) -> list[int]:
    if frame_count <= maximum:
        return list(range(frame_count))
    return sorted(
        {
            min(frame_count - 1, round(index * (frame_count - 1) / (maximum - 1)))
            for index in range(maximum)
        }
    )


def _decoded(image, edge: int):
    """The current frame, shrunk while it decodes when it is at least twice
    ``edge`` both ways: a JPEG at a reduced DCT scale, any image by a whole
    factor before a full-size copy is made."""
    image.draft("RGB", (edge, edge))  # JPEG only; before the pixels load.
    factor = min(image.width // edge, image.height // edge)
    if factor < 2:
        return image.copy()
    if image.mode in ("P", "1"):  # Palette and bilevel images don't reduce.
        image = image.convert("RGBA")
    return image.reduce(factor)


def _caption(path: str, max_edge: int, max_pixels: int) -> dict:
    """Up to nine frames, each oriented, flattened on white and fit within
    ``max_edge``, in one grid. A format this Pillow cannot read answers
    ``raw``: providers may still read the original."""
    from PIL import Image, ImageOps, UnidentifiedImageError

    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(path) as source:
                frame_count = int(getattr(source, "n_frames", 1) or 1)
                frames = []
                total_pixels = 0
                for index in _frame_indices(frame_count):
                    source.seek(index)
                    width, height = source.size
                    pixels = width * height
                    if pixels <= 0 or pixels > max_pixels:
                        return {"limit": "image exceeds the decoded-pixel limit"}
                    total_pixels += pixels
                    if total_pixels > max_pixels:
                        return {
                            "limit": "animated image exceeds the decoded-pixel limit"
                        }
                    frame = ImageOps.exif_transpose(_decoded(source, max_edge))
                    frame = frame.convert("RGBA")
                    frame.thumbnail((max_edge, max_edge), Image.Resampling.LANCZOS)
                    flattened = Image.new("RGB", frame.size, "white")
                    flattened.paste(frame, mask=frame.getchannel("A"))
                    frames.append(flattened)
    except (Image.DecompressionBombError, Image.DecompressionBombWarning):
        return {"limit": "image exceeds the decoded-pixel limit"}
    except (OSError, UnidentifiedImageError, ValueError):
        return {"raw": True}

    if len(frames) == 1:
        output = frames[0]
    else:
        columns = min(3, len(frames))
        rows = math.ceil(len(frames) / columns)
        cell_width = max(frame.width for frame in frames)
        cell_height = max(frame.height for frame in frames)
        output = Image.new("RGB", (cell_width * columns, cell_height * rows), "white")
        for index, frame in enumerate(frames):
            x = (index % columns) * cell_width + (cell_width - frame.width) // 2
            y = (index // columns) * cell_height + (cell_height - frame.height) // 2
            output.paste(frame, (x, y))

    buffer = io.BytesIO()
    output.save(buffer, format="JPEG", quality=85, optimize=True)
    return {"jpeg": base64.b64encode(buffer.getvalue()).decode()}


def _webp(image) -> str:
    from PIL import Image

    if image.width > THUMBNAIL_WIDTH:
        height = max(1, round(image.height * THUMBNAIL_WIDTH / image.width))
        image = image.resize((THUMBNAIL_WIDTH, height), Image.Resampling.LANCZOS)
    if image.height > _THUMBNAIL_MAX_HEIGHT:
        image = image.crop((0, 0, image.width, _THUMBNAIL_MAX_HEIGHT))
    buffer = io.BytesIO()
    image.save(buffer, "WEBP", quality=_WEBP_QUALITY)
    return base64.b64encode(buffer.getvalue()).decode()


def _thumbnail(path: str, format_name: str, max_pixels: int) -> dict:
    """The first frame, oriented, shrunk, then flattened on white like
    captioning does."""
    from PIL import Image, ImageOps

    # SVG has no rasterizer here, and HEIC only with a Pillow plugin.
    if f".{format_name}" not in Image.registered_extensions():
        return {"none": True}
    with warnings.catch_warnings():
        warnings.simplefilter("error", Image.DecompressionBombWarning)
        with Image.open(path) as opened:
            width, height = opened.size
            if width * height <= 0 or width * height > max_pixels:
                raise ValueError("image exceeds the decoded-pixel limit")
            # Shrunk while it decodes; the full-size frame goes when the file
            # closes, before anything else is made from it.
            frame = ImageOps.exif_transpose(_decoded(opened, 2 * THUMBNAIL_WIDTH))
    # Shrink first, so the colour conversion and flattening work on the
    # thumbnail rather than the full image.
    frame.thumbnail((THUMBNAIL_WIDTH, frame.height), Image.Resampling.LANCZOS)
    frame = frame.crop((0, 0, frame.width, min(frame.height, _THUMBNAIL_MAX_HEIGHT)))
    rgba = frame.convert("RGBA")
    flat = Image.new("RGB", rgba.size, "white")
    flat.paste(rgba, mask=rgba.getchannel("A"))
    return {"webp": _webp(flat)}


def _page(png: bytes) -> dict:
    """The parser's page image as the stored WebP. Its header is checked
    before any pixel is decoded: a PNG within the thumbnail's own size."""
    from PIL import Image

    with Image.open(io.BytesIO(png)) as image:
        if (
            image.format != "PNG"
            or image.width > THUMBNAIL_WIDTH
            or image.height > _THUMBNAIL_MAX_HEIGHT
        ):
            raise ValueError(f"bundled page image is {image.format} {image.size}")
        return {"webp": _webp(image.convert("RGB"))}


def main(argv: list[str]) -> None:
    mode, *args = argv
    if mode == "evidence":
        answer = _evidence(args[0], json.load(sys.stdin))
    elif mode == "caption":
        answer = _caption(args[0], int(args[1]), int(args[2]))
    elif mode == "thumbnail":
        answer = _thumbnail(args[0], args[1], int(args[2]))
    elif mode == "page":
        answer = _page(sys.stdin.buffer.read())
    else:
        raise SystemExit(f"unknown decode mode {mode!r}")
    sys.stdout.write(json.dumps(answer))


if __name__ == "__main__":
    main(sys.argv[1:])
