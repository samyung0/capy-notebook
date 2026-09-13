"""Replay frozen multilingual candidates under a small set of fusion rules."""

import argparse
import collections
import hashlib
import json
import math
from pathlib import Path

EXPECTED = {
    "prepared.json": "34f3b67f83601d33e4a3938efea87d59f2b919a73aa464c6b80540a45408c96a",
    "dev.jsonl": "313ff544b59b81ac988cf88bebefd5ce9728e68221f965224835b4d5590ad2af",
    "heldout.jsonl": "1a6e534a7b1e0c15826654e9a6c8031bbfba5b48bdfd1e4f236ca60ee5bb8e4b",
    "jlpt_snapshot.json": "0fb5faa79e0ff11128d75bb58179602d3184c11bd16589a6ad01beadf2b1dc5b",
    "jlpt_results.json": "dafded6a2d0f4fed71a263138c121159dd5889e9b84a1b756399f3e9a3291ec1",
}
METHODS = ("current", "dense", "equal_rrf", "all_term_rrf", "score_tmm_50")
RRF_K = 60
TOP_CANDIDATES = 40
TOP_K = 5


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load_json(path):
    return json.loads(path.read_text())


def baseline_records(path):
    records = {}
    for line in path.read_text().splitlines():
        row = json.loads(line)
        if row["method"] == "baseline":
            assert row["id"] not in records
            records[row["id"]] = row
    return records


def rrf_score(row, lexical_weight):
    dense = row["dense"]
    score = 1 / (RRF_K + dense["rank"]) if dense["rank"] <= 40 else 0
    lexical = row["lexical"]
    if lexical:
        score += lexical_weight(lexical) / (RRF_K + lexical["rank"])
    return score


def rank_candidates(record, method):
    rows = record["candidates"]
    if method == "dense":
        ranked = [
            (1 - row["dense"]["distance"], row)
            for row in rows
            if row["dense"]["rank"] <= TOP_CANDIDATES
        ]
    elif method == "current":
        ranked = [
            (rrf_score(row, lambda lex: 1 if lex["exact"] else 0.5), row)
            for row in rows
        ]
    elif method == "equal_rrf":
        ranked = [(rrf_score(row, lambda _lex: 1), row) for row in rows]
    elif method == "all_term_rrf":
        ranked = [
            (rrf_score(row, lambda lex: 1 if lex["all_match"] else 0.5), row)
            for row in rows
        ]
    elif method == "score_tmm_50":
        # Theoretical min-max normalization from Bruch et al. The lower bounds
        # are -1 for cosine similarity and 0 for PostgreSQL cover-density rank.
        maximum_dense = max(1 - row["dense"]["distance"] for row in rows)
        maximum_lexical = max(
            (row["lexical"]["score"] if row["lexical"] else 0 for row in rows),
            default=0,
        )
        ranked = []
        for row in rows:
            dense = ((1 - row["dense"]["distance"]) + 1) / (maximum_dense + 1)
            lexical = (
                row["lexical"]["score"] / maximum_lexical
                if row["lexical"] and maximum_lexical
                else 0
            )
            ranked.append((0.5 * dense + 0.5 * lexical, row))
    else:
        raise ValueError(method)
    ranked.sort(key=lambda item: (-item[0], item[1]["id"]))
    return [{**row, "strategy_score": score} for score, row in ranked[:40]]


def cap(rows, files, per_file):
    seen = collections.Counter()
    kept, overflow = [], []
    for row in rows:
        file_id = files[row["id"]]
        if seen[file_id] < per_file:
            kept.append(row)
            seen[file_id] += 1
        else:
            overflow.append(row)
    return (kept + overflow)[:TOP_K]


def relevance_metrics(rows, qrels, files):
    seen, found = set(), set()
    dcg = 0.0
    reciprocal = 0.0
    for position, row in enumerate(rows, 1):
        file_id = files[row["id"]]
        grade = qrels.get(file_id, 0) if file_id not in seen else 0
        seen.add(file_id)
        if grade > 0:
            found.add(file_id)
            dcg += (2**grade - 1) / math.log2(position + 1)
            if not reciprocal:
                reciprocal = 1 / position
    relevant = {file_id for file_id, grade in qrels.items() if grade > 0}
    ideal = sum(
        (2**grade - 1) / math.log2(position + 2)
        for position, grade in enumerate(sorted(qrels.values(), reverse=True)[:5])
    )
    return {
        "hit5": int(bool(found)),
        "ndcg5": dcg / ideal if ideal else 0,
        "mrr5": reciprocal,
        "recall5": len(found) / len(relevant) if relevant else 0,
    }


def source_recall(rows, qrels, files):
    relevant = {file_id for file_id, grade in qrels.items() if grade > 0}
    present = {files[row["id"]] for row in rows} & relevant
    return len(present) / len(relevant) if relevant else 0


def summarize(records):
    groups = collections.defaultdict(list)
    for row in records:
        for group, key in (
            ("overall", "all"),
            ("locale", row["locale"]),
            ("kind", row["kind"]),
            ("locale_kind", row["locale"] + "/" + row["kind"]),
        ):
            groups[(row["split"], row["method"], group, key)].append(row)
    output = []
    for (split, method, group, key), rows in sorted(groups.items()):
        output.append(
            {
                "split": split,
                "method": method,
                "group": group,
                "key": key,
                "questions": len(rows),
                "hit5": sum(row["metrics"]["hit5"] for row in rows),
                "ndcg5": sum(row["metrics"]["ndcg5"] for row in rows) / len(rows),
                "mrr5": sum(row["metrics"]["mrr5"] for row in rows) / len(rows),
                "recall5": sum(row["metrics"]["recall5"] for row in rows) / len(rows),
                "union_recall": sum(row["union_recall"] for row in rows) / len(rows),
                "ranked40_recall": sum(row["ranked40_recall"] for row in rows)
                / len(rows),
            }
        )
    return output


