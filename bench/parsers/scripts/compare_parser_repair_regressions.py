"""Read-only comparison of fresh production exports with cached heading evidence.

uv run --frozen python bench/parsers/scripts/compare_parser_repair_regressions.py --only boj-financial2025 openstax-chemistry-2e
"""

from __future__ import annotations

import argparse
from collections import Counter
from pathlib import Path

import audit_coherent_banner_scope as scope_audit
import evaluate_unseen_headings as evaluation
from experiment_coherent_banner_roles import OUT, compare_region_paths

from pipeline.retrieval.chunking import Chunk, Region

FRESH = evaluation.ROOT / "bench/parsers/reports/local/2026-09-20-parser-repairs"


def chunks(values: list[dict]) -> list[Chunk]:
    return [
        Chunk(**{**value, "regions": [Region(**r) for r in value["regions"]]})
        for value in values
    ]


def signature(value: dict) -> dict:
    # The cached experiment packs only; production also annotates confidence.
    return {
        k: v for k, v in value.items() if k not in {"confidence", "confidence_reasons"}
    }


def raw_payloads(blocks: list[dict]) -> Counter:
    return Counter((*evaluation.region_key(b), evaluation.payload(b)) for b in blocks)


def compare(id: str, prior: dict) -> dict:
    fresh = FRESH / id
    status = evaluation.read(fresh / "status.json")
    if status["status"] != "complete":
        raise ValueError(f"{id}: fresh production export is not complete")
    cached = OUT / id
    original_status = evaluation.read(evaluation.LOCAL / "parse" / id / "status.json")
    original = (
        evaluation.LOCAL / "parse" / original_status["attempt_directory"] / "baseline"
    )
    baseline = evaluation.read(original / "content_list.json")
    expected = evaluation.read(cached / "candidate-blocks.json")
    final = evaluation.read(fresh / "content_list.json")
    expected_chunks = evaluation.read(cached / "candidate-chunks.json")
    final_chunks = evaluation.read(fresh / "chunks.json")
    baseline_chunks = chunks(
        evaluation.read(
            evaluation.ROOT / prior["evaluation_directory"] / "baseline-chunks.json"
        )
    )
    packed = chunks(final_chunks)
    metrics = evaluation.read(cached / "metrics.json")
    receipt = evaluation.read(fresh / "result.json")
    assert receipt["source_sha256"] == metrics["source_sha256"]
    assert receipt["measured_sha256"] == metrics["measured_pdf_sha256"]
    assert len(baseline) == len(final)
    old_payloads, new_payloads = raw_payloads(baseline), raw_payloads(final)
    baseline_changes = [
        {
            "index": i,
            "changed_fields": sorted(
                k for k in a.keys() | b.keys() if a.get(k) != b.get(k)
            ),
        }
        for i, (a, b) in enumerate(zip(baseline, final, strict=True))
        if a != b
    ]
    # Independent fresh-vs-cached comparison tests actual emitted paths, including
    # identical title occurrences, without excluding any breadcrumb component.
    direct_paths = compare_region_paths(chunks(expected_chunks), packed, set())
    return {
        "id": id,
        "status": "measured",
        "source_sha256": receipt["source_sha256"],
        "pages": receipt["pages"],
        "fresh_parse_seconds": receipt["parse_seconds"],
        "fidelity": receipt["fidelity"],
        "input_hashes": {
            "fresh_final_blocks": evaluation.sha256(fresh / "content_list.json"),
            "fresh_chunks": evaluation.sha256(fresh / "chunks.json"),
            "fresh_heading_stage": evaluation.sha256(fresh / "heading-stage.json"),
            "fresh_result": evaluation.sha256(fresh / "result.json"),
            "cached_candidate_blocks": evaluation.sha256(
                cached / "candidate-blocks.json"
            ),
            "cached_candidate_chunks": evaluation.sha256(
                cached / "candidate-chunks.json"
            ),
            "original_baseline_blocks": evaluation.sha256(
                original / "content_list.json"
            ),
            "comparison_script": evaluation.sha256(Path(__file__)),
        },
        "blocks": len(final),
        "chunks": len(final_chunks),
        "candidate_block_dictionaries_equal": expected == final,
        "candidate_chunk_signatures_equal": [signature(c) for c in expected_chunks]
        == [signature(c) for c in final_chunks],
        "raw_source_payloads_removed": sum((old_payloads - new_payloads).values()),
        "raw_source_payloads_added": sum((new_payloads - old_payloads).values()),
        "new_boundary_count": sum(
            bool(b.get("_heading_boundary_level")) for b in final
        ),
        "baseline_changed_blocks": baseline_changes,
        "body": evaluation.compare_body(baseline, final, baseline_chunks, packed),
        "occurrence_scope": scope_audit.audit(baseline, final),
        "fresh_vs_cached_region_paths": {
            k: v for k, v in direct_paths.items() if k != "records"
        },
        "region_path_differences": direct_paths["records"],
        "matched_anchor_retention": metrics["headings"]["candidate"][
            "anchors_still_headings"
        ]
        if expected == final
        else None,
        "limitation": "Raw payload comparison covers all emitted final blocks, including discarded headings. Java-internal raw JSON was not exported. Anchor retention transfers from exact final-block and text/path/citation parity with the source-checked cached candidate.",
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--only", nargs="+", required=True)
    args = parser.parse_args()
    original = {
        r["id"]: r
        for r in evaluation.read(evaluation.LOCAL / "heading-evaluation/summary.json")[
            "documents"
        ]
    }
    records = []
    for id in args.only:
        result = compare(id, original[id])
        evaluation.write(OUT / "production-comparison" / f"{id}.json", result)
        records.append(result)
        print(
            id,
            "blocks equal",
            result["candidate_block_dictionaries_equal"],
            "chunk signatures equal",
            result["candidate_chunk_signatures_equal"],
            "new body misses",
            result["body"]["newly_missing_source_bound_text_count"],
            "scope mismatches",
            result["occurrence_scope"]["scope_mismatch_count"],
        )
    evaluation.write(OUT / "production-comparison/summary.json", records)
    assert all(
        r["candidate_block_dictionaries_equal"]
        and r["candidate_chunk_signatures_equal"]
        and r["raw_source_payloads_removed"] == r["raw_source_payloads_added"] == 0
        and r["body"]["newly_missing_source_bound_text_count"] == 0
        and r["occurrence_scope"]["scope_mismatch_count"] == 0
        for r in records
    )


if __name__ == "__main__":
    main()
