"""Pick the figures worth describing, then describe them.

A figure with no caption is invisible to retrieval. That is fine for a prose
textbook and ruinous for lecture slides, where the substance is in the diagrams
and the text on the page is three bullet points. So when captioning is enabled
for a file, every figure that survives filtering is described — the filters, not
a count, are what bound the cost.

Descriptions are written onto the ``content_list`` image blocks in place, before
chunking, so a caption is embedded, summarized, concept-extracted and cited as
part of the passage it belongs to.

## Filtering

Two kinds of image come out of a parse: figures, and page furniture. Rejecting
the furniture matters more for latency than for money — a caption is a fraction
of a cent, but a few hundred of them are a minute of wall clock, and a caption of
a university crest is noise in the index forever.

The load-bearing filter is *repetition*. A crest, header rule or footer logo
appears on nearly every page of a deck; a real figure does not. Grouping by
perceptual hash and dropping whatever recurs across pages catches this
independently of language, script or subject matter, which the cheaper
per-image heuristics cannot do.

The flatness heuristics are deliberately timid. The obvious rule — "mostly one
colour means it is a logo" — is wrong here: a line diagram on a white background
is also 95% one colour, and those are exactly the images worth captioning. So
flatness only rejects images that are *almost entirely* uniform (blank crops,
rules, solid blocks). A one-off logo on a title page still gets captioned; that
costs one call and is the deliberate trade for never dropping a diagram.

## Caching

Captions are cached in B2 under a source-identity key
(``captions/{source_sha256}/{caption version}.json``), keyed by image content
hash. The parse fingerprint is deliberately not part of this path: a re-parse
(different MinerU route or parser version) must not recaption figures that
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
from ..store import blobstore

log = logging.getLogger("evo.parse.figures")

# --- absolute bounds: too small to carry information at all ---------------
# Encoded size is a poor proxy for content: a bar chart exported from slideware
# is a 600x400 PNG of flat fills that compresses to under 2 KB, while a scanned
# smudge is far larger. So this floor only skips spacers and truncated files,
# and the pixel bounds below do the real work.
_MIN_BYTES = 512
_MIN_WIDTH = 160
_MIN_HEIGHT = 120
_MIN_PIXELS = 40_000
_MAX_ASPECT = 8.0
# MinerU normalizes bboxes to a 1000x1000 page, so this is 1.2% of the page.
_MIN_PAGE_AREA = 12_000

# --- flatness: only near-uniform crops, never merely sparse line art ------
_FLAT_SAMPLE = 128
_FLAT_DOMINANT_RATIO = 0.97
_FLAT_MAX_COLORS = 8
# Uniform fills and smooth backgrounds measure 0.0 here; the sparsest drawing
# worth keeping (a single labelled arrow) measures about 0.28. The threshold
# sits far below that, because the colour-count test above already rejects
# rules and solid blocks and this only has to catch gradients it cannot see.
_MIN_ENTROPY = 0.15

# --- repetition: page furniture recurs, figures do not --------------------
_HASH_DISTANCE = 6
_REPEAT_MIN_PAGES = 3
_REPEAT_PAGE_RATIO = 0.3

# Picture blocks arrive under two labels: ``image`` and ``chart`` (a plot the
# layout model recognised as a data graphic). A chart is the single most
# caption-worthy thing in a lecture deck, and it carries the same ``img_path``
# as an image. Must match ``_IMAGE_TYPES`` in retrieval/chunking.py — a block
# captioned here but unknown there is money spent on text nobody indexes.
_IMAGE_TYPES = frozenset({"image", "chart"})

# Per-type caption keys, checked in order. MinerU names the field after the
# block type, so a chart's label lives under ``chart_caption``.
_CAPTION_KEYS = ("image_caption", "chart_caption")

_CAPTION_PROMPT = """You are describing a figure from a study document so that a student's search query can find it.
Caption the image in brief and easy to understand way. List out facts/data/formulas clearly visible in the image (if any)
Focus on the facts and drop all unnecessary opinions. Make the sentences short and drop all the fillers, preamble or pleasantries"""

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


def _page_count(content_list: list[dict[str, Any]]) -> int:
    pages = [
        int(item["page_idx"])
        for item in content_list
        if isinstance(item, dict) and isinstance(item.get("page_idx"), int)
    ]
    return (max(pages) + 1) if pages else 1


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


def _is_flat(image: Any) -> bool:
    from PIL import Image

    sample = image.convert("RGB")
    sample.thumbnail((_FLAT_SAMPLE, _FLAT_SAMPLE), Image.Resampling.BILINEAR)
    if sample.convert("L").entropy() < _MIN_ENTROPY:
        return True
    colors = sample.getcolors(maxcolors=_FLAT_MAX_COLORS * 8)
    if colors is None:
        return False
    total = sum(count for count, _ in colors)
    if not total:
        return True
    dominant = max(count for count, _ in colors)
    return dominant / total >= _FLAT_DOMINANT_RATIO and len(colors) <= _FLAT_MAX_COLORS


def _dhash(image: Any) -> int:
    """64-bit difference hash: adjacent-pixel gradients of a 9x8 grayscale."""
    from PIL import Image

    small = image.convert("L").resize((9, 8), Image.Resampling.LANCZOS)
    pixels = small.tobytes()
    bits = 0
    for row in range(8):
        base = row * 9
        for col in range(8):
            bits = (bits << 1) | int(pixels[base + col] < pixels[base + col + 1])
    return bits


def _drop_recurring(
    figures: list[Figure], hashes: dict[str, int], pages: int
) -> list[Figure]:
    """Drop figures whose near-identical twin appears across many pages.

    Greedy clustering on Hamming distance rather than exact equality, because a
    logo re-cropped by a page or two off differs in a handful of bits.
    """
    threshold = max(_REPEAT_MIN_PAGES, int(pages * _REPEAT_PAGE_RATIO))
    clusters: list[tuple[int, set[int | None]]] = []
    membership: list[int] = []
    for figure in figures:
        value = hashes[figure.digest]
        for index, (representative, seen) in enumerate(clusters):
            if (representative ^ value).bit_count() <= _HASH_DISTANCE:
                seen.add(figure.page)
                membership.append(index)
                break
        else:
            clusters.append((value, {figure.page}))
            membership.append(len(clusters) - 1)

    kept: list[Figure] = []
    for figure, cluster in zip(figures, membership):
        if len(clusters[cluster][1]) >= threshold:
            continue
        kept.append(figure)
    dropped = len(figures) - len(kept)
    if dropped:
        log.info("dropped %s recurring page-furniture images", dropped)
    return kept


def select_figures(content_list: list[dict[str, Any]], raw_dir: Path) -> list[Figure]:
    """Figures worth captioning, deduplicated by image content."""
    from PIL import Image, UnidentifiedImageError

    pages = _page_count(content_list)
    by_digest: dict[str, Figure] = {}
    hashes: dict[str, int] = {}
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
        if not target.is_file() or target.stat().st_size < _MIN_BYTES:
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
                if (
                    width < _MIN_WIDTH
                    or height < _MIN_HEIGHT
                    or width * height < _MIN_PIXELS
                    or max(width, height) / max(1, min(width, height)) > _MAX_ASPECT
                ):
                    continue
                area = _bbox_area(item)
                if area is not None and area < _MIN_PAGE_AREA:
                    continue
                if _is_flat(image):
                    continue
                hashes[digest] = _dhash(image)
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

    figures = _drop_recurring([by_digest[d] for d in order], hashes, pages)
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
    except json.JSONDecodeError:
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
    empty = {"selected": 0, "cached": 0, "captioned": 0, "applied": 0, "key": ""}
    if not figures:
        return empty

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
            return figure.digest, await models.caption_image(data_url, _prompt(figure))

    fresh = await asyncio.gather(*(describe(figure) for figure in pending))
    written = {digest: text for digest, text in fresh if text}
    saved = False
    if written:
        cached.update(written)
        saved = await asyncio.to_thread(_save_cache, key, cached)

    applied = 0
    for figure in figures:
        description = cached.get(figure.digest)
        if not description:
            continue
        for item in figure.items:
            item["description"] = description
        applied += 1
    return {
        "selected": len(figures),
        "cached": len(figures) - len(pending),
        "captioned": len(written),
        "applied": applied,
        "key": key if (loaded or saved) else "",
    }
