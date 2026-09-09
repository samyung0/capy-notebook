"""Union source-native geometry for text flattened from list descendants."""

from __future__ import annotations

import argparse
import copy
import math
import time
from collections import defaultdict
from dataclasses import asdict
from pathlib import Path

import pymupdf
from compare_opendataloader import node_text
from experiment_odl_column_continuation import repair_columns
from experiment_odl_heading_retention import load_chunks, retain_headings
from experiment_odl_list_text import repair_lists
from experiment_odl_native_tables import chunk_native_bounded
from experiment_odl_native_text import judge, read, repair_text, save, sha


def nodes(node):
    yield node
    for key in ["kids", "list items", "toc items", "rows", "cells"]:
        for child in node.get(key, []):
            yield from nodes(child)


def flattened_nodes(node):
    if isinstance(node.get("content"), str) and node["content"].strip():
        yield node
    # Match exactly the recursion used by node_text, not table/image traversal.
    for key in ["kids", "list items", "toc items"]:
        for child in node.get(key, []):
            yield from flattened_nodes(child)


def normalized(box, page):
    return [
        round(box[0] / page.rect.width * 1000, 3),
        round((page.rect.height - box[3]) / page.rect.height * 1000, 3),
        round(box[2] / page.rect.width * 1000, 3),
        round((page.rect.height - box[1]) / page.rect.height * 1000, 3),
    ]


def valid(box, page):
    return (
        isinstance(box, list)
        and len(box) == 4
        and all(isinstance(v, (int, float)) and math.isfinite(v) for v in box)
        and 0 <= box[0] < box[2] <= page.rect.width
        and 0 <= box[1] < box[3] <= page.rect.height
    )


def repair_list_geometry(blocks, native_document, parsed_pdf):
    """Apply before glyph repairs; require exact original Java list identity."""
    by_id = defaultdict(list)
    for node in nodes(native_document):
        if "id" in node:
            by_id[node["id"]].append(node)
    revised, decisions = copy.deepcopy(blocks), []
    with pymupdf.open(parsed_pdf) as document:
        for index, block in enumerate(revised):
            if block.get("type") != "list":
                continue
            record = {"index": index, "native_id": block.get("_native_id")}
            matches = by_id[block.get("_native_id")]
            if len(matches) != 1 or matches[0].get("type") != "list":
                decisions.append({**record, "state": "native_identity_mismatch"})
                continue
            native = matches[0]
            items = native.get("list items", [])
            if [node_text(item) for item in items] != block.get("list_items"):
                decisions.append({**record, "state": "text_mismatch"})
                continue
            number = native.get("page number")
            children = [child for item in items for child in flattened_nodes(item)]
            if (
                not isinstance(number, int)
                or not 1 <= number <= len(document)
                or block.get("page_idx") != number - 1
                or not children
                or any(child.get("page number") != number for child in children)
            ):
                decisions.append({**record, "state": "page_mismatch"})
                continue
            page = document[number - 1]
            boxes = [native.get("bounding box")] + [
                child.get("bounding box") for child in children
            ]
            if page.rotation or any(not valid(box, page) for box in boxes):
                decisions.append({**record, "state": "unsupported_geometry"})
                continue
            union = [
                min(b[0] for b in boxes),
                min(b[1] for b in boxes),
                max(b[2] for b in boxes),
                max(b[3] for b in boxes),
            ]
            target = normalized(union, page)
            if block.get("bbox") == target:
                continue
            if block.get("bbox") != normalized(boxes[0], page):
                decisions.append({**record, "state": "parent_geometry_mismatch"})
                continue
            decisions.append(
                {
                    **record,
                    "page": number,
                    "state": "expanded",
                    "before": block["bbox"],
                    "after": target,
                    "children": [
                        {"id": c.get("id"), "bbox": normalized(c["bounding box"], page)}
                        for c in children
                    ],
                }
            )
            block["bbox"] = target
    for before, after in zip(blocks, revised):
        assert {k: v for k, v in before.items() if k != "bbox"} == {
            k: v for k, v in after.items() if k != "bbox"
        }
    return revised, decisions


