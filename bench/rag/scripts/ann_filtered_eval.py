"""Compare the current vector SQL with exact search in a disposable local DB.

This measures database candidate recall, not relevance or answer quality. Eight
copies of the same frozen corpus model shared documents across workspaces.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sqlite3
import statistics
import time
from array import array
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

import psycopg

REPO = Path(__file__).resolve().parents[3]
INPUT = REPO / "bench/rag/reports/local/2026-09-13-multilingual-language-handling"
DSN = "postgresql://postgres@127.0.0.1:55439/capy_ann_lab"
COPIES = 8
MODES = {
    "current": [],
    "iterative40": ["SET LOCAL hnsw.iterative_scan = strict_order"],
    "iterative200": [
        "SET LOCAL hnsw.iterative_scan = strict_order",
        "SET LOCAL hnsw.ef_search = 200",
    ],
}


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def save(path: Path, value: object) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def literal(values: array) -> str:
    return "[" + ",".join(f"{x:.6g}" for x in values) + "]"


def vector(cache: sqlite3.Connection, text: str) -> str:
    result = cache.execute(
        "SELECT value FROM vectors WHERE key=?", (digest(text.encode()),)
    ).fetchone()
    if result is None:
        raise ValueError("Frozen vector missing")
    values = array("f")
    values.frombytes(result[0])
    assert len(values) == 2560
    return literal(values)


def index_names(plan: object) -> list[str]:
    if isinstance(plan, dict):
        names = [plan["Index Name"]] if "Index Name" in plan else []
        return names + [name for value in plan.values() for name in index_names(value)]
    if isinstance(plan, list):
        return [name for item in plan for name in index_names(item)]
    return []


def setup(conn: psycopg.Connection, prepared: dict, cache: sqlite3.Connection) -> None:
    # ponytail: only the vector leg's columns/indexes; no application migrations.
    conn.execute("CREATE EXTENSION vector")
    conn.execute(
        "CREATE TABLE files (id text PRIMARY KEY, name text, added_at timestamptz, trashed_at timestamptz)"
    )
    conn.execute("CREATE TABLE rag_contents (id text PRIMARY KEY, status text)")
    conn.execute(
        "CREATE TABLE rag_file_contents (file_id text PRIMARY KEY, content_id text, workspace_id text)"
    )
    conn.execute("CREATE INDEX ON rag_file_contents(workspace_id)")
    conn.execute("CREATE INDEX ON rag_file_contents(content_id)")
    conn.execute(
        "CREATE TABLE rag_chunks (id text PRIMARY KEY, content_id text, workspace_id text)"
    )
    conn.execute("CREATE INDEX ON rag_chunks(content_id)")
    conn.execute("CREATE INDEX ON rag_chunks(workspace_id)")
    conn.execute(
        "CREATE TABLE rag_chunk_vectors_2560 (chunk_id text PRIMARY KEY, workspace_id text, embedding halfvec(2560))"
    )
    conn.execute("CREATE INDEX ON rag_chunk_vectors_2560(workspace_id)")
    chunks = prepared["chunks"]
    docs = sorted({c["file_id"] for c in chunks})
    vectors = {c["id"]: vector(cache, c["text"]) for c in chunks}
    with conn.cursor() as cur:
        for table, columns, rows in (
            (
                "files",
                "id,name,added_at",
                (
                    (f"w{w}:{d}", d, "2026-09-13T00:00:00Z")
                    for w in range(COPIES)
                    for d in docs
                ),
            ),
            (
                "rag_contents",
                "id,status",
                ((f"w{w}:{d}", "ready") for w in range(COPIES) for d in docs),
            ),
            (
                "rag_file_contents",
                "file_id,content_id,workspace_id",
                (
                    (f"w{w}:{d}", f"w{w}:{d}", f"w{w}")
                    for w in range(COPIES)
                    for d in docs
                ),
            ),
            (
                "rag_chunks",
                "id,content_id,workspace_id",
                (
                    (f"w{w}:{c['id']}", f"w{w}:{c['file_id']}", f"w{w}")
                    for w in range(COPIES)
                    for c in chunks
                ),
            ),
            (
                "rag_chunk_vectors_2560",
                "chunk_id,workspace_id,embedding",
                (
                    (f"w{w}:{c['id']}", f"w{w}", vectors[c["id"]])
                    for w in range(COPIES)
                    for c in chunks
                ),
            ),
        ):
            with cur.copy(f"COPY {table} ({columns}) FROM STDIN") as copy:
                for row in rows:
                    copy.write_row(row)
    conn.execute("SET maintenance_work_mem = '128MB'")
    conn.execute("SET max_parallel_maintenance_workers = 0")
    conn.execute(
        "CREATE INDEX ann_embedding_idx ON rag_chunk_vectors_2560 USING hnsw (embedding halfvec_cosine_ops)"
    )
    conn.execute("ANALYZE")


def run(output: Path, reuse_lab: bool) -> None:
    output.mkdir(parents=True, exist_ok=False)
    prepared = json.loads((INPUT / "prepared.json").read_text())
    source = (REPO / "pipeline/pipeline/retrieval/store.py").read_text()
    template = source.split('_SEARCH_SQL_TEMPLATE = """', 1)[1].split('"""', 1)[0]
    sql = template.split(",\nq AS (", 1)[0] + " SELECT * FROM vec ORDER BY rank"
    sql = sql.format(vector_table="rag_chunk_vectors_2560")
    # Full hybrid SQL references this CTE repeatedly, which materializes it.
    sql = sql.replace("WITH scoped_files AS (", "WITH scoped_files AS MATERIALIZED (")
    exact_sql = sql.replace(
        "v.embedding <=> %(vector)s::halfvec",
        "(v.embedding <=> %(vector)s::halfvec) + 0",
    )
    task_source = (REPO / "pipeline/pipeline/prompts/retrieval.py").read_text()
    task = (
        "Given a question about the user's notes and uploaded materials, "
        "retrieve relevant passages that answer the question"
    )
    assert task.split("uploaded")[0] in task_source
    selected = []
    for locale in sorted({q["locale"] for q in prepared["queries"]}):
        choices = [q for q in prepared["queries"] if q["locale"] == locale]
        selected.extend(sorted(choices, key=lambda q: digest(q["id"].encode()))[:4])
    freeze = {
        "utc": datetime.now(timezone.utc).isoformat(),
        "script_sha256": digest(Path(__file__).read_bytes()),
        "prepared_sha256": digest((INPUT / "prepared.json").read_bytes()),
        "vectors_sha256": digest((INPUT / "vectors.sqlite3").read_bytes()),
        "store_sha256": digest(source.encode()),
        "copies": COPIES,
        "reuse_lab": reuse_lab,
        "rows": len(prepared["chunks"]) * COPIES,
        "queries": selected,
        "modes": MODES,
        "scopes": ["workspace", "locale", "positive_file"],
        "protocol": "32 hash-selected queries, three scopes, exact baseline and three planner-selected arms. Tie-aware distance recall and shortfall against min(40,scope size). Three measured repetitions, one warmup, fixed rotated mode order. Candidate-engine diagnostic only; cloned tenants are not a traffic model.",
    }
    save(output / "freeze.json", freeze)
    (output / "vector.sql").write_text(sql)
    cache = sqlite3.connect(f"file:{INPUT / 'vectors.sqlite3'}?mode=ro", uri=True)
    with psycopg.connect(DSN, autocommit=True, prepare_threshold=None) as conn:
        setup_started = time.monotonic()
        if reuse_lab:
            count = conn.execute(
                "SELECT count(*) FROM rag_chunk_vectors_2560"
            ).fetchone()[0]
            assert count == len(prepared["chunks"]) * COPIES
        else:
            setup(conn, prepared, cache)
        save(
            output / "database.json",
            {
                "server_version": conn.execute("SHOW server_version").fetchone()[0],
                "vector_version": conn.execute(
                    "SELECT extversion FROM pg_extension WHERE extname='vector'"
                ).fetchone()[0],
                "settings": {
                    k: conn.execute(f"SHOW {k}").fetchone()[0]
                    for k in (
                        "hnsw.ef_search",
                        "hnsw.iterative_scan",
                        "hnsw.max_scan_tuples",
                        "work_mem",
                    )
                },
                "setup_seconds": time.monotonic() - setup_started,
            },
        )
        records = []
        for query_index, q in enumerate(selected):
            positive = min(d for d, grade in q["qrels"].items() if grade > 0)
            scope_files = {
                "workspace": [],
                "locale": sorted(
                    {
                        c["file_id"]
                        for c in prepared["chunks"]
                        if c["locale"] == q["locale"]
                    }
                ),
                "positive_file": [positive],
            }
            qvector = vector(cache, f"Instruct: {task}\nQuery:{q['q']}")
            for scope, files in scope_files.items():
                params = {
                    "ws": "w0",
                    "no_filter": not files,
                    "file_ids": [f"w0:{f}" for f in files],
                    "vector": qvector,
                    "candidates": 40,
                }
                exact = conn.execute(exact_sql, params).fetchall()
                assert exact
                expected = len(exact)
                threshold = max(row[1] for row in exact) + 1e-7
                modes = list(MODES)
                modes = modes[query_index % 3 :] + modes[: query_index % 3]
                for mode in modes:
                    with conn.transaction():
                        for setting in MODES[mode]:
                            conn.execute(setting)
                        plan = conn.execute(
                            "EXPLAIN (FORMAT JSON) " + sql, params
                        ).fetchone()[0]
                        conn.execute(sql, params).fetchall()
                        durations = []
                        for _ in range(3):
                            started = time.perf_counter()
                            result = conn.execute(sql, params).fetchall()
                            durations.append((time.perf_counter() - started) * 1000)
                    record = {
                        "query_id": q["id"],
                        "locale": q["locale"],
                        "scope": scope,
                        "mode": mode,
                        "expected_count": expected,
                        "count": len(result),
                        "shortfall": expected - len(result),
                        "distance_recall": sum(row[1] <= threshold for row in result)
                        / expected,
                        "exact_ids": [r[0] for r in exact],
                        "result_ids": [r[0] for r in result],
                        "exact_distances": [r[1] for r in exact],
                        "result_distances": [r[1] for r in result],
                        "client_ms": durations,
                        "median_client_ms": statistics.median(durations),
                        "indexes": index_names(plan),
                        "plan": plan,
                    }
                    records.append(record)
                save(output / "results.json", records)
        grouped = defaultdict(list)
        for r in records:
            grouped[(r["scope"], r["mode"])].append(r)
        summary = []
        for (scope, mode), rows in sorted(grouped.items()):
            summary.append(
                {
                    "scope": scope,
                    "mode": mode,
                    "queries": len(rows),
                    "mean_distance_recall": statistics.mean(
                        r["distance_recall"] for r in rows
                    ),
                    "queries_with_shortfall": sum(r["shortfall"] > 0 for r in rows),
                    "hnsw_plans": sum(
                        "ann_embedding_idx" in r["indexes"] for r in rows
                    ),
                    "median_client_ms": statistics.median(
                        r["median_client_ms"] for r in rows
                    ),
                }
            )
        save(output / "summary.json", summary)
        print(json.dumps(summary, indent=2), flush=True)
    cache.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--reuse-lab", action="store_true")
    args = parser.parse_args()
    run(args.output, args.reuse_lab)
