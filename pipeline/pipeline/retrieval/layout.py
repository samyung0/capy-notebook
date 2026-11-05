"""Make a quiz: the layout service's regions on the selected pages, the boxes a
page window picks figures from, the crop those boxes make, and the box call's box
grown to ink (Epo 2026-11-04;
bench/extraction/reports/2026-11-04-figure-matching.md).

``read_regions`` asks the service (``layout/app.py``, one pool on the ingest
host) for every selected page before the windows start. Nothing here fails a
run: a page whose request fails, stays busy or runs out of time has no regions,
and its figures take the box call. With no CAPY_LAYOUT_URL no page has regions.
"""

from __future__ import annotations

import asyncio
import base64
import io
import logging
import random
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

import httpx
from PIL import Image

from ..config import cfg

log = logging.getLogger("capy.retrieval.layout")

# Requests a run has in flight, one a page.
PAGES_IN_FLIGHT = 3
# One request, its wait in the service's queue included.
REQUEST_TIMEOUT_S = 30.0
# Every page of a run; what has not answered by then uses the box call.
ALL_PAGES_TIMEOUT_S = 90.0
# A 429 is tried again after about 2 s, this many tries in all.
BUSY_TRIES = 4
BUSY_WAIT_S = (1.5, 2.5)

FIGURE_LABELS = frozenset({"image", "chart"})
CAPTION_LABEL = "figure_title"
MIN_SCORE = 0.5
# Two figure boxes this alike are one.
SAME_BOX_IOU = 0.8
# A box holding a smaller box at least this much is its outer box.
NESTED_INSIDE = 0.9
# A caption at most this far above or below a figure, on the 0-1000 grid.
CAPTION_GAP = 25
# 1% of the page on every side, on the 0-1000 grid.
CROP_PAD = 10
# The box call's box grown to the ink around it (Epo 2026-11-04): 68 whole, 64
# tight, 56 both of 80 against 63, 40, 36 with a fixed pad, the settings tuned in
# bench/extraction/reports/2026-11-04-hosted-figure-boxes.md. Grey below INK_LEVEL
# is ink, and a strip with INK_MIN dark pixels holds ink. An edge stops after
# INK_GAP blank grid units or INK_CAP units from where it started; a gap of 12 or
# more crosses the line spacing and climbs into the question's text.
INK_LEVEL = 150
INK_MIN = 2
INK_GAP = 6
INK_CAP = 80
INK_MARGIN = 5


@dataclass(frozen=True)
class Region:
    """What the layout model found: a box [left, top, right, bottom] on the
    0-1000 grid."""

    label: str
    score: float
    box: list[float]


def _area(box: list[float]) -> float:
    return max(0.0, box[2] - box[0]) * max(0.0, box[3] - box[1])


def _shared(a: list[float], b: list[float]) -> float:
    return _area([max(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), min(a[3], b[3])])


def _iou(a: list[float], b: list[float]) -> float:
    shared = _shared(a, b)
    return shared / (_area(a) + _area(b) - shared) if shared else 0.0


def _inside(a: list[float], b: list[float]) -> float:
    """The share of a that lies in b."""
    return _shared(a, b) / _area(a) if _area(a) else 0.0


def _around(boxes: list[list[float]]) -> list[float]:
    return [
        min(b[0] for b in boxes),
        min(b[1] for b in boxes),
        max(b[2] for b in boxes),
        max(b[3] for b in boxes),
    ]


def figure_boxes(regions: tuple[Region, ...]) -> list[Region]:
    """The picture and chart boxes a window picks from, top to bottom, then
    left to right. One of two nearly equal boxes stays. A box that holds a
    smaller box and also text outside it goes: it is the figure with its
    options or question text (2022 Paper 2 Q14)."""
    found: list[Region] = []
    for region in sorted(regions, key=lambda r: -r.score):
        if (
            region.label in FIGURE_LABELS
            and region.score >= MIN_SCORE
            and all(_iou(region.box, kept.box) < SAME_BOX_IOU for kept in found)
        ):
            found.append(region)
    found.sort(key=lambda r: (round(r.box[1] / 20), r.box[0]))
    texts = [r.box for r in regions if r.label == "text" and r.score >= MIN_SCORE]

    def holds_more(outer: Region) -> bool:
        return any(
            inner is not outer
            and _area(inner.box) < _area(outer.box)
            and _inside(inner.box, outer.box) >= NESTED_INSIDE
            and any(
                _inside(text, outer.box) >= 0.5 and _inside(text, inner.box) < 0.5
                for text in texts
            )
            for inner in found
        )

    return [region for region in found if not holds_more(region)]


def crop_box(boxes: list[list[float]], regions: tuple[Region, ...]) -> list[float]:
    """The crop of a figure's boxes: around them all, grown to take in a
    caption found just above or below with its middle over them, padded 1%."""
    around = _around(boxes)
    grown = [around]
    for region in regions:
        if region.label != CAPTION_LABEL or region.score < MIN_SCORE:
            continue
        caption = region.box
        gap = max(caption[1] - around[3], around[1] - caption[3])
        if around[0] <= (caption[0] + caption[2]) / 2 <= around[2] and (
            gap <= CAPTION_GAP
        ):
            grown.append(caption)
    crop = _around(grown)
    return [
        max(0.0, crop[0] - CROP_PAD),
        max(0.0, crop[1] - CROP_PAD),
        min(1000.0, crop[2] + CROP_PAD),
        min(1000.0, crop[3] + CROP_PAD),
    ]


