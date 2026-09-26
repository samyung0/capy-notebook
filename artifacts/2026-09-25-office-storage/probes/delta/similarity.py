"""Cosine similarity of each arm's summary to the same round's full
regeneration, with Qwen3-Embedding-4B (the production embedding model).
The floor is two full runs on identical input (round 0 a/b/c, last round a/b).
Usage: python similarity.py chapter|book
"""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import llm

HERE = Path(__file__).resolve().parent
ARMS = ("reuse", "diff", "chunk", "diff2", "chunk2", "diff3", "diff3t")


def cos(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    return dot / (math.sqrt(sum(x * x for x in a)) * math.sqrt(sum(y * y for y in b)))


def main() -> None:
    doc = sys.argv[1]
    results = json.loads((HERE / f"results-{doc}.json").read_text(encoding="utf-8"))
    rounds = sorted(
        {k.split("-")[0] for k in results["full"]}, key=lambda r: int(r[1:])
    )
    items: dict[str, dict] = {}
    for key, s in results["full"].items():
        items[f"full-{key}"] = s
    for arm in ARMS:
        for r in rounds[1:]:
            if arm == "reuse":
                items[f"reuse-{r}"] = results["full"][f"{rounds[0]}-a"]
            elif arm in results and r in results[arm]:
                items[f"{arm}-{r}"] = results[arm][r]
    names = sorted(items)
    vectors = {}
    for field in ("descriptor", "summary"):
        texts = [items[n][field] for n in names]
        vecs = llm.embed(f"{doc}-{field}-{len(names)}", texts)
        vectors[field] = dict(zip(names, vecs))
    table = {}
    for field in ("descriptor", "summary"):
        v = vectors[field]
        floor = [
            cos(v[f"full-{rounds[0]}-a"], v[f"full-{rounds[0]}-b"]),
            cos(v[f"full-{rounds[0]}-a"], v[f"full-{rounds[0]}-c"]),
            cos(v[f"full-{rounds[0]}-b"], v[f"full-{rounds[0]}-c"]),
            cos(v[f"full-{rounds[-1]}-a"], v[f"full-{rounds[-1]}-b"]),
        ]
        table[field] = {"floor_full_vs_full": [round(x, 4) for x in floor]}
        for arm in ARMS:
            row = {}
            for r in rounds[1:]:
                name = f"{arm}-{r}"
                if name in v:
                    row[r] = round(cos(v[name], v[f"full-{r}-a"]), 4)
            if row:
                table[field][arm] = row
    (HERE / f"similarity-{doc}.json").write_text(
        json.dumps(table, indent=1), encoding="utf-8"
    )
    for field, rows in table.items():
        print(f"== {field}")
        for arm, row in rows.items():
            print(f"  {arm:20s}", row)


if __name__ == "__main__":
    main()
