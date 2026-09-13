"""Inventory ODL structure that survives Capy's adapter and chunker.

Pass one or more benchmark case directories containing ``native/source.json``,
``raw.json`` and ``chunks.json``. The script only reads saved artifacts and
writes one JSON summary to stdout.
"""

from __future__ import annotations

import argparse
import json
from collections import Counter
from pathlib import Path


def walk(node: dict, parent: int | None = None):
    yield node, parent
    node_id = node.get("id") if isinstance(node.get("id"), int) else parent
    for key in ("kids", "rows", "cells", "list items", "toc items"):
        for child in node.get(key, []):
            if isinstance(child, dict):
                yield from walk(child, node_id)


def audit(case_dir: Path) -> dict:
    native = json.loads((case_dir / "native/source.json").read_text())
    blocks = json.loads((case_dir / "raw.json").read_text())
    chunks = json.loads((case_dir / "chunks.json").read_text())
    nodes = list(walk(native))
    typed = [(node, parent) for node, parent in nodes if node.get("type")]
    text_nodes = [node for node, _ in typed if isinstance(node.get("content"), str)]
    linked = [node for node, _ in typed if "linked content id" in node]
    by_id = {node["id"]: node for node, _ in typed if isinstance(node.get("id"), int)}
    link_targets = Counter(
        by_id.get(node.get("linked content id"), {}).get("type", "missing")
        for node in linked
    )
    continuations = [
        node
        for node, _ in typed
        if any(
            key in node
            for key in (
                "previous table id",
                "next table id",
                "previous list id",
                "next list id",
            )
        )
    ]
    cells = [node for node, _ in typed if node.get("type") == "table cell"]
    nested = [node for node, parent in typed if parent is not None and node.get("id")]
    adapted_ids = {
        block.get("_native_id")
        for block in blocks
        if block.get("_native_id") is not None
    }
    region_owners: Counter[str] = Counter()
    for chunk in chunks:
        for region in chunk.get("regions", []):
            region_owners[json.dumps(region, sort_keys=True)] += 1
    return {
        "case": case_dir.name,
        "native_types": dict(Counter(node.get("type") for node, _ in typed)),
        "native_typed_nodes": len(typed),
        "native_text_nodes": len(text_nodes),
        "native_nested_nodes": len(nested),
        "native_caption_links": len(linked),
        "native_caption_link_targets": dict(link_targets),
        "native_continuation_links": len(continuations),
        "native_table_cells": len(cells),
        "native_table_cells_with_bbox": sum("bounding box" in cell for cell in cells),
        "native_text_with_style": sum(
            all(key in node for key in ("font", "font size", "text color"))
            for node in text_nodes
        ),
        "adapted_blocks": len(blocks),
        "adapted_native_ids": len(adapted_ids),
        "adapted_parent_links": sum("_native_parent_id" in block for block in blocks),
        "adapted_caption_links": sum("linked content id" in block for block in blocks),
        "adapted_continuation_links": sum(
            any(
                key in block
                for key in (
                    "previous table id",
                    "next table id",
                    "previous list id",
                    "next list id",
                )
            )
            for block in blocks
        ),
        "adapted_text_with_style": sum(
            any(key in block for key in ("font", "font size", "text color"))
            for block in blocks
        ),
        "chunks": len(chunks),
        "chunks_with_native_ids": sum("_native_id" in chunk for chunk in chunks),
        "shared_regions": sum(count > 1 for count in region_owners.values()),
        "max_chunks_per_region": max(region_owners.values(), default=0),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("cases", nargs="+", type=Path)
    args = parser.parse_args()
    results = [audit(case) for case in args.cases]
    totals = {
        key: sum(result[key] for result in results)
        for key in (
            "native_typed_nodes",
            "native_text_nodes",
            "native_nested_nodes",
            "native_caption_links",
            "native_continuation_links",
            "native_table_cells",
            "native_table_cells_with_bbox",
            "native_text_with_style",
            "adapted_blocks",
            "adapted_native_ids",
            "adapted_parent_links",
            "adapted_caption_links",
            "adapted_continuation_links",
            "adapted_text_with_style",
            "chunks",
            "chunks_with_native_ids",
            "shared_regions",
        )
    }
    totals["max_chunks_per_region"] = max(
        result["max_chunks_per_region"] for result in results
    )
    print(
        json.dumps({"cases": results, "totals": totals}, ensure_ascii=False, indent=2)
    )


if __name__ == "__main__":
    main()
