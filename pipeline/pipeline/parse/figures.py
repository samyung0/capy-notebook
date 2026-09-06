"""Pick the figures worth describing, then describe them.

A figure with no caption is invisible to retrieval. That is fine for a prose
textbook and ruinous for lecture slides, where the substance is in the diagrams
and the text on the page is three bullet points. So when captioning is enabled
for a file, every figure that survives filtering is described — the filters, not
a count, are what bound the cost.

Descriptions are written onto the ``content_list`` image blocks in place, before
chunking, so a caption is embedded, summarized and cited as
part of the passage it belongs to.

## Filtering

Selection rejects only unreadable images, images below 130×130, images already
described by the parser, and exact duplicates. Aspect ratio, compressed size,
page area, flatness, entropy, and cross-page repetition all produced plausible
false negatives for sparse scientific diagrams. Decorative classification is
left to the caption model and cached with the same image digest as a caption.

## Caching

Each image digest resolves through its containing file's live reuse permissions.
Authorized reuse attaches a reference to a shared image-only caption payload.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import io
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ..config import cfg
from ..prompts.captioning import DECORATIVE, IMAGE_PROMPT
from . import caption_cache

log = logging.getLogger("capy.parse.figures")

_MIN_WIDTH = 130
_MIN_HEIGHT = 130

# Picture blocks arrive under two labels: ``image`` and ``chart`` (a plot the
# layout model recognised as a data graphic). A chart is the single most
# caption-worthy thing in a lecture deck, and it carries the same ``img_path``
# as an image. Must match ``_IMAGE_TYPES`` in retrieval/chunking.py — a block
# captioned here but unknown there is money spent on text nobody indexes.
_IMAGE_TYPES = frozenset({"image", "chart"})


@dataclass
class Figure:
    """One image block that survived filtering, with its captioning context."""

    items: list[dict[str, Any]]
    path: Path
    digest: str


# ------------------------------------------------------------------ selection


def _bbox_area(item: dict[str, Any]) -> float | None:
    bbox = item.get("bbox")
    if not isinstance(bbox, list) or len(bbox) != 4:
        return None
    try:
        width = float(bbox[2]) - float(bbox[0])
        height = float(bbox[3]) - float(bbox[1])
    except (TypeError, ValueError):
        return None
    return max(0.0, width) * max(0.0, height)


def select_figures(content_list: list[dict[str, Any]], raw_dir: Path) -> list[Figure]:
    """Figures worth captioning, deduplicated by image content."""
    from PIL import Image, UnidentifiedImageError

    by_digest: dict[str, Figure] = {}
    order: list[str] = []

    for item in content_list:
        if not isinstance(item, dict) or item.get("type") not in _IMAGE_TYPES:
            continue
        if str(item.get("description") or "").strip():
            continue
        img_path = str(item.get("img_path") or "")
        if not img_path:
            continue
        target = raw_dir.joinpath(*Path(img_path).parts)
        if not target.is_file():
            continue

        try:
            data = target.read_bytes()
        except OSError:
            continue
        digest = hashlib.sha256(data).hexdigest()

        existing = by_digest.get(digest)
        if existing is not None:
            # The same picture used twice: caption once, attach to both blocks.
            existing.items.append(item)
            continue

        try:
            with Image.open(io.BytesIO(data)) as image:
                width, height = image.size
                if width < _MIN_WIDTH or height < _MIN_HEIGHT:
                    continue
        except (OSError, UnidentifiedImageError):
            continue

        by_digest[digest] = Figure(
            items=[item],
            path=target,
            digest=digest,
        )
        order.append(digest)

    figures = [by_digest[digest] for digest in order]
    if cfg.caption_max_per_file > 0 and len(figures) > cfg.caption_max_per_file:
        # A safety valve for a pathological document, not a quality knob. The
        # largest figures survive, since page area is the best cheap proxy for
        # which picture the page is actually about.
        log.warning(
            "capping %s figures at CAPY_CAPTION_MAX_PER_FILE=%s",
            len(figures),
            cfg.caption_max_per_file,
        )
        figures.sort(key=lambda f: _bbox_area(f.items[0]) or 0.0, reverse=True)
        figures = figures[: cfg.caption_max_per_file]
    return figures


def _encode(path: Path) -> str | None:
    """Downscale and re-encode one figure as a JPEG data URL.

    Well past the resolution a description needs, and far below what the raw
    crop from a 300 DPI scan would cost in image tokens and upload time.
    """
    from PIL import Image, UnidentifiedImageError

    try:
        with Image.open(path) as image:
            image.load()
            # Flatten transparency onto white: a PNG logo or diagram with an
            # alpha channel becomes black-on-black when naively converted.
            if image.mode in ("RGBA", "LA", "P"):
                image = image.convert("RGBA")
                flattened = Image.new("RGB", image.size, "white")
                flattened.paste(image, mask=image.split()[-1])
                image = flattened
            else:
                image = image.convert("RGB")
            image.thumbnail(
                (cfg.caption_max_edge, cfg.caption_max_edge), Image.Resampling.LANCZOS
            )
            buffer = io.BytesIO()
            image.save(buffer, format="JPEG", quality=80, optimize=True)
    except (OSError, UnidentifiedImageError, ValueError):
        log.warning("could not encode figure %s", path.name, exc_info=True)
        return None
    encoded = base64.b64encode(buffer.getvalue()).decode()
    return f"data:image/jpeg;base64,{encoded}"


async def caption_figures(
    *,
    content_list: list[dict[str, Any]],
    raw_dir: Path,
    file_name: str,
    source_sha256: str,
    file_id: str,
    refresh_job_id: str | None = None,
) -> dict[str, Any]:
    """Describe selected images without disclosing surrounding document text."""
    figures = select_figures(content_list, raw_dir)
    semaphore = asyncio.Semaphore(max(1, cfg.caption_concurrency))

    async def describe(figure: Figure) -> tuple[str, bool]:
        async with semaphore:

            async def encode() -> str | None:
                return await asyncio.to_thread(_encode, figure.path)

            text, _, _, hit = await caption_cache.caption(
                file_id=file_id,
                image_sha256=figure.digest,
                data_url=encode,
                prompt=IMAGE_PROMPT,
                published=refresh_job_id is None,
                source_refresh_job_id=refresh_job_id,
                require_source_job=refresh_job_id is None,
            )
            return text, hit

    tasks = [asyncio.create_task(describe(figure)) for figure in figures]
    try:
        results = await asyncio.gather(*tasks)
    except BaseException:
        for task in tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        raise
    counts = {
        "selected": len(figures),
        "cached": 0,
        "captioned": 0,
        "decorative": 0,
        "applied": 0,
        "key": "",
    }
    for figure, (text, hit) in zip(figures, results):
        if not text:
            continue
        counts["cached" if hit else "captioned"] += 1
        if text == DECORATIVE:
            counts["decorative"] += 1
            continue
        for item in figure.items:
            item["description"] = text
        counts["applied"] += 1
    return counts
