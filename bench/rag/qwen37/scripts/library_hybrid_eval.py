"""Score the production hybrid library search results (library_hybrid.py search).

Same excerpt-level metrics and paired bootstrap as library_eval.py; ranks come
from library.search(top_k=10) over 40 fused candidates, so a relevant excerpt
outside the fused candidates counts as a miss exactly as it would in the app.

Output: data/qwen37-embedding/library/results-hybrid.json
"""

from __future__ import annotations

import json

import numpy as np
from common import DATA, FIXTURES, REPO, paired_bootstrap, write_json
from library_eval import GROUPS, rank_of, scores

LIB = DATA / "library"
ARMS = ("q4", "q37", "q37i")


def main():
    fixture = json.loads((FIXTURES / "library-queries.json").read_text(encoding="utf-8"))
    runs = {arm: json.loads((LIB / f"results-hybrid-{arm}.json").read_text(encoding="utf-8")) for arm in ARMS}
    records = []
    for q in fixture["queries"]:
        rel = set(q["relevant_excerpts"])
        records.append({"id": q["id"], "cohort": q["cohort"], "lang": q["lang"], "arms": {arm: scores(rank_of(runs[arm][q["id"]], rel)) for arm in ARMS}})
    summary = {"n": len(records), "arms": {}, "paired": {}}
    for arm in ARMS:
        def agg(rows):
            return {k: float(np.mean([r["arms"][arm][k] for r in rows])) for k in ("mrr10", "hit1", "hit5", "hit10")} | {"n": len(rows)}
        summary["arms"][arm] = {"all": agg(records), "groups": {g: agg([r for r in records if GROUPS[r["cohort"]] == g]) for g in sorted(set(GROUPS.values()))}}
    cohort_of = {r["id"]: r["cohort"] for r in records}
    for arm in ARMS[1:]:
        d = {r["id"]: r["arms"][arm]["mrr10"] - r["arms"]["q4"]["mrr10"] for r in records}
        mean, ci = paired_bootstrap(d, cohort_of, seed=20260925)
        groups = {}
        for g in sorted(set(GROUPS.values())):
            ids = [r["id"] for r in records if GROUPS[r["cohort"]] == g]
            gm, gci = paired_bootstrap({i: d[i] for i in ids}, cohort_of, seed=20260925)
            groups[g] = {"delta": gm, "ci95": gci, "n": len(ids)}
        summary["paired"][arm] = {
            "mrr10_delta": mean,
            "ci95": ci,
            "groups": groups,
            "hit10_gains": sum(r["arms"][arm]["hit10"] > r["arms"]["q4"]["hit10"] for r in records),
            "hit10_losses": sum(r["arms"][arm]["hit10"] < r["arms"]["q4"]["hit10"] for r in records),
        }
    pilot = json.loads((REPO / "bench/rag/fixtures/knowledge-base-pilot-questions.json").read_text(encoding="utf-8"))["questions"]
    overlap = {arm: float(np.mean([len(set(runs["q4"][p["id"]][:5]) & set(runs[arm][p["id"]][:5])) for p in pilot])) for arm in ARMS[1:]}
    write_json(LIB / "results-hybrid.json", {"summary": summary, "pilot_top5_overlap_with_q4": overlap, "records": records})
    for arm in ARMS:
        a = summary["arms"][arm]["all"]
        p = summary["paired"].get(arm)
        print(f"{arm:5s} MRR@10 {a['mrr10']:.3f} hit@1 {a['hit1']:.3f} hit@5 {a['hit5']:.3f} hit@10 {a['hit10']:.3f}",
              f"d {p['mrr10_delta']:+.3f} [{p['ci95'][0]:+.3f},{p['ci95'][1]:+.3f}]" if p else "")


if __name__ == "__main__":
    main()
