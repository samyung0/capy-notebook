"""Frozen corpus, model-only retrieval comparisons, ANN and API timing."""

from __future__ import annotations

import argparse
import asyncio
import gzip
import hashlib
import json
import random
import sys
import time
from pathlib import Path

import httpx
import psycopg
from embed import CONDITIONS, ROOT, append, cached, request, write_json
from psycopg.rows import dict_row

sys.path.insert(0, "/lab/broad")
from index_corpus import guard
from run_retrieval import dense_sql, metrics, self_check, top

from pipeline.config import cfg
from pipeline.retrieval import chunking, lang, models, search, store

SCHEMA = "embedding_eval_20260906"
BROAD = Path("/lab/broad")


def inputs():
    datasets = {
        **json.loads((BROAD / "miracl.json").read_text())["datasets"],
        **json.loads((BROAD / "beir.json").read_text()),
    }
    state = json.loads((BROAD / "retrieval-workspaces.json").read_text())
    curated = json.loads(Path("/lab/corpus/workspaces.json").read_text())
    return datasets, state, curated


def fingerprint(conn, workspaces):
    return conn.execute(
        """SELECT workspace_id,count(*) AS chunks,
        md5(string_agg(id || ':' || md5(indexed_text), ',' ORDER BY id)) AS hash
        FROM rag_chunks WHERE workspace_id=ANY(%s)
        GROUP BY workspace_id ORDER BY workspace_id""",
        (workspaces,),
    ).fetchall()


def freeze():
    guard()
    self_check()
    datasets, state, curated = inputs()
    workspaces = [w["id"] for w in state.values()] + [w["id"] for w in curated.values()]
    with psycopg.connect(cfg.dsn, row_factory=dict_row) as conn:
        frozen = {
            "created_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "conditions": CONDITIONS,
            "files": {
                str(p): hashlib.sha256(p.read_bytes()).hexdigest()
                for p in [
                    BROAD / "miracl.json",
                    BROAD / "beir.json",
                    BROAD / "retrieval-workspaces.json",
                    Path("/lab/corpus/questions.json"),
                    Path("/lab/corpus/workspaces.json"),
                    ROOT / "PLAN.md",
                    ROOT / "embed.py",
                    ROOT / "run.py",
                ]
            },
            "runtime_sources": {
                m.__name__: hashlib.sha256(Path(m.__file__).read_bytes()).hexdigest()
                for m in (chunking, lang, models, search, store)
            },
            "index_state": fingerprint(conn, workspaces),
            "postgres": conn.execute("SELECT version() AS version").fetchone(),
            "pgvector": conn.execute(
                "SELECT extversion FROM pg_extension WHERE extname='vector'"
            ).fetchone(),
            "workspaces": workspaces,
            "questions": sum(len(d["questions"]) for d in datasets.values()),
        }
        assert frozen["questions"] == 360
        if (ROOT / "freeze.json").exists():
            previous = json.loads((ROOT / "freeze.json").read_text())
            for key in ("files", "runtime_sources", "index_state"):
                assert previous[key] == frozen[key], key
        else:
            write_json(ROOT / "freeze.json", frozen)
            rows = conn.execute(
                "SELECT * FROM rag_chunks WHERE workspace_id=ANY(%s) ORDER BY id",
                (workspaces,),
            ).fetchall()
            with gzip.open(ROOT / "chunks.json.gz", "wt") as out:
                json.dump(rows, out, default=str, ensure_ascii=False)
        print(
            "frozen",
            frozen["questions"],
            "queries",
            sum(r["chunks"] for r in frozen["index_state"]),
            "chunks",
            flush=True,
        )


