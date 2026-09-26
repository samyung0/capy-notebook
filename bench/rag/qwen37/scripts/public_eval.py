"""Exact dense retrieval on the public benchmark, scored like the Sept 6 dense arm.

Per question: cosine over every chunk of the question's pool (halfvec-rounded,
L2-normalised vectors), one alias per identical-content document (as
scoped_files does), BEIR's own document removed; the top 40 candidates pass
the production per-file cap of 4 and the first 5 passages are scored with the
Sept 6 metric (document relevance, repeated documents earn nothing).
recall@20 uses 100 candidates, the same cap and the first 20 passages.

  python public_eval.py dev   -> results-dev.json, selection.json (q37 query handling)
  python public_eval.py main  -> results-main.json + printed tables
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import math
from collections import defaultdict

import numpy as np
from common import (
    DATA,
    QWEN3_QUERY_TASK,
    Spec,
    as_stored,
    cache_db,
    cached_keys,
    load_vectors,
    paired_bootstrap,
    write_json,
)

PUB = DATA / "public"
TOP_K, CAP, CANDIDATES, RECALL_K, RECALL_CANDIDATES = 5, 4, 40, 20, 100

# arm -> (document spec, query spec, dimensions)
ARMS = {
    "q4": (Spec("q4", "document"), Spec("q4", "query"), None),
    "q37": (Spec("q37", "document"), Spec("q37", "query"), None),
    "q37i": (Spec("q37", "document"), Spec("q37", "query", instruct=QWEN3_QUERY_TASK), None),
    "q37c": (Spec("q37", "query"), Spec("q37", "query"), None),
    "q4@1024": (Spec("q4", "document"), Spec("q4", "query"), 1024),
    "q37@1024": (Spec("q37", "document"), Spec("q37", "query"), 1024),
    "q37i@1024": (Spec("q37", "document"), Spec("q37", "query", instruct=QWEN3_QUERY_TASK), 1024),
}


def metrics(passages: list[str], labels: dict[str, int]) -> dict:
    """Sept 6 run_retrieval.metrics over content keys (first TOP_K passages)."""
    relevant = {c for c, g in labels.items() if g > 0}
    seen, found = set(), set()
    dcg = reciprocal = 0.0
    for position, content in enumerate(passages[:TOP_K], 1):
        grade = labels.get(content, 0) if content not in seen else 0
        seen.add(content)
        if grade > 0:
            found.add(content)
            dcg += (2**grade - 1) / math.log2(position + 1)
            if reciprocal == 0:
                reciprocal = 1 / position
    ideal = sum((2**g - 1) / math.log2(i + 2) for i, g in enumerate(sorted(labels.values(), reverse=True)[:TOP_K]))
    return {
        "hit_at_5": int(bool(found)),
        "ndcg_at_5": dcg / ideal,
        "mrr_at_5": reciprocal,
        "recall_at_5": len(found) / len(relevant),
    }


def capped(order: list[int], files: list[str], cap: int) -> list[int]:
    seen, kept, overflow = defaultdict(int), [], []
    for i in order:
        if seen[files[i]] < cap:
            seen[files[i]] += 1
            kept.append(i)
        else:
            overflow.append(i)
    return kept + overflow


def load_corpus():
    rows = [json.loads(s) for s in gzip.open(PUB / "chunks.jsonl.gz", "rt", encoding="utf-8")]
    by_doc = defaultdict(list)
    for r in rows:
        by_doc[r["docid"]].append(r["text"])
    content_of = {d: hashlib.sha256("\x00".join(t).encode()).hexdigest() for d, t in by_doc.items()}
    return by_doc, content_of


def run(split: str, arms: list[str]):
    data = json.loads((PUB / "questions.json").read_text(encoding="utf-8"))
    questions, pools = data["questions"][split], data["pools"]
    by_doc, content_of = load_corpus()
    texts = list(dict.fromkeys(t for ts in by_doc.values() for t in ts))
    text_row = {t: i for i, t in enumerate(texts)}
    conn = cache_db()
    qtexts = list(dict.fromkeys(q["q"] for q in questions))
    results = {q["id"]: {"id": q["id"], "cohort": q["cohort"], "arms": {}} for q in questions}
    for arm in arms:
        dspec, qspec, dim = ARMS[arm]
        D = as_stored(load_vectors(conn, dspec, texts), dim)
        Q = as_stored(load_vectors(conn, qspec, qtexts), dim)
        qrow = {t: i for i, t in enumerate(qtexts)}
        for q in questions:
            pool = [d for d in pools[q["pool"]] if d != q.get("exclude")]
            # One alias per identical content, like DISTINCT ON (content_id).
            rep = {}
            for d in sorted(pool):
                rep.setdefault(content_of[d], d)
            chunk_rows, chunk_content = [], []
            for content, d in rep.items():
                for t in by_doc[d]:
                    chunk_rows.append(text_row[t])
                    chunk_content.append(content)
            scores = D[chunk_rows] @ Q[qrow[q["q"]]]
            order = sorted(range(len(scores)), key=lambda i: (-scores[i], chunk_content[i], i))
            top = capped(order[:CANDIDATES], chunk_content, CAP)[:TOP_K]
            wide = capped(order[:RECALL_CANDIDATES], chunk_content, CAP)[:RECALL_K]
            labels = {}
            for d, g in q["qrels"].items():
                if d in content_of:
                    labels[content_of[d]] = max(labels.get(content_of[d], 0), g)
            relevant = {c for c, g in labels.items() if g > 0}
            m = metrics([chunk_content[i] for i in top], labels)
            m["recall_at_20"] = len(relevant & {chunk_content[i] for i in wide}) / len(relevant)
            results[q["id"]]["arms"][arm] = {"metrics": m, "top5": [chunk_content[i][:12] for i in top]}
    conn.close()
    return list(results.values())


def summarize(records: list[dict], arms: list[str], base: str = "q4") -> dict:
    cohorts = sorted({r["cohort"] for r in records})
    out = {"n": len(records), "arms": {}, "paired": {}}
    for arm in arms:
        rows = [r["arms"][arm]["metrics"] for r in records]
        out["arms"][arm] = {
            "all": {k: float(np.mean([m[k] for m in rows])) for k in rows[0]} | {"hits": sum(m["hit_at_5"] for m in rows)},
            "cohorts": {
                c: {k: float(np.mean([r["arms"][arm]["metrics"][k] for r in records if r["cohort"] == c])) for k in rows[0]}
                | {"hits": sum(r["arms"][arm]["metrics"]["hit_at_5"] for r in records if r["cohort"] == c)}
                for c in cohorts
            },
        }
    cohort_of = {r["id"]: r["cohort"] for r in records}
    for arm in arms:
        if arm == base:
            continue
        entry = {}
        for metric in ("ndcg_at_5", "recall_at_20"):
            deltas = {r["id"]: r["arms"][arm]["metrics"][metric] - r["arms"][base]["metrics"][metric] for r in records}
            mean, ci = paired_bootstrap(deltas, cohort_of, seed=20260925)
            entry[metric] = {"delta": mean, "ci95": ci}
        gains = [r["id"] for r in records if r["arms"][arm]["metrics"]["hit_at_5"] > r["arms"][base]["metrics"]["hit_at_5"]]
        losses = [r["id"] for r in records if r["arms"][arm]["metrics"]["hit_at_5"] < r["arms"][base]["metrics"]["hit_at_5"]]
        entry["hit_gains"], entry["hit_losses"] = gains, losses
        out["paired"][arm] = entry
    return out


def main(split: str):
    arms = ["q4", "q37", "q37i"]
    if split == "main":
        arms += ["q4@1024", "q37@1024", "q37i@1024"]
    by_doc, _ = load_corpus()
    texts = list(dict.fromkeys(t for ts in by_doc.values() for t in ts))
    conn = cache_db()
    keys = [Spec("q37", "query").cache_key(t) for t in texts]
    if len(cached_keys(conn, keys)) == len(set(keys)):
        arms.append("q37c")  # compat-mode documents were embedded (public_embed.py docs-q)
    conn.close()
    records = run(split, arms)
    summary = summarize(records, arms)
    write_json(PUB / f"results-{split}.json", {"summary": summary, "records": records})
    for arm in arms:
        a = summary["arms"][arm]["all"]
        p = summary["paired"].get(arm, {})
        print(
            f"{arm:10s} hits {a['hits']:3d}/{summary['n']}  nDCG@5 {a['ndcg_at_5']:.4f}  R@20 {a['recall_at_20']:.4f}",
            (f" dnDCG {p['ndcg_at_5']['delta']:+.4f} [{p['ndcg_at_5']['ci95'][0]:+.4f},{p['ndcg_at_5']['ci95'][1]:+.4f}]"
             f" +{len(p['hit_gains'])}/-{len(p['hit_losses'])}") if p else "",
        )
    if split == "dev":
        # Pre-registered rule: the query handling with the higher dev nDCG@5; ties go to the plain query.
        plain = summary["arms"]["q37"]["all"]["ndcg_at_5"]
        instr = summary["arms"]["q37i"]["all"]["ndcg_at_5"]
        choice = "q37i" if instr > plain else "q37"
        write_json(PUB / "selection.json", {"rule": "higher dev nDCG@5, ties to plain", "q37": plain, "q37i": instr, "choice": choice})
        print("selected", choice)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("split", choices=("dev", "main"))
    main(parser.parse_args().split)
