"""Move source-confirmed column continuations ahead of intervening small print."""

from __future__ import annotations

import copy
import re
import unicodedata
from pathlib import Path

import pymupdf

from .source_text import RAW_FLAGS, center_inside, compact, rect_for, source_text


def canonical(text: str) -> str:
    text = unicodedata.normalize("NFKC", text).replace("\xad", "")
    text = re.sub(r"(?<=[^\W\d_])-[ \t]*\n\s*(?=[a-zäöüß])", "", text)
    return compact(text)


def _text(block: dict) -> str:
    return (
        block.get("text", "")
        if block.get("type") == "text"
        else "\n".join(block.get("list_items", []))
    )


def _source_page(page: pymupdf.Page):
    groups = page.get_text("rawdict", flags=RAW_FLAGS)["blocks"]
    glyphs = []
    for span in page.get_texttrace():
        if span["type"] == 3 or span["opacity"] < 0.99 or span["dir"][0] < 0.99:
            continue
        for code, _, origin, box in span["chars"]:
            if chr(code).isalnum():
                glyphs.append((box, origin, span["font"], span["size"]))
    return groups, glyphs


def _selected_glyphs(glyphs, area):
    return sorted(
        [g for g in glyphs if center_inside(g[0], area)],
        key=lambda g: (round(g[1][1], 1), g[1][0]),
    )


def _prove(page, groups, glyphs, left, right, intervening) -> bool:
    a, b = rect_for(left, page), rect_for(right, page)
    first, following = _text(left).strip(), _text(right).strip()
    stop = re.search(r"[.!?](?=\s|$)", following)
    if stop is None or not 20 <= stop.end() <= 400:
        return False
    prefix = following[: stop.end()]
    if canonical(source_text(groups, a)) != canonical(first):
        return False
    if not canonical(source_text(groups, b)).startswith(canonical(prefix)):
        return False
    ag, bg = _selected_glyphs(glyphs, a), _selected_glyphs(glyphs, b)
    if not ag or not bg:
        return False
    font, size = ag[-1][2:]
    if bg[0][2] != font or abs(bg[0][3] - size) > 0.05:
        return False
    # The endpoints must be the last/first body-sized text in their columns.
    if any(
        g[3] >= size * 0.95
        and (
            a.x0 <= g[1][0] <= a.x1
            and g[1][1] > a.y1 + 1
            or b.x0 <= g[1][0] <= b.x1
            and g[1][1] < b.y0 - 1
        )
        for g in glyphs
    ):
        return False
    for block in intervening:
        if block.get("text_level") or len(block.get("bbox", [])) != 4:
            return False
        box = rect_for(block, page)
        if not (
            box.x1 <= a.x1 + 1
            and box.y0 >= a.y1 - 1
            or box.x0 >= b.x0 - 1
            and box.y1 <= b.y0 + 1
        ):
            return False
        selected = _selected_glyphs(glyphs, box)
        if not selected or max(g[3] for g in selected) > size * 0.92:
            return False
    return True


def repair_columns(blocks: list[dict], pdf: Path) -> tuple[list[dict], int]:
    result = copy.deepcopy(blocks)
    moves = 0
    with pymupdf.open(pdf) as document:
        for number in sorted({b["page_idx"] for b in blocks}):
            slots = [i for i, b in enumerate(result) if b["page_idx"] == number]
            page_blocks = [result[i] for i in slots]
            groups = glyphs = None
            moved = False
            for i, left in enumerate(page_blocks):
                a = left.get("bbox", [])
                if (
                    len(a) != 4
                    or left.get("type") not in {"text", "list"}
                    or left.get("text_level")
                    or len(_text(left)) < 25
                    or not re.search(r"\w$", _text(left).strip())
                    or a[1] < 650
                    or a[2] - a[0] < 200
                ):
                    continue
                for j in range(i + 2, min(i + 32, len(page_blocks))):
                    right = page_blocks[j]
                    b = right.get("bbox", [])
                    if (
                        len(b) != 4
                        or right.get("type") != "text"
                        or right.get("text_level")
                        or a[2] + 15 >= b[0]
                        or a[1] < b[1] + 200
                        or not 0.8 <= (b[2] - b[0]) / (a[2] - a[0]) <= 1.2
                    ):
                        continue
                    page = document[number]
                    if page.rotation:
                        break
                    if groups is None:
                        groups, glyphs = _source_page(page)
                    if not _prove(
                        page, groups, glyphs, left, right, page_blocks[i + 1 : j]
                    ):
                        continue
                    ordered = (
                        page_blocks[: i + 1]
                        + [right]
                        + page_blocks[i + 1 : j]
                        + page_blocks[j + 1 :]
                    )
                    for slot, block in zip(slots, ordered):
                        result[slot] = block
                    moves += 1
                    moved = True
                    break
                if moved:
                    break
    return result, moves