async def index(condition):
    freeze()
    table = f"{SCHEMA}.{condition}"
    dim = CONDITIONS[condition][2]
    rows = json.loads(gzip.decompress((ROOT / "chunks.json.gz").read_bytes()))
    started = time.perf_counter()
    async with httpx.AsyncClient(timeout=120) as client:
        vectors = await cached(
            client,
            condition,
            [r["indexed_text"] for r in rows],
            "document",
            phase="index",
        )
    embedding_s = time.perf_counter() - started
    with psycopg.connect(cfg.dsn, autocommit=True) as conn:
        conn.execute(f"CREATE SCHEMA IF NOT EXISTS {SCHEMA}")
        exists = conn.execute("SELECT to_regclass(%s)", (table,)).fetchone()[0]
        if exists:
            assert conn.execute(f"SELECT count(*) FROM {table}").fetchone()[0] == len(
                rows
            )
            print(condition, "table already indexed", flush=True)
            return
        started = time.perf_counter()
        with conn.transaction():
            conn.execute(
                f"CREATE TABLE {table} (chunk_id text PRIMARY KEY, workspace_id text NOT NULL, embedding halfvec({dim}) NOT NULL)"
            )
            with conn.cursor().copy(f"COPY {table} FROM STDIN") as copy:
                for row, vector in zip(rows, vectors):
                    copy.write_row(
                        (row["id"], row["workspace_id"], store.vector_literal(vector))
                    )
            conn.execute(f"CREATE INDEX {condition}_ws_idx ON {table}(workspace_id)")
        insert_s = time.perf_counter() - started
        conn.execute("SET maintenance_work_mem='512MB'")
        started = time.perf_counter()
        conn.execute(
            f"CREATE INDEX {condition}_hnsw ON {table} USING hnsw (embedding halfvec_cosine_ops) WITH (m=16, ef_construction=64)"
        )
        build_s = time.perf_counter() - started
        conn.execute(f"ANALYZE {table}")
        sizes = conn.execute(
            "SELECT pg_table_size(%s),pg_indexes_size(%s),pg_relation_size(%s)",
            (table, table, f"{SCHEMA}.{condition}_hnsw"),
        ).fetchone()
        result = {
            "condition": condition,
            "chunks": len(rows),
            "embedding_s_including_cache": embedding_s,
            "insert_s": insert_s,
            "index_build_s": build_s,
            "table_bytes": sizes[0],
            "all_index_bytes": sizes[1],
            "hnsw_bytes": sizes[2],
        }
        write_json(ROOT / f"index-{condition}.json", result)
        print(result, flush=True)


def params(ws, query, vector, scope):
    terms = chunking.search_query_terms(query)
    return {
        "ws": ws,
        "vector": store.vector_literal(vector),
        "no_filter": scope is None,
        "file_ids": scope or [],
        "candidates": 40,
        "any_of": terms.any_of,
        "all_of": terms.all_of,
        "latin": terms.latin,
        "terms": terms.terms,
        "lookup_min": store._LOOKUP_TERMS[0],
        "lookup_max": store._LOOKUP_TERMS[1],
        "langs": list(lang.TS_CONFIG),
        "cfgs": list(lang.TS_CONFIG.values()),
        "rrf_k": store._RRF_K,
        "lex_weight": store._LEX_WEIGHT,
    }


def scope_for(dataset, ws, question):
    if dataset["source"] in {"scifact", "arguana"} and question["id"] in ws["files"]:
        assert question["qrels"].get(question["id"], 0) == 0
        return [f["id"] for docid, f in ws["files"].items() if docid != question["id"]]
    return None


def compact_hits(rows):
    return [
        {k: hit[k] for k in ("chunk_id", "file_id", "vec_rank", "lex_rank", "score")}
        for hit in top(rows)
    ]


