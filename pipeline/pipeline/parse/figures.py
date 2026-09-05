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

Captions are cached in B2 under a source-identity key
(``captions/{source_sha256}/{caption version}.json``), keyed by image content
hash. The parse fingerprint is deliberately not part of this path: a re-parse
(different parser route or version) must not recaption figures that
have not changed. The key also survives file deletion and re-upload, because
it no longer includes ``blob_path``. Ownership lives on ``artifact_cache``,
not ``files.caption_blob_path``.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import io
import json
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ..config import cfg
from ..retrieval import models
from ..store import blobstore, db

log = logging.getLogger("evo.parse.figures")

_MIN_WIDTH = 130
_MIN_HEIGHT = 130

# Picture blocks arrive under two labels: ``image`` and ``chart`` (a plot the
# layout model recognised as a data graphic). A chart is the single most
# caption-worthy thing in a lecture deck, and it carries the same ``img_path``
# as an image. Must match ``_IMAGE_TYPES`` in retrieval/chunking.py — a block
# captioned here but unknown there is money spent on text nobody indexes.
_IMAGE_TYPES = frozenset({"image", "chart"})

# Per-type caption keys, checked in order. The parser names the field after the
# block type, so a chart's label lives under ``chart_caption``.
_CAPTION_KEYS = ("image_caption", "chart_caption")

_DECORATIVE = "DECORATIVE"

_CAPTION_PROMPT = """Describe this figure from a study document so a student's search can find the information it carries.
Use brief, clear sentences. Include visible facts, data, labels, formulas, relationships, and conclusions. Do not add facts that are not visible or supported by the supplied context.
If the image is likely only decorative, such as an ornament, generic icon, divider, background, or branding with no useful study information, return exactly DECORATIVE in all caps and nothing else. If uncertain, describe the potentially useful information instead.
Do not use headings or other formattings since this response will be chunked and indexed."""

# Appended only when there is context to introduce. Left dangling on a figure
# with no surrounding text, the trailing colon reads as a promise of material
# that never arrives, which is an invitation to invent some.
_CAPTION_CONTEXT_PREAMBLE = (
    "Suggested context of the image is provided below, only use it for reference:"
)


@dataclass
class Figure:
    """One image block that survived filtering, with its captioning context."""

    items: list[dict[str, Any]]
    path: Path
    digest: str
    page: int | None
    context: str


# ------------------------------------------------------------------ selection


def _context_for(content_list: list[dict[str, Any]], index: int) -> str:
    """Heading path plus the nearest prose, as a hint for the caption model.

    A diagram captioned in isolation gets a generic description; the same
    diagram captioned with "Section: Krebs cycle" and the sentence that
    introduces it gets one that uses the document's vocabulary, which is the
    vocabulary the student will search with.
    """
    item = content_list[index]
    parts: list[str] = []

    headings: list[str] = []
    for prior in reversed(content_list[:index]):
        if not isinstance(prior, dict) or prior.get("type") != "text":
            continue
        level = prior.get("text_level")
        if isinstance(level, int) and level > 0:
            title = str(prior.get("text") or "").strip()
            if title and title not in headings:
                headings.append(title)
        if len(headings) >= 2:
            break
    if headings:
        parts.append("Section: " + " › ".join(reversed(headings)))

    labels: list[str] = []
    for key in _CAPTION_KEYS:
        raw = item.get(key)
        values = raw if isinstance(raw, list) else [raw]
        labels.extend(str(v).strip() for v in values if str(v or "").strip())
    if labels:
        parts.append("Figure label: " + " ".join(labels))

    for offset in (-1, 1):
        cursor = index + offset
        while 0 <= cursor < len(content_list):
            neighbour = content_list[cursor]
            if isinstance(neighbour, dict) and neighbour.get("type") == "text":
                text = str(neighbour.get("text") or "").strip()
                if text:
                    label = "Text before" if offset < 0 else "Text after"
                    parts.append(f"{label}: {text[:400]}")
                    break
            cursor += offset

    return "\n".join(parts)


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

    for index, item in enumerate(content_list):
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

        page = item.get("page_idx")
        by_digest[digest] = Figure(
            items=[item],
            path=target,
            digest=digest,
            page=int(page) if isinstance(page, int) else None,
            context=_context_for(content_list, index),
        )
        order.append(digest)

    figures = [by_digest[digest] for digest in order]
    if cfg.caption_max_per_file > 0 and len(figures) > cfg.caption_max_per_file:
        # A safety valve for a pathological document, not a quality knob. The
        # largest figures survive, since page area is the best cheap proxy for
        # which picture the page is actually about.
        log.warning(
            "capping %s figures at EVO_CAPTION_MAX_PER_FILE=%s",
            len(figures),
            cfg.caption_max_per_file,
        )
        figures.sort(key=lambda f: _bbox_area(f.items[0]) or 0.0, reverse=True)
        figures = figures[: cfg.caption_max_per_file]
    return figures


