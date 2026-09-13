"""One exploratory correction: parse stemmed Latin lexemes without re-stemming.

Run after the frozen experiment as: python SCRIPT run EXPERIMENT_ROOT.
Uses retained vectors and a disposable lexical table; no provider calls.
"""

import json
import time
from pathlib import Path

import multilingual_handling_eval as base
import numpy as np
import psycopg
from psycopg.rows import dict_row


def run():
    root = base.ROOT
    outfile = root / "posthoc-latin-content-once.jsonl"
    assert not outfile.exists()
    manifest = base.read("freeze.json")
    assert (
        base.sha((root / "prepared.json").read_bytes()) == manifest["prepared_sha256"]
    )
    base.save(
        "posthoc-latin-plan.json",
        {
            "declared_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "script_sha256": base.sha(Path(__file__).read_bytes()),
            "original_selection_sha256": base.sha(
                (root / "selection.json").read_bytes()
            ),
            "condition": "latin_content_once",
            "scope": "All original en/es/fr dev and held-out queries. Exploratory after original scores were inspected; selection stays unchanged.",
            "change": "Extract Latin content lexemes with the document language configuration, then parse those lexemes with simple so the stemmer runs once. Keep normalization, lexical index, all-content boost and all other settings unchanged.",
        },
    )
    prepared = base.read("prepared.json")
    queries = [q for q in prepared["queries"] if q["locale"] in {"en", "es", "fr"}]
    chunks = [c for c in prepared["chunks"] if c["locale"] in {"en", "es", "fr"}]
    files = {c["id"]: c["file_id"] for c in chunks}
    assert len(queries) == 264
    with base.cache() as cache:
        vectors = {
            k: np.frombuffer(v, dtype=np.float32)
            for k, v in cache.execute("SELECT key,value FROM vectors")
        }

    def unit(v):
        value = np.asarray([float(f"{x:.6g}") for x in v], dtype=np.float16).astype(
            np.float32
        )
        return value / np.linalg.norm(value)

    matrix = np.asarray([unit(vectors[base.sha(c["text"])]) for c in chunks])
    records = []
    with (
        psycopg.connect(base.DSN, row_factory=dict_row) as conn,
        outfile.open("w") as out,
    ):
        token = base.Tokens()
        conn.execute(
            "CREATE TEMP TABLE latin_control (id text, locale text, lang text, search tsvector)"
        )
        with conn.cursor() as cur:
            cur.executemany(
                "INSERT INTO latin_control VALUES (%s,%s,%s,to_tsvector(%s::regconfig,%s))",
                [
                    (
                        c["id"],
                        c["locale"],
                        c["lang"],
                        base.TS_CONFIG[c["lang"]],
                        ""
                        if c["reference"]
                        else token.terms(c["text"], c["lang"], "content_terms")[0],
                    )
                    for c in chunks
                ],
            )
        for number, query in enumerate(queries):
            indices = [
                i for i, c in enumerate(chunks) if c["locale"] == query["locale"]
            ]
            distances = 1 - matrix[indices] @ unit(
                vectors[base.sha(base.qwen3_query(query["q"]))]
            )
            ordered = sorted(
                zip(indices, distances.tolist()),
                key=lambda r: (r[1], chunks[r[0]]["id"]),
            )
            dense = {
                chunks[i]["id"]: {"rank": rank + 1, "distance": distance}
                for rank, (i, distance) in enumerate(ordered)
            }
            parameters, tokens = [], {}
            for lang in sorted({chunks[i]["lang"] for i in indices}):
                assert lang in {"en", "es", "fr", "und"}
                text, _ = token.terms(query["q"], lang, "content_terms")
                words = conn.execute(
                    "SELECT tsvector_to_array(to_tsvector(%s::regconfig,%s)) AS words",
                    (base.TS_CONFIG[lang], text),
                ).fetchone()["words"]
                tokens[lang] = words
                parameters.append(
                    (
                        lang,
                        " or ".join('"' + w + '"' for w in words),
                        " ".join('"' + w + '"' for w in words),
                    )
                )
            sql = (
                """WITH q AS (
                SELECT lang,websearch_to_tsquery('simple',any_of) AS any_of,
                  websearch_to_tsquery('simple',all_of) AS all_of
                FROM (VALUES """
                + ",".join(["(%s,%s,%s)"] * len(parameters))
                + """
                ) v(lang,any_of,all_of))
                SELECT c.id,c.search @@ q.all_of AS all_match,
                  c.search @@ q.all_of AS exact,ts_rank_cd(c.search,q.any_of) AS score
                FROM latin_control c JOIN q ON q.lang=c.lang
                WHERE c.locale=%s AND c.search @@ q.any_of
                ORDER BY all_match DESC,score DESC,c.id LIMIT 40"""
            )
            matches = conn.execute(
                sql, [v for row in parameters for v in row] + [query["locale"]]
            ).fetchall()
            lexical = {r["id"]: r | {"rank": i + 1} for i, r in enumerate(matches)}
            candidates = {cid for cid, r in dense.items() if r["rank"] <= 40} | set(
                lexical
            )
            fused = []
            for cid in candidates:
                dr, lr = dense[cid], lexical.get(cid)
                score = 1 / (60 + dr["rank"]) if dr["rank"] <= 40 else 0
                if lr:
                    score += (1 if lr["exact"] else 0.5) / (60 + lr["rank"])
                fused.append({"id": cid, "score": score, "dense": dr, "lexical": lr})
            fused.sort(key=lambda r: (-r["score"], r["id"]))
            hits = base.cap(fused[:40], files)
            record = {
                "id": query["id"],
                "locale": query["locale"],
                "split": query["split"],
                "kind": query["kind"],
                "family": query["family"],
                "method": "latin_content_once",
                "tokens": tokens,
                "metrics": base.metrics(hits, query["qrels"], files),
                "hits": hits,
                "candidates": fused,
            }
            out.write(json.dumps(record, ensure_ascii=False) + "\n")
            out.flush()
            records.append(record)
            if number % 40 == 0:
                print("posthoc", number + 1, "/", len(queries), flush=True)
    base.METHODS = ["latin_content_once"]
    summary = {
        split: base.summarize([r for r in records if r["split"] == split])
        for split in ["dev", "heldout"]
    }
    base.save("posthoc-latin-summary.json", summary)
    print(json.dumps(summary), flush=True)


if __name__ == "__main__":
    run()