async def evaluate(condition):
    freeze()
    datasets, state, _ = inputs()
    table = f"{SCHEMA}.{condition}"
    exact_hybrid = store._SEARCH_SQL_TEMPLATE.format(vector_table=table).replace(
        "v.embedding <=> %(vector)s::halfvec",
        "(v.embedding <=> %(vector)s::halfvec) + 0",
    )
    sqls = {"hybrid": exact_hybrid, "dense": dense_sql(table, exact=True)}
    out = ROOT / f"retrieval-{condition}.jsonl"
    done = (
        {json.loads(s)["id"] for s in out.read_text().splitlines()}
        if out.exists()
        else set()
    )
    plans = {}
    async with httpx.AsyncClient(timeout=120) as client:
        with psycopg.connect(cfg.dsn, row_factory=dict_row, autocommit=True) as conn:
            for label, dataset in datasets.items():
                ws = state[label]
                questions = [
                    q for q in dataset["questions"] if label + ":" + q["id"] not in done
                ]
                vectors = await cached(
                    client,
                    condition,
                    [q["q"] for q in questions],
                    "query",
                    phase="retrieval",
                )
                for q, vector in zip(questions, vectors):
                    args = params(ws["id"], q["q"], vector, scope_for(dataset, ws, q))
                    record = {
                        "id": label + ":" + q["id"],
                        "dataset": label,
                        "language": dataset["language"],
                        "condition": condition,
                        "arms": {},
                    }
                    order = list(sqls)
                    random.Random(record["id"]).shuffle(order)
                    for arm in order:
                        started = time.perf_counter()
                        rows = conn.execute(sqls[arm], args).fetchall()
                        elapsed = (time.perf_counter() - started) * 1000
                        hits = top(rows)
                        record["arms"][arm] = {
                            "metrics": metrics(hits, q["qrels"], ws["files"]),
                            "hits": compact_hits(rows),
                            "sql_ms": elapsed,
                        }
                        key = label + ":" + arm
                        if key not in plans:
                            plans[key] = conn.execute(
                                "EXPLAIN (FORMAT JSON) " + sqls[arm], args
                            ).fetchone()["QUERY PLAN"]
                            assert "_hnsw" not in json.dumps(plans[key]), (
                                "quality arm accidentally used ANN"
                            )
                    append(out.name, record)
                print(condition, label, "retrieval done", flush=True)
    write_json(ROOT / f"plans-{condition}.json", plans)


async def ann(condition):
    datasets, state, _ = inputs()
    table = f"{SCHEMA}.{condition}"
    base = f"SELECT chunk_id,embedding <=> %(vector)s::halfvec AS distance FROM {table} WHERE workspace_id=%(ws)s AND NOT(chunk_id=ANY(%(exclude)s)) ORDER BY embedding <=> %(vector)s::halfvec LIMIT 40"
    exact_sql = base.replace(
        "ORDER BY embedding <=> %(vector)s::halfvec",
        "ORDER BY (embedding <=> %(vector)s::halfvec) + 0",
    )
    rows = json.loads(gzip.decompress((ROOT / "chunks.json.gz").read_bytes()))
    plans = {}
    out = ROOT / f"ann-{condition}.jsonl"
    done = (
        {json.loads(s)["id"] for s in out.read_text().splitlines()}
        if out.exists()
        else set()
    )
    async with httpx.AsyncClient(timeout=120) as client:
        with psycopg.connect(cfg.dsn, row_factory=dict_row, autocommit=True) as conn:
            for label, dataset in datasets.items():
                ws = state[label]
                questions = [
                    q for q in dataset["questions"] if label + ":" + q["id"] not in done
                ]
                vectors = await cached(
                    client, condition, [q["q"] for q in questions], "query", phase="ann"
                )
                for q, vector in zip(questions, vectors):
                    exclude_content = (
                        ws["files"].get(q["id"], {}).get("content_id")
                        if scope_for(dataset, ws, q)
                        else None
                    )
                    args = {
                        "ws": ws["id"],
                        "vector": store.vector_literal(vector),
                        "exclude": [
                            r["id"] for r in rows if r["content_id"] == exclude_content
                        ],
                    }
                    started = time.perf_counter()
                    exact = conn.execute(exact_sql, args).fetchall()
                    exact_ms = (time.perf_counter() - started) * 1000
                    gold = [r["chunk_id"] for r in exact]
                    record = {
                        "id": label + ":" + q["id"],
                        "dataset": label,
                        "condition": condition,
                        "exact_ms": exact_ms,
                        "arms": {},
                    }
                    if label not in plans:
                        plans[label] = {
                            "natural": conn.execute(
                                "EXPLAIN (FORMAT JSON) " + base, args
                            ).fetchone()["QUERY PLAN"]
                        }
                    for ef, mode in ((40, "off"), (100, "strict_order")):
                        arm = f"ef{ef}_{mode}"
                        with conn.transaction():
                            conn.execute("SET LOCAL enable_seqscan=off")
                            conn.execute("SET LOCAL enable_bitmapscan=off")
                            conn.execute("SET LOCAL enable_sort=off")
                            conn.execute(f"SET LOCAL hnsw.ef_search={ef}")
                            conn.execute(f"SET LOCAL hnsw.iterative_scan='{mode}'")
                            if arm not in plans[label]:
                                plans[label][arm] = conn.execute(
                                    "EXPLAIN (FORMAT JSON) " + base, args
                                ).fetchone()["QUERY PLAN"]
                                assert condition + "_hnsw" in json.dumps(
                                    plans[label][arm]
                                ), "ANN arm did not use HNSW"
                            started = time.perf_counter()
                            hits = conn.execute(base, args).fetchall()
                            elapsed = (time.perf_counter() - started) * 1000
                        ids = [r["chunk_id"] for r in hits]
                        record["arms"][arm] = {
                            "ms": elapsed,
                            "returned": len(ids),
                            "overlap5": len(set(ids[:5]) & set(gold[:5]))
                            / len(gold[:5]),
                            "overlap40": len(set(ids) & set(gold)) / len(gold),
                        }
                    append(out.name, record)
                print(condition, label, "ANN done", flush=True)
    write_json(ROOT / f"ann-plans-{condition}.json", plans)


