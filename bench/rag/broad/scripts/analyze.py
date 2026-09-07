"""Summarize first attempts; chat conclusions require explicit reviewed grades."""

import argparse
import hashlib
import json
import statistics
from collections import Counter
from pathlib import Path

from fetch_data import write_json


def rows(path):
    return [json.loads(line) for line in path.read_text().splitlines()]


def retrieval(root):
    data = rows(root / "retrieval.jsonl")
    assert len(data) == len({r["id"] for r in data}) == 360
    state = json.loads((root / "retrieval-workspaces.json").read_text())
    result = {}
    for dataset in sorted({r["dataset"] for r in data}):
        group = [r for r in data if r["dataset"] == dataset]
        assert len(group) == 40
        metrics = {}
        for arm in ("hybrid", "dense", "exact_dense"):
            values = [r["arms"][arm]["metrics"] for r in group]
            metrics[arm] = {
                "hit_count": sum(v["hit_at_5"] for v in values),
                **{
                    key: statistics.mean(v[key] for v in values)
                    for key in ("hit_at_5", "recall_at_5", "ndcg_at_5", "mrr_at_5")
                },
                "sql_path_median_ms": statistics.median(
                    r["arms"][arm]["sql_path_ms"] for r in group
                ),
            }
        result[dataset] = {
            "queries": len(group),
            "documents": len(state[dataset]["files"]),
            "source_language": state[dataset]["language"],
            "indexed_languages": state[dataset]["counts_by_detected_language"],
            "arms": metrics,
            "hybrid_only_hits": [
                r["id"]
                for r in group
                if r["arms"]["hybrid"]["metrics"]["hit_at_5"]
                and not r["arms"]["dense"]["metrics"]["hit_at_5"]
            ],
            "dense_only_hits": [
                r["id"]
                for r in group
                if r["arms"]["dense"]["metrics"]["hit_at_5"]
                and not r["arms"]["hybrid"]["metrics"]["hit_at_5"]
            ],
            "mean_dense_exact_overlap_at_5": statistics.mean(
                r["dense_exact_overlap_at_5"] for r in group
            ),
        }
        print(dataset, {a: v["hit_count"] for a, v in metrics.items()})
    result["raw_sha256"] = hashlib.sha256(
        (root / "retrieval.jsonl").read_bytes()
    ).hexdigest()
    write_json(root / "retrieval-summary.json", result)


