"""Rerank the candidate pools and run the fixed verification/latency sample.

  python rerank_run.py union KEY [INSTRUCTION]   # one request per query over the 40-chunk pool
  python rerank_run.py sample                    # direct 40-document requests, sequential

KEY is a reranker in rr.RERANKERS; INSTRUCTION is default (the default) or
learner. Documents are the chunks' exact indexed_text in chunk-id order; the
query is the raw study query. Responses come from the cache when present, so a
rerun never bills twice. Alibaba requests run two at a time and retry only on
429; DeepInfra requests run four at a time with up to four attempts. A run
stops on an authentication error or after five non-429 failures.

sample: the protocol's 50 queries (10 per group, sha256 order), as amended in
fixtures/protocol-amendments.json. For each query, in turn: the 40 pool
documents in fused (production) order to every reranker (model order rotated
per query), then the first 20 of them to ali-qwen3-rerank. Sequential, so the
recorded latency is one request at a time from this PC. Comparing these scores
with the chunk-id-order request tests order and composition dependence.

Output: data/rerank-eval/scores/<KEY>__<INSTRUCTION>.json (query -> chunk ->
score, plus per-query usage), sample.json
"""

from __future__ import annotations

import asyncio
import hashlib
import sys
import time

import rr
from first_stage import queries

GROUP = {"mono_en": "mono_en", "cross": "cross", "en_to_es": "cross", "paraphrase": "paraphrase", "mono_es": "paraphrase",
         "samedoc": "samedoc", "nearmiss": "nearmiss"}


def texts():
    chunks, _, _ = rr.load_snapshot(verify=False)
    return {c["id"]: c["indexed_text"] for c in chunks}


async def union(key: str, instruction_id: str):
    spec = rr.RERANKERS[key]
    pools = rr.read_json(rr.DATA / "pools.json")
    text_of = texts()
    items = queries()
    conn = rr.cache_db()
    alibaba = spec["provider"] == "alibaba"
    gate = asyncio.Semaphore(2 if alibaba else 4)
    last_start = [0.0]
    spacing = asyncio.Lock()
    failures, out, usage = [], {}, {}
    stop = [False]

    async def one(q):
        if stop[0]:
            return
        ids = pools[q["id"]]["union"]
        docs = [text_of[c] for c in ids]
        async with gate:
            if alibaba:
                async with spacing:
                    wait = 0.3 - (time.monotonic() - last_start[0])
                    if wait > 0:
                        await asyncio.sleep(wait)
                    last_start[0] = time.monotonic()
            try:
                scores, use, meta = await rr.rerank(http, conn, key, q["query"], docs, instruction_id, phase="union",
                                                    tag={"query_id": q["id"], "pool": "union"})
            except rr.ProviderError as exc:
                failures.append({"query_id": q["id"], "status": exc.status, "error": str(exc)[:300]})
                if exc.status in (401, 403) or len(failures) >= 5:
                    stop[0] = True
                return
        out[q["id"]] = dict(zip(ids, scores))
        usage[q["id"]] = {"n_docs": len(ids), "tokens": rr.billed_tokens(spec["provider"], use), "cached": bool(meta.get("cached"))}

    async with rr.client(120.0) as http:
        await asyncio.gather(*(one(q) for q in items))
    conn.close()
    (rr.DATA / "scores").mkdir(exist_ok=True)
    rr.write_json(rr.DATA / "scores" / f"{key}__{instruction_id}.json",
                  {"key": key, "instruction": instruction_id, "scores": out, "usage": usage, "failures": failures})
    fresh = sum(not u["cached"] for u in usage.values())
    print(key, instruction_id, "scored", len(out), "of", len(items), "| fresh requests", fresh, "| failures", len(failures))
    print({p: {k: round(v, 4) if isinstance(v, float) else v for k, v in s.items()} for p, s in rr.spend().items()})


def sample_ids(items):
    by_group = {}
    for q in sorted(items, key=lambda q: hashlib.sha256(("capy-rerank-sample:" + q["id"]).encode()).hexdigest()):
        g = GROUP[q["cohort"]]
        if len(by_group.setdefault(g, [])) < 10:
            by_group[g].append(q["id"])
    return [i for g in ("mono_en", "cross", "paraphrase", "samedoc", "nearmiss") for i in by_group[g]]


