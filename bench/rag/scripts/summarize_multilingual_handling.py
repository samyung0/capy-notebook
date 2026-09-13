"""Summarize frozen results without provider calls or retrieval changes."""

import collections
import hashlib
import json
import random
import sys
from pathlib import Path


def macro(rows, metric="ndcg5"):
    groups = collections.defaultdict(list)
    for row in rows:
        groups[row["kind"]].append(row["metrics"][metric])
    return sum(sum(values) / len(values) for values in groups.values()) / len(groups)


def interval(pairs):
    # Resample source families, retaining all their query forms together.
    strata = {
        "controlled": collections.defaultdict(list),
        "natural": collections.defaultdict(list),
    }
    for baseline, candidate in pairs:
        name = "natural" if baseline["kind"] == "natural_semantic" else "controlled"
        strata[name][baseline["family"]].append((baseline, candidate))
    rng = random.Random(20260913)
    deltas = []
    for _ in range(2000):
        sampled = []
        for groups in strata.values():
            keys = sorted(groups)
            if keys:
                for key in rng.choices(keys, k=len(keys)):
                    sampled.extend(groups[key])
        deltas.append(macro([b for _, b in sampled]) - macro([a for a, _ in sampled]))
    deltas.sort()
    return [deltas[49], deltas[1949]]


def run(root):
    prepared = json.loads((root / "prepared.json").read_text())
    queries = {q["id"]: q for q in prepared["queries"]}
    methods = ["baseline", "normalized", "segmented", "content_terms", "dense"]
    rows = [
        json.loads(line) for line in (root / "heldout.jsonl").read_text().splitlines()
    ]
    lookup = {(r["id"], r["method"]): r for r in rows}
    assert len(lookup) == len(rows) == 312 * len(methods)
    assert all(queries[r["id"]]["split"] == "heldout" for r in rows)
    results = {}
    for locale in sorted({r["locale"] for r in rows}):
        baseline = [
            r for r in rows if r["locale"] == locale and r["method"] == "baseline"
        ]
        results[locale] = {}
        for method in methods:
            pairs = [(b, lookup[(b["id"], method)]) for b in baseline]
            changed = []
            for b, c in pairs:
                if b["metrics"] != c["metrics"]:
                    changed.append(
                        {
                            "id": b["id"],
                            "q": queries[b["id"]]["q"],
                            "kind": b["kind"],
                            "baseline": b["metrics"],
                            "candidate": c["metrics"],
                        }
                    )
            results[locale][method] = {
                "n": len(pairs),
                "hit5": sum(c["metrics"]["hit5"] for _, c in pairs),
                "macro_ndcg": macro([c for _, c in pairs]),
                "macro_delta": macro([c for _, c in pairs]) - macro(baseline),
                "delta_family_bootstrap_95": interval(pairs)
                if method != "baseline"
                else [0, 0],
                "hit_gains": sum(
                    c["metrics"]["hit5"] > b["metrics"]["hit5"] for b, c in pairs
                ),
                "hit_losses": sum(
                    c["metrics"]["hit5"] < b["metrics"]["hit5"] for b, c in pairs
                ),
                "source_family_counts": dict(
                    collections.Counter(
                        "natural" if k.startswith("miracl-") else "controlled"
                        for k in {b["family"] for b in baseline}
                    )
                ),
                "changes": changed,
            }
    overall = {}
    for method in methods:
        overall[method] = {}
        for pool in ["controlled", "natural"]:
            group = [
                r
                for r in rows
                if r["method"] == method
                and (r["kind"] == "natural_semantic") == (pool == "natural")
            ]
            overall[method][pool] = {
                "n": len(group),
                **{
                    m: sum(r["metrics"][m] for r in group) / len(group)
                    for m in ["hit5", "ndcg5", "mrr5", "recall5"]
                },
            }
    artifact = {
        "heldout_sha256": hashlib.sha256(
            (root / "heldout.jsonl").read_bytes()
        ).hexdigest(),
        "bootstrap": "Paired percentile interval, 2000 draws, seed 20260913; source families sampled within controlled/natural strata, query forms kept together; descriptive only, four controlled held-out families per locale.",
        "locales": results,
        "overall": overall,
    }
    (root / "analysis.json").write_text(
        json.dumps(artifact, ensure_ascii=False, indent=2) + "\n"
    )
    print(json.dumps(overall, indent=2))
    for locale, conditions in results.items():
        print(
            locale,
            " | ".join(
                f"{m}: {r['hit5']}/{r['n']} {r['macro_ndcg']:.3f} delta{r['macro_delta']:+.3f} CI{r['delta_family_bootstrap_95']} gain/loss {r['hit_gains']}/{r['hit_losses']}"
                for m, r in conditions.items()
            ),
        )


if __name__ == "__main__":
    run(Path(sys.argv[1]))
