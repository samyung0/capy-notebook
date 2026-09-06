"""Summarize saved first attempts without changing labels or hiding failures."""

from __future__ import annotations

import argparse
import json
import random
import statistics
from collections import defaultdict
from pathlib import Path

METRICS = ("hit_at_5", "recall_at_5", "ndcg_at_5", "mrr_at_5")


def read(path):
    return (
        [json.loads(s) for s in path.read_text().splitlines()] if path.exists() else []
    )


def distribution(values):
    if not values:
        return {"n": 0}
    values = sorted(values)
    return {
        "n": len(values),
        "mean": statistics.mean(values),
        "p50": statistics.median(values),
        "p95": statistics.quantiles(values, n=100, method="inclusive")[94]
        if len(values) > 1
        else values[0],
    }


def aggregate(records):
    return {
        arm: {
            metric: statistics.mean(r["arms"][arm]["metrics"][metric] for r in records)
            for metric in METRICS
        }
        | {
            "hits": sum(r["arms"][arm]["metrics"]["hit_at_5"] for r in records),
            "sql_ms": distribution([r["arms"][arm]["sql_ms"] for r in records]),
        }
        for arm in ("hybrid", "dense")
    }


def summarize(root):
    quality = {}
    raw = {}
    for path in sorted(root.glob("retrieval-*.jsonl")):
        condition = path.stem.removeprefix("retrieval-")
        records = read(path)
        if not records:
            continue
        assert len({r["id"] for r in records}) == len(records)
        raw[condition] = {r["id"]: r for r in records}
        cohorts = defaultdict(list)
        for r in records:
            cohorts[r["dataset"]].append(r)
        quality[condition] = {
            "n": len(records),
            "all": aggregate(records),
            "cohorts": {k: aggregate(v) for k, v in cohorts.items()},
        }
    paired = {}
    if "qwen4" in raw:
        base = raw["qwen4"]
        for condition, records in raw.items():
            if condition == "qwen4" or records.keys() != base.keys():
                continue
            paired[condition] = {}
            for arm in ("hybrid", "dense"):
                changes = {
                    key: records[key]["arms"][arm]["metrics"]["ndcg_at_5"]
                    - base[key]["arms"][arm]["metrics"]["ndcg_at_5"]
                    for key in base
                }
                # Stratify by cohort and pair the same question across models.
                groups = defaultdict(list)
                for key, value in changes.items():
                    groups[base[key]["dataset"]].append(value)
                rng = random.Random(20260906)
                bootstrap = sorted(
                    statistics.mean(
                        rng.choice(values) for values in groups.values() for _ in values
                    )
                    for _ in range(2000)
                )
                gain, loss = [], []
                for key in base:
                    delta = (
                        records[key]["arms"][arm]["metrics"]["hit_at_5"]
                        - base[key]["arms"][arm]["metrics"]["hit_at_5"]
                    )
                    if delta > 0:
                        gain.append(key)
                    elif delta < 0:
                        loss.append(key)
                paired[condition][arm] = {
                    "hit_gains": gain,
                    "hit_losses": loss,
                    "ndcg_delta": statistics.mean(changes.values()),
                    "paired_bootstrap_95pct": [bootstrap[49], bootstrap[1949]],
                }
    ann = {}
    for path in sorted(root.glob("ann-*.jsonl")):
        records = read(path)
        if not records:
            continue
        condition = path.stem.removeprefix("ann-")
        ann[condition] = {}
        cohorts = {"all": records} | {
            label: [r for r in records if r["dataset"] == label]
            for label in sorted({r["dataset"] for r in records})
        }
        for label, cohort in cohorts.items():
            ann[condition][label] = {
                "n": len(cohort),
                "exact_ms": distribution([r["exact_ms"] for r in cohort]),
            }
            for arm in ("ef40_off", "ef100_strict_order"):
                ann[condition][label][arm] = {
                    "overlap5": statistics.mean(
                        r["arms"][arm]["overlap5"] for r in cohort
                    ),
                    "overlap40": statistics.mean(
                        r["arms"][arm]["overlap40"] for r in cohort
                    ),
                    "fewer_than_5": sum(r["arms"][arm]["returned"] < 5 for r in cohort),
                    "ms": distribution([r["arms"][arm]["ms"] for r in cohort]),
                }
    latency = {}
    timing = read(root / "latency.jsonl")
    for condition in sorted({r["condition"] for r in timing}):
        latency[condition] = {}
        for concurrency in (1, 4):
            batches = [
                r
                for r in timing
                if r["condition"] == condition and r["concurrency"] == concurrency
            ]
            requests = [v for r in batches for v in r["requests"]]
            if not requests:
                continue
            latency[condition][concurrency] = distribution(
                [r["elapsed_ms"] for r in requests if "error" not in r]
            ) | {
                "attempted": len(requests),
                "errors": sum("error" in r for r in requests),
                "completed_rps": sum("error" not in r for r in requests)
                / sum(r["wall_s"] for r in batches),
            }
    costs = {}
    requests = read(root / "requests.jsonl")
    for condition in sorted({r["condition"] for r in requests}):
        rows = [r for r in requests if r["condition"] == condition]
        tokens = sum((r.get("usage") or {}).get("prompt_tokens", 0) for r in rows)
        price = 0.02 if condition == "qwen4" else 0.01
        costs[condition] = {
            "requests": len(rows),
            "errors": sum("error" in r for r in rows),
            "prompt_tokens": tokens,
            "usd": sum((r.get("usage") or {}).get("cost", 0) for r in rows)
            if not condition.startswith("qwen")
            else tokens * price / 1e6,
            "cost_source": "DeepInfra published rate times usage"
            if condition.startswith("qwen")
            else "OpenRouter response usage.cost",
            "phases": {
                phase: {
                    "requests": sum(r["phase"] == phase for r in rows),
                    "tokens": sum(
                        (r.get("usage") or {}).get("prompt_tokens", 0)
                        for r in rows
                        if r["phase"] == phase
                    ),
                }
                for phase in sorted({r["phase"] for r in rows})
            },
        }
    chat = {}
    chat_rows = read(root / "chat.jsonl")
    for condition in sorted({r["variant"] for r in chat_rows}):
        rows = [r for r in chat_rows if r["variant"] == condition]
        positives = [r for r in rows if r["score"]["evidence_groups"]]
        chat[condition] = {
            "attempts": len(rows),
            "completed": sum(
                r["status"] == "complete" and not r["errors"] for r in rows
            ),
            "positive_attempts": len(positives),
            "negative_attempts": len(rows) - len(positives),
            "values_and_all_evidence": sum(
                r["score"]["answer_values_present"]
                and r["score"]["all_evidence_reached"]
                and not r["errors"]
                for r in positives
            ),
            "all_evidence_cited": sum(
                r["score"]["all_evidence_cited"] and not r["errors"] for r in positives
            ),
            "completed_seconds": distribution(
                [
                    r["elapsed_s"]
                    for r in rows
                    if r["status"] == "complete" and not r["errors"]
                ]
            ),
            "mean_searches": statistics.mean(
                sum(c["name"] == "search_workspace" for c in r["calls"]) for r in rows
            ),
        }
    result = {
        "quality": quality,
        "paired": paired,
        "ann": ann,
        "latency": latency,
        "embedding_costs": costs,
        "chat_diagnostics": chat,
        "indexes": {
            p.stem.removeprefix("index-"): json.loads(p.read_text())
            for p in root.glob("index-*.json")
        },
    }
    (root / "summary.json").write_text(
        json.dumps(result, ensure_ascii=False, indent=2) + "\n"
    )
    print(
        json.dumps(
            {
                condition: {
                    "n": r["n"],
                    "hybrid": r["all"]["hybrid"]["hits"],
                    "dense": r["all"]["dense"]["hits"],
                    "hybrid_ndcg": round(r["all"]["hybrid"]["ndcg_at_5"], 4),
                }
                for condition, r in quality.items()
            },
            indent=2,
        )
    )
    if len(quality) == 5 and all(r["n"] == 360 for r in quality.values()):
        winner = max(
            (c for c in quality if c != "qwen4"),
            key=lambda c: quality[c]["all"]["hybrid"]["ndcg_at_5"],
        )
        selection = {
            "challenger": winner,
            "criterion": "highest aggregate hybrid nDCG@5",
            "scores": {c: quality[c]["all"]["hybrid"]["ndcg_at_5"] for c in quality},
        }
        (root / "selection.json").write_text(json.dumps(selection, indent=2) + "\n")
        print("Selected challenger:", winner)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("root", type=Path)
    summarize(parser.parse_args().root)
