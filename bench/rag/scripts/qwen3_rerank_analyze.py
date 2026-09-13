"""Score frozen rerank attempts without network calls or label changes."""

import collections
import importlib.util
import json
import math
import random
import statistics
import sys
from pathlib import Path

import qwen3_rerank_eval as base


def mean(rows, field):
    return sum(r[field] for r in rows) / len(rows) if rows else None


def percentile(values, fraction):
    if not values:
        return None
    return sorted(values)[min(len(values) - 1, math.ceil(fraction * len(values)) - 1)]


def aggregate(rows):
    successful = [r for r in rows if r["success"]]
    return {
        "n": len(rows),
        "successful": sum(r["success"] for r in rows),
        "hits": sum(r["metrics"]["hit5"] for r in rows),
        "cap_changed": sum(r["cap_changed"] for r in rows),
        **{
            m: statistics.mean(r["metrics"][m] for r in rows)
            for m in ["hit5", "recall5", "ndcg5", "mrr5"]
        },
        "candidate_hit": mean(rows, "candidate_hit"),
        "candidate_recall": mean(rows, "candidate_recall"),
        "candidate_count_mean": mean(rows, "candidate_count"),
        "successful_call_quality": {
            "n": len(successful),
            **{
                m: statistics.mean(r["metrics"][m] for r in successful)
                if successful
                else None
                for m in ["hit5", "recall5", "ndcg5", "mrr5"]
            },
        },
        "failure_as_zero": True,
    }


def grouped(rows, fields):
    groups = collections.defaultdict(list)
    for row in rows:
        groups["/".join(str(row[f]) for f in fields)].append(row)
    return {key: aggregate(group) for key, group in sorted(groups.items())}