def check():
    import tempfile

    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / "source.pdf"
        document = pymupdf.open()
        document.new_page(width=100, height=100)
        document.save(path)
        native = {
            "kids": [
                {
                    "id": 1,
                    "type": "list",
                    "page number": 1,
                    "bounding box": [10, 10, 30, 80],
                    "list items": [
                        {
                            "id": 2,
                            "content": "Title",
                            "page number": 1,
                            "bounding box": [10, 70, 30, 80],
                            "kids": [
                                {
                                    "id": 3,
                                    "content": "Included body",
                                    "page number": 1,
                                    "bounding box": [10, 10, 80, 65],
                                },
                                {
                                    "id": 4,
                                    "type": "table",
                                    "rows": [
                                        {
                                            "id": 5,
                                            "content": "Not flattened",
                                            "page number": 1,
                                            "bounding box": [0, 0, 100, 100],
                                        }
                                    ],
                                },
                            ],
                        }
                    ],
                }
            ]
        }
        blocks = [
            {
                "type": "list",
                "_native_id": 1,
                "page_idx": 0,
                "bbox": [100, 200, 300, 900],
                "list_items": [node_text(native["kids"][0]["list items"][0])],
            }
        ]
        revised, decisions = repair_list_geometry(blocks, native, path)
        assert revised[0]["bbox"] == [100, 200, 800, 900] and len(decisions) == 1
        assert repair_list_geometry(revised, native, path)[0] == revised
        changed = copy.deepcopy(blocks)
        changed[0]["list_items"] = ["Changed text"]
        assert repair_list_geometry(changed, native, path)[0] == changed
        native["kids"][0]["list items"][0]["kids"][0]["page number"] = 2
        assert repair_list_geometry(blocks, native, path)[0] == blocks
    print(
        "Included descendants only; text identity, same-page geometry and idempotence checked"
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path, nargs="?")
    parser.add_argument("output", type=Path, nargs="?")
    parser.add_argument("--baseline", type=Path)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    if args.check:
        check()
        return
    if not args.root or not args.output or not args.baseline:
        parser.error("root, fresh output and --baseline required")
    args.output.mkdir(parents=True, exist_ok=False)
    sources, frozen = (
        read(args.root / "sources.json"),
        read(args.root / "checks-v2.json"),
    )
    assert sha(args.root / "sources.json") == frozen["sources_sha256"]
    records = []
    for case, source in sources.items():
        for field, digest in [
            ("native_json", "native_json_sha256"),
            ("native_receipt", "native_receipt_sha256"),
            ("parsed_pdf", "parsed_pdf_sha256"),
            ("content_list", "content_sha256"),
        ]:
            assert sha(source[field]) == source[digest]
        assert (
            read(source["native_receipt"])["pdf_sha256"] == source["parsed_pdf_sha256"]
        )
        native, blocks = read(source["native_json"]), read(source["content_list"])
        original = copy.deepcopy(blocks)
        start = time.perf_counter()
        geometry, decisions = repair_list_geometry(blocks, native, source["parsed_pdf"])
        geometry_seconds = time.perf_counter() - start
        assert blocks == original
        assert (
            repair_list_geometry(geometry, native, source["parsed_pdf"])[0] == geometry
        )
        start = time.perf_counter()
        repaired, text_decisions = repair_text(
            geometry, source["parsed_pdf"], paragraphs=True
        )
        repaired, list_decisions = repair_lists(repaired, source["parsed_pdf"])
        repaired, column_decisions = repair_columns(repaired, source["parsed_pdf"])
        rewrite_seconds = time.perf_counter() - start
        _, chunks, _ = chunk_native_bounded(repaired)
        chunks, heading_decisions = retain_headings(
            repaired, source["parsed_pdf"], chunks
        )
        baseline_path = args.baseline / case / "chunks.json"
        baseline = load_chunks(baseline_path)
        labels = [c for c in frozen["labels"] if c["case"] == case]
        target = args.output / case
        save(target / "geometry-only.json", geometry)
        save(target / "content_list.json", repaired)
        save(
            target / "chunks.json",
            [{**asdict(c), "indexed_text": c.indexed_text()} for c in chunks],
        )
        save(
            target / "decisions.json",
            {
                "geometry": decisions,
                "text": text_decisions,
                "lists": list_decisions,
                "columns": column_decisions,
                "headings": heading_decisions,
            },
        )
        by_id = {b.get("_native_id"): b for b in repaired if b.get("type") == "list"}
        geometry_checks = []
        for expected in [c for c in frozen["geometry"] if c["case"] == case]:
            block = by_id[expected["native_id"]]
            hits = [
                i
                for i, c in enumerate(chunks)
                if any(
                    r.page == expected["page"] and r.bbox == expected["union_bbox"]
                    for r in c.regions
                )
            ]
            geometry_checks.append(
                {
                    "id": expected["id"],
                    "pass": block["bbox"] == expected["union_bbox"] and bool(hits),
                    "chunks": hits,
                }
            )
        records.append(
            {
                "case": case,
                "pages": source["pages"],
                "geometry_seconds": geometry_seconds,
                "rewrite_seconds": rewrite_seconds,
                "expanded": sum(d["state"] == "expanded" for d in decisions),
                "baseline_chunks_sha256": sha(baseline_path),
                "geometry_checks": geometry_checks,
                "baseline": [judge(baseline, c) for c in labels],
                "candidate": [judge(chunks, c) for c in labels],
            }
        )
    save(
        args.output / "summary.json",
        {
            "script_sha256": sha(__file__),
            "dependencies_sha256": {
                name: sha(Path(__file__).with_name(name + ".py"))
                for name in [
                    "compare_opendataloader",
                    "experiment_odl_native_text",
                    "experiment_odl_list_text",
                    "experiment_odl_column_continuation",
                    "experiment_odl_heading_retention",
                    "experiment_odl_native_tables",
                ]
            },
            "checks_sha256": sha(args.root / "checks-v2.json"),
            "records": records,
        },
    )
    print(
        "Expanded",
        sum(r["expanded"] for r in records),
        "geometry seconds",
        round(sum(r["geometry_seconds"] for r in records), 3),
    )
    print(
        "Geometry checks",
        sum(c["pass"] for r in records for c in r["geometry_checks"]),
        "labels",
        sum(c["pass"] for r in records for c in r["baseline"]),
        "->",
        sum(c["pass"] for r in records for c in r["candidate"]),
    )


if __name__ == "__main__":
    main()