# ------------------------------------------------------------------- caching


def cache_key(source_sha256: str) -> str:
    """Stable caption-cache object for one source, independent of parse route."""
    if not source_sha256:
        return ""
    return f"captions/{source_sha256}/{cfg.caption_version}.json"


def _load_cache(key: str) -> dict[str, str]:
    if not key:
        return {}
    try:
        raw = blobstore.read_bytes(key)
    except Exception:
        log.warning("could not read caption cache", exc_info=True)
        return {}
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError):
        return {}
    if not isinstance(parsed, dict):
        return {}
    return {str(k): str(v) for k, v in parsed.items() if isinstance(v, str)}


def _save_cache(key: str, captions: dict[str, str]) -> bool:
    if not key or not captions:
        return False
    try:
        blobstore.write_bytes(
            key,
            json.dumps(captions, ensure_ascii=False, separators=(",", ":")).encode(),
            "application/json",
        )
        return True
    except Exception:
        # A missing cache costs money on the next ingest; it is never a reason
        # to fail a parse that already succeeded.
        log.warning("could not write caption cache", exc_info=True)
        return False


class _CaptionCacheLock:
    def __init__(self, identity: str):
        self.identity = identity
        self.connection = None

    async def __aenter__(self) -> None:
        while self.connection is None:
            self.connection = await db.try_source_artifact_lock_async(self.identity)
            if self.connection is None:
                await asyncio.sleep(max(0.1, cfg.poll_interval))

    async def __aexit__(self, *_exc: object) -> None:
        if self.connection is not None:
            await asyncio.to_thread(
                db.release_source_artifact_lock, self.connection, self.identity
            )


# ---------------------------------------------------------------- captioning


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


def _prompt(figure: Figure) -> str:
    """Caption prompt built only from the document's own bytes.

    The uploader's file name is deliberately absent. Captions are cached under
    ``(source_sha256, caption version)`` and served to every later upload of the
    same bytes, so anything outside that key must not reach the model: it would
    make the cached text depend on an input the key does not cover, and one
    uploader's file name would surface in another workspace's figure captions.
    """
    parts = [_CAPTION_PROMPT]
    if figure.page is not None:
        parts.append(f"Page: {figure.page + 1}")
    if figure.context:
        parts.append(_CAPTION_CONTEXT_PREAMBLE)
        parts.append("\nSurrounding content:\n" + figure.context)
    return "\n".join(parts)


async def caption_figures(
    *,
    content_list: list[dict[str, Any]],
    raw_dir: Path,
    file_name: str,
    source_sha256: str,
) -> dict[str, Any]:
    """Describe every figure worth describing, in place on ``content_list``."""
    figures = select_figures(content_list, raw_dir)
    key = cache_key(source_sha256)
    empty = {
        "selected": 0,
        "cached": 0,
        "captioned": 0,
        "decorative": 0,
        "applied": 0,
        "key": "",
    }
    if not figures:
        return empty

    identity = f"figure-caption:{source_sha256}:{cfg.caption_version}"
    async with _CaptionCacheLock(identity):
        # Load inside the lock. A competing ingest may have populated the cache
        # while this one waited, in which case no second vision call is needed.
        cached = await asyncio.to_thread(_load_cache, key)
        loaded = bool(cached)
        pending = [figure for figure in figures if figure.digest not in cached]
        log.info(
            "captioning %s figures for %s (%s already cached)",
            len(pending),
            file_name,
            len(figures) - len(pending),
        )

        semaphore = asyncio.Semaphore(max(1, cfg.caption_concurrency))

        async def describe(figure: Figure) -> tuple[str, str]:
            async with semaphore:
                data_url = await asyncio.to_thread(_encode, figure.path)
                if data_url is None:
                    return figure.digest, ""
                return figure.digest, await models.caption_image(
                    data_url, _prompt(figure)
                )

        tasks = [asyncio.create_task(describe(figure)) for figure in pending]
        try:
            fresh = await asyncio.gather(*tasks)
        except BaseException:
            for task in tasks:
                if not task.done():
                    task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            raise
        written = {digest: text.strip() for digest, text in fresh if text.strip()}
        saved = False
        if written:
            cached.update(written)
            saved = await asyncio.to_thread(_save_cache, key, cached)

    applied = 0
    decorative = 0
    for figure in figures:
        description = cached.get(figure.digest)
        if not description:
            continue
        if description.strip() == _DECORATIVE:
            decorative += 1
            continue
        for item in figure.items:
            item["description"] = description
        applied += 1
    return {
        "selected": len(figures),
        "cached": len(figures) - len(pending),
        "captioned": len(written),
        "decorative": decorative,
        "applied": applied,
        "key": key if (loaded or saved) else "",
    }
