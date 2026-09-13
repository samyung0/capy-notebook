"""Conservative two-column reading order on a page's saved blocks."""

from __future__ import annotations

import re
import unicodedata
from collections import Counter
from pathlib import Path

import pymupdf

TEXT_FLAGS = pymupdf.TEXTFLAGS_DICT & ~pymupdf.TEXT_PRESERVE_IMAGES


def text(block: dict) -> str:
    return " ".join([block.get("text", ""), *block.get("list_items", [])])


def normal(value: str) -> str:
    return "".join(
        c for c in unicodedata.normalize("NFKC", value).casefold() if c.isalnum()
    )


def _signature(block: dict) -> str:
    import json

    return json.dumps(block, sort_keys=True)


def repair_page(blocks: list[dict]) -> tuple[list[dict], str]:
    """Reorder only a page with two tall text columns and an empty gutter.

    Whole-page, left-to-right columns only. Mixed layouts, tables and images
    stay untouched.
    """
    if any(b.get("type") not in {"text", "list"} for b in blocks):
        return blocks, "non_prose_block"
    if any(len(b.get("bbox", [])) != 4 for b in blocks):
        return blocks, "missing_geometry"
    body = [
        b
        for b in blocks
        if len(text(b)) >= 80
        and not b.get("text_level")
        and b["bbox"][2] - b["bbox"][0] >= 200
    ]
    if len(body) < 4:
        return blocks, "insufficient_prose"
    left_edge = min(b["bbox"][0] for b in body)
    right_edge = max(b["bbox"][2] for b in body)
    candidates = sorted({b["bbox"][2] for b in body})
    for edge in candidates:
        left = [b for b in body if b["bbox"][2] <= edge]
        right = [b for b in body if b["bbox"][0] >= edge + 15]
        if len(left) < 2 or len(right) < 2 or len(left) + len(right) != len(body):
            continue
        cut = (edge + min(b["bbox"][0] for b in right)) / 2
        if (
            not left_edge + (right_edge - left_edge) * 0.3
            < cut
            < left_edge + (right_edge - left_edge) * 0.7
        ):
            continue
        if any(
            max(b["bbox"][3] for b in col) - min(b["bbox"][1] for b in col) < 300
            for col in [left, right]
        ):
            continue
        top = min(b["bbox"][1] for b in body)
        bottom = max(b["bbox"][3] for b in body)
        # Short full-width text inside the columns signals a different layout.
        if any(
            b["bbox"][0] < cut < b["bbox"][2]
            and b["bbox"][1] < bottom
            and b["bbox"][3] > top
            for b in blocks
        ):
            return blocks, "spanning_body_block"
        slots = [
            i
            for i, b in enumerate(blocks)
            if b["bbox"][0] >= left_edge - 2
            and b["bbox"][2] <= right_edge + 2
            and b["bbox"][1] >= top - 2
            and b["bbox"][3] <= bottom + 2
        ]
        ordered = sorted(
            (blocks[i] for i in slots),
            key=lambda b: (b["bbox"][0] >= cut, b["bbox"][1], b["bbox"][0]),
        )
        result = blocks.copy()
        for i, b in zip(slots, ordered):
            result[i] = b
        return result, "reordered" if result != blocks else "already_ordered"
    return blocks, "no_clear_columns"


def repair(blocks: list[dict]) -> tuple[list[dict], set[int]]:
    """Reorder each page independently; return the pages that changed."""
    result = blocks.copy()
    reordered: set[int] = set()
    for page in sorted({b["page_idx"] for b in blocks}):
        slots = [i for i, b in enumerate(blocks) if b["page_idx"] == page]
        ordered, reason = repair_page([blocks[i] for i in slots])
        for i, block in zip(slots, ordered):
            result[i] = block
        if reason == "reordered":
            reordered.add(page)
    assert Counter(map(_signature, blocks)) == Counter(map(_signature, result))
    return result, reordered


