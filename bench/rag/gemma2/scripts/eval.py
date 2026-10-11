"""EmbeddingGemma 2 against the stored Qwen3-Embedding-4B vectors, dense and reranked.

Reuses the rerank study's frozen inputs (43-book snapshot, 360 labelled
queries, production hybrid and 4B dense pools, DeepInfra Qwen3-Reranker-4B
scores) and adds EmbeddingGemma 2 vectors from embed.py. Run from the
repository root as `PYTHONUTF8=1 uv run --no-sync --with numpy python bench/rag/gemma2/scripts/eval.py STEP`:

  rerank    DeepInfra Qwen3-Reranker-4B over each query's EmbeddingGemma 2 top 40,
            sent exactly like the rerank study (chunk-id order, default
            instruction), so a pool identical to the 4B pool is a cache hit
  analyze   excerpt-level metrics per arm and cohort, first-stage recall, paired
            bootstrap deltas -> data/gemma2-eval/results.json, tables.md

The rerank cache and request log are copies under data/gemma2-eval/; the rerank
study's own files are only read.
"""

from __future__ import annotations

import asyncio
import shutil
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "rerank" / "scripts"))
import rr  # noqa: E402
from analyze import GROUP_OF, GROUPS, METRICS, scores_of  # noqa: E402
from first_stage import fold, queries  # noqa: E402

OUT = rr.REPO / "data" / "gemma2-eval"
RERANKER = "di-4b"
SEED = 20261011


def own_cache() -> None:
    """Point rr's cache and request log at this study's copies."""
    if not (OUT / "cache.sqlite3").exists():
        shutil.copyfile(rr.DATA / "cache.sqlite3", OUT / "cache.sqlite3")
    rr.DATA = OUT
    rr.REQUEST_LOG = OUT / "requests.jsonl"


def dense_orders(D: np.ndarray, Q: np.ndarray, ids: list[str], depth: int) -> list[list[str]]:
    """Exact cosine top `depth`, ties by chunk id (the rerank study's dense40 rule)."""
    out = []
    for v in Q:
        s = D @ v
        top = np.argsort(-s, kind="stable")[: depth * 4]
        out.append([ids[i] for i in sorted(top.tolist(), key=lambda i: (-s[i], ids[i]))[:depth]])
    return out


def gemma(dim: int | None):
    D = rr.q37.as_stored(np.load(OUT / "docs.npy"), dim)
    Q = rr.q37.as_stored(np.load(OUT / "queries.npy"), dim)
    order = rr.read_json(OUT / "queries.json")
    assert order == [q["id"] for q in queries()], "query order changed since embed.py"
    return D, Q


async def rerank() -> None:
    own_cache()
    chunks, _, _ = rr.load_snapshot(verify=False)
    ids = [c["id"] for c in chunks]
    text_of = {c["id"]: c["indexed_text"] for c in chunks}
    items = queries()
    D, Q = gemma(None)
    pools = dense_orders(D, Q, ids, 40)
    conn = rr.cache_db()
    gate = asyncio.Semaphore(4)
    out, usage, failures = {}, {}, []

    async def one(q, pool):
        cids = sorted(pool)
        async with gate:
            try:
                scores, use, meta = await rr.rerank(http, conn, RERANKER, q["query"], [text_of[c] for c in cids], "default",
                                                    phase="gemma2", tag={"query_id": q["id"], "pool": "gemma2-40"})
            except rr.ProviderError as exc:
                failures.append({"query_id": q["id"], "status": exc.status, "error": str(exc)[:300]})
                return
        out[q["id"]] = dict(zip(cids, scores))
        usage[q["id"]] = {"tokens": rr.billed_tokens("deepinfra", use), "cached": bool(meta.get("cached"))}

    async with rr.client(120.0) as http:
        await asyncio.gather(*(one(q, p) for q, p in zip(items, pools)))
    conn.close()
    rr.write_json(OUT / f"scores-{RERANKER}.json", {"scores": out, "usage": usage, "failures": failures})
    fresh = [u for u in usage.values() if not u["cached"]]
    print("scored", len(out), "| fresh", len(fresh), "| tokens", sum(u["tokens"] for u in fresh), "| failures", len(failures))


def reranked(base: list[str], scores: dict[str, float], k: int) -> list[str]:
    head = sorted(base[:k], key=lambda c: (-scores[c], base.index(c), c))
    return head + base[k:]


