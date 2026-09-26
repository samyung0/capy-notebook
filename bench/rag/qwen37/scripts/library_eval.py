"""Exact dense retrieval over the frozen library subset.

Every eligible snapshot chunk is ranked by cosine (halfvec-rounded, normalised).
Excerpt ranking follows library.search: walk the chunk ranking, keep the first
chunk of each excerpt and skip a repeated passage of the same book. A query's
rank is the position of its first relevant excerpt (primary) or relevant chunk.
q4 documents are the vectors stored in the live library; q37 documents are fresh.

Also runs the 24 pilot questions (topic labels only): top-5 excerpt overlap
between arms and the share of top-5 excerpts tagged with an expected topic.

Output: data/qwen37-embedding/library/results-dense.json + printed tables.
"""

from __future__ import annotations

import gzip
import json
import re
from collections import defaultdict

import numpy as np
from common import DATA, FIXTURES, QWEN3_QUERY_TASK, REPO, Spec, as_stored, cache_db, load_vectors, paired_bootstrap, write_json

LIB = DATA / "library"
DEPTH = 10
GROUPS = {"mono_en": "monolingual EN", "mono_es": "monolingual non-EN", "cross": "cross-lingual", "en_to_es": "cross-lingual", "paraphrase": "paraphrase"}
QUERY_SPECS = {"q4": Spec("q4", "query"), "q37": Spec("q37", "query"), "q37i": Spec("q37", "query", instruct=QWEN3_QUERY_TASK)}
ARMS = {  # arm -> (document source, query spec key, dims)
    "q4": ("q4", "q4", None),
    "q37": ("q37", "q37", None),
    "q37i": ("q37", "q37i", None),
    "q4@1024": ("q4", "q4", 1024),
    "q37@1024": ("q37", "q37", 1024),
    "q37i@1024": ("q37", "q37i", 1024),
}


def load():
    chunks = [json.loads(s) for s in gzip.open(LIB / "chunks.jsonl.gz", "rt", encoding="utf-8")]
    excerpts = {}
    for s in gzip.open(LIB / "excerpts.jsonl.gz", "rt", encoding="utf-8"):
        e = json.loads(s)
        excerpts[f"{e['content_id']}/{e['id']}"] = e
    return chunks, excerpts


def excerpt_order(order, chunks, depth):
    """library.search folding: first chunk per excerpt, no repeated passage within a book."""
    seen, passages, out = set(), set(), []
    for i in order:
        c = chunks[i]
        key = f"{c['content_id']}/{c['excerpt_id']}"
        if key in seen:
            continue
        passage = re.sub(r"\s+", " ", c["text"]).strip()
        dup = f"{c['book_id']}\n{passage}"
        if passage and dup in passages:
            continue
        seen.add(key)
        passages.add(dup)
        out.append(key)
        if len(out) == depth:
            break
    return out


def rank_of(items, relevant):
    for pos, item in enumerate(items, 1):
        if item in relevant:
            return pos
    return None


def scores(rank):
    return {
        "rank": rank,
        "mrr10": 1 / rank if rank and rank <= 10 else 0.0,
        "hit1": int(bool(rank) and rank <= 1),
        "hit5": int(bool(rank) and rank <= 5),
        "hit10": int(bool(rank) and rank <= 10),
    }


def main():
    chunks, excerpts = load()
    fixture = json.loads((FIXTURES / "library-queries.json").read_text(encoding="utf-8"))
    queries = fixture["queries"]
    pilot = json.loads((REPO / "bench/rag/fixtures/knowledge-base-pilot-questions.json").read_text(encoding="utf-8"))["questions"]
    conn = cache_db()
    docs = {
        "q4": np.load(LIB / "q4_stored.npy"),
        "q37": load_vectors(conn, Spec("q37", "document"), [c["indexed_text"] for c in chunks]),
    }
    all_q = list(dict.fromkeys([q["query"] for q in queries] + [q["query"] for q in pilot]))
    qrow = {t: i for i, t in enumerate(all_q)}
    qvecs = {k: load_vectors(conn, spec, all_q) for k, spec in QUERY_SPECS.items()}
    conn.close()
    chunk_index = {c["id"]: i for i, c in enumerate(chunks)}
    records = {q["id"]: {"id": q["id"], "cohort": q["cohort"], "lang": q["lang"], "arms": {}} for q in queries}
    pilot_out = {p["id"]: {"id": p["id"], "expected_topics": p["expected_topics"], "unanswerable": p["unanswerable"], "arms": {}} for p in pilot}
    for arm, (dsrc, qkey, dim) in ARMS.items():
        D = as_stored(docs[dsrc], dim)
        Q = as_stored(qvecs[qkey], dim)
        for q in queries:
            s = D @ Q[qrow[q["query"]]]
            top = np.argsort(-s, kind="stable")[:400]
            order = sorted(top.tolist(), key=lambda i: (-s[i], chunks[i]["id"]))
            ex = excerpt_order(order, chunks, DEPTH)
            rel_chunks = {chunk_index[c] for c in q["relevant"]}
            chunk_rank = rank_of(order[:DEPTH], rel_chunks)
            records[q["id"]]["arms"][arm] = {
                "excerpt": scores(rank_of(ex, set(q["relevant_excerpts"]))),
                "chunk": scores(chunk_rank),
                "top5": ex[:5],
                "top1_cos": float(s[order[0]]),
            }
        for p in pilot:
            s = D @ Q[qrow[p["query"]]]
            top = np.argsort(-s, kind="stable")[:400]
            order = sorted(top.tolist(), key=lambda i: (-s[i], chunks[i]["id"]))
            ex = excerpt_order(order, chunks, 5)
            on_topic = [bool(set(excerpts[e]["topic_ids"]) & set(p["expected_topics"])) for e in ex]
            pilot_out[p["id"]]["arms"][arm] = {"top5": ex, "on_topic": on_topic, "top1_cos": float(s[order[0]])}
    records = list(records.values())
    write_json(LIB / "results-dense.json", {"summary": summarize(records), "pilot": pilot_summary(list(pilot_out.values()), excerpts), "records": records})