async def sample():
    """Protocol sample, as amended: the 40 pool documents in fused (production)
    order to every reranker, then the first 20 of them to ali-qwen3-rerank."""
    pools = rr.read_json(rr.DATA / "pools.json")
    text_of = texts()
    items = {q["id"]: q for q in queries()}
    ids = sample_ids(list(items.values()))
    keys = list(rr.RERANKERS)
    conn = rr.cache_db()
    rows = []
    async with rr.client(120.0) as http:
        for n, qid in enumerate(ids):
            q = items[qid]
            fused = [p["id"] for p in pools[qid]["hybrid"]]
            order = keys[n % len(keys):] + keys[: n % len(keys)]
            plan = [(k, "fused40", fused) for k in order] + [("ali-qwen3-rerank", "fused20", fused[:20])]
            for key, pool, cids in plan:
                docs = [text_of[c] for c in cids]
                row = {"query_id": qid, "key": key, "pool": pool, "n_docs": len(cids)}
                try:
                    scores, use, meta = await rr.rerank(http, conn, key, q["query"], docs, "default", phase="sample",
                                                        tag={"query_id": qid, "pool": pool})
                    row |= {"scores": dict(zip(cids, scores)), "tokens": rr.billed_tokens(rr.RERANKERS[key]["provider"], use),
                            "latency_ms": meta.get("latency_ms"), "cached": bool(meta.get("cached"))}
                except rr.ProviderError as exc:
                    row |= {"status": exc.status, "error": str(exc)[:300]}
                rows.append(row)
            print(n + 1, "/", len(ids), flush=True)
    conn.close()
    rr.write_json(rr.DATA / "sample.json", {"query_ids": ids, "rows": rows})
    print({p: {k: round(v, 4) if isinstance(v, float) else v for k, v in s.items()} for p, s in rr.spend().items()})


async def latency():
    """Exploratory, outside the frozen protocol: on the same 50 queries, the fused
    top 20 to each DeepInfra model (ali-qwen3-rerank already has fused20 from the
    sample), then a second, uncached pass of the fused 40 to every reranker.
    Sequential and interleaved like the sample."""
    pools = rr.read_json(rr.DATA / "pools.json")
    text_of = texts()
    items = {q["id"]: q for q in queries()}
    ids = sample_ids(list(items.values()))
    keys = list(rr.RERANKERS)
    conn = rr.cache_db()
    rows = []
    async with rr.client(120.0) as http:
        for phase, n_docs, models, use_cache in (("latency-20", 20, [k for k in keys if k.startswith("di-")], True),
                                                 ("latency-40-repeat", 40, keys, False)):
            for n, qid in enumerate(ids):
                q = items[qid]
                cids = [p["id"] for p in pools[qid]["hybrid"]][:n_docs]
                order = models[n % len(models):] + models[: n % len(models)]
                for key in order:
                    row = {"phase": phase, "query_id": qid, "key": key, "n_docs": n_docs}
                    try:
                        scores, use, meta = await rr.rerank(http, conn, key, q["query"], [text_of[c] for c in cids], "default",
                                                            phase=phase, tag={"query_id": qid, "pool": f"fused{n_docs}"},
                                                            use_cache=use_cache)
                        row |= {"tokens": rr.billed_tokens(rr.RERANKERS[key]["provider"], use), "latency_ms": meta.get("latency_ms"),
                                "cached": bool(meta.get("cached"))}
                    except rr.ProviderError as exc:
                        row |= {"status": exc.status, "error": str(exc)[:300]}
                    rows.append(row)
                print(phase, n + 1, "/", len(ids), flush=True)
    conn.close()
    rr.write_json(rr.DATA / "latency.json", {"query_ids": ids, "rows": rows})
    print({p: {k: round(v, 4) if isinstance(v, float) else v for k, v in s.items()} for p, s in rr.spend().items()})


if __name__ == "__main__":
    if sys.platform == "win32":
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
    if sys.argv[1] == "union":
        asyncio.run(union(sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else "default"))
    elif sys.argv[1] == "latency":
        asyncio.run(latency())
    else:
        asyncio.run(sample())
