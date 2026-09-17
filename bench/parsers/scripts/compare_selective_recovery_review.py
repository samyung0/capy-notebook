"""Snapshot saved ODL evidence that geometrically overlaps frozen recovery crops."""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import pymupdf
from compare_selective_recovery import FIXTURE, ROOT, read, save, sha


def overlap(first, second):
    return min(first[2], second[2]) > max(first[0], second[0]) and min(
        first[3], second[3]
    ) > max(first[1], second[1])


def snapshot(output):
    records = []
    for case in read(FIXTURE)["cases"]:
        book = Path(case["source"]).stem
        if case["group"] == "prior-known":
            folder = ROOT / "data/knowledge-base-pilot/run/books" / book
        else:
            folder = (
                ROOT
                / "bench/parsers/reports/local/2026-09-16-odl-shared-fix/baseline/books"
                / book
            )
        with pymupdf.open(ROOT / case["source"]) as document:
            page = document[case["page"] - 1]
            box = [
                value * 1000 / (page.rect.width if i % 2 == 0 else page.rect.height)
                for i, value in enumerate(case["bbox"])
            ]
        block_path = folder / "parsed/content_list.json"
        corpus_path = folder / "corpus.json"
        blocks = [
            {"index": i, **block}
            for i, block in enumerate(read(block_path))
            if block.get("page_idx") == case["page"] - 1
            and block.get("bbox")
            and overlap(box, block["bbox"])
        ]
        chunks = [
            chunk
            for chunk in read(corpus_path)["chunks"]
            if any(
                region.get("page") == case["page"]
                and region.get("bbox")
                and overlap(box, region["bbox"])
                for region in chunk["regions"]
            )
        ]
        records.append(
            {
                "case": case["id"],
                "baseline_folder": folder.relative_to(ROOT).as_posix(),
                "block_sha256": sha(block_path),
                "corpus_sha256": sha(corpus_path),
                "box": box,
                "blocks": blocks,
                "chunks": chunks,
                "any_overlapping_table": any(b.get("type") == "table" for b in blocks),
                "any_overlapping_low_confidence_chunk": any(
                    c.get("confidence", 1) < 0.9 for c in chunks
                ),
            }
        )
    save(
        output,
        {
            "epoch": time.time(),
            "fixture_sha256": sha(FIXTURE),
            "caveat": "Geometric overlap is a routing proxy, not an implemented crop selector or measured recall. A neighboring low-confidence chunk can touch a crop whose formula was not detected. Baseline blocks may extend outside the source crop, so this is diagnostic context rather than matched visual input.",
            "cases": records,
        },
    )
    print(
        json.dumps(
            [
                {
                    "case": r["case"],
                    "table": r["any_overlapping_table"],
                    "low_confidence_overlap": r["any_overlapping_low_confidence_chunk"],
                    "min_confidence": min(
                        (c["confidence"] for c in r["chunks"]), default=None
                    ),
                }
                for r in records
            ]
        )
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    snapshot(args.output)
