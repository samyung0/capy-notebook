"""Summarize diagnostic results without treating number matching as a judge."""

import json
import statistics
import sys
from collections import defaultdict
from pathlib import Path

groups = defaultdict(list)
for path in sys.argv[1:]:
    for line in Path(path).read_text().splitlines():
        row = json.loads(line)
        groups[(row["variant"], row["split"])].append(row)

for (variant, split), rows in sorted(groups.items()):
    completed = [r for r in rows if r["status"] == "complete"]
    answerable = [r for r in completed if not r["score"]["needs_manual_grade"]]
    searches = [
        sum(c["name"] == "search_workspace" and not c["refused"] for c in r["calls"])
        for r in completed
    ]
    tokens = [
        next(
            (
                e.get("tokenCount", 0)
                for e in reversed(r["events"])
                if e["type"] == "done"
            ),
            0,
        )
        for r in completed
    ]
    result = {
        "variant": variant,
        "split": split,
        "completed": len(completed),
        "attempted": len(rows),
        "answerable": len(answerable),
        "all_answer_values_present": sum(
            r["score"]["answer_values_present"] for r in answerable
        ),
        "all_required_evidence_reached": sum(
            r["score"]["all_evidence_reached"] for r in answerable
        ),
        "values_and_evidence": sum(
            r["score"]["answer_values_present"] and r["score"]["all_evidence_reached"]
            for r in answerable
        ),
        "all_required_evidence_cited": sum(
            r["score"]["all_evidence_cited"] for r in answerable
        ),
        "needs_manual_grade": [
            r["id"] for r in completed if r["score"]["needs_manual_grade"]
        ],
        "failed_value_or_evidence_checks": [
            r["id"]
            for r in answerable
            if not (
                r["score"]["answer_values_present"]
                and r["score"]["all_evidence_reached"]
            )
        ],
        "mean_searches": round(statistics.mean(searches), 2),
        "median_latency_s": round(
            statistics.median(r["elapsed_s"] for r in completed), 2
        ),
        "mean_latency_s": round(statistics.mean(r["elapsed_s"] for r in completed), 2),
        "mean_reported_tokens": round(statistics.mean(tokens)),
    }
    print(json.dumps(result))
