"""Column order on pages whose text layer is a hidden OCR layer over a scan."""

from __future__ import annotations

import json
from itertools import pairwise

import pymupdf


def source_facts(page: pymupdf.Page) -> dict:
    spans = page.get_texttrace()
    count = sum(len(span["chars"]) for span in spans)
    hidden = sum(
        len(span["chars"])
        for span in spans
        if span["type"] == 3 or span["opacity"] == 0
    )
    coverage = max(
        (
            (pymupdf.Rect(image["bbox"]) & page.rect).get_area() / page.rect.get_area()
            for image in page.get_image_info()
        ),
        default=0,
    )
    return {
        "characters": count,
        "hidden_characters": hidden,
        "largest_image_fraction": coverage,
        "eligible": count >= 100 and hidden >= 0.9 * count and coverage >= 0.9,
    }


def block_text(block: dict) -> str:
    return block.get("text", block.get("latex", "\n".join(block.get("list_items", []))))


def gutter(blocks: list[dict]) -> float | None:
    candidates = [
        block
        for block in blocks
        if len(block_text(block)) >= 100
        and "bbox" in block
        and block["bbox"][2] - block["bbox"][0] < 600
    ]
    starts = sorted({block["bbox"][0] for block in candidates})
    if len(starts) < 2:
        return None
    left, right = max(pairwise(starts), key=lambda pair: pair[1] - pair[0])
    if right - left < 150:
        return None
    boundary = (left + right) / 2
    end = max(block["bbox"][2] for block in candidates if block["bbox"][0] < boundary)
    start = min(
        block["bbox"][0] for block in candidates if block["bbox"][0] >= boundary
    )
    return (end + start) / 2 if start > end else None


def column_order(blocks: list[dict], cut: float) -> list[dict]:
    images = [block for block in blocks if block.get("type") in {"image", "chart"}]
    text = [block for block in blocks if block not in images]
    wide = sorted(
        [
            block
            for block in text
            if block["bbox"][0] < cut - 80 and block["bbox"][2] > cut + 80
        ],
        key=lambda block: block["bbox"][1],
    )
    remaining = [block for block in text if block not in wide]
    result = images.copy()

    def ordered(items: list[dict]) -> list[dict]:
        return sorted(
            items,
            key=lambda block: (
                (block["bbox"][0] + block["bbox"][2]) / 2 > cut,
                block["bbox"][1],
                block["bbox"][0],
            ),
        )

    for barrier in wide:
        above = [
            block
            for block in remaining
            if (block["bbox"][1] + block["bbox"][3]) / 2 < barrier["bbox"][1]
        ]
        result.extend(ordered(above))
        result.append(barrier)
        remaining = [block for block in remaining if block not in above]
    result.extend(ordered(remaining))
    return result


def recover_hidden_ocr_order(
    blocks: list[dict], eligible_pages: set[int]
) -> list[dict]:
    """Reorder only source-verified hidden OCR pages; preserve every block."""
    result = blocks.copy()
    for page in sorted({block["page_idx"] for block in blocks}):
        positions = [
            index for index, block in enumerate(blocks) if block["page_idx"] == page
        ]
        original = [blocks[index] for index in positions]
        cut = gutter(original) if page in eligible_pages else None
        if cut is None or any("bbox" not in block for block in original):
            continue
        ordered = column_order(original, cut)
        assert column_order(ordered, cut) == ordered
        assert sorted(
            json.dumps(block, sort_keys=True) for block in original
        ) == sorted(json.dumps(block, sort_keys=True) for block in ordered)
        for index, block in zip(positions, ordered):
            result[index] = block
    return result
