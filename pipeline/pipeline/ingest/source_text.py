"""Worker-side derived text for non-document source files.

Images and delimited tables need searchable text but do not belong in the
document parser. The worker already owns the source download, so it derives
that text locally; image captions are cached by the server-computed source SHA.
"""

from __future__ import annotations

import asyncio
import base64
import csv
import io
import math
import mimetypes
import re
import warnings
from collections.abc import Iterator
from pathlib import Path

from ..config import cfg
from ..jobs import InputLimitError, RetryableError, TerminalError
from ..prompts.captioning import IMAGE_PROMPT
from ..retrieval.chunking import estimate_tokens

# csv.reader streams rows, but it builds a whole row before its width can be
# read: one 30 MiB row of short fields peaks above 500 MiB, and the widest row
# sets the header list. So each row's raw delimiters (quoted ones too, an upper
# bound on its columns) are counted as its lines reach the reader, and a row
# over the cap is refused before it is parsed. Repeating headers make the
# searchable projection several times the source, so its estimated tokens are
# capped while it is built, before anything is chunked or embedded. With no
# overlap that is 2,500 to 5,000 chunks (2,700 for 11 short columns, one chunk
# per row once a row passes half a chunk), roughly a 1,400-page PDF or more.
_TABULAR_MAX_COLUMNS = 1_000
_TABULAR_MAX_FIELD_CHARS = 8 << 20
_TABULAR_MAX_TOKENS = 1_000_000
# Whitespace runs in a cell, line breaks inside quoted cells included, become
# one space, so each row stays one line. Only runs that aren't already a single
# space match: re.sub keeps every match's segment until it joins them, so a cell
# of ordinary single-spaced text then allocates nothing per word.
_WHITESPACE = re.compile(r"\s{2,}|[^\S ]")


def extension(name: str) -> str:
    return Path(name).suffix.lower().lstrip(".")


def _mime_type(name: str) -> str:
    known = {
        "avif": "image/avif",
        "heic": "image/heic",
        "heif": "image/heif",
        "jp2": "image/jp2",
        "svg": "image/svg+xml",
    }
    return (
        known.get(extension(name))
        or mimetypes.guess_type(name)[0]
        or "application/octet-stream"
    )


def _raw_data_url(path: Path, name: str) -> str:
    encoded = base64.b64encode(path.read_bytes()).decode()
    return f"data:{_mime_type(name)};base64,{encoded}"


def _frame_indices(frame_count: int, maximum: int = 9) -> list[int]:
    if frame_count <= maximum:
        return list(range(frame_count))
    return sorted(
        {
            min(frame_count - 1, round(index * (frame_count - 1) / (maximum - 1)))
            for index in range(maximum)
        }
    )


def _encode_image(path: Path, name: str) -> str:
    """Normalize supported raster images; retain SVG as its original payload."""
    if extension(name) == "svg":
        return _raw_data_url(path, name)

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
                    if pixels <= 0 or pixels > cfg.image_max_pixels:
                        raise InputLimitError(
                            "image_pixel_limit", "image exceeds the decoded-pixel limit"
                        )
                    total_pixels += pixels
                    if total_pixels > cfg.image_max_pixels:
                        raise InputLimitError(
                            "image_pixel_limit",
                            "animated image exceeds the decoded-pixel limit",
                        )
                    frame = ImageOps.exif_transpose(source.copy()).convert("RGBA")
                    frame.thumbnail(
                        (cfg.caption_max_edge, cfg.caption_max_edge),
                        Image.Resampling.LANCZOS,
                    )
                    flattened = Image.new("RGB", frame.size, "white")
                    flattened.paste(frame, mask=frame.getchannel("A"))
                    frames.append(flattened)
    except TerminalError:
        raise
    except (Image.DecompressionBombError, Image.DecompressionBombWarning) as exc:
        raise InputLimitError(
            "image_pixel_limit", "image exceeds the decoded-pixel limit"
        ) from exc
    except (OSError, UnidentifiedImageError, ValueError):
        # Some provider-supported formats may not be compiled into the local
        # Pillow build. Sending their original MIME payload preserves support
        # without routing the source through the Go gateway.
        return _raw_data_url(path, name)

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
    encoded = base64.b64encode(buffer.getvalue()).decode()
    return f"data:image/jpeg;base64,{encoded}"


async def caption_image_source(
    *, local_path: str, name: str, source_sha256: str, file_id: str
) -> tuple[str, str, int, bool]:
    from ..parse import caption_cache

    async def encode() -> str:
        return await asyncio.to_thread(_encode_image, Path(local_path), name)

    result = await caption_cache.caption(
        file_id=file_id,
        image_sha256=source_sha256,
        data_url=encode,
        prompt=IMAGE_PROMPT,
    )
    if not result[0]:
        raise RetryableError("image captioning produced no searchable text")
    return result


def tabular_text(path: str, name: str) -> str:
    """Turn CSV/TSV rows into explicit field/value text for semantic search."""
    delimiter = "\t" if extension(name) == "tsv" else ","
    csv.field_size_limit(_TABULAR_MAX_FIELD_CHARS)
    with open(path, "r", encoding="utf-8-sig", errors="replace", newline="") as source:
        row_delimiters = 0

        def lines() -> Iterator[str]:
            # The reader pulls lines only until its row ends, so the count
            # since the last row covers exactly the row being built.
            nonlocal row_delimiters
            for line in source:
                row_delimiters += line.count(delimiter)
                if row_delimiters >= _TABULAR_MAX_COLUMNS:
                    raise InputLimitError(
                        "tabular_column_limit",
                        "delimited table exceeds the column limit",
                    )
                yield line

        sample_rows: list[list[str]] = []
        width = 0
        for row in csv.reader(lines(), delimiter=delimiter):
            row_delimiters = 0
            if len(sample_rows) < 20:
                sample_rows.append(row)
            width = max(width, len(row))
    if not sample_rows or width == 0:
        return ""

    sample = "\n".join(delimiter.join(row) for row in sample_rows)
    try:
        has_header = csv.Sniffer().has_header(sample)
    except csv.Error:
        has_header = False
    headers = (
        sample_rows[0]
        if has_header
        else [f"Column {index + 1}" for index in range(width)]
    )
    headers = [
        (_WHITESPACE.sub(" ", headers[index]).strip() if index < len(headers) else "")
        or f"Column {index + 1}"
        for index in range(width)
    ]

    parts: list[str] = []
    tokens = 0

    def append(line: str) -> None:
        nonlocal tokens
        # A character costs at least a quarter token, so a line whose length
        # alone passes the cap is refused before the slower estimate.
        if tokens + len(line) // 4 <= _TABULAR_MAX_TOKENS:
            tokens += estimate_tokens(line)
            if tokens <= _TABULAR_MAX_TOKENS:
                parts.append(line)
                return
        raise InputLimitError(
            "tabular_text_limit",
            "delimited table exceeds the searchable-text limit",
        )

    append("Columns: " + " | ".join(headers))
    with open(path, "r", encoding="utf-8-sig", errors="replace", newline="") as source:
        reader = csv.reader(source, delimiter=delimiter)
        if has_header:
            next(reader, None)
        for row_number, row in enumerate(reader, start=2 if has_header else 1):
            values = []
            for index, raw_value in enumerate(row):
                value = _WHITESPACE.sub(" ", raw_value).strip()
                if value:
                    values.append(f"{headers[index]}={value}")
            if values:
                append(f"Row {row_number}: " + " | ".join(values))
    # A blank line between rows makes each row its own paragraph, so the
    # chunker packs whole rows and never splits one table-sized block.
    return "\n\n".join(parts)
