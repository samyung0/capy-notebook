"""Retain source-confirmed headings that the packed chunks omit.

A ``text_level`` block becomes part of the section path of the body that
follows it, so a heading with no body on its page (a figure title, a label, a
heading whose body starts on the next page) vanishes from the index. This adds
each such heading as its own small chunk when the page's glyphs prove it is
real, visible text: ``verified`` names those blocks, from the parser's frozen
Office evidence or the ingest decode helper (ingest/decode.py). Ported from
the September 2026 parser lab
(``bench/parsers/scripts/experiment_odl_heading_retention.py``); every existing
chunk is kept unchanged.
"""

from __future__ import annotations

import re
import unicodedata
from collections import defaultdict

from .chunking import Chunk, Region


def compact(text: str) -> str:
    return "".join(text.split())


def canonical(text: str) -> str:
    text = unicodedata.normalize("NFKC", text).replace("\xad", "")
    text = re.sub(r"(?<=[^\W\d_])-[ \t]*\n\s*(?=[a-zäöüß])", "", text)
    return compact(text)


def retain_headings(
    blocks: list[dict], chunks: list[Chunk], *, verified: set[int]
) -> list[Chunk]:
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
        if index not in verified:
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