def analyze(root):
    global base
    protocol = base.read(root / "analysis-freeze.json")
    assert base.sha(Path(__file__).read_bytes()) == protocol["analyzer_sha256"]
    assert (
        base.sha((root / "freeze.json").read_bytes())
        == protocol["network_freeze_sha256"]
    )
    frozen = base.read(root / "freeze.json")
    snapshot = root / "qwen3_rerank_eval.py"
    assert base.sha(snapshot.read_bytes()) == frozen["script_sha256"]
    spec = importlib.util.spec_from_file_location("qwen3_executed", snapshot)
    executed = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(executed)
    base = executed
    prepared = base.read(root / "prepared.json")
    assert (
        base.sha((root / "prepared.json").read_bytes())
        == base.read(root / "freeze.json")["prepared_sha256"]
    )
    chunks, queries = prepared["chunks"], prepared["queries"]
    assert base.sha((root / "payloads.json").read_bytes()) == frozen["payloads_sha256"]
    assert base.sha((root / "probe.json").read_bytes()) == frozen["probe_sha256"]
    payload_list = base.read(root / "payloads.json")
    payloads = {p["id"]: p for p in payload_list}
    assert len(payloads) == len(payload_list) == frozen["planned_main_calls"]
    query_map = {q["id"]: q for q in queries}
    assert len(query_map) == len(queries) == frozen["queries"]
    for payload in payload_list:
        query = query_map[payload["query_id"]]
        ids = payload["document_ids"]
        assert ids == sorted(query["pools"][payload["pool"]]) and len(ids) == len(
            set(ids)
        )
        assert payload["id"] == query["id"] + "/" + payload["pool"]
        assert payload["body"] == {
            "model": frozen["model"],
            "query": query["query"],
            "documents": [chunks[cid]["text"] for cid in ids],
            "top_n": len(ids),
            "instruct": frozen["instruction"],
        }
    attempts = [base.read(p) for p in sorted((root / "attempts").glob("*.json"))]
    assert [a["sequence"] for a in attempts] == list(range(1, len(attempts) + 1))
    assert (
        len({a["id"] for a in attempts}) == len(attempts) <= frozen["hard_attempt_cap"]
    )
    all_payloads = payloads | {"schema-probe": base.read(root / "probe.json")}
    for attempt in attempts:
        payload = all_payloads[attempt["id"]]
        assert (
            attempt["query_id"] == payload["query_id"]
            and attempt["pool"] == payload["pool"]
        )
        assert attempt["payload_sha256"] == base.sha(
            json.dumps(payload["body"], ensure_ascii=False, separators=(",", ":"))
        )
        assert attempt["state"] in {"success", "failed", "started"}
        if attempt["state"] == "success":
            assert attempt["status"] == 200
            base.validate_response(attempt["response"], len(payload["document_ids"]))
    base.save(
        root / "integrity.json",
        {
            "status": "passed",
            "attempts": len(attempts),
            "checks": [
                "frozen inputs and executed snapshot hashes",
                "unique query and payload IDs",
                "body/index membership",
                "unique contiguous attempt sequences",
                "attempt-to-body hashes and successful response schemas",
            ],
            "missing_payload_ids": sorted(set(payloads) - {a["id"] for a in attempts}),
            "incomplete_attempts": [
                a["id"] for a in attempts if a["state"] == "started"
            ],
            "analyzer_sha256": protocol["analyzer_sha256"],
        },
    )
    calls = {}
    for attempt in attempts:
        if attempt["id"] != "schema-probe":
            assert attempt["id"] not in calls, (
                "Repeated attempts require an explicit selection policy"
            )
            calls[attempt["id"]] = attempt

    def scores(qid, pool):
        cid = qid + "/" + pool
        call = calls.get(cid)
        if not call or call["state"] != "success":
            return None
        payload = payloads[cid]
        base.validate_response(call["response"], len(payload["document_ids"]))
        return {
            payload["document_ids"][r["index"]]: r["relevance_score"]
            for r in call["response"]["results"]
        }

    rows, agreement = [], []
    for query in queries:
        union_scores = scores(query["id"], "union")
        for pool in base.POOLS:
            ids = query["pools"][pool]
            conditions = [(pool, ids, True)]
            reranked = (
                sorted(ids, key=lambda cid: (-union_scores[cid], cid))
                if union_scores
                else []
            )
            conditions.append(
                (
                    pool + ("_rerank" if pool == "union" else "_rerank_union_replay"),
                    reranked,
                    union_scores is not None,
                )
            )
            direct = scores(query["id"], pool) if pool != "union" else None
            if query["id"] + "/" + pool in payloads and pool != "union":
                direct_ids = (
                    sorted(ids, key=lambda cid: (-direct[cid], cid)) if direct else []
                )
                conditions.append(
                    (pool + "_rerank_direct", direct_ids, direct is not None)
                )
                if direct and union_scores:
                    direct_hits, replay_hits = (
                        base.capped(direct_ids, chunks),
                        base.capped(reranked, chunks),
                    )
                    ranks = {cid: i for i, cid in enumerate(reranked)}
                    inversions = sum(
                        ranks[a] > ranks[b]
                        for i, a in enumerate(direct_ids)
                        for b in direct_ids[i + 1 :]
                    )
                    agreement.append(
                        {
                            "id": query["id"],
                            "locale": query["locale"],
                            "cohort": query["cohort"],
                            "pool": pool,
                            "same_full_order": direct_ids == reranked,
                            "same_top5_order": direct_hits == replay_hits,
                            "top5_overlap": len(set(direct_hits) & set(replay_hits))
                            / 5,
                            "inversions": inversions,
                            "pairs": len(ids) * (len(ids) - 1) // 2,
                            "direct_ids": direct_ids,
                            "replay_ids": reranked,
                        }
                    )
            label_ids = {
                cid if query["label_unit"] == "chunk" else chunks[cid]["file_id"]
                for cid in ids
            }
            relevant = {key for key, grade in query["qrels"].items() if grade > 0}
            for arm, ordered, success in conditions:
                hits = base.capped(ordered, chunks)
                rows.append(
                    {
                        **{
                            k: query[k]
                            for k in [
                                "id",
                                "locale",
                                "cohort",
                                "split",
                                "kind",
                                "family",
                            ]
                        },
                        "arm": arm,
                        "success": success,
                        "candidate_count": len(ids),
                        "candidate_hit": int(bool(label_ids & relevant)),
                        "candidate_recall": len(label_ids & relevant) / len(relevant),
                        "metrics": base.metrics(hits, query, chunks),
                        "hits": hits,
                        "uncapped_top5": ordered[:5],
                        "cap_changed": hits != ordered[:5],
                        "relevant_candidate_ranks": {
                            cid: i + 1
                            for i, cid in enumerate(ordered)
                            if (
                                cid
                                if query["label_unit"] == "chunk"
                                else chunks[cid]["file_id"]
                            )
                            in relevant
                        },
                    }
                )
    with (root / "scored.jsonl").open("w") as out:
        for row in rows:
            out.write(json.dumps(row, ensure_ascii=False) + "\n")
    base.save(root / "agreement.json", agreement)
    summary = {
        "cohort_split_arm": grouped(rows, ["cohort", "split", "arm"]),
        "locale_split_arm": grouped(
            [r for r in rows if r["cohort"] != "jlpt"], ["locale", "split", "arm"]
        ),
        "task_split_arm": grouped(
            [r for r in rows if r["cohort"] != "jlpt"], ["kind", "split", "arm"]
        ),
    }
    base.save(root / "summary.json", summary)
    latency = {}
    for pool in ["union", "hybrid40", "dense40", "schema"]:
        subset = [a for a in attempts if a["pool"] == pool]
        successful = [a for a in subset if a["state"] == "success"]
        elapsed = [a["elapsed_ms"] for a in successful]
        latency[pool] = {
            "attempts": len(subset),
            "successes": len(successful),
            "p50_ms": percentile(elapsed, 0.5),
            "p95_ms": percentile(elapsed, 0.95),
            "max_ms": max(elapsed) if elapsed else None,
        }
    usage = [a.get("response", {}).get("usage") for a in attempts]
    reported = [
        u["total_tokens"]
        for u in usage
        if isinstance(u, dict) and isinstance(u.get("total_tokens"), int)
    ]
    costs = {
        "attempts": len(attempts),
        "responses_with_reported_total_tokens": len(reported),
        "reported_total_tokens": sum(reported),
        "gross_list_price_cny": 0.5 * sum(reported) / 1_000_000,
        "actual_billed_cost": None,
        "usage_missing_attempts": len(attempts) - len(reported),
        "returned_models": sorted(
            {
                a.get("response", {}).get("model")
                for a in attempts
                if a.get("response", {}).get("model")
            }
        ),
        "latency": latency,
    }
    base.save(root / "usage-latency.json", costs)
    lookup = {(r["id"], r["arm"]): r for r in rows}
    deltas = []
    for row in rows:
        if row["arm"] == "hybrid40":
            continue
        before = lookup[(row["id"], "hybrid40")]
        if before["metrics"] != row["metrics"]:
            deltas.append(
                {
                    **{
                        k: row[k]
                        for k in ["id", "locale", "cohort", "split", "kind", "arm"]
                    },
                    "before": before["metrics"],
                    "after": row["metrics"],
                    "before_hits": before["hits"],
                    "after_hits": row["hits"],
                    "change_type": "ranking_change"
                    if row["success"]
                    else "provider_failure",
                }
            )
    base.save(root / "deltas.json", deltas)
    intervals = {}
    for cohort in ["natural", "controlled"]:
        baseline = [
            r
            for r in rows
            if r["cohort"] == cohort
            and r["split"] == "heldout"
            and r["arm"] == "hybrid40"
        ]
        groups = collections.defaultdict(list)
        for r in baseline:
            groups[r["family"]].append(r)
        for arm in [
            "dense40",
            "hybrid40_rerank_union_replay",
            "dense40_rerank_union_replay",
            "union_rerank",
        ]:
            rng, changes = random.Random(20260913), []
            matched = {
                key: [r for r in group if lookup[(r["id"], arm)]["success"]]
                for key, group in groups.items()
            }
            matched = {key: group for key, group in matched.items() if group}
            keys = sorted(matched)
            if not keys:
                intervals[cohort + "/" + arm] = {
                    "successful_pairs": 0,
                    "percentile95": None,
                }
                continue
            for _ in range(2000):
                chosen = [r for k in rng.choices(keys, k=len(keys)) for r in matched[k]]
                changes.append(
                    statistics.mean(
                        lookup[(r["id"], arm)]["metrics"]["ndcg5"]
                        - r["metrics"]["ndcg5"]
                        for r in chosen
                    )
                )
            intervals[cohort + "/" + arm] = {
                "delta": statistics.mean(
                    lookup[(r["id"], arm)]["metrics"]["ndcg5"] - r["metrics"]["ndcg5"]
                    for group in matched.values()
                    for r in group
                ),
                "family_count": len(matched),
                "successful_pairs": sum(len(group) for group in matched.values()),
                "provider_failures_excluded": len(baseline)
                - sum(len(group) for group in matched.values()),
                "percentile95": [
                    percentile(changes, 0.025),
                    percentile(changes, 0.975),
                ],
            }
    base.save(root / "intervals.json", intervals)
    print(json.dumps(costs, indent=2))
    print(
        json.dumps(
            {
                k: v
                for k, v in summary["cohort_split_arm"].items()
                if "/heldout/" in k and "direct" not in k
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    analyze(Path(sys.argv[2]))