def compare(records):
    by_key = {(row["split"], row["id"], row["method"]): row for row in records}
    output = {}
    for split in ("dev", "heldout"):
        current = {
            row["id"]: row
            for row in records
            if row["split"] == split and row["method"] == "current"
        }
        output[split] = {}
        for method in METHODS[1:] + ("current_cap5",):
            gains, losses = [], []
            for query_id, baseline in current.items():
                row = by_key[(split, query_id, method)]
                delta = row["metrics"]["hit5"] - baseline["metrics"]["hit5"]
                if delta > 0:
                    gains.append(query_id)
                elif delta < 0:
                    losses.append(query_id)
            output[split][method] = {"hit_gains": gains, "hit_losses": losses}
    return output


def replay_multilingual(root):
    prepared_path = root / "prepared.json"
    assert digest(prepared_path) == EXPECTED["prepared.json"]
    prepared = load_json(prepared_path)
    queries = {row["id"]: row for row in prepared["queries"]}
    files = {row["id"]: row["file_id"] for row in prepared["chunks"]}
    output = []
    for split in ("dev", "heldout"):
        source = root / f"{split}.jsonl"
        assert digest(source) == EXPECTED[source.name]
        records = baseline_records(source)
        assert len(records) == 312
        for query_id, record in records.items():
            query = queries[query_id]
            union_recall = source_recall(record["candidates"], query["qrels"], files)
            for method in METHODS:
                ranked = rank_candidates(record, method)
                hits = cap(ranked, files, 4)
                output.append(
                    {
                        "id": query_id,
                        "split": split,
                        "locale": query["locale"],
                        "kind": query["kind"],
                        "family": query["family"],
                        "method": method,
                        "union_recall": union_recall,
                        "ranked40_recall": source_recall(ranked, query["qrels"], files),
                        "metrics": relevance_metrics(hits, query["qrels"], files),
                        "hits": [row["id"] for row in hits],
                    }
                )
                if method == "current":
                    assert [row["id"] for row in hits] == [
                        row["id"] for row in record["hits"]
                    ]
                    cap5 = cap(ranked, files, 5)
                    output.append(
                        {
                            "id": query_id,
                            "split": split,
                            "locale": query["locale"],
                            "kind": query["kind"],
                            "family": query["family"],
                            "method": "current_cap5",
                            "union_recall": union_recall,
                            "ranked40_recall": source_recall(
                                ranked, query["qrels"], files
                            ),
                            "metrics": relevance_metrics(cap5, query["qrels"], files),
                            "hits": [row["id"] for row in cap5],
                        }
                    )
    return output


def replay_jlpt(root):
    snapshot_path, results_path = root / "snapshot.json", root / "results.json"
    assert digest(snapshot_path) == EXPECTED["jlpt_snapshot.json"]
    assert digest(results_path) == EXPECTED["jlpt_results.json"]
    snapshot, source = load_json(snapshot_path), load_json(results_path)
    files = {row["id"]: row["file_id"] for row in snapshot["chunks"]}
    target = "chk_5901ee92e1a8f428"
    output = []
    for record in source:
        if record["variant"] != "stored_original" or record["mode"] != "current":
            continue
        fake = {
            "candidates": [
                {
                    "id": row["id"],
                    "dense": {
                        "rank": row["vector_rank"],
                        "distance": row["distance"],
                    },
                    "lexical": row["lexical"],
                }
                for row in record["candidates"]
            ]
        }
        methods = METHODS[:-1]
        for method in methods:
            ranked = rank_candidates(fake, method)
            hits = cap(ranked, files, 4)
            output.append(
                {
                    "query": record["query"],
                    "method": method,
                    "target_rank40": next(
                        (i for i, row in enumerate(ranked, 1) if row["id"] == target),
                        None,
                    ),
                    "target_output": next(
                        (i for i, row in enumerate(hits, 1) if row["id"] == target),
                        None,
                    ),
                }
            )
    assert len(output) == 20
    return output


def self_check():
    files = {str(i): "a" if i < 5 else "b" for i in range(6)}
    rows = [{"id": str(i)} for i in range(6)]
    assert [row["id"] for row in cap(rows, files, 4)] == ["0", "1", "2", "3", "5"]
    assert [row["id"] for row in cap(rows, files, 5)] == ["0", "1", "2", "3", "4"]


def main():
    parser = argparse.ArgumentParser()
    default = Path("bench/rag/reports/local")
    parser.add_argument(
        "--multilingual-root",
        type=Path,
        default=default / "2026-09-13-multilingual-language-handling",
    )
    parser.add_argument(
        "--jlpt-root", type=Path, default=default / "2026-09-13-jlpt-lookup"
    )
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    self_check()
    args.output.mkdir(parents=True, exist_ok=False)
    multilingual = replay_multilingual(args.multilingual_root)
    jlpt = replay_jlpt(args.jlpt_root)
    details = args.output / "results.jsonl"
    details.write_text(
        "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in multilingual)
    )
    summary = {
        "protocol": {
            "methods": list(METHODS),
            "rrf_k": RRF_K,
            "candidate_limit": TOP_CANDIDATES,
            "top_k": TOP_K,
            "score_fusion": "theoretical min-max, alpha=0.5",
            "input_hashes": EXPECTED,
        },
        "records": len(multilingual),
        "summary": summarize(multilingual),
        "comparisons": compare(multilingual),
        "jlpt": jlpt,
        "results_sha256": digest(details),
    }
    (args.output / "summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + "\n"
    )


if __name__ == "__main__":
    main()