def analyze() -> None:
    chunks, _, books = rr.load_snapshot(verify=False)
    ids = [c["id"] for c in chunks]
    text_of = {c["id"]: c["text"] for c in chunks}
    excerpt_of = {c["id"]: rr.excerpt_key(c) for c in chunks}
    file_of = {b["content_id"]: b["file_id"] for b in books}
    book_file = {c["id"]: file_of[c["content_id"]] for c in chunks}
    items = queries()
    strata = {q["id"]: q["cohort"] for q in items}
    pools = rr.read_json(rr.DATA / "pools.json")
    q4_scores = rr.read_json(rr.DATA / "scores" / f"{RERANKER}__default.json")["scores"]
    g_scores = rr.read_json(OUT / f"scores-{RERANKER}.json")["scores"]

    D4 = rr.q37.as_stored(np.load(rr.SNAP / "q4_stored.npy"))
    Q4 = rr.q37.as_stored(rr.query_vectors([q["query"] for q in items]))
    deep = {"q4": dense_orders(D4, Q4, ids, 100)}
    for dim in (768, 256):
        deep[f"eg2-{dim}"] = dense_orders(*gemma(None if dim == 768 else dim), ids, 100)
    for q, o in zip(items, deep["q4"]):
        assert o[:40] == [d["id"] for d in pools[q["id"]]["dense"]], f"4B dense order does not reproduce pools.json: {q['id']}"

    def arms_for(n: int, q: dict) -> dict[str, list[str]]:
        p = pools[q["id"]]
        q4d, eg = deep["q4"][n][:40], deep["eg2-768"][n][:40]
        return {
            "q4 hybrid (production)": [r["id"] for r in p["hybrid"]],
            "q4 dense": q4d,
            "eg2 dense 768": eg,
            "eg2 dense 256": deep["eg2-256"][n][:40],
            "q4 dense + rerank top20": reranked(q4d, q4_scores[q["id"]], 20),
            "q4 dense + rerank top40": reranked(q4d, q4_scores[q["id"]], 40),
            "eg2 dense + rerank top20": reranked(eg, g_scores[q["id"]], 20),
            "eg2 dense + rerank top40": reranked(eg, g_scores[q["id"]], 40),
        }

    records = []
    for n, q in enumerate(items):
        rel = set(q["relevant_excerpts"])
        rec = {"id": q["id"], "group": GROUP_OF[q["cohort"]], "arms": {}, "recall": {}}
        for arm, order in arms_for(n, q).items():
            folded = fold(order, text_of, excerpt_of, book_file)
            rank = next((i for i, (x, _) in enumerate(folded, 1) if x in rel), None)
            rec["arms"][arm] = scores_of(rank)
        for model, orders in deep.items():
            rec["recall"][model] = {k: any(excerpt_of[c] in rel for c in orders[n][:k]) for k in (10, 20, 40, 100)}
        records.append(rec)

    arms = list(records[0]["arms"])
    summary = {}
    for arm in arms:
        summary[arm] = {}
        for g in ["all"] + GROUPS:
            rows = [r["arms"][arm] for r in records if g == "all" or r["group"] == g]
            summary[arm][g] = {"n": len(rows)} | {m: float(np.mean([r[m] for r in rows])) for m in METRICS}
    recall = {model: {k: float(np.mean([r["recall"][model][k] for r in records])) for k in (10, 20, 40, 100)} for model in deep}
    pairs = {}
    for a, b in [("eg2 dense 768", "q4 dense"), ("eg2 dense 256", "eg2 dense 768"), ("eg2 dense + rerank top20", "q4 dense + rerank top20"),
                 ("eg2 dense + rerank top40", "q4 dense + rerank top40"), ("eg2 dense + rerank top20", "q4 hybrid (production)"),
                 ("eg2 dense + rerank top20", "q4 dense")]:
        d = {r["id"]: r["arms"][a]["mrr10"] - r["arms"][b]["mrr10"] for r in records}
        mean, ci = rr.q37.paired_bootstrap(d, strata, seed=SEED)
        won = sum(r["arms"][a]["hit5"] > r["arms"][b]["hit5"] for r in records)
        lost = sum(r["arms"][a]["hit5"] < r["arms"][b]["hit5"] for r in records)
        pairs[f"{a} vs {b}"] = {"mrr10_delta": mean, "ci95": ci, "hit5_won": won, "hit5_lost": lost}
    rr.write_json(OUT / "results.json", {"summary": summary, "recall": recall, "pairs": pairs, "records": records})

    lines = ["| Arm | MRR@10 | hit@1 | hit@5 | nDCG@5 |", "| --- | ---: | ---: | ---: | ---: |"]
    for arm in arms:
        s = summary[arm]["all"]
        lines.append(f"| {arm} | {s['mrr10']:.3f} | {s['hit1']:.3f} | {s['hit5']:.3f} | {s['ndcg5']:.3f} |")
    lines += ["", "MRR@10 by group:", "", "| Arm | " + " | ".join(f"{g} ({summary[arms[0]][g]['n']})" for g in GROUPS) + " |",
              "| --- |" + " ---: |" * len(GROUPS)]
    for arm in arms:
        lines.append(f"| {arm} | " + " | ".join(f"{summary[arm][g]['mrr10']:.3f}" for g in GROUPS) + " |")
    lines += ["", "First-stage recall (relevant excerpt among the first k chunks):", "", "| Model | @10 | @20 | @40 | @100 |",
              "| --- | ---: | ---: | ---: | ---: |"]
    for model, r in recall.items():
        lines.append(f"| {model} | " + " | ".join(f"{r[k]:.3f}" for k in (10, 20, 40, 100)) + " |")
    lines += ["", "Paired MRR@10 deltas (cohort-stratified bootstrap, 2,000 resamples):", "",
              "| Pair | ΔMRR@10 | 95% CI | hit@5 won / lost |", "| --- | ---: | --- | ---: |"]
    for name, p in pairs.items():
        lines.append(f"| {name} | {p['mrr10_delta']:+.3f} | {p['ci95'][0]:+.3f} to {p['ci95'][1]:+.3f} | {p['hit5_won']} / {p['hit5_lost']} |")
    (OUT / "tables.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("\n".join(lines))


if __name__ == "__main__":
    if sys.argv[1] == "rerank":
        if sys.platform == "win32":
            asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
        asyncio.run(rerank())
    else:
        analyze()
