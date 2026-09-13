"""List repairs: descendant geometry from the Java tree, then the frozen
overprint proof applied without moving an item boundary."""

from __future__ import annotations

import copy
import math
import re
from collections import defaultdict
from pathlib import Path

import pymupdf

from .adapter import node_text, nodes
from .source_text import repair_text, runs


def _flattened_nodes(node: dict):
    if isinstance(node.get("content"), str) and node["content"].strip():
        yield node
    # Match exactly the recursion used by node_text, not table/image traversal.
    for key in ["kids", "list items", "toc items"]:
        for child in node.get(key, []):
            yield from _flattened_nodes(child)


def _normalized(box, page: pymupdf.Page) -> list[float]:
    return [
        round(box[0] / page.rect.width * 1000, 3),
        round((page.rect.height - box[3]) / page.rect.height * 1000, 3),
        round(box[2] / page.rect.width * 1000, 3),
        round((page.rect.height - box[1]) / page.rect.height * 1000, 3),
    ]


def _valid(box, page: pymupdf.Page) -> bool:
    return (
        isinstance(box, list)
        and len(box) == 4
        and all(isinstance(v, (int, float)) and math.isfinite(v) for v in box)
        and 0 <= box[0] < box[2] <= page.rect.width
        and 0 <= box[1] < box[3] <= page.rect.height
    )


def repair_list_geometry(
    blocks: list[dict], native_document: dict, parsed_pdf: Path
) -> tuple[list[dict], int]:
    """Union a list's box with its flattened descendants. Runs before glyph
    repairs and requires exact original Java list identity."""
    by_id = defaultdict(list)
    for node in nodes(native_document):
        if "id" in node:
            by_id[node["id"]].append(node)
    revised = copy.deepcopy(blocks)
    expanded = 0
    with pymupdf.open(parsed_pdf) as document:
        for block in revised:
            if block.get("type") != "list":
                continue
            matches = by_id[block.get("_native_id")]
            if len(matches) != 1 or matches[0].get("type") != "list":
                continue
            native = matches[0]
            items = native.get("list items", [])
            if [node_text(item) for item in items] != block.get("list_items"):
                continue
            number = native.get("page number")
            children = [child for item in items for child in _flattened_nodes(item)]
            if (
                not isinstance(number, int)
                or not 1 <= number <= len(document)
                or block.get("page_idx") != number - 1
                or not children
                or any(child.get("page number") != number for child in children)
            ):
                continue
            page = document[number - 1]
            boxes = [native.get("bounding box")] + [
                child.get("bounding box") for child in children
            ]
            if page.rotation or any(not _valid(box, page) for box in boxes):
                continue
            union = [
                min(b[0] for b in boxes),
                min(b[1] for b in boxes),
                max(b[2] for b in boxes),
                max(b[3] for b in boxes),
            ]
            target = _normalized(union, page)
            if block.get("bbox") == target:
                continue
            if block.get("bbox") != _normalized(boxes[0], page):
                continue
            block["bbox"] = target
            expanded += 1
    return revised, expanded


def restore_items(items: list[str], repaired: str) -> list[str]:
    cursor, restored = 0, []
    for index, item in enumerate(items):
        output = []
        for char in item:
            if cursor < len(repaired) and char == repaired[cursor]:
                output.append(char)
                cursor += 1
            elif char.isspace():
                raise ValueError("whitespace changed")
        value = "".join(output)
        before, after = re.split(r"(\s+)", item), re.split(r"(\s+)", value)
        if len(before) != len(after) or any(
            a != b
            if a.isspace()
            else [c for c, _ in runs(a)] != [c for c, _ in runs(b)]
            for a, b in zip(before, after)
        ):
            raise ValueError("deletion crosses an item or whitespace boundary")
        restored.append(value)
        if index + 1 < len(items):
            if repaired[cursor : cursor + 1] != "\n":
                raise ValueError("item separator changed")
            cursor += 1
    if cursor != len(repaired):
        raise ValueError("unmatched repaired suffix")
    assert "\n".join(restored) == repaired
    return restored


def repair_lists(blocks: list[dict], pdf: Path) -> tuple[list[dict], int]:
    """Apply the text overprint proof to lists through a text proxy per list."""
    indices, proxies = [], []
    for index, block in enumerate(blocks):
        items = block.get("list_items")
        if (
            block.get("type") != "list"
            or not isinstance(items, list)
            or not all(isinstance(x, str) for x in items)
        ):
            continue
        if not re.search(r"(\S)\1{2,}", "\n".join(items)):
            continue
        indices.append(index)
        proxies.append(
            {**copy.deepcopy(block), "type": "text", "text": "\n".join(items)}
        )
    repaired, _ = repair_text(proxies, pdf)
    revised = copy.deepcopy(blocks)
    count = 0
    for index, proxy, original in zip(indices, repaired, proxies):
        if proxy["text"] == original["text"]:
            continue
        try:
            items = restore_items(blocks[index]["list_items"], proxy["text"])
        except ValueError:
            continue
        revised[index]["list_items"] = items
        count += 1
    return revised, count
