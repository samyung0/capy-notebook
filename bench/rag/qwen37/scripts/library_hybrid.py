"""Production hybrid library search over a local copy of the frozen subset.

Needs a disposable pgvector container (see README), never the live library:

  docker run -d --name qwen37-hybrid-scratch -e POSTGRES_PASSWORD=scratch \
      -p 127.0.0.1:55437:5432 pgvector/pgvector:pg16

  python library_hybrid.py load q4     # database lib_q4: stored Qwen3-Embedding-4B vectors
  python library_hybrid.py load q37    # database lib_q37: qwen3.7 vectors in the same table
  python library_hybrid.py search q4 | q37 | q37i

`search` sets LIBRARY_DATABASE_URL to the scratch database and calls the
unchanged pipeline.retrieval.library.search(query, vector=...) with top_k=10,
so the vector leg, lexical leg, fusion weights, verified-tag filter and excerpt
folding are production code. The workspace pin row stays the 4B pin because it
only selects the vector table; vectors come from the override.
"""

from __future__ import annotations

import argparse
import asyncio
import gzip
import json
import os
import sys

import numpy as np
from common import DATA, FIXTURES, QWEN3_QUERY_TASK, REPO, Spec, cache_db, load_vectors, write_json

LIB = DATA / "library"
SCRATCH = "postgresql://postgres:scratch@127.0.0.1:55437/{db}"


def halfvec_literal(v: np.ndarray) -> str:
    return "[" + ",".join(f"{x:.6g}" for x in v.astype(np.float16).astype(np.float32)) + "]"


def load(arm: str):
    import psycopg

    from pipeline.retrieval.library import LIBRARY_SCHEMA

    db = f"lib_{arm}"
    with psycopg.connect(SCRATCH.format(db="postgres"), autocommit=True) as admin:
        assert admin.info.port == 55437 and admin.info.host in ("127.0.0.1", "localhost")
        admin.execute(f"DROP DATABASE IF EXISTS {db}")
        admin.execute(f"CREATE DATABASE {db}")
    chunks = [json.loads(s) for s in gzip.open(LIB / "chunks.jsonl.gz", "rt", encoding="utf-8")]
    excerpts = [json.loads(s) for s in gzip.open(LIB / "excerpts.jsonl.gz", "rt", encoding="utf-8")]
    books = json.loads((LIB / "books.json").read_text(encoding="utf-8"))
    if arm == "q4":
        vectors = np.load(LIB / "q4_stored.npy")
    else:
        conn = cache_db()
        vectors = load_vectors(conn, Spec("q37", "document"), [c["indexed_text"] for c in chunks])
        conn.close()
    with psycopg.connect(SCRATCH.format(db=db)) as conn:
        conn.execute(LIBRARY_SCHEMA)
        conn.execute("INSERT INTO workspaces VALUES ('library','deepinfra','Qwen/Qwen3-Embedding-4B',1,2560)")
        for b in books:
            conn.execute("INSERT INTO rag_contents VALUES (%s,'ready')", (b["content_id"],))
            conn.execute("INSERT INTO files (id,name,added_at) VALUES (%s,%s,%s)", (b["file_id"], b["file_name"], b["added_at"]))
            conn.execute("INSERT INTO rag_file_contents VALUES (%s,'library',%s)", (b["file_id"], b["content_id"]))
            # Only id/title/content_id are read by search; the rest are placeholders.
            conn.execute(
                """INSERT INTO library_books VALUES (%s,%s,'[]','','','','','','','',0,0,0,%s,%s,'[]','[]')""",
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
            for e in excerpts:
                copy.write_row((e["content_id"], e["id"], e["book_id"], e["section_path"], e["chunk_ids"], e["pages"], e["regions"],
                                e["figure_ids"], e["text"], e["tag_status"], e["roles"], e["topic_ids"], e["confidence"], e["evidence"],
                                e["evidence_verified"], e["synopsis"], e["proposed_topic"], e["review_reasons"], e["retrieval"]))
        with conn.cursor().copy("COPY rag_chunk_vectors_2560 (chunk_id,workspace_id,embedding) FROM STDIN") as copy:
            for c, v in zip(chunks, vectors):
                copy.write_row((c["id"], "library", halfvec_literal(v)))
        conn.execute("ANALYZE")
        n = conn.execute("SELECT count(*) FROM rag_chunks").fetchone()[0]
    print(db, "loaded", n, "searchable chunks")


async def search(arm: str):
    doc_arm = "q37" if arm.startswith("q37") else "q4"
    os.environ["LIBRARY_DATABASE_URL"] = SCRATCH.format(db=f"lib_{doc_arm}")
    from pipeline.retrieval import library

    fixture = json.loads((FIXTURES / "library-queries.json").read_text(encoding="utf-8"))
    pilot = json.loads((REPO / "bench/rag/fixtures/knowledge-base-pilot-questions.json").read_text(encoding="utf-8"))["questions"]
    items = [(q["id"], q["query"]) for q in fixture["queries"]] + [(p["id"], p["query"]) for p in pilot]
    spec = {"q4": Spec("q4", "query"), "q37": Spec("q37", "query"), "q37i": Spec("q37", "query", instruct=QWEN3_QUERY_TASK)}[arm]
    conn = cache_db()
    vectors = load_vectors(conn, spec, [t for _, t in items])
    conn.close()
    out = {}
    for (qid, text), v in zip(items, vectors):
        result = await library.search(text, vector=v.astype(np.float16).astype(np.float32).tolist(), top_k=10)
        out[qid] = [f"{content}/{e.id}" for e in result.excerpts for content in [_content(e)]]
    await library.close_pool()
    write_json(LIB / f"results-hybrid-{arm}.json", out)
    print(arm, "searched", len(out))


_CONTENT: dict[str, str] = {}


def _content(excerpt) -> str:
    if not _CONTENT:
        for b in json.loads((LIB / "books.json").read_text(encoding="utf-8")):
            _CONTENT[b["id"]] = b["content_id"]
    return _CONTENT[excerpt.book_id]


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("step", choices=("load", "search"))
    parser.add_argument("arm", choices=("q4", "q37", "q37i"))
    args = parser.parse_args()
    if args.step == "load":
        assert args.arm in ("q4", "q37")
        load(args.arm)
    else:
        if sys.platform == "win32":
            asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
        asyncio.run(search(args.arm))