def chat(root):
    data = rows(root / "chat.jsonl")
    questions = {
        q["id"]: q for q in json.loads((root / "corpus/questions.json").read_text())
    }
    grades = json.loads((root / "chat-review.json").read_text())
    key = lambda r: (r["id"], r["variant"], r["repeat"])
    review = {key(r): r for r in grades}
    assert len(data) == len({key(r) for r in data}) == len(grades) == len(review) == 144
    assert {key(r) for r in data} == review.keys()
    assert review.keys() == {
        (qid, variant, repeat)
        for qid in questions
        for variant in ("baseline", "follow_links_ids")
        for repeat in range(2)
    }
    assert all(
        type(g[name]) is bool
        for g in grades
        for name in ("answer_correct", "grounded", "citation_supported")
    )
    complete = lambda r: r["status"] == "complete" and not r["errors"]
    assert all(
        not any(
            review[key(r)][m]
            for m in ("answer_correct", "grounded", "citation_supported")
        )
        for r in data
        if not complete(r)
    ), "Failed first attempts must remain failures in the primary denominator."
    result = {}
    for variant in ("baseline", "follow_links_ids"):
        group = [r for r in data if r["variant"] == variant]
        per_category = {}
        for category in sorted({r["category"] for r in group}):
            subset = [r for r in group if r["category"] == category]
            per_category[category] = {
                "turns": len(subset),
                "completed": sum(complete(r) for r in subset),
                **{
                    metric: sum(review[key(r)][metric] for r in subset)
                    for metric in ("answer_correct", "grounded", "citation_supported")
                },
                "all_labeled_evidence_reached": sum(
                    bool(r["score"]["all_evidence_reached"]) for r in subset
                ),
                "all_labeled_evidence_cited": sum(
                    bool(r["score"]["all_evidence_cited"]) for r in subset
                ),
                "correct_and_grounded": sum(
                    review[key(r)]["answer_correct"] and review[key(r)]["grounded"]
                    for r in subset
                ),
            }
        reads = [c for r in group for c in r["calls"] if c["name"] == "read_document"]
        searches = [
            sum(c["name"] == "search_workspace" for c in r["calls"]) for r in group
        ]
        finished = [r for r in group if complete(r)]
        result[variant] = {
            "turns": len(group),
            "completed": len(finished),
            "failed_attempts": len(group) - len(finished),
            "categories": per_category,
            "completed_median_s": statistics.median(r["elapsed_s"] for r in finished),
            "completed_mean_s": statistics.mean(r["elapsed_s"] for r in finished),
            "completed_p95_s": statistics.quantiles(
                [r["elapsed_s"] for r in finished], n=100, method="inclusive"
            )[94],
            "mean_searches": statistics.mean(searches),
            "completed_mean_reported_tokens": statistics.mean(
                next(
                    e["tokenCount"]
                    for e in reversed(r["events"])
                    if e["type"] == "done"
                )
                for r in finished
            ),
            "read_calls": len(reads),
            "rejected_read_calls": sum(bool(c["error"] or c["refused"]) for c in reads),
            "correct_both_repeats": sum(
                all(review[(qid, variant, i)]["answer_correct"] for i in range(2))
                for qid in questions
            ),
            "positive_correct_both_repeats": sum(
                all(review[(qid, variant, i)]["answer_correct"] for i in range(2))
                for qid, q in questions.items()
                if q["category"] != "missing_source"
            ),
            "native_by_language": {
                language: {
                    "turns": len(subset),
                    "correct": sum(review[key(r)]["answer_correct"] for r in subset),
                    "correct_and_grounded": sum(
                        review[key(r)]["answer_correct"] and review[key(r)]["grounded"]
                        for r in subset
                    ),
                    "citation_supported": sum(
                        review[key(r)]["citation_supported"] for r in subset
                    ),
                }
                for language in ("en", "de", "es", "fr", "ja", "ko", "zh")
                if (
                    subset := [
                        r
                        for r in group
                        if r["category"] == "native"
                        and questions[r["id"]]["language"] == language
                    ]
                )
            },
            "missing_by_case": {
                qid: {
                    "turns": len(subset),
                    "completed": sum(complete(r) for r in subset),
                    "correct": sum(review[key(r)]["answer_correct"] for r in subset),
                    "correct_and_grounded": sum(
                        review[key(r)]["answer_correct"] and review[key(r)]["grounded"]
                        for r in subset
                    ),
                }
                for qid, q in questions.items()
                if q["category"] == "missing_source"
                and (subset := [r for r in group if r["id"] == qid])
            },
            "failure_reasons": dict(
                Counter(
                    review[key(r)]["reason"]
                    for r in group
                    if not review[key(r)]["answer_correct"]
                )
            ),
        }
    result["paired_positive"] = {
        metric: {
            "candidate_only": [
                [qid, repeat]
                for qid, q in questions.items()
                for repeat in range(2)
                if q["category"] != "missing_source"
                and review[(qid, "follow_links_ids", repeat)][metric]
                and not review[(qid, "baseline", repeat)][metric]
            ],
            "baseline_only": [
                [qid, repeat]
                for qid, q in questions.items()
                for repeat in range(2)
                if q["category"] != "missing_source"
                and review[(qid, "baseline", repeat)][metric]
                and not review[(qid, "follow_links_ids", repeat)][metric]
            ],
        }
        for metric in ("answer_correct", "grounded", "citation_supported")
    }
    write_json(root / "chat-summary.json", result)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("root", type=Path)
    parser.add_argument("part", choices=("retrieval", "chat"))
    args = parser.parse_args()
    {"retrieval": retrieval, "chat": chat}[args.part](args.root)
