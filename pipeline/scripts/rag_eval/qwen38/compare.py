"""Summarize the complete, source-reviewed paired chat comparison."""

from __future__ import annotations

import argparse
import collections
import json
import random
import statistics
from pathlib import Path

NEGATIVE = {"missing_bridge", "unanswerable"}


def quantile(values, fraction):
    values = sorted(values)
    index = (len(values) - 1) * fraction
    lo = int(index)
    return values[lo] + (values[min(lo + 1, len(values) - 1)] - values[lo]) * (
        index - lo
    )


def strict(row):
    return (
        row["status"] == "complete"
        and not row["errors"]
        and all(row[k] for k in ("task_correct", "grounded", "citations_supported"))
    )


def read(root):
    rows = [json.loads(s) for s in (root / "chat.jsonl").read_text().splitlines()]
    reviews = json.loads((root / "answer-reviews.json").read_text())
    assert len(rows) == len(reviews) == 192
    out = {}
    for ordinal, (row, review) in enumerate(zip(rows, reviews)):
        assert ordinal == review["ordinal"]
        key = tuple(row[k] for k in ("id", "variant", "repeat"))
        assert key == tuple(review[k] for k in ("id", "variant", "repeat"))
        assert key not in out
        out[key] = {**row, **review}
    return out


def counts(rows):
    return {
        "attempts": len(rows),
        "complete": sum(r["status"] == "complete" and not r["errors"] for r in rows),
        "nonempty_answers": sum(bool(r["answer"].strip()) for r in rows),
        **{
            k: sum(r[k] for r in rows)
            for k in ("task_correct", "grounded", "citations_supported")
        },
        "strict_supported": sum(strict(r) for r in rows),
    }


def summary(rows):
    times = [r["elapsed_s"] for r in rows]
    lengths = [len(r["answer"]) for r in rows]
    calls = collections.Counter(c["name"] for r in rows for c in r["calls"])
    return {
        **counts(rows),
        "positive": counts([r for r in rows if r["category"] not in NEGATIVE]),
        "negative": counts([r for r in rows if r["category"] in NEGATIVE]),
        "categories": {
            cat: counts([r for r in rows if r["category"] == cat])
            for cat in sorted({r["category"] for r in rows})
        },
        "latency_s": {
            "p50": quantile(times, 0.5),
            "p95": quantile(times, 0.95),
            "mean": statistics.mean(times),
            "max": max(times),
        },
        "tool_calls": dict(calls),
        "tool_failures": sum(
            bool(c["error"] or c["refused"]) for r in rows for c in r["calls"]
        ),
        "mean_tools_per_answer": sum(calls.values()) / len(rows),
        "answer_characters": {
            "p50": quantile(lengths, 0.5),
            "mean": statistics.mean(lengths),
        },
    }


def paired(old, new, variant, measure):
    keys = sorted(k for k in old if k[1] == variant)
    value = strict if measure == "strict_supported" else lambda row: row[measure]
    deltas = collections.defaultdict(list)
    gains, losses = [], []
    for key in keys:
        a, b = value(old[key]), value(new[key])
        deltas[key[0]].append(int(b) - int(a))
        if b and not a:
            gains.append(key)
        elif a and not b:
            losses.append(key)
    # Resample questions, retaining both repetitions in each sampled cluster.
    clusters = [statistics.mean(v) for v in deltas.values()]
    rng = random.Random(20260907)
    draws = sorted(
        statistics.mean(rng.choices(clusters, k=len(clusters))) for _ in range(10000)
    )
    return {
        "delta": statistics.mean(clusters),
        "question_cluster_bootstrap_95": [
            quantile(draws, 0.025),
            quantile(draws, 0.975),
        ],
        "gains": gains,
        "losses": losses,
    }


