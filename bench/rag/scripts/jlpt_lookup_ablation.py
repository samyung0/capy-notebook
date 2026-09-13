"""Frozen, isolated diagnostic for the 2026-09-13 JLPT section-lookup incident.

Run `freeze`, then `embed`, then `analyze`, passing a fresh scratch directory.
Freeze reads the configured database with transaction_read_only. Embed makes one
direct provider call, without application accounting, retries, or index writes.
Analyze uses the saved corpus and provider response without database access.
"""

import hashlib
import json
import math
import os
import re
import struct
import sys
import time
from pathlib import Path

WORKSPACE = "ws_b5ac136d14"
TARGET = "chk_5901ee92e1a8f428"
QUERIES = [
    "question 10 reading comprehension passage N1",
    "問題10 次の文章を読んで 読解",
    "問題 10 次の文章を読んで",
    "問題 10",
    "シアノバクテリアと藻類による大気環境の変化と現代人による環境変化はどのように違うか",
]
MODES = ["current", "no_lookup", "equal", "all_terms", "dense"]


def save(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def freeze(root):
    import psycopg
    from psycopg.rows import dict_row

    from pipeline.config import cfg
    from pipeline.prompts.retrieval import qwen3_query
    from pipeline.retrieval.chunking import search_query_terms
    from pipeline.retrieval.lang import TS_CONFIG
    from pipeline.retrieval.store import _SEARCH_SQL_TEMPLATE

    root.mkdir(parents=True, exist_ok=False)
    with psycopg.connect(
        cfg.dsn,
        row_factory=dict_row,
        options="-c default_transaction_read_only=on -c statement_timeout=60000",
    ) as conn:
        pin = conn.execute(
            "SELECT embedding_provider_slug,embedding_model_slug,"
            "embedding_model_version,embedding_dim FROM workspaces WHERE id=%s",
            (WORKSPACE,),
        ).fetchone()
        assert list(pin.values()) == ["deepinfra", "Qwen/Qwen3-Embedding-4B", 1, 2560]
        scoped = _SEARCH_SQL_TEMPLATE.split("vec AS (")[0]
        params = {"ws": WORKSPACE, "no_filter": True, "file_ids": []}
        chunks = conn.execute(
            scoped.rstrip().removesuffix(",")
            + " SELECT c.id,c.chunk_idx,c.text,c.indexed_text,c.section_path,"
            "c.page_start,c.page_end,sf.file_id,sf.file_name,v.embedding::text "
            "FROM scoped_files sf JOIN rag_chunks c ON c.content_id=sf.content_id "
            "JOIN rag_chunk_vectors_2560 v ON v.chunk_id=c.id ORDER BY c.id",
            params,
        ).fetchall()
        qlex = (
            "q AS ("
            + _SEARCH_SQL_TEMPLATE.split("q AS (", 1)[1].split(",\nfused AS (", 1)[0]
        )
        sql = (
            scoped
            + qlex
            + (
                " SELECT lex.id,lex.rank,lex.exact,c.search @@ q.all_of AS all_match "
                "FROM lex JOIN rag_chunks c ON c.id=lex.id "
                "JOIN q ON q.lang=c.lang ORDER BY lex.rank"
            )
        )
        lexical = []
        for query in QUERIES:
            terms = search_query_terms(query)
            rows = conn.execute(
                sql,
                params
                | {
                    "any_of": terms.any_of,
                    "all_of": terms.all_of,
                    "latin": terms.latin,
                    "terms": terms.terms,
                    "lookup_min": 2,
                    "lookup_max": 3,
                    "langs": list(TS_CONFIG),
                    "cfgs": list(TS_CONFIG.values()),
                    "candidates": 100000,
                },
            ).fetchall()
            lexical.append({"terms": terms.__dict__, "rows": rows})
    target = next(c for c in chunks if c["id"] == TARGET)
    heading = "第二部分 読解 › 問題 10"
    starts = list(re.finditer(r"問題\s*10\s*次の文章", target["text"]))
    assert len(starts) == 1
    body = target["text"][starts[0].start() :]
    variants = {
        "fresh_original": target["indexed_text"],
        "heading_only": heading + "\n\n" + target["text"],
        "body_only": target["section_path"] + "\n\n" + body,
        "heading_and_body": heading + "\n\n" + body,
    }
    save(root / "snapshot.json", {"chunks": chunks, "lexical": lexical})
    save(
        root / "freeze.json",
        {
            "frozen_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "workspace": WORKSPACE,
            "target": TARGET,
            "pin": pin,
            "queries": QUERIES,
            "variants": variants,
            "modes": MODES,
            "candidates": 40,
            "top_k": 5,
            "per_file_cap": 4,
            "rrf_k": 60,
            "snapshot_sha256": digest(root / "snapshot.json"),
            "script_sha256": digest(Path(__file__)),
            "embedding_payload": {
                "model": pin["embedding_model_slug"],
                "input": [qwen3_query(q) for q in QUERIES] + list(variants.values()),
                "dimensions": 2560,
                "encoding_format": "float",
            },
            "controls": [
                "All nontarget vectors remain fixed at their stored half precision.",
                "Only target embedding changes; lexical ranks remain fixed.",
                "Exact cosine scan; no HNSW approximation or application writes.",
                "Fresh original isolates drift between stored and fresh embeddings.",
                "One provider request, no retries, all results retained.",
                "Stable chunk-ID tie-break for numeric ties; SQL tie order may differ.",
            ],
        },
    )
    print(
        "Frozen", len(chunks), "chunks; manifest sha256", digest(root / "freeze.json")
    )


def embed(root):
    import httpx

    manifest = json.loads((root / "freeze.json").read_text())
    assert digest(root / "snapshot.json") == manifest["snapshot_sha256"]
    assert not (root / "response.json").exists()
    started = time.perf_counter()
    response = httpx.post(
        "https://api.deepinfra.com/v1/openai/embeddings",
        headers={"Authorization": "Bearer " + os.environ["DEEPINFRA_API_KEY"]},
        json=manifest["embedding_payload"],
        timeout=60,
    )
    save(
        root / "receipt.json",
        {
            "manifest_sha256": digest(root / "freeze.json"),
            "status": response.status_code,
            "elapsed_ms": 1000 * (time.perf_counter() - started),
        },
    )
    response.raise_for_status()
    data = response.json()
    vectors = sorted(data["data"], key=lambda v: v["index"])
    assert [v["index"] for v in vectors] == list(range(9))
    for v in vectors:
        assert len(v["embedding"]) == 2560
        assert all(math.isfinite(x) for x in v["embedding"])
        assert sum(x * x for x in v["embedding"]) > 0
    save(root / "response.json", data)
    print("Embedded", len(vectors), "inputs; usage", data.get("usage"))


def unit(vector):
    norm = math.sqrt(sum(x * x for x in vector))
    return [x / norm for x in vector]


def stored_precision(vector):
    return [struct.unpack("e", struct.pack("e", float(f"{x:.6g}")))[0] for x in vector]


def cap(rows, file_ids):
    seen, keep, overflow = {}, [], []
    for row in rows:
        file_id = file_ids[row["id"]]
        if seen.get(file_id, 0) < 4:
            seen[file_id] = seen.get(file_id, 0) + 1
            keep.append(row)
        else:
            overflow.append(row)
    return keep + overflow


def analyze(root):
    manifest = json.loads((root / "freeze.json").read_text())
    assert digest(root / "snapshot.json") == manifest["snapshot_sha256"]
    snapshot = json.loads((root / "snapshot.json").read_text())
    response = json.loads((root / "response.json").read_text())
    fresh = [
        unit(stored_precision(v["embedding"]))
        for v in sorted(response["data"], key=lambda v: v["index"])
    ]
    chunks = snapshot["chunks"]
    corpus = {c["id"]: unit(json.loads(c["embedding"])) for c in chunks}
    files = {c["id"]: c["file_id"] for c in chunks}
    variants = {"stored_original": corpus[TARGET]} | dict(
        zip(manifest["variants"], fresh[5:])
    )
    results = []
    for qi, query in enumerate(manifest["queries"]):
        lexical = {r["id"]: r for r in snapshot["lexical"][qi]["rows"]}
        for name, target_vector in variants.items():
            distances = {
                cid: 1
                - sum(
                    a * b
                    for a, b in zip(fresh[qi], target_vector if cid == TARGET else v)
                )
                for cid, v in corpus.items()
            }
            ordered = sorted(distances, key=lambda cid: (distances[cid], cid))
            ranks = {cid: i + 1 for i, cid in enumerate(ordered)}
            for mode in manifest["modes"]:
                candidates = set(ordered[:40])
                if mode != "dense":
                    candidates |= {cid for cid, r in lexical.items() if r["rank"] <= 40}
                fused = []
                for cid in candidates:
                    lex = lexical.get(cid)
                    score = 1 / (60 + ranks[cid]) if ranks[cid] <= 40 else 0
                    if mode != "dense" and lex and lex["rank"] <= 40:
                        full = (
                            mode == "equal"
                            or (mode == "current" and lex["exact"])
                            or (mode == "all_terms" and lex["all_match"])
                        )
                        score += (1 if full else 0.5) / (60 + lex["rank"])
                    fused.append(
                        {
                            "id": cid,
                            "score": score,
                            "vector_rank": ranks[cid],
                            "distance": distances[cid],
                            "lexical": lex,
                        }
                    )
                fused.sort(key=lambda r: (-r["score"], r["id"]))
                postcap = cap(fused[:40], files)
                result = {
                    "query": query,
                    "variant": name,
                    "mode": mode,
                    "target_vector_rank": ranks[TARGET],
                    "target_distance": distances[TARGET],
                    "target_lexical": lexical.get(TARGET),
                    "target_fused_rank": next(
                        (i + 1 for i, r in enumerate(fused) if r["id"] == TARGET), None
                    ),
                    "target_output_position": next(
                        (i + 1 for i, r in enumerate(postcap[:5]) if r["id"] == TARGET),
                        None,
                    ),
                    "candidates": fused,
                    "output": postcap[:5],
                }
                results.append(result)
    # Tiny independent ordering checks catch cap and weighting mistakes.
    assert [
        r["id"]
        for r in cap(
            [{"id": str(i)} for i in range(6)],
            {str(i): "a" if i < 5 else "b" for i in range(6)},
        )
    ] == ["0", "1", "2", "3", "5", "4"]
    assert 1 / 73 + 0.5 / 61 < 1 / 65 + 0.5 / 71 < 1 / 73 + 1 / 61
    save(root / "results.json", results)
    save(
        root / "artifacts.json",
        {p.name: digest(p) for p in root.glob("*.json") if p.name != "artifacts.json"},
    )
    for qi, query in enumerate(manifest["queries"]):
        print("Query", qi + 1, query)
        for name in variants:
            rows = [r for r in results if r["query"] == query and r["variant"] == name]
            print(
                name,
                "dense_rank",
                rows[0]["target_vector_rank"],
                "distance",
                round(rows[0]["target_distance"], 6),
                {r["mode"]: r["target_output_position"] for r in rows},
            )


if __name__ == "__main__":
    {"freeze": freeze, "embed": embed, "analyze": analyze}[sys.argv[1]](
        Path(sys.argv[2])
    )
