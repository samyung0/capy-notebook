"""Replay the eight reviewed source-geometry tables and their final document chunks.

Run from repository root with the preserved local input artifacts. This is an
explicit evaluation set, not automatic selection of every geometry candidate.
"""

import argparse
import copy
import difflib
import hashlib
import json
import statistics
import time
from dataclasses import asdict
from pathlib import Path

import pymupdf
from experiment_odl_native_tables import chunk_native_bounded
from experiment_odl_table_geometry import (
    as_block,
    replace_regions,
    row_label_spans,
    table_from_region,
)
from structured_recovery import chunk_structured


def integrate(r):
    base = Path("bench/parsers/reports/local/2026-09-09-odl-accuracy/combined-final")
    main_sources = json.loads((r / "frozen-checks.json").read_text(encoding="utf8"))[
        "sources"
    ]
    transfer_sources = json.loads(
        (r / "transfer/frozen-checks.json").read_text(encoding="utf8")
    )["sources"]
    cases = [
        (
            n,
            p,
            base / n / "content_list.json",
            r / "row-spans-final" / n,
            main_sources[n]["pdf"],
        )
        for n, p in [("ccl-feedback", 8), ("attention", 8), ("hongkong-figures", 13)]
    ]
    cases += [
        (
            "ccl-cot",
            6,
            Path(
                "bench/parsers/reports/local/2026-09-09-odl-font-transfer/r2/ccl-cot/rebuild-cmap/content_list.json"
            ),
            r / "transfer/row-spans-final/ccl-cot",
            transfer_sources["ccl-cot"]["pdf"],
        ),
        (
            "ccl-children",
            4,
            Path(
                "bench/parsers/reports/local/2026-09-09-odl-font-transfer/ccl-children/native-content_list.json"
            ),
            r / "transfer/row-spans-final/ccl-children",
            transfer_sources["ccl-children"]["pdf"],
        ),
    ]
    records = []
    for mode in ["automatic", "oracle"]:
        for name, page, source, directory, pdf in cases:
            files = sorted(directory.glob(f"p{page}-t*.json"))
            bundles = [json.loads(p.read_text(encoding="utf8")) for p in files]
            blocks = json.loads(source.read_text(encoding="utf8"))
            merged, receipts = replace_regions(
                blocks, bundles, allow_partial=mode == "oracle"
            )
            drops = {
                i
                for receipt in receipts
                if receipt["accepted"]
                for i in receipt["wholly_contained"] + receipt["partially_overlapping"]
            }
            affected = {page - 1} if drops else set()
            page_count = len(pymupdf.open(pdf))
            samepages = [
                p
                for p in range(page_count)
                if p not in affected
                and [b for b in blocks if b.get("page_idx") == p]
                == [b for b in merged if b.get("page_idx") == p]
            ]
            assert len(samepages) == page_count - len(affected)
            before = chunk_native_bounded(blocks)[1]
            begun = time.perf_counter()
            after = chunk_native_bounded(merged)[1]
            elapsed = time.perf_counter() - begun
            sig = lambda c: json.dumps(asdict(c), sort_keys=True, ensure_ascii=False)
            safe = lambda c, affected=affected: (
                not any(c.page_start <= p + 1 <= c.page_end for p in affected)
                if c.page_start is not None and c.page_end is not None
                else True
            )
            outside_equal = [sig(c) for c in before if safe(c)] == [
                sig(c) for c in after if safe(c)
            ]
            out = r / "composition-final" / mode / name
            out.mkdir(parents=True, exist_ok=True)
            for fn, v in [
                ("content_list.json", merged),
                (
                    "chunks-before.json",
                    [asdict(c) | {"indexed_text": c.indexed_text()} for c in before],
                ),
                (
                    "chunks-after.json",
                    [asdict(c) | {"indexed_text": c.indexed_text()} for c in after],
                ),
                ("replacement.json", receipts),
            ]:
                (out / fn).write_text(
                    json.dumps(v, ensure_ascii=False, indent=2), encoding="utf8"
                )
            original = [b for i, b in enumerate(blocks) if i not in drops]
            new = [b for b in merged if b.get("_recovery") != "source-geometry"]
            assert original == new
            table_chunks = []
            for bundle, receipt in zip(bundles, receipts):
                matches = [
                    i
                    for i, c in enumerate(after)
                    if len(c.regions) == 1
                    and c.regions[0].page == page
                    and max(
                        abs(a - b)
                        for a, b in zip(c.regions[0].bbox, bundle["block"]["bbox"])
                    )
                    < 0.01
                ]
                table_chunks.append(matches if receipt["accepted"] else [])
            rec = {
                "mode": mode,
                "source": name,
                "source_content": str(source),
                "baseline_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
                "pdf_sha256": hashlib.sha256(Path(pdf).read_bytes()).hexdigest(),
                "bundles": [
                    {
                        "path": str(p),
                        "sha256": hashlib.sha256(p.read_bytes()).hexdigest(),
                    }
                    for p in files
                ],
                "accepted_tables": sum(x["accepted"] for x in receipts),
                "removed_blocks": len(drops),
                "unchanged_original_blocks": len(original),
                "unchanged_pages": len(samepages),
                "total_pages": page_count,
                "unaffected_chunk_sequence_equal": outside_equal,
                "chunks_before": len(before),
                "chunks_after": len(after),
                "table_chunk_indices": table_chunks,
                "chunking_s": elapsed,
            }
            records.append(rec)
            print(
                rec["mode"],
                name,
                "tables",
                rec["accepted_tables"],
                "samepages",
                rec["unchanged_pages"],
                "partial",
                [x["partial_text"] for x in receipts],
                "chunks",
                table_chunks,
            )
    (r / "composition-final/manifest.json").write_text(
        json.dumps(
            {
                "records": records,
                "script_sha256": hashlib.sha256(
                    Path(
                        "bench/parsers/scripts/experiment_odl_table_geometry.py"
                    ).read_bytes()
                ).hexdigest(),
                "evaluation_sha256": hashlib.sha256(
                    Path(__file__).read_bytes()
                ).hexdigest(),
            },
            indent=2,
        ),
        encoding="utf8",
    )