def jpeg_of(data_url: str) -> bytes:
    return base64.b64decode(data_url.split(",", 1)[1])


def grown_to_ink(jpeg: bytes, boxes: list[list[float]]) -> list[list[float]]:
    """Each box pushed outward over the ink on the page image the model saw:
    each edge in turn moves while the strip just outside it holds ink, until none
    moves, then the margin goes on."""
    with Image.open(io.BytesIO(jpeg)) as page:
        mask = page.convert("L").point(lambda v: 255 if v < INK_LEVEL else 0)
    return [_grown(mask, box) for box in boxes]


def _grown(mask: Image.Image, box: list[float]) -> list[float]:
    width, height = mask.size
    sx, sy = width / 1000, height / 1000
    x0, y0, x1, y1 = (
        round(box[0] * sx),
        round(box[1] * sy),
        round(box[2] * sx),
        round(box[3] * sy),
    )
    left, top = max(0, x0 - round(INK_CAP * sx)), max(0, y0 - round(INK_CAP * sy))
    right = min(width - 1, x1 + round(INK_CAP * sx))
    bottom = min(height - 1, y1 + round(INK_CAP * sy))
    gap_x, gap_y = max(1, round(INK_GAP * sx)), max(1, round(INK_GAP * sy))

    def reach(start: int, limit: int, step: int, gap: int, strip) -> int:
        """How far an edge gets from start toward limit, one pixel at a time."""
        position, blank, edge = start, 0, start
        while (limit - position) * step > 0 and blank < gap:
            position += step
            if mask.crop(strip(position)).histogram()[255] >= INK_MIN:
                edge, blank = position, 0
            else:
                blank += 1
        return edge

    # Both read the edges as they stand when called.
    def column(p: int) -> tuple[int, int, int, int]:
        return (p, y0, p + 1, y1 + 1)

    def row(p: int) -> tuple[int, int, int, int]:
        return (x0, p, x1 + 1, p + 1)

    moved = True
    while moved:
        before = (x0, y0, x1, y1)
        x0 = reach(x0, left, -1, gap_x, column)
        x1 = reach(x1, right, 1, gap_x, column)
        y0 = reach(y0, top, -1, gap_y, row)
        y1 = reach(y1, bottom, 1, gap_y, row)
        moved = (x0, y0, x1, y1) != before
    return [
        max(0.0, x0 / sx - INK_MARGIN),
        max(0.0, y0 / sy - INK_MARGIN),
        min(1000.0, (x1 + 1) / sx + INK_MARGIN),
        min(1000.0, (y1 + 1) / sy + INK_MARGIN),
    ]


def _parsed(data: Any) -> tuple[Region, ...]:
    try:
        regions = tuple(
            Region(str(r["label"]), float(r["score"]), [float(v) for v in r["box"]])
            for r in data["regions"]
        )
    except (KeyError, TypeError) as exc:
        raise ValueError("the layout reply is not regions") from exc
    if any(len(region.box) != 4 for region in regions):
        raise ValueError("the layout reply has a box that is not four numbers")
    return regions


async def _page(client: httpx.AsyncClient, jpeg: bytes) -> tuple[Region, ...]:
    for attempt in range(BUSY_TRIES):
        response = await client.post(
            f"{cfg.layout_url.rstrip('/')}/regions",
            content=jpeg,
            headers={
                "Authorization": f"Bearer {cfg.layout_token}",
                "Content-Type": "image/jpeg",
            },
        )
        if response.status_code != 429:
            response.raise_for_status()
            return _parsed(response.json())
        if attempt < BUSY_TRIES - 1:
            await asyncio.sleep(random.uniform(*BUSY_WAIT_S))
    raise ValueError(f"the layout service stayed busy for {BUSY_TRIES} tries")


async def read_regions(
    images: list[Callable[[], Awaitable[str]]],
) -> list[tuple[Region, ...]]:
    """Each page's regions, from its image as a data URL, in order; none for a
    page whose request failed or ran out of time."""
    found: list[tuple[Region, ...]] = [() for _ in images]
    if not cfg.layout_url:
        return found
    gate = asyncio.Semaphore(PAGES_IN_FLIGHT)

    async def one(client: httpx.AsyncClient, index: int) -> None:
        async with gate:
            jpeg = jpeg_of(await images[index]())
            try:
                found[index] = await _page(client, jpeg)
            except (httpx.HTTPError, httpx.InvalidURL, ValueError) as exc:
                # The exception's type and message: no page content.
                log.warning("layout page %d failed: %r", index + 1, exc)

    try:
        async with (
            asyncio.timeout(ALL_PAGES_TIMEOUT_S),
            httpx.AsyncClient(timeout=REQUEST_TIMEOUT_S, trust_env=False) as client,
        ):
            await asyncio.gather(*(one(client, i) for i in range(len(images))))
    except TimeoutError:
        log.warning("layout ran out of time on %d pages", len(images))
    return found
