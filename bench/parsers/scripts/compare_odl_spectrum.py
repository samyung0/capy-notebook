"""Compare saved full-document baseline/current runs, retaining timing boundaries."""

from __future__ import annotations

import argparse
import json
from collections import Counter, defaultdict
from pathlib import Path

from experiment_odl_textbook_recovery import historical_checks
from score_odl_textbook_fix import ROOT, literal, read, score

from pipeline.retrieval.chunking import clean_inline


def payload(block):
    return json.dumps(
        {
            k: block.get(k)
            for k in (
                "page_idx",
                "bbox",
                "text",
                "table_body",
                "list_items",
                "image_caption",
                "chart_caption",
                "table_caption",
                "table_footnote",
            )
        },
        sort_keys=True,
        ensure_ascii=False,
    )


def visible(chunks):
    result = defaultdict(list)
    for chunk in chunks:
        text = literal(clean_inline(chunk["text"]))
        for region in chunk["regions"]:
            result[(region["page"], tuple(region["bbox"]))].append(text)
    return result


def check():
    box = [10, 20, 30, 40]
    indexed = visible([{"text": "same text", "regions": [{"page": 2, "bbox": box}]}])
    assert indexed[(2, tuple(box))] == [literal("same text")]
    assert not indexed[(1, tuple(box))]
    assert not indexed[(2, (10, 20, 30, 41))]
    old = {"page_idx": 1, "bbox": box, "text": "value", "text_level": 1}
    revised = {**old, "text_level": 0, "_source_role": "table_header"}
    assert payload(old) == payload(revised)
    assert payload(old) != payload({**old, "text": "changed value"})
    assert sum((Counter([payload(old)] * 2) - Counter([payload(old)])).values()) == 1


def compare(baseline, current, manifests):
    gold = read(ROOT / "bench/parsers/fixtures/textbook-recovery.json")[
        "historical_checks"
    ]
    summary = []
    scores = {
        arm: {r["book"]: r for r in score(run, manifests=manifests)}
        for arm, run in [("baseline", baseline), ("current", current)]
    }
    for source in [s for path in manifests for s in read(path)["sources"]]:
        name = source["id"]
        records, blocks = {}, {}
        for arm, run in [("baseline", baseline), ("current", current)]:
            folder = run / "books" / name
            corpus = read(folder / "corpus.json")
            blocks[arm] = read(folder / "parsed/content_list.json")
            receipt = read(folder / "parsed/manifest.json")["parse_receipt"][
                "measurements"
            ]
            records[arm] = {
                **scores[arm][name],
                "client_parse_seconds": corpus["metrics"]["parse_seconds"],
                "local_postprocess_seconds": corpus["metrics"]["chunk_seconds"],
                "phases": receipt["_phases"],
                "ocr_pages": receipt["_ocr_page_count"],
                "body_characters": sum(len(c["text"]) for c in corpus["chunks"]),
                "path_characters": sum(
                    len(c["section_path"]) for c in corpus["chunks"]
                ),
                "historical_heading_checks": historical_checks(
                    name, corpus["chunks"], gold
                ),
                "chunks_data": corpus["chunks"],
            }
        before, after = [
            visible(records[arm]["chunks_data"]) for arm in ["baseline", "current"]
        ]
        losses = []
        for index, block in enumerate(blocks["baseline"]):
            if (
                not block.get("text")
                or block.get("text_level")
                or not block.get("bbox")
            ):
                continue
            key = (block["page_idx"] + 1, tuple(block["bbox"]))
            text = literal(clean_inline(block["text"]))
            if (
                text
                and any(text in c for c in before[key])
                and not any(text in c for c in after[key])
            ):
                losses.append(
                    {
                        "index": index,
                        "page": key[0],
                        "bbox": block["bbox"],
                        "text": block["text"],
                    }
                )
        old, new = [
            Counter(payload(b) for b in blocks[arm]) for arm in ["baseline", "current"]
        ]
        for record in records.values():
            record.pop("chunks_data")
        summary.append(
            {
                "book": name,
                "family": source.get("family"),
                "records": records,
                "raw_payloads_removed": sum((old - new).values()),
                "raw_payloads_added": sum((new - old).values()),
                "previously_visible_body_candidates_missing": losses,
            }
        )
    return summary


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--baseline", type=Path)
    parser.add_argument("--current", type=Path)
    parser.add_argument("--manifest", type=Path, action="append")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.check:
        check()
        print("Comparison checks passed")
        raise SystemExit(0)
    if not all((args.baseline, args.current, args.manifest, args.output)):
        parser.error("--baseline, --current, --manifest and --output are required")
    result = compare(args.baseline, args.current, args.manifest)
    args.output.write_text(
        json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    for row in result:
        print(
            json.dumps(
                {
                    "book": row["book"],
                    "seconds": {
                        arm: r["execution_seconds"] for arm, r in row["records"].items()
                    },
                    "raw_payload_deltas": [
                        row["raw_payloads_removed"],
                        row["raw_payloads_added"],
                    ],
                    "potential_body_losses": len(
                        row["previously_visible_body_candidates_missing"]
                    ),
                    "historical_checks": {
                        arm: [
                            sum(c["pass"] for c in r["historical_heading_checks"]),
                            len(r["historical_heading_checks"]),
                        ]
                        for arm, r in row["records"].items()
                    },
                }
            )
        )