def score(root):
    read = lambda p: json.loads(Path(p).read_text(encoding="utf8"))
    sha = lambda p: hashlib.sha256(Path(p).read_bytes()).hexdigest()
    norm = lambda s: "".join(s.split())
    fixture = read(root / "frozen-checks.json")
    transfer = read("bench/parsers/fixtures/odl-font-transfer-checks.json")["cases"][0]
    manifest = read(root / "composition-final/manifest.json")
    records = []

    for record in manifest["records"]:
        chunks = read(
            root
            / "composition-final"
            / record["mode"]
            / record["source"]
            / "chunks-after.json"
        )
        for i, binding in enumerate(record["bundles"]):
            bundle = read(binding["path"])
            table = bundle["table"]
            expected = None
            source = record["source"]
            if source == "ccl-feedback":
                expected = fixture["ccl"]["rows"]
                assert table["headers"][0] == ""
                assert table["headers"][1:] == fixture["ccl"]["headers"][1:]
                assert table["bold_cells"] == fixture["ccl"]["bold_cells"]
            elif source == "attention":
                expected = fixture["attention"]["rows"]
                assert table["headers"] == fixture["attention"]["headers"]
                assert table["bold_cells"] == fixture["attention"]["bold_cells"]
                assert table["spans"] == fixture["attention"]["spans"]
                assert any("41.0" in c["text"] for c in chunks)
            elif source == "hongkong-figures":
                key = ["sex", "age", "unemployment", "underemployment"][i]
                expected = copy.deepcopy(fixture["hongkong"][key]["rows"])
                if key == "age":
                    expected[3][2] = (
                        "3.6"  # Source-review correction; original fixture remains unchanged.
                    )
                for actual, frozen in zip(table["rows"], expected, strict=True):
                    if frozen[0] == "change":
                        assert actual[0] == ""
                    else:
                        assert norm(frozen[0]).replace("(000)", "") in norm(actual[0])
                assert [[norm(v) for v in row[1:]] for row in table["rows"]] == [
                    [norm(v) for v in row[1:]] for row in expected
                ]
                if i < 2:
                    assert table["notes"]
                    assert all(
                        any(year in header for header in table["headers"])
                        for year in ["2018", "2022", "2023"]
                    )
                expected = None
            elif source == "ccl-cot":
                assert [r[2:] for r in table["rows"]] == [
                    r["values"] for r in transfer["rows"]
                ]
                assert [
                    h.replace(" / ", " ") for h in table["headers"][2:]
                ] == transfer["columns"]
                assert table["spans"] == [
                    {"row": 0, "column": 0, "rowspan": 3, "colspan": 1},
                    {"row": 3, "column": 0, "rowspan": 3, "colspan": 1},
                ]
                assert table["rows"][0][:2] == ["SDS", "AI"] and table["rows"][3][
                    :2
                ] == ["MDS", "AI"]
                assert [r[1] for r in table["rows"]] == ["AI", "Medical", "Overall"] * 2
            elif source == "ccl-children":
                expected = [
                    ["体育", "23", "29", "46"],
                    ["社会", "107", "76", "178"],
                    ["榜样", "100", "11", "111"],
                    ["政治", "30", "9", "39"],
                    ["文化", "77", "38", "115"],
                    ["经济", "10", "4", "14"],
                    ["科学", "110", "77", "187"],
                    ["环境保护", "77", "46", "123"],
                ]
                assert table["headers"] == [
                    "文本类别",
                    "儿童长新闻数量",
                    "儿童短新闻数量",
                    "成年人新闻数量",
                ]
            if expected is not None:
                assert [[norm(v) for v in row] for row in table["rows"]] == [
                    [norm(v) for v in row] for row in expected
                ]
            ids = record["table_chunk_indices"][i]
            assert len(bundle["chunks"]) == 1
            if ids:
                assert len(ids) == 1
                assert bundle["chunks"][0]["text"] == chunks[ids[0]]["text"]
                assert chunks[ids[0]]["text"] in chunks[ids[0]]["indexed_text"]
            records.append(
                {
                    "mode": record["mode"],
                    "source": source,
                    "table_index": i,
                    "complete_source_grid_checked": True,
                    "source_geometry_chunk_equal_to_document_chunk": bool(ids),
                    "document_chunk_indices": ids,
                }
            )

    # The original blind transfer succeeds numerically but fails complete row-group meaning.
    old = read(root / "transfer/r1/ccl-cot/p6-t0.json")["table"]
    assert [r[1:] for r in old["rows"]] == [r["values"] for r in transfer["rows"]]
    assert old["spans"] == []
    unchanged = []
    for path in (root / "final").rglob("p*-t*.json"):
        other = root / "row-spans-final" / path.relative_to(root / "final")
        assert path.read_bytes() == other.read_bytes()
        unchanged.append(str(path.relative_to(root)))
    assert (root / "transfer/r1/ccl-children/p4-t0.json").read_bytes() == (
        root / "transfer/row-spans-final/ccl-children/p4-t0.json"
    ).read_bytes()

    child_before = read(
        root / "composition-final/automatic/ccl-children/chunks-before.json"
    )[18]["text"]
    child_table = read(root / "transfer/row-spans-final/ccl-children/p4-t0.json")[
        "table"
    ]
    assert norm(" ".join(child_table["headers"])) in norm(child_before)
    assert all(norm(" ".join(row)) in norm(child_before) for row in child_table["rows"])
    hk_before = read(
        root / "composition-final/automatic/hongkong-figures/chunks-before.json"
    )
    hk_after = read(
        root / "composition-final/automatic/hongkong-figures/chunks-after.json"
    )
    outside = lambda rows: [
        c for c in rows if not (c["page_start"] <= 13 <= c["page_end"])
    ]
    hk_changes = []
    for before, after in zip(outside(hk_before), outside(hk_after), strict=True):
        if before != after:
            changes = [
                {"kind": op, "before": before["text"][i:j], "after": after["text"][k:l]}
                for op, i, j, k, l in difflib.SequenceMatcher(
                    None, before["text"], after["text"]
                ).get_opcodes()
                if op != "equal"
            ]
            assert before["section_path"] == after["section_path"]
            assert all(
                c["kind"] == "insert" and norm(c["after"]) == "註釋：(1)Note:(1)"
                for c in changes
            )
            hk_changes.append(
                {
                    "page_start": after["page_start"],
                    "page_end": after["page_end"],
                    "changes": changes,
                    "section_unchanged": True,
                }
            )
    assert len(hk_changes) == 2

    timings = []
    source_map = (
        fixture["sources"] | read(root / "transfer/frozen-checks.json")["sources"]
    )
    for record in manifest["records"]:
        if record["mode"] != "automatic":
            continue
        pdf = pymupdf.open(source_map[record["source"]]["pdf"])
        for binding in record["bundles"]:
            bundle = read(binding["path"])
            page = pdf[bundle["block"]["page_idx"]]
            elapsed = []
            for _ in range(3):
                begun = time.perf_counter()
                table = row_label_spans(
                    page, table_from_region(page, bundle["table"]["bbox"])
                )
                chunks = chunk_structured([as_block(table, page)])
                elapsed.append(time.perf_counter() - begun)
                assert chunks[0].text == bundle["chunks"][0]["text"]
            timings.append(
                {
                    "source": record["source"],
                    "page": page.number + 1,
                    "bbox": bundle["table"]["bbox"],
                    "seconds": elapsed,
                    "median_s": statistics.median(elapsed),
                }
            )

    result = {
        "geometry_script_sha256": sha(
            "bench/parsers/scripts/experiment_odl_table_geometry.py"
        ),
        "scoring_script_sha256": sha(__file__),
        "frozen_fixture_sha256": sha(root / "frozen-checks.json"),
        "source_correction": {
            "field": "hongkong.age.rows[3][2]",
            "frozen": "3.6*",
            "source_review": "3.6",
            "source_image": "hk-65-age-source.png",
            "original_fixture_preserved": True,
        },
        "child_ground_truth": {
            "scope": "Source-reviewed all 24 counts and four headers after candidate; not pre-frozen numeric ground truth. Baseline chunk 18 already contains all counts and headers."
        },
        "original_blind_cot_transfer": {
            "numeric_cells": 66,
            "numeric_headers": 11,
            "row_group_semantics": False,
            "revised_arm_is_development": True,
        },
        "source_and_final_chunk_checks": records,
        "original_bundles_byte_equal_after_second_arm": unchanged,
        "children_bundle_byte_equal": True,
        "hongkong_outside_page_changes": hk_changes,
        "children_baseline_all_rows_and_headers_in_chunk": 18,
        "known_region_timings": {
            "scope": "Local Windows Python 3.12.9 / PyMuPDF 1.28.2; known source page and region; PDF open excluded; includes text extraction, geometry, rowspan, HTML and one-table chunking; excludes whole-source selection, JSON writes and full-document replacement/chunking. Three consecutive repeats, not a VM or end-to-end parser benchmark.",
            "records": timings,
            "sum_of_table_medians_s": sum(t["median_s"] for t in timings),
        },
    }
    (root / "source-score-and-timing.json").write_text(
        json.dumps(result, ensure_ascii=False, indent=2), encoding="utf8"
    )
    print(
        json.dumps(
            {
                "checks": len(records),
                "unchanged_original_bundles": len(unchanged),
                "known_region_sum_medians_s": result["known_region_timings"][
                    "sum_of_table_medians_s"
                ],
            }
        )
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=["integrate", "score"])
    parser.add_argument(
        "root",
        type=Path,
        nargs="?",
        default=Path("bench/parsers/reports/local/2026-09-09-odl-table-geometry"),
    )
    args = parser.parse_args()
    if args.mode == "integrate":
        integrate(args.root)
    else:
        score(args.root)


if __name__ == "__main__":
    main()