async def latency():
    datasets, _, _ = inputs()
    sample = [
        q["q"]
        for label, d in sorted(datasets.items())
        for q in sorted(
            d["questions"], key=lambda q: hashlib.sha256(q["id"].encode()).hexdigest()
        )[:4]
    ]
    write_json(ROOT / "latency-sample.json", sample)
    plan = [
        (condition, concurrency, repeat)
        for condition in CONDITIONS
        for concurrency in (1, 4)
        for repeat in range(3)
    ]
    random.Random(20260906).shuffle(plan)
    done = (
        {
            tuple(json.loads(s)[k] for k in ("condition", "concurrency", "repeat"))
            for s in (ROOT / "latency.jsonl").read_text().splitlines()
        }
        if (ROOT / "latency.jsonl").exists()
        else set()
    )
    async with httpx.AsyncClient(timeout=30) as client:
        for condition, concurrency, repeat in plan:
            if (condition, concurrency, repeat) in done:
                continue
            gate = asyncio.Semaphore(concurrency)

            async def one(i, query, *, gate=gate, condition=condition):
                async with gate:
                    try:
                        _, record = await request(
                            client, condition, [query], "query", phase="latency"
                        )
                        return {
                            "query_index": i,
                            "elapsed_ms": record["elapsed_ms"],
                            "usage": record["usage"],
                        }
                    except Exception as exc:  # noqa: BLE001 -- every failed latency sample stays in the denominator
                        return {"query_index": i, "error": str(exc)}

            started = time.perf_counter()
            results = await asyncio.gather(*(one(i, q) for i, q in enumerate(sample)))
            append(
                "latency.jsonl",
                {
                    "condition": condition,
                    "concurrency": concurrency,
                    "repeat": repeat,
                    "wall_s": time.perf_counter() - started,
                    "requests": results,
                },
            )
            print(
                "latency",
                condition,
                concurrency,
                repeat,
                "errors",
                sum("error" in r for r in results),
                flush=True,
            )


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "phase", choices=["freeze", "index", "retrieval", "ann", "latency"]
    )
    parser.add_argument("condition", nargs="?", choices=list(CONDITIONS))
    args = parser.parse_args()
    if args.phase == "freeze":
        freeze()
    elif args.phase == "latency":
        asyncio.run(latency())
    else:
        asyncio.run(
            {"index": index, "retrieval": evaluate, "ann": ann}[args.phase](
                args.condition
            )
        )
