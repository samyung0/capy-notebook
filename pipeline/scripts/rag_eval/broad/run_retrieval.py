"""Frozen hybrid/dense/exact diagnostics, with human source relevance labels."""

from __future__ import annotations

import asyncio
import dataclasses
import hashlib
import json
import math
import time
from collections import Counter
from pathlib import Path

import psycopg
from index_corpus import ROOT, embed_cached, guard, open_cache, write_json

from pipeline import registry
from pipeline.config import cfg
from pipeline.retrieval import chunking, lang, models, search, store
from pipeline.retrieval.chunking import CHUNKER_VERSION


def metrics(hits, qrels, files):
    """Grade actual passage positions; repeated chunks earn no extra gain."""
    labels = {}
    fid_to_cid = {f["id"]: f["content_id"] for f in files.values()}
    for docid, grade in qrels.items():
        cid = files[docid]["content_id"]
        labels[cid] = max(labels.get(cid, 0), grade)
    relevant = {cid for cid, grade in labels.items() if grade > 0}
    assert relevant
    seen = set()
    found = set()
    dcg = reciprocal = 0.0
    for position, hit in enumerate(hits, 1):
        cid = fid_to_cid[hit["file_id"]]
        grade = labels.get(cid, 0) if cid not in seen else 0
        seen.add(cid)
        if grade > 0:
            found.add(cid)
            dcg += (2**grade - 1) / math.log2(position + 1)
            if reciprocal == 0:
                reciprocal = 1 / position
    ideal = sum(
        (2**grade - 1) / math.log2(i + 2)
        for i, grade in enumerate(sorted(labels.values(), reverse=True)[:5])
    )
    return {
        "hit_at_5": int(bool(found)),
        "recall_at_5": len(found) / len(relevant),
        "ndcg_at_5": dcg / ideal,
        "mrr_at_5": reciprocal,
        "relevant_documents": len(relevant),
        "relevant_retrieved": len(found),
        "returned_passages": len(hits),
    }


def self_check():
    files = {"a": {"id": "fa", "content_id": "a"}, "b": {"id": "fb", "content_id": "b"}}
    hits = [{"file_id": "fa"}, {"file_id": "fa"}, {"file_id": "fb"}]
    score = metrics(hits, {"a": 1, "b": 1}, files)
    assert score["recall_at_5"] == 1
    assert abs(score["ndcg_at_5"] - (1 + 0.5) / (1 + 1 / math.log2(3))) < 1e-12
    assert metrics([], {"a": 1}, files)["hit_at_5"] == 0
    assert metrics([{"file_id": "fb"}], {"a": 1}, files)["recall_at_5"] == 0
    files["alias"] = {"id": "fc", "content_id": "a"}
    duplicate = metrics(
        [{"file_id": "fa"}, {"file_id": "fc"}], {"a": 1, "alias": 1}, files
    )
    assert duplicate["ndcg_at_5"] == duplicate["recall_at_5"] == 1


def dense_sql(table, *, exact):
    template = store._SEARCH_SQL_TEMPLATE.format(vector_table=table)
    if not exact:
        prefix = template.split("\nq AS (", 1)[0].rstrip(",\n")
        return (
            prefix
            + """
        SELECT c.id,sf.file_id,sf.file_name,c.chunk_idx,c.section_path,c.text,
               c.page_start,c.page_end,c.regions,c.lang,1.0/(60+vec.rank) AS score,
               vec.rank AS vec_rank,vec.dist AS vec_dist,NULL::bigint AS lex_rank
        FROM vec JOIN rag_chunks c ON c.id=vec.id
        JOIN scoped_files sf ON sf.content_id=c.content_id ORDER BY vec.rank
        """
        )
    prefix = template.split(",\nvec AS (", 1)[0]
    return (
        prefix
        + f""",
        selected AS MATERIALIZED (
            SELECT c.id,sf.file_id,sf.file_name,c.chunk_idx,c.section_path,c.text,
                   c.page_start,c.page_end,c.regions,c.lang,v.embedding
            FROM {table} v JOIN rag_chunks c ON c.id=v.chunk_id
            JOIN scoped_files sf ON sf.content_id=c.content_id
            WHERE v.workspace_id=%(ws)s
        )
        SELECT id,file_id,file_name,chunk_idx,section_path,text,page_start,page_end,
               regions,lang,0.0 AS score,NULL::bigint AS vec_rank,
               embedding <=> %(vector)s::halfvec AS vec_dist,NULL::bigint AS lex_rank
        FROM selected ORDER BY embedding <=> %(vector)s::halfvec LIMIT %(candidates)s
        """
    )