def summarize(records):
    out = {"n": len(records), "arms": {}, "paired": {}}
    fine = sorted({r["cohort"] for r in records})
    langs = sorted({r["lang"] for r in records if r["cohort"] == "cross"})
    for arm in ARMS:
        entry = {}
        for level in ("excerpt", "chunk"):
            def agg(rows):
                return {k: float(np.mean([r["arms"][arm][level][k] for r in rows])) for k in ("mrr10", "hit1", "hit5", "hit10")} | {"n": len(rows)}
            entry[level] = {
                "all": agg(records),
                "groups": {g: agg([r for r in records if GROUPS[r["cohort"]] == g]) for g in sorted(set(GROUPS.values()))},
                "cohorts": {c: agg([r for r in records if r["cohort"] == c]) for c in fine},
                "cross_langs": {lang: agg([r for r in records if r["cohort"] == "cross" and r["lang"] == lang]) for lang in langs},
            }
        out["arms"][arm] = entry
    cohort_of = {r["id"]: r["cohort"] for r in records}
    for arm in ARMS:
        if arm == "q4":
            continue
        base = "q4"  # every row, including the 1024-d truncations, is compared with production
        entry = {}
        for level in ("excerpt", "chunk"):
            d = {r["id"]: r["arms"][arm][level]["mrr10"] - r["arms"][base][level]["mrr10"] for r in records}
            mean, ci = paired_bootstrap(d, cohort_of, seed=20260925)
            groups = {}
            for g in sorted(set(GROUPS.values())):
                ids = [r["id"] for r in records if GROUPS[r["cohort"]] == g]
                gm, gci = paired_bootstrap({i: d[i] for i in ids}, cohort_of, seed=20260925)
                groups[g] = {"delta": gm, "ci95": gci, "n": len(ids)}
            entry[level] = {
                "mrr10_delta": mean,
                "ci95": ci,
                "groups": groups,
                "hit10_gains": [r["id"] for r in records if r["arms"][arm][level]["hit10"] > r["arms"][base][level]["hit10"]],
                "hit10_losses": [r["id"] for r in records if r["arms"][arm][level]["hit10"] < r["arms"][base][level]["hit10"]],
                "hit1_gains": sum(r["arms"][arm][level]["hit1"] > r["arms"][base][level]["hit1"] for r in records),
                "hit1_losses": sum(r["arms"][arm][level]["hit1"] < r["arms"][base][level]["hit1"] for r in records),
            }
        out["paired"][arm] = entry
    return out


def pilot_summary(rows, excerpts):
    answerable = [r for r in rows if not r["unanswerable"]]
    out = {}
    for arm in ARMS:
        out[arm] = {
            "topic_precision_at5": float(np.mean([np.mean(r["arms"][arm]["on_topic"]) for r in answerable])),
            "any_on_topic_at5": int(sum(any(r["arms"][arm]["on_topic"]) for r in answerable)),
            "unanswerable_top1_cos": [r["arms"][arm]["top1_cos"] for r in rows if r["unanswerable"]],
            "answerable_top1_cos_median": float(np.median([r["arms"][arm]["top1_cos"] for r in answerable])),
        }
    overlap = [len(set(r["arms"]["q4"]["top5"]) & set(r["arms"]["q37"]["top5"])) for r in rows]
    overlap_i = [len(set(r["arms"]["q4"]["top5"]) & set(r["arms"]["q37i"]["top5"])) for r in rows]
    books = defaultdict(lambda: defaultdict(int))
    for r in rows:
        for arm in ("q4", "q37", "q37i"):
            for e in r["arms"][arm]["top5"]:
                books[arm][excerpts[e]["book_id"]] += 1
    out["overlap_q4_q37"] = {"mean_shared_of_5": float(np.mean(overlap)), "per_question": overlap}
    out["overlap_q4_q37i"] = {"mean_shared_of_5": float(np.mean(overlap_i)), "per_question": overlap_i}
    out["books_in_top5"] = {arm: dict(sorted(v.items(), key=lambda kv: -kv[1])) for arm, v in books.items()}
    out["rows"] = rows
    return out


if __name__ == "__main__":
    main()
