"""Audit and summarize a completed frozen BM25 run, without network access."""

import collections
import hashlib
import json
import math
import random
import statistics
import sys
from pathlib import Path

ARMS = (
    "current",
    "dense",
    "lex_current",
    "lex_pg",
    "lex_bm25_k1.2_b0.75",
    "lex_bm25_selected",
    "bm25_current_rules",
    "bm25_rrf_half",
    "bm25_rrf_equal",
    "cc_pg_a0.5",
    "cc_bm25_a0.5",
    "cc_pg_selected",
    "cc_bm25_selected",
)


def read(path):
    return json.loads(path.read_text())


def records(path):
    return [json.loads(line) for line in path.read_text().splitlines()]


def sha(value):
    return hashlib.sha256(value).hexdigest()


def save(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def baseline(root):
    import bm25_fusion_eval as base

    prepared = base.verify(root)
    receipt = read(root / "extraction.json")
    assert sha((root / "features.jsonl").read_bytes()) == receipt["features_sha256"]
    chunks = {c["id"]: c for c in prepared["chunks"]}
    features = {r["id"]: r for r in records(root / "features.jsonl")}
    mismatches = []
    for q in prepared["queries"]:
        f = features[q["id"]]
        pg = {r["id"]: r["pg_score"] for r in f["rows"]}
        actual = base.evaluate(q, f, chunks, pg, "current")["hits"]
        if actual != q["expected"]:
            mismatches.append(
                {"id": q["id"], "expected": q["expected"], "actual": actual}
            )
    save(
        root / "baseline-audit.json",
        {
            "verified": len(prepared["queries"]),
            "mismatches": mismatches,
            "before_dev_selection": not (root / "selection.json").exists(),
            "features_sha256": receipt["features_sha256"],
        },
    )
    assert not mismatches, mismatches[:5]
    print("current baseline exact output reproduction", len(prepared["queries"]))


def run(root):
    protocol = read(root / "analysis-freeze.json")
    assert sha(Path(__file__).read_bytes()) == protocol["analyzer_sha256"]
    frozen = read(root / "freeze.json")
    assert sha((root / "freeze.json").read_bytes()) == protocol["freeze_sha256"]
    prepared = read(root / "prepared.json")
    queries = {q["id"]: q for q in prepared["queries"]}
    chunks = {c["id"]: c for c in prepared["chunks"]}
    rows = []
    for split in ("dev", "heldout"):
        path = root / f"{split}.jsonl"
        receipt = read(root / f"{split}-receipt.json")
        assert sha(path.read_bytes()) == receipt["result_sha256"]
        assert (
            sha((root / "selection.json").read_bytes()) == receipt["selection_sha256"]
        )
        part = records(path)
        assert len(part) == receipt["rows"]
        assert len({(r["id"], r["arm"]) for r in part}) == len(part)
        assert all(r["id"] in queries and set(r["hits"]) <= chunks.keys() for r in part)
        assert all(
            math.isfinite(v) and 0 <= v <= 1
            for r in part
            for v in r["metrics"].values()
        )
        rows.extend(part)
    by_key = {(r["id"], r["arm"]): r for r in rows}
    multi = [q for q in queries.values() if q["split"] == "heldout"]
    deltas = {}
    for arm in ARMS:
        pairs = [
            (q, by_key[(q["id"], "current")], by_key[(q["id"], arm)]) for q in multi
        ]
        deltas[arm] = {
            "hit_gains": [
                q["id"]
                for q, a, b in pairs
                if b["metrics"]["hit5"] > a["metrics"]["hit5"]
            ],
            "hit_losses": [
                q["id"]
                for q, a, b in pairs
                if b["metrics"]["hit5"] < a["metrics"]["hit5"]
            ],
            "ndcg_gains": sum(
                b["metrics"]["ndcg5"] > a["metrics"]["ndcg5"] for q, a, b in pairs
            ),
            "ndcg_losses": sum(
                b["metrics"]["ndcg5"] < a["metrics"]["ndcg5"] for q, a, b in pairs
            ),
        }
    save(root / "deltas.json", deltas)
    selection = read(root / "selection.json")
    packet = []
    selected = deltas["cc_bm25_selected"]
    losses = sorted(
        selected["hit_losses"],
        key=lambda qid: (
            by_key[(qid, "cc_bm25_selected")]["metrics"]["ndcg5"]
            - by_key[(qid, "current")]["metrics"]["ndcg5"],
            qid,
        ),
    )[:10]
    gains = sorted(selected["hit_gains"], key=lambda qid: sha(qid.encode()))[:8]
    for qid in losses + gains:
        q = queries[qid]
        old, new = by_key[(qid, "current")], by_key[(qid, "cc_bm25_selected")]

        def label(c, query=q):
            return c["id"] if query["label_unit"] == "chunk" else c["file_id"]

        def render(cid, query=q, key_for=label):
            return {
                "id": cid,
                "grade": query["qrels"].get(key_for(chunks[cid]), 0),
                "text": chunks[cid]["text"],
            }

        packet.append(
            {
                "id": qid,
                "change": "loss" if qid in losses else "gain",
                "query": q,
                "before": old,
                "after": new,
                "before_texts": [render(c) for c in old["hits"]],
                "after_texts": [render(c) for c in new["hits"]],
                "positive_texts": [
                    render(cid)
                    for cid, c in chunks.items()
                    if q["qrels"].get(label(c), 0) > 0
                ],
            }
        )
    save(root / "source-review-packet.json", packet)
    intervals = {}
    for cohort in ("natural", "controlled"):
        for baseline in ("current", "dense"):
            groups = collections.defaultdict(list)
            for q in multi:
                if q["cohort"] == cohort:
                    groups[q["family"]].append(
                        by_key[(q["id"], "cc_bm25_selected")]["metrics"]["ndcg5"]
                        - by_key[(q["id"], baseline)]["metrics"]["ndcg5"]
                    )
            values = list(groups.values())
            rng = random.Random(20260913)
            draws = sorted(
                statistics.mean(
                    v for group in rng.choices(values, k=len(values)) for v in group
                )
                for _ in range(2000)
            )
            intervals[cohort + "/" + baseline] = {
                "delta": statistics.mean(v for group in values for v in group),
                "families": len(values),
                "percentile95": [draws[49], draws[1949]],
            }
    save(root / "intervals.json", intervals)
    features = records(root / "features.jsonl")
    assert (
        sha((root / "features.jsonl").read_bytes())
        == read(root / "extraction.json")["features_sha256"]
    )
    full_pairs, nonmatch_positive, outside40_positive = 0, 0, 0
    for f in features:
        q = queries[f["id"]]
        scope = {cid for cid, c in chunks.items() if c["scope"] == q["scope"]}
        assert {r["id"] for r in f["rows"]} == scope
        assert len(f["rows"]) == len(scope)
        full_pairs += len(scope)
        nonmatch_positive += sum(
            r["pg_score"] > 0 and not r["pg_match"] for r in f["rows"]
        )
        pg40 = {
            r["id"]
            for r in sorted(
                (r for r in f["rows"] if r["pg_match"]),
                key=lambda r: (-r["all_match"], -r["pg_score"], r["pg_tie"], r["id"]),
            )[:40]
        }
        dense40 = sorted(f["rows"], key=lambda r: (-r["cosine"], r["id"]))[:40]
        outside40_positive += sum(
            r["pg_score"] > 0 and r["id"] not in pg40 for r in dense40
        )
    for split in ("dev", "heldout"):
        saved = records(root / f"{split}-bm25-scores.jsonl")
        for f in saved:
            q = queries[f["id"]]
            assert set(f["scores"]) == {
                c for c, v in chunks.items() if v["scope"] == q["scope"]
            }
            assert f["parameters"] == selection["bm25"]
            assert all(math.isfinite(s) and s >= 0 for s in f["scores"].values())
    save(
        root / "integrity.json",
        {
            "status": "passed",
            "scored_rows": len(rows),
            "full_query_document_pairs": full_pairs,
            "nonmatching_pg_positive_scores": nonmatch_positive,
            "positive_pg_dense_candidates_outside_current_lexical40": outside40_positive,
            "selected_bm25_full_scores_verified": len(queries),
            "input_runner_sha256": frozen["script_sha256"],
            "analyzer_sha256": protocol["analyzer_sha256"],
        },
    )
    save(
        root / "jlpt.json",
        [r for r in rows if r["cohort"] == "jlpt" and r["arm"] in ARMS],
    )
    print(
        json.dumps(
            {
                "selection": {
                    k: selection[k] for k in ("bm25", "alpha_pg", "alpha_bm25")
                },
                "rows": len(rows),
                "full_pairs": full_pairs,
                "selected_gains": len(selected["hit_gains"]),
                "selected_losses": len(selected["hit_losses"]),
            }
        )
    )


if __name__ == "__main__":
    if sys.argv[1] == "baseline":
        baseline(Path(sys.argv[2]))
    else:
        run(Path(sys.argv[1]))
