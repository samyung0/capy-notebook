"""Retain source-confirmed headings that the packed chunks omit.

A ``text_level`` block becomes part of the section path of the body that
follows it, so a heading with no body on its page (a figure title, a label, a
heading whose body starts on the next page) vanishes from the index. This adds
each such heading as its own small chunk when the page's glyphs prove it is
real, visible text. Ported from the September 2026 parser lab
(``bench/parsers/scripts/experiment_odl_heading_retention.py``); every existing
chunk is kept unchanged.
"""

from __future__ import annotations

import re
import unicodedata
from collections import defaultdict
from pathlib import Path

import pymupdf

from .chunking import Chunk, Region

RAW_FLAGS = pymupdf.TEXTFLAGS_RAWDICT & ~pymupdf.TEXT_PRESERVE_IMAGES


def compact(text: str) -> str:
    return "".join(text.split())


def canonical(text: str) -> str:
    text = unicodedata.normalize("NFKC", text).replace("\xad", "")
    text = re.sub(r"(?<=[^\W\d_])-[ \t]*\n\s*(?=[a-zäöüß])", "", text)
    return compact(text)


def _rect_for(block: dict, page: pymupdf.Page) -> pymupdf.Rect:
    box = block["bbox"]
    return pymupdf.Rect(
        box[0] * page.rect.width / 1000,
        box[1] * page.rect.height / 1000,
        box[2] * page.rect.width / 1000,
        box[3] * page.rect.height / 1000,
    )


def _center_inside(box, area: pymupdf.Rect) -> bool:
    return area.contains(pymupdf.Point((box[0] + box[2]) / 2, (box[1] + box[3]) / 2))


def _disjoint(box, area: pymupdf.Rect) -> bool:
    return box[0] > area.x1 or box[2] < area.x0 or box[1] > area.y1 or box[3] < area.y0


def _source_text(groups: list[dict], area: pymupdf.Rect) -> str:
    return "\n".join(
        "".join(
            char["c"]
            for span in line["spans"]
            if not _disjoint(span["bbox"], area)
            for char in span["chars"]
            if _center_inside(char["bbox"], area)
        )
        for group in groups
        if not _disjoint(group["bbox"], area)
        for line in group.get("lines", [])
        if abs(line["dir"][0] - 1) < 0.01 and abs(line["dir"][1]) < 0.01
    )


def retain_headings(blocks: list[dict], pdf: Path, chunks: list[Chunk]) -> list[Chunk]:
    """Add literal source headings, keeping every original chunk unchanged."""
    locations: dict[tuple[int, tuple], list[int]] = defaultdict(list)
    furniture: dict[tuple[str, bool], set[int]] = defaultdict(set)
    for index, block in enumerate(blocks):
        if len(block.get("bbox", [])) == 4 and isinstance(block.get("page_idx"), int):
            locations[(block["page_idx"] + 1, tuple(block["bbox"]))].append(index)
        text = block.get("text", "")
        box = block.get("bbox", [])
        if text and len(box) == 4 and (box[3] < 100 or box[1] > 900):
            label = re.sub(r"\d+", "", canonical(text))
            if label:
                furniture[(label, box[3] < 100)].add(block["page_idx"])
    spans = []
    for chunk in chunks:
        positions = [
            i
            for region in chunk.regions
            for i in locations.get((region.page, tuple(region.bbox)), [])
        ]
        spans.append((min(positions), max(positions)) if positions else None)
    insertions: dict[int, list[Chunk]] = defaultdict(list)
    pages: dict[int, tuple[list[dict], list[dict]]] = {}
    with pymupdf.open(pdf) as document:
        for index, block in enumerate(blocks):
            text = block.get("text", "")
            box = block.get("bbox", [])
            if (
                not block.get("text_level")
                or len(box) != 4
                or not any(c.isalpha() for c in text)
            ):
                continue
            page_number = block["page_idx"] + 1
            page_chunks = [
                c
                for c in chunks
                if c.page_start is not None
                and c.page_start <= page_number <= (c.page_end or c.page_start)
            ]
            if any(
                canonical(text) in canonical(value)
                for c in page_chunks
                for value in (c.text, c.section_path, c.indexed_text())
            ):
                continue
            label = re.sub(r"\d+", "", canonical(text))
            if (box[3] < 100 or box[1] > 900) and len(
                furniture[(label, box[3] < 100)]
            ) >= 3:
                continue
            if not 1 <= page_number <= len(document):
                continue
            page = document[page_number - 1]
            if page.rotation:
                continue
            if page_number not in pages:
                pages[page_number] = (
                    page.get_text("rawdict", flags=RAW_FLAGS)["blocks"],
                    page.get_texttrace(),
                )
            groups, traces = pages[page_number]
            area = _rect_for(block, page)
            if canonical(_source_text(groups, area)) != canonical(text):
                continue
            visible = sum(
                1
                for span in traces
                if span["opacity"] >= 0.99
                and span["type"] != 3
                and span["dir"][0] > 0.99
                for char in span["chars"]
                if chr(char[0]).isalpha() and _center_inside(char[3], area)
            )
            if visible < sum(c.isalpha() for c in text):
                continue
            if any(span and span[0] < index < span[1] for span in spans):
                continue
            slot = next(
                (j for j, span in enumerate(spans) if span and span[0] > index),
                len(chunks),
            )
            insertions[slot].append(
                Chunk(
                    text=text,
                    page_start=page_number,
                    page_end=page_number,
                    regions=[Region(page_number, list(box))],
                )
            )
    result: list[Chunk] = []
    for index in range(len(chunks) + 1):
        result.extend(insertions[index])
        if index < len(chunks):
            result.append(chunks[index])
    return result
