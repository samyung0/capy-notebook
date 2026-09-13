"""Source text beneath a block: overprint deletion and paragraph-role proof.

Every repair here requires the page's own glyphs to prove it; nothing is
inferred from the parser output alone.
"""

from __future__ import annotations

import copy
import itertools
import re
from collections import Counter
from pathlib import Path

import pymupdf

RAW_FLAGS = pymupdf.TEXTFLAGS_RAWDICT & ~pymupdf.TEXT_PRESERVE_IMAGES


def compact(text: str) -> str:
    return "".join(text.split())


def runs(text: str) -> list[tuple[str, int]]:
    return [
        (char, len(list(group))) for char, group in itertools.groupby(compact(text))
    ]


def rect_for(block: dict, page: pymupdf.Page) -> pymupdf.Rect:
    box = block["bbox"]
    return pymupdf.Rect(
        box[0] * page.rect.width / 1000,
        box[1] * page.rect.height / 1000,
        box[2] * page.rect.width / 1000,
        box[3] * page.rect.height / 1000,
    )


def center_inside(box, area: pymupdf.Rect) -> bool:
    return area.contains(pymupdf.Point((box[0] + box[2]) / 2, (box[1] + box[3]) / 2))


def disjoint(box, area: pymupdf.Rect) -> bool:
    return box[0] > area.x1 or box[2] < area.x0 or box[1] > area.y1 or box[3] < area.y0


def source_text(groups: list[dict], area: pymupdf.Rect) -> str:
    return "\n".join(
        "".join(
            char["c"]
            for span in line["spans"]
            if not disjoint(span["bbox"], area)
            for char in span["chars"]
            if center_inside(char["bbox"], area)
        )
        for group in groups
        if not disjoint(group["bbox"], area)
        for line in group.get("lines", [])
        if abs(line["dir"][0] - 1) < 0.01 and abs(line["dir"][1]) < 0.01
    )


def overprints(traces: list[dict], area: pymupdf.Rect) -> Counter:
    """Count only identical source glyphs painted within six percent of an em."""
    clusters: list[dict] = []
    for span in traces:
        if span["opacity"] < 0.99 or span["type"] == 3:
            continue
        if abs(span["dir"][0] - 1) > 0.01 or abs(span["dir"][1]) > 0.01:
            continue
        for code, glyph, origin, box in span["chars"]:
            if not center_inside(box, area):
                continue
            key = (code, glyph, span["font"], round(span["size"], 3))
            match = next(
                (
                    c
                    for c in reversed(clusters[-8:])
                    if c["key"] == key
                    and max(abs(a - b) for a, b in zip(c["origin"], origin))
                    <= span["size"] * 0.06
                ),
                None,
            )
            if match is None:
                clusters.append({"key": key, "origin": origin, "count": 1})
            else:
                match["count"] += 1
    duplicates: Counter = Counter()
    for cluster in clusters:
        if cluster["count"] > 1:
            duplicates[chr(cluster["key"][0])] += cluster["count"] - 1
    return duplicates


def delete_supported_repeats(
    text: str, source: str, duplicates: Counter
) -> tuple[str, dict[str, int]]:
    before, after = runs(text), runs(source)
    if len(before) != len(after) or not before:
        return text, {}
    removed: Counter = Counter()
    for (char, count), (other, target) in zip(before, after):
        if char != other or target > count:
            return text, {}
        removed[char] += count - target
    removed += Counter()  # Drop zero-count entries.
    if not removed or any(removed[c] > duplicates[c] for c in removed):
        return text, {}
    output: list[str] = []
    run_index, seen = -1, 0
    last, separated = None, False
    for char in text:
        if char.isspace():
            output.append(char)
            separated = True
            continue
        if char != last:
            run_index += 1
            seen = 0
            last = char
        elif separated and after[run_index][1] < before[run_index][1]:
            # A compact run spanning words cannot safely allocate deleted copies.
            return text, {}
        separated = False
        seen += 1
        if seen <= after[run_index][1]:
            output.append(char)
    result = "".join(output)
    assert compact(result) == compact(source)
    return result, dict(removed)


def same_source_paragraph(
    first: dict, following: dict, groups: list[dict], page: pymupdf.Page
) -> bool:
    text = first["text"].strip()
    tail = following.get("text", "").lstrip()
    if len(text) < 35 or text[-1] in ".!?。！？:：;；" or not tail[:1].islower():
        return False
    if following.get("type") != "text" or following.get("text_level"):
        return False
    a, b = rect_for(first, page), rect_for(following, page)
    if not 0 <= b.y0 - a.y1 <= a.height or abs(a.x1 - b.x1) > a.height:
        return False
    for group in groups:
        lines = group.get("lines", [])
        for line, next_line in itertools.pairwise(lines):
            if any(abs(item["dir"][0] - 1) > 0.01 for item in [line, next_line]):
                continue
            line_text = "".join(c["c"] for s in line["spans"] for c in s["chars"])
            next_text = "".join(c["c"] for s in next_line["spans"] for c in s["chars"])
            prefix = compact(next_text).rstrip("-‐‑")
            if compact(text) != compact(line_text) or len(prefix) < 12:
                continue
            if not compact(tail).startswith(prefix):
                continue
            if not center_inside(line["bbox"], a) or not center_inside(
                next_line["bbox"], b
            ):
                continue
            return True
    return False


def repair_text(
    blocks: list[dict], pdf: Path, *, paragraphs: bool = False
) -> tuple[list[dict], int]:
    """Delete source-proven overprints; demote headings that are paragraph starts.

    Returns rewritten copies and the number of repairs; geometry is unchanged.
    """
    revised = copy.deepcopy(blocks)
    repairs = 0
    cache: dict[int, list[dict]] = {}
    traces: dict[int, list[dict]] = {}
    with pymupdf.open(pdf) as document:
        for index, block in enumerate(revised):
            if block.get("type") != "text" or len(block.get("bbox", [])) != 4:
                continue
            repeat = re.search(r"(\S)\1{2,}", block.get("text", ""))
            heading = (
                paragraphs and block.get("text_level") and index + 1 < len(revised)
            )
            if heading:
                following = revised[index + 1]
                text = block["text"].strip()
                heading = (
                    len(text) >= 35
                    and text[-1] not in ".!?。！？:：;；"
                    and following.get("text", "").lstrip()[:1].islower()
                    and following.get("page_idx") == block["page_idx"]
                    and not following.get("text_level")
                )
            if not repeat and not heading:
                continue
            page_index = block["page_idx"]
            page = document[page_index]
            if page.rotation:
                continue
            if page_index not in cache:
                cache[page_index] = page.get_text("rawdict", flags=RAW_FLAGS)["blocks"]
            groups = cache[page_index]
            if repeat:
                area = rect_for(block, page)
                source = source_text(groups, area)
                changed, removed = delete_supported_repeats(
                    block["text"], source, Counter(block["text"])
                )
                if removed:
                    if page_index not in traces:
                        traces[page_index] = page.get_texttrace()
                    duplicates = overprints(traces[page_index], area)
                    if any(count > duplicates[char] for char, count in removed.items()):
                        continue
                    block["text"] = changed
                    repairs += 1
            if heading:
                following = revised[index + 1]
                if (
                    following.get("page_idx") != page_index
                    or len(following.get("bbox", [])) != 4
                ):
                    continue
                if same_source_paragraph(block, following, groups, page):
                    del block["text_level"]
                    repairs += 1
    return revised, repairs