def top(rows):
    return [
        dataclasses.asdict(p)
        for p in search._cap_per_file(
            [search.Passage.from_row(row) for row in rows], cfg.search_per_file_cap
        )[:5]
    ]


async def main():
    guard()
    self_check()
    assert (
        cfg.search_top_k,
        cfg.search_per_file_cap,
        cfg.search_candidates,
        store._LEX_WEIGHT,
    ) == (5, 4, 40, 0.5)
    registry.registry.start()
    datasets = {
        **json.loads((ROOT / "miracl.json").read_text())["datasets"],
        **json.loads((ROOT / "beir.json").read_text()),
    }
    state = json.loads((ROOT / "retrieval-workspaces.json").read_text())
    assert all(state[label].get("ready") for label in datasets)
    artifact_names = (
        "PLAN.md",
        "fetch_data.py",
        "index_corpus.py",
        "run_retrieval.py",
        "miracl.json",
        "beir.json",
        "retrieval-workspaces.json",
    )
    freeze = {
        "created_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "files": {
            name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest()
            for name in artifact_names
        },
        "chunker": CHUNKER_VERSION,
        "top_k": 5,
        "per_file_cap": 4,
        "candidates": 40,
        "lex_weight": 0.5,
        "source_count": len(datasets),
        "query_count": sum(len(d["questions"]) for d in datasets.values()),
        "arms": ["hybrid", "dense", "exact_dense"],
    }
    freeze["runtime_sources"] = {
        m.__name__: hashlib.sha256(Path(m.__file__).read_bytes()).hexdigest()
        for m in (chunking, lang, models, search, store)
    }
    with psycopg.connect(cfg.dsn) as conn:
        freeze["index_state"] = conn.execute("""
            SELECT workspace_id,count(*),md5(string_agg(id || ':' || md5(indexed_text), ',' ORDER BY id))
            FROM rag_chunks GROUP BY workspace_id ORDER BY workspace_id
        """).fetchall()
        freeze["postgres"] = conn.execute("SELECT version()").fetchone()[0]
        freeze["vector_extension"] = conn.execute(
            "SELECT extversion FROM pg_extension WHERE extname='vector'"
        ).fetchone()[0]
        freeze["index_definitions"] = conn.execute(
            "SELECT indexname,indexdef FROM pg_indexes WHERE tablename LIKE 'rag_%' ORDER BY indexname"
        ).fetchall()
    freeze_path = ROOT / "retrieval-freeze.json"
    if freeze_path.exists():
        previous = json.loads(freeze_path.read_text())
        for key in ("files", "runtime_sources", "index_state", "index_definitions"):
            assert previous[key] == json.loads(json.dumps(freeze[key])), (
                "Frozen experiment changed: " + key
            )
    else:
        write_json(freeze_path, freeze)
    output = ROOT / "retrieval.jsonl"
    done = (
        {
            r["id"]
            for r in (json.loads(line) for line in output.read_text().splitlines())
        }
        if output.exists()
        else set()
    )
    db = await store.pool()
    plans = {}
    with open_cache() as cache:
        for label, dataset in datasets.items():
            ws = state[label]
            pin = await store.workspace_embedding_pin(ws["id"])
            spec = registry.resolve_pinned(
                pin["embedding_provider_slug"],
                pin["embedding_model_slug"],
                pin["embedding_model_version"],
                registry.Slot.RETRIEVAL,
            )
            pending = [
                q for q in dataset["questions"] if label + ":" + q["id"] not in done
            ]
            vectors = await embed_cached(
                [models.format_query(q["q"], spec) for q in pending], spec, cache
            )
            for q, vector in zip(pending, vectors):
                # BEIR excludes the query itself when it is also a corpus item.
                # Apply the same scope to all arms through the real file filter.
                scope = None
                if (
                    dataset["source"] in {"scifact", "arguana"}
                    and q["id"] in ws["files"]
                ):
                    assert q["qrels"].get(q["id"], 0) == 0
                    scope = [
                        f["id"] for docid, f in ws["files"].items() if docid != q["id"]
                    ]
                original_embed = models.embed

                async def frozen_embed(
                    texts, *, spec, question=q["q"], embedding=vector
                ):
                    assert texts == [models.format_query(question, spec)]
                    assert spec.pin == ("deepinfra", "Qwen/Qwen3-Embedding-4B", 1)
                    return [embedding]

                models.embed = frozen_embed
                started = time.monotonic()
                try:
                    hybrid = [
                        dataclasses.asdict(p)
                        for p in await search.search(
                            workspace_id=ws["id"], query=q["q"], file_ids=scope
                        )
                    ]
                finally:
                    models.embed = original_embed
                hybrid_ms = (time.monotonic() - started) * 1000
                params = {
                    "ws": ws["id"],
                    "vector": store.vector_literal(vector),
                    "no_filter": scope is None,
                    "file_ids": scope or [],
                    "candidates": cfg.search_candidates,
                }
                arms = {"hybrid": hybrid}
                times = {"hybrid": hybrid_ms}
                for arm, exact in (("dense", False), ("exact_dense", True)):
                    sql = dense_sql(store.vector_table_for_pin(pin), exact=exact)
                    started = time.monotonic()
                    async with db.connection() as conn:
                        cursor = await conn.execute(sql, params)
                        rows = await cursor.fetchall()
                        times[arm] = (time.monotonic() - started) * 1000
                        if label + ":" + arm not in plans:
                            plan = await conn.execute(
                                "EXPLAIN (FORMAT JSON) " + sql, params
                            )
                            plans[label + ":" + arm] = (await plan.fetchone())[
                                "QUERY PLAN"
                            ]
                            write_json(ROOT / "retrieval-plans.json", plans)
                    arms[arm] = top(rows)
                exact_ids = {h["chunk_id"] for h in arms["exact_dense"]}
                dense_ids = {h["chunk_id"] for h in arms["dense"]}
                record = {
                    "id": label + ":" + q["id"],
                    "dataset": label,
                    "language": dataset["language"],
                    "question": q["q"],
                    "qrels": q["qrels"],
                    "workspace_id": ws["id"],
                    "query_document_excluded": scope is not None,
                    "arms": {
                        arm: {
                            "metrics": metrics(hits, q["qrels"], ws["files"]),
                            "hits": hits,
                            "sql_path_ms": round(times[arm], 3),
                        }
                        for arm, hits in arms.items()
                    },
                    "dense_exact_overlap_at_5": len(dense_ids & exact_ids)
                    / len(exact_ids)
                    if exact_ids
                    else None,
                    "hits_languages": dict(Counter(h["lang"] for h in hybrid)),
                }
                with output.open("a") as stream:
                    stream.write(json.dumps(record, ensure_ascii=False) + "\n")
                print(
                    record["id"],
                    {a: r["metrics"]["hit_at_5"] for a, r in record["arms"].items()},
                    flush=True,
                )
    with psycopg.connect(cfg.dsn) as conn:
        count = conn.execute("SELECT count(*) FROM rag_chunks").fetchone()[0]
    write_json(
        ROOT / "retrieval-completion.json",
        {
            "total_index_chunks": count,
            "completed_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "raw_sha256": hashlib.sha256(output.read_bytes()).hexdigest(),
        },
    )
    await store.close_pool()


if __name__ == "__main__":
    asyncio.run(main())