def matched_first_searches(old, new):
    cases = []
    for key, a in old.items():
        b = new[key]
        if a["category"] != "bridge":
            continue
        if not a["calls"] or not b["calls"]:
            continue
        x, y = a["calls"][0], b["calls"][0]
        if x["name"] != "search_workspace" or y["name"] != "search_workspace":
            continue
        if any(x["args"].get(k) != y["args"].get(k) for k in ("query", "file_ids")):
            continue
        same = [(p["chunk_id"], p["text"]) for p in x["passages"]] == [
            (p["chunk_id"], p["text"]) for p in y["passages"]
        ]
        cases.append(
            {
                "key": key,
                "identical_first_passages": same,
                "old_correct": a["task_correct"],
                "new_correct": b["task_correct"],
                "old_calls": [
                    {"name": c["name"], "query": c["args"].get("query")}
                    for c in a["calls"]
                ],
                "new_calls": [
                    {"name": c["name"], "query": c["args"].get("query")}
                    for c in b["calls"]
                ],
            }
        )
    return cases


def main():
    assert quantile([0, 10], 0.5) == 5
    assert not strict(
        {
            "status": "complete",
            "errors": [],
            "task_correct": True,
            "grounded": True,
            "citations_supported": False,
        }
    )
    parser = argparse.ArgumentParser()
    parser.add_argument("baseline", type=Path)
    parser.add_argument("new", type=Path)
    args = parser.parse_args()
    old, new = read(args.baseline), read(args.new)
    assert old.keys() == new.keys()
    result = {
        "review": "Codex source review using the same protocol; known fixtures, two dependent repeats; no independent human grading.",
        "models": {
            name: {
                v: summary([r for k, r in data.items() if k[1] == v])
                for v in ("qwen4", "voyage4")
            }
            for name, data in (("deepseek_flash_vision", old), ("qwen38_flash", new))
        },
        "paired_qwen_minus_deepseek": {
            v: {
                metric: paired(old, new, v, metric)
                for metric in ("task_correct", "strict_supported")
            }
            for v in ("qwen4", "voyage4")
        },
        "matched_first_search_bridge_cases": matched_first_searches(old, new),
    }
    requests = [
        json.loads(s)
        for s in (args.new / "llm-requests.jsonl").read_text().splitlines()
    ]
    questions = {r["question"] for r in new.values()}
    requests = [
        r
        for r in requests
        if any(
            m.get("role") == "user" and m.get("content") in questions
            for m in r["body"]["messages"]
        )
    ]
    assert all(
        r["actual_model"] == "qwen3.8-flash"
        and r["body"]["enable_thinking"] is False
        and r["body"]["temperature"] == 0.3
        for r in requests
    )
    usage = collections.Counter()
    for r in requests:
        u = r.get("usage") or {}
        if not r.get("error"):
            assert u and {e["model"] for e in r["responses"] if e.get("model")} == {
                "qwen3.8-flash"
            }
        for key in ("prompt_tokens", "completion_tokens", "total_tokens"):
            usage[key] += u.get(key, 0)
        usage["cached_input_tokens"] += u.get("prompt_tokens_details", {}).get(
            "cached_tokens", 0
        )
    result["qwen_provider"] = {
        "primary_attempts": len(requests),
        "failed_attempts": sum(bool(r.get("error")) for r in requests),
        "usage": dict(usage),
        "tool_calls_returned_without_tool_definitions": sum(
            not r["body"].get("tools")
            and any(
                c.get("delta", {}).get("tool_calls")
                for e in r["responses"]
                for c in e.get("choices", [])
            )
            for r in requests
        ),
        "pricing_note": "Actual Alibaba usage. The unchanged lab ledger's DeepSeek dollar amounts are not Qwen prices.",
    }
    metadata = json.loads((args.new / "api-metadata.json").read_text())
    rates = metadata["usd_per_million_tokens"]
    result["qwen_provider"]["published_rate_estimate_usd"] = (
        (usage["prompt_tokens"] - usage["cached_input_tokens"]) * rates["input"]
        + usage["cached_input_tokens"] * rates["cached_input"]
        + usage["completion_tokens"] * rates["output"]
    ) / 1_000_000
    result["qwen_provider"]["price_sources"] = metadata["sources"]
    (args.new / "comparison.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result["models"], indent=2))


if __name__ == "__main__":
    main()