def move_rotated_labels(blocks: list[dict], pages: set[int], pdf: Path) -> list[dict]:
    """Move source-confirmed vertical sidebar labels ahead of the page's prose.

    The heading level is kept (the lab's ``demote=False`` arm).
    """
    result = blocks.copy()
    with pymupdf.open(pdf) as document:
        for page in sorted(pages):
            source = document[page]
            rotated = []
            for group in source.get_text("dict", flags=TEXT_FLAGS)["blocks"]:
                for line in group.get("lines", []):
                    if abs(line["dir"][0]) < 0.1:
                        rotated.append(line)
            labels = []
            for index, block in enumerate(result):
                if block["page_idx"] != page or not block.get("text_level"):
                    continue
                box = block["bbox"]
                rect = pymupdf.Rect(
                    box[0] * source.rect.width / 1000,
                    box[1] * source.rect.height / 1000,
                    box[2] * source.rect.width / 1000,
                    box[3] * source.rect.height / 1000,
                )
                matching = [
                    line
                    for line in rotated
                    if (pymupdf.Rect(line["bbox"]) & rect).get_area()
                    >= pymupdf.Rect(line["bbox"]).get_area() * 0.8
                ]
                source_text = " ".join(
                    "".join(s["text"] for s in line["spans"]) for line in matching
                )
                if normal(source_text) == normal(text(block)) and normal(source_text):
                    labels.append((index, block.copy()))
            if labels:
                page_slots = [i for i, b in enumerate(result) if b["page_idx"] == page]
                removed = {i for i, _ in labels}
                replacement = [b for _, b in labels] + [
                    result[i] for i in page_slots if i not in removed
                ]
                for index, block in zip(page_slots, replacement):
                    result[index] = block
    return result


def split_continuations(blocks: list[dict], pages: set[int], pdf: Path) -> list[dict]:
    """Expose a small column-continuation prefix to the chunk packer.

    Every derived right-column block keeps the original right-column box.
    """
    result: list[dict] = []
    with pymupdf.open(pdf) as document:
        for index, block in enumerate(blocks):
            previous = blocks[index - 1] if index else None
            page = block["page_idx"]
            if previous is None or page not in pages or previous["page_idx"] != page:
                result.append(block)
                continue
            left, right = previous["bbox"], block["bbox"]
            if (
                previous.get("type") not in {"text", "list"}
                or block.get("type") != "text"
                or previous.get("text_level")
                or block.get("text_level")
                or left[2] + 15 >= right[0]
                or left[1] <= right[1] + 100
                or not re.search(r"\w$", text(previous))
            ):
                result.append(block)
                continue
            split = re.search(r"[.!?](?=\s)", block["text"])
            if split is None or not 10 <= split.end() <= 400:
                result.append(block)
                continue
            source = document[page]
            spans = [
                s
                for g in source.get_text("dict", flags=TEXT_FLAGS)["blocks"]
                for line in g.get("lines", [])
                if line["dir"][0] > 0.99
                for s in line["spans"]
                if s["text"].strip()
            ]

            def boundary_font(box, first, source=source, spans=spans):
                rect = pymupdf.Rect(
                    box[0] * source.rect.width / 1000,
                    box[1] * source.rect.height / 1000,
                    box[2] * source.rect.width / 1000,
                    box[3] * source.rect.height / 1000,
                )
                selected = [
                    s
                    for s in spans
                    if (pymupdf.Rect(s["bbox"]) & rect).get_area()
                    >= pymupdf.Rect(s["bbox"]).get_area() * 0.8
                ]
                selected.sort(key=lambda s: (round(s["origin"][1], 1), s["origin"][0]))
                if not selected:
                    return None
                span = selected[0 if first else -1]
                return span["font"], round(span["size"], 1)

            font = boundary_font(left, False)
            if font is None or font != boundary_font(right, True):
                result.append(block)
                continue
            prefix, remainder = (
                block["text"][: split.end()],
                block["text"][split.end() :],
            )
            result.extend([{**block, "text": prefix}, {**block, "text": remainder}])
    return result
