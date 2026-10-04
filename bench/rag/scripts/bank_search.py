"""Question-bank search: Postgres keyword search against Qwen3 embeddings.

Runs against a local restore of a bank dump (never the live bank, which UAT
reads). Relevance is judged at the topic level: a hit counts when its topic is
one the query names. Report: bench/rag/reports/2026-10-04-bank-search.md.

  docker run -d --name capy-bank-search-lab -e POSTGRES_PASSWORD=lab \\
    -e POSTGRES_DB=bank -p 127.0.0.1:15499:5432 postgres:16
  pg_restore -h 127.0.0.1 -p 15499 -U postgres -d bank --no-owner --no-privileges \\
    data/question-bank/backups/bank-2026-10-03-before-round2.dump
  uv run --with psycopg[binary] --with requests --with numpy \\
    python bench/rag/scripts/bank_search.py

DEEPINFRA_API_KEY comes from the environment or the repository .env.local.
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path

import numpy as np
import psycopg
import requests

REPO = Path(__file__).resolve().parents[3]
DSN = os.environ.get("BANK_LAB_DSN", "postgresql://postgres:lab@127.0.0.1:15499/bank")
CACHE = REPO / "data" / "question-bank" / "search-lab" / "embeddings.npz"
MODEL = "Qwen/Qwen3-Embedding-4B"
INSTRUCT = "Given a study request, retrieve exam questions that practise it"

M = "hkdse-math-compulsory-"
R = "ielts-academic-reading-"
# (query, topics it may return)
QUERIES: list[tuple[str, set[str]]] = [
    ("tangents from an external point to a circle", {M + "circle-properties"}),
    ("angles in the same segment and cyclic quadrilaterals", {M + "circle-properties"}),
    ("equation of a circle from its centre and radius", {M + "circle-equations"}),
    ("standard deviation and interquartile range", {M + "dispersion"}),
    ("what happens to the variance when every value doubles", {M + "dispersion"}),
    ("solve an equation with logarithms", {M + "exponentials-and-logarithms"}),
    ("sum of the first n terms of an arithmetic sequence", {M + "sequences-and-series"}),
    ("arrangements of letters with restrictions", {M + "permutations-and-combinations"}),
    ("probability of at least one success", {M + "probability"}),
    ("maximise profit over a feasible region", {M + "inequalities-and-linear-programming"}),
    ("remainder theorem and factors of a cubic", {M + "polynomials"}),
    ("sine rule and cosine rule with bearings", {M + "trigonometry"}),
    ("y varies inversely as the square of x", {M + "variations"}),
    ("locus of points equidistant from two fixed points", {M + "loci"}),
    ("misleading graphs and biased samples", {M + "uses-and-abuses-of-statistics"}),
    ("reflecting and translating the graph of a function", {M + "graphs-of-functions", M + "functions-and-graphs"}),
    ("discriminant and the nature of roots", {M + "quadratic-equations"}),
    ("slope of a perpendicular line", {M + "straight-lines"}),
    ("simultaneous equations in two unknowns", {M + "equations"}),
    ("true false not given statements", {R + "identifying-information"}),
    ("does the writer agree: yes no not given", {R + "identifying-writer-views"}),
    ("choose the correct heading for each paragraph", {R + "matching-headings"}),
    ("complete the summary using words from the passage", {R + "summary-note-table-flow-chart-completion", R + "sentence-completion"}),
    ("label the diagram", {R + "diagram-label-completion"}),
    ("which paragraph contains the following information", {R + "matching-information"}),
    ("match each statement with the person who said it", {R + "matching-features"}),
]


def question_text(content: dict) -> str:
    """Stem and part text, without solutions or marking schemes."""
    blocks = list(content.get("stem") or [])
    for part in content.get("parts") or []:
        blocks.extend(part.get("blocks") or [])
    return " ".join(str(b.get("text") or "") for b in blocks if b.get("type") == "text")


def deepinfra_key() -> str:
    key = os.environ.get("DEEPINFRA_API_KEY", "")
    if not key:
        for line in (REPO / ".env.local").read_text(encoding="utf-8").splitlines():
            if line.startswith("DEEPINFRA_API_KEY="):
                key = line.split("=", 1)[1].strip().strip("\r")
    if not key:
        raise SystemExit("DEEPINFRA_API_KEY is not set")
    return key


def embed(texts: list[str], key: str) -> np.ndarray:
    out = []
    for start in range(0, len(texts), 64):
        resp = requests.post(
            "https://api.deepinfra.com/v1/openai/embeddings",
            headers={"Authorization": f"Bearer {key}"},
            json={"model": MODEL, "input": texts[start : start + 64], "encoding_format": "float"},
            timeout=120,
        )
        resp.raise_for_status()
        out.extend(item["embedding"] for item in resp.json()["data"])
    vectors = np.array(out, dtype=np.float32)
    return vectors / np.linalg.norm(vectors, axis=1, keepdims=True)


def main() -> None:
    with psycopg.connect(DSN) as conn:
        rows = conn.execute("SELECT id, topic_id, content FROM questions ORDER BY id").fetchall()
        conn.execute("DROP TABLE IF EXISTS search_lab")
        conn.execute("CREATE TABLE search_lab (id text PRIMARY KEY, topic_id text, body tsvector)")
        with conn.cursor() as cur:
            cur.executemany(
                "INSERT INTO search_lab VALUES (%s, %s, to_tsvector('english', %s))",
                [(qid, topic, question_text(content)) for qid, topic, content in rows],
            )
        ids = [r[0] for r in rows]
        topic_of = {r[0]: r[1] for r in rows}

        def keyword(query: str) -> list[str]:
            # websearch_to_tsquery ANDs every word; OR them so partial matches rank.
            found = conn.execute(
                """SELECT id FROM search_lab, to_tsquery('english',
                       array_to_string(tsvector_to_array(to_tsvector('english', %s)), ' | ')) q
                   WHERE body @@ q ORDER BY ts_rank_cd(body, q) DESC LIMIT 10""",
                (query,),
            ).fetchall()
            return [r[0] for r in found]

        key = deepinfra_key()
        if CACHE.exists() and list(np.load(CACHE)["ids"]) == ids:
            docs = np.load(CACHE)["vectors"]
        else:
            started = time.time()
            docs = embed([question_text(r[2])[:4000] for r in rows], key)
            CACHE.parent.mkdir(parents=True, exist_ok=True)
            np.savez(CACHE, ids=np.array(ids), vectors=docs)
            print(f"embedded {len(ids)} questions in {time.time() - started:.0f}s")
        queries = embed([f"Instruct: {INSTRUCT}\nQuery: {q}" for q, _ in QUERIES], key)

        results = []
        for (query, topics), qvec in zip(QUERIES, queries, strict=True):
            semantic = [ids[i] for i in np.argsort(-(docs @ qvec))[:10]]
            row = {"query": query}
            for name, hits in (("keyword", keyword(query)), ("embedding", semantic)):
                row[name] = {
                    "p5": sum(topic_of[h] in topics for h in hits[:5]) / 5,
                    "hit10": any(topic_of[h] in topics for h in hits[:10]),
                    "returned": len(hits),
                }
            results.append(row)
            print(json.dumps(row))
        for name in ("keyword", "embedding"):
            p5 = np.mean([r[name]["p5"] for r in results])
            hit = np.mean([r[name]["hit10"] for r in results])
            empty = sum(r[name]["returned"] == 0 for r in results)
            print(f"{name}: precision@5 {p5:.2f}, hit@10 {hit:.2f}, empty {empty}/{len(results)}")


if __name__ == "__main__":
    main()
