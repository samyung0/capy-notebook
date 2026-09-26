"""First-stage candidate pools on a disposable local copy of the frozen subset.

  docker run -d --name rerank-eval-scratch -e POSTGRES_PASSWORD=scratch \
      -p 127.0.0.1:55441:5432 pgvector/pgvector:pg16
  python first_stage.py embed    # 4B query vectors for the new cohorts (DeepInfra, production shape)
  python first_stage.py load     # snapshot -> database lib_q4 on the scratch container
  python first_stage.py pools    # hybrid40 (production SQL) + dense40 (exact numpy) per query
  docker rm -f rerank-eval-scratch

`pools` calls store.hybrid_search with exactly the arguments library.search
uses, keeps all 40 fused rows, and asserts that folding them with the
production fold reproduces library.search(top_k=10) for every query. dense40
is exact cosine over the stored halfvec vectors; its ranks are checked against
the SQL vector leg (vec_rank) wherever a fused row carries one. The live
library is never touched.

Output: data/rerank-eval/pools.json, pools-check.json
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import sys

import numpy as np
import rr

SCRATCH = "postgresql://postgres:scratch@127.0.0.1:55441/{db}"
DB = "lib_q4"


def queries() -> list[dict]:
    """All study queries in a fixed order: the 235 existing, then the new cohorts."""
    old = rr.read_json(rr.REPO / "bench/rag/qwen37/fixtures/library-queries.json")["queries"]
    new = rr.read_json(rr.FIX / "cohorts.json")["queries"]
    out = []
    for q in old:
        out.append({"id": q["id"], "cohort": q["cohort"], "lang": q["lang"], "query": q["query"], "book_id": q["book_id"],
                    "target": q["target"], "relevant": q["relevant"], "relevant_excerpts": q["relevant_excerpts"],
                    "wrong": []})
    for q in new:
        wrong = sorted(set(q["distractors"]) | {x["id"] for x in q.get("not_acceptable", [])})
        out.append({"id": q["id"], "cohort": q["cohort"], "lang": q["lang"], "query": q["query"], "book_id": q["book_id"],
                    "target": q["target"], "relevant": q["relevant"], "relevant_excerpts": q["relevant_excerpts"],
                    "wrong": wrong, "subtype": q.get("subtype")})
    return out


def fold(rows: list[dict], text_of: dict[str, str], excerpt_of: dict[str, str], book_of: dict[str, str], depth: int | None = None):
    """library.search's fold: first chunk per excerpt, identical hit text within a book collapsed.

    Returns [(excerpt_key, hit_chunk_id)] in order.
    """
    seen, passages, out = set(), set(), []
    for cid in rows:
        key = excerpt_of[cid]
        if key in seen:
            continue
        passage = re.sub(r"\s+", " ", text_of[cid]).strip()
        dup = f"{book_of[cid]}\n{passage}"
        if passage and dup in passages:
            continue
        seen.add(key)
        passages.add(dup)
        out.append((key, cid))
        if depth and len(out) == depth:
            break
    return out


async def embed():
    n = await rr.embed_missing([q["query"] for q in queries()])
    print("embedded", n, "new query texts")


def halfvec_literal(v: np.ndarray) -> str:
    return "[" + ",".join(f"{x:.6g}" for x in v.astype(np.float16).astype(np.float32)) + "]"


def load():
    import psycopg

    from pipeline.retrieval.library import LIBRARY_SCHEMA

    chunks, excerpts, books = rr.load_snapshot()
    vectors = np.load(rr.SNAP / "q4_stored.npy")
    with psycopg.connect(SCRATCH.format(db="postgres"), autocommit=True) as admin:
        assert admin.info.port == 55441 and admin.info.host in ("127.0.0.1", "localhost")
        admin.execute(f"DROP DATABASE IF EXISTS {DB}")
        admin.execute(f"CREATE DATABASE {DB}")
    with psycopg.connect(SCRATCH.format(db=DB)) as conn:
        conn.execute(LIBRARY_SCHEMA)
        conn.execute("INSERT INTO workspaces VALUES ('library','deepinfra','Qwen/Qwen3-Embedding-4B',1,2560)")
        for b in books:
            conn.execute("INSERT INTO rag_contents VALUES (%s,'ready')", (b["content_id"],))
            conn.execute("INSERT INTO files (id,name,added_at) VALUES (%s,%s,%s)", (b["file_id"], b["file_name"], b["added_at"]))
            conn.execute("INSERT INTO rag_file_contents VALUES (%s,'library',%s)", (b["file_id"], b["content_id"]))
            # search reads only id, title and content_id; the other columns are placeholders.
            conn.execute(
                "INSERT INTO library_books (id,title,authors,edition,source_url,download_url,license,license_url,attribution,"
                "sha256,bytes,pages,first_content_page,content_id,version,rights_notes,figure_exclusions) "
                "VALUES (%s,%s,'[]','','','','','','','',0,0,0,%s,%s,'[]','[]')",
                (b["id"], b["title"], b["content_id"], b["version"]),
            )
        with conn.cursor().copy(
            "COPY library_chunks (id,workspace_id,content_id,chunk_idx,section_path,text,indexed_text,page_start,page_end,"
            "regions,lang,confidence,confidence_reasons,search,searchable,book_id,excerpt_id,reference) FROM STDIN"
        ) as copy:
            for c in chunks:
                copy.write_row((c["id"], "library", c["content_id"], c["chunk_idx"], c["section_path"], c["text"], c["indexed_text"],
                                c["page_start"], c["page_end"], c["regions"], c["lang"], c["confidence"], c["confidence_reasons"],
                                c["search"], True, c["book_id"], c["excerpt_id"], c["reference"]))
        with conn.cursor().copy(
            "COPY library_excerpts (content_id,id,book_id,section_path,chunk_ids,pages,regions,figure_ids,text,tag_status,roles,"
            "topic_ids,confidence,evidence,evidence_verified,synopsis,proposed_topic,review_reasons,retrieval) FROM STDIN"
        ) as copy:
            for e in excerpts.values():
                copy.write_row((e["content_id"], e["id"], e["book_id"], e["section_path"], e["chunk_ids"], e["pages"], e["regions"],
                                e["figure_ids"], e["text"], e["tag_status"], e["roles"], e["topic_ids"], e["confidence"], e["evidence"],
                                e["evidence_verified"], e["synopsis"], e["proposed_topic"], e["review_reasons"], e["retrieval"]))
        with conn.cursor().copy("COPY rag_chunk_vectors_2560 (chunk_id,workspace_id,embedding) FROM STDIN") as copy:
            for c, v in zip(chunks, vectors):
                copy.write_row((c["id"], "library", halfvec_literal(v)))
        conn.execute("ANALYZE")
        n = conn.execute("SELECT count(*) FROM rag_chunks").fetchone()[0]
    print(DB, "loaded", n, "searchable chunks")


async def pools():
    os.environ["LIBRARY_DATABASE_URL"] = SCRATCH.format(db=DB)
    from pipeline.config import cfg
    from pipeline.retrieval import library, store
    from pipeline.retrieval.chunking import search_query_terms

    assert cfg.library_dsn.endswith(f"55441/{DB}"), "LIBRARY_DATABASE_URL must point at the scratch copy"
    chunks, _, books = rr.load_snapshot()
    index = {c["id"]: i for i, c in enumerate(chunks)}
    text_of = {c["id"]: c["text"] for c in chunks}
    excerpt_of = {c["id"]: rr.excerpt_key(c) for c in chunks}
    file_of = {b["content_id"]: b["file_id"] for b in books}
    book_file = {c["id"]: file_of[c["content_id"]] for c in chunks}
    D = rr.q37.as_stored(np.load(rr.SNAP / "q4_stored.npy"))
    items = queries()
    Q = rr.query_vectors([q["query"] for q in items])
    ids = np.array([c["id"] for c in chunks])
    out, checks = {}, {"fold_mismatch": [], "vec_rank_mismatch": [], "rows_lt_40": []}
    db = await library.pool()
    for q, v in zip(items, Q):
        vec = v.astype(np.float16).astype(np.float32)
        async with db.connection() as conn:
            cur = await conn.execute(
                "SELECT embedding_provider_slug, embedding_model_slug, embedding_model_version, embedding_dim FROM workspaces WHERE id = %s",
                (library.WORKSPACE,),
            )
            pin = dict(await cur.fetchone())
            rows = await store.hybrid_search(
                workspace_id=library.WORKSPACE,
                vector=vec.tolist(),
                terms=search_query_terms(q["query"]),
                file_ids=None,
                candidates=cfg.search_candidates,
                pin=pin,
                conn=conn,
                chunk_filter=library._VERIFIED_TAG_FILTER,
                chunk_filter_params={"min_confidence": cfg.library_tag_min_confidence, "no_topics": True, "topics": [],
                                     "no_roles": True, "roles": []},
            )
        result = await library.search(q["query"], vector=vec.tolist(), top_k=10)
        mine = [k for k, _ in fold([r["id"] for r in rows], text_of, excerpt_of, book_file, depth=10)]
        prod = [f"{chunks[index[e.hit_chunk_id]]['content_id']}/{e.id}" for e in result.excerpts]
        if mine != prod:
            checks["fold_mismatch"].append(q["id"])
        if len(rows) < cfg.search_candidates:
            checks["rows_lt_40"].append(q["id"])
        s = D @ rr.q37.as_stored(v[None, :])[0]
        top = np.argsort(-s, kind="stable")[:400]
        order = sorted(top.tolist(), key=lambda i: (-s[i], chunks[i]["id"]))[:40]
        dense_rank = {chunks[i]["id"]: r for r, i in enumerate(order, 1)}
        for r in rows:
            if r["vec_rank"] is not None and dense_rank.get(r["id"]) != r["vec_rank"]:
                checks["vec_rank_mismatch"].append([q["id"], r["id"], r["vec_rank"], dense_rank.get(r["id"])])
        out[q["id"]] = {
            "hybrid": [{"id": r["id"], "score": float(r["score"]), "flat": float(r["flat_score"]), "vec_rank": r["vec_rank"],
                        "lex_rank": r["lex_rank"]} for r in rows],
            "dense": [{"id": chunks[i]["id"], "cos": float(s[i])} for i in order],
        }
        u = {r["id"] for r in rows} | {chunks[i]["id"] for i in order}
        out[q["id"]]["union"] = sorted(u)
        assert set(ids[order]) <= u
    await library.close_pool()
    rr.write_json(rr.DATA / "pools.json", out)
    sizes = [len(p["union"]) for p in out.values()]
    checks |= {"queries": len(out), "union_size": {"min": min(sizes), "mean": float(np.mean(sizes)), "max": max(sizes)},
               "vec_rank_mismatch_queries": len({m[0] for m in checks["vec_rank_mismatch"]})}
    rr.write_json(rr.DATA / "pools-check.json", checks)
    print(json.dumps({k: (v if not isinstance(v, list) else len(v)) for k, v in checks.items()}, indent=1))


if __name__ == "__main__":
    step = sys.argv[1]
    if step == "load":
        load()
    else:
        if sys.platform == "win32":
            asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
        asyncio.run({"embed": embed, "pools": pools}[step]())
