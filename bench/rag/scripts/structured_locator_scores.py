"""Frozen full-document ranking replay in a disposable PostgreSQL database.

Use the original query vectors. Locator decisions are already frozen. No model
calls. Unit labels are source/page/anchor controls, not full-answer judgements.
"""

import array
import collections
import importlib.metadata
import json
import math
import sqlite3
import sys
import time
from pathlib import Path

import psycopg
import structured_locator_eval as locator
from psycopg.rows import dict_row

from pipeline.retrieval import chunking, lang

DSN = "postgresql://postgres@127.0.0.1:55439/locator"
ARMS = ("current", "adjacent_atomic_boundary")


def read(path):
    return locator.read(path)


def compact(text):
    return locator.norm(text).replace(" ", "")


def gold(case, chunks):
    expected = case["expected"]
    source_page = [
        c
        for c in chunks
        if c["file_id"] == expected.get("source_id")
        and set(range(c["page_start"], c["page_end"] + 1))
        & set(expected.get("physical_pages", []))
    ]
    anchors = expected.get("anchors", [])
    versions = {"canonical": anchors}
    if expected.get("raw_glyph_anchor"):
        assert len(anchors) == 1
        versions["raw_glyph"] = [expected["raw_glyph_anchor"]]
    else:
        versions["raw_glyph"] = anchors
    output = {"source_page_ids": [c["id"] for c in source_page]}
    for name, terms in versions.items():
        indexed = [
            c["id"]
            for c in source_page
            if terms and all(compact(a) in compact(c["indexed_text"]) for a in terms)
        ]
        body = [
            c["id"]
            for c in source_page
            if terms and all(compact(a) in compact(c["text"]) for a in terms)
        ]
        output[name] = {
            "ids": indexed,
            "body_ids": body,
            "prefix_only_ids": sorted(set(indexed) - set(body)),
        }
    return output


def metric(ids, gold_ids):
    rank = next((i for i, cid in enumerate(ids, 1) if cid in gold_ids), None)
    return {
        "hit": int(rank is not None),
        "rank": rank,
        "discounted_first_hit": 1 / math.log2(rank + 1) if rank else 0.0,
        "mrr": 1 / rank if rank else 0.0,
    }


def freeze(root, embedding):
    assert not (root / "scores-freeze.json").exists()
    complete = read(embedding / "complete.json")
    assert (
        locator.sha((embedding / "vectors.sqlite3").read_bytes())
        == complete["vectors_sha256"]
    )
    inputs = [
        root / "freeze.json",
        root / "punctuation-freeze.json",
        root / "external-inputs-freeze.json",
    ]
    inputs += [
        root / arm / name
        for arm in ARMS
        for name in ("input.json", "external-results.json", "punctuation-results.json")
    ]
    inputs += [
        embedding / name
        for name in (
            "prepared-v2.json",
            "freeze-v2.json",
            "complete.json",
            "vectors.sqlite3",
        )
    ]
    inputs += [
        embedding.parent / name
        for name in ("freeze.json", "results.json", "ranking-export.json")
    ]
    controls = Path(read(root / "freeze.json")["inputs"]["real_controls"]["path"])
    inputs.append(controls)
    cases = read(controls)["cases"]
    assert (
        len(cases) == 28
        and sum(c["expected"]["outcome"] == "resolve" for c in cases) == 15
    )
    with psycopg.connect(DSN, row_factory=dict_row) as db:
        server = db.execute(
            "SELECT version() AS version,(SELECT datcollate FROM pg_database WHERE datname=current_database()) AS collate,(SELECT extversion FROM pg_extension WHERE extname='vector') AS vector_version"
        ).fetchone()
    assert server["vector_version"]
    labels = {
        arm: {
            c["id"]: gold(c, read(root / arm / "input.json")["chunks"]) for c in cases
        }
        for arm in ARMS
    }
    locator.save(root / "scores-labels.json", labels)
    inputs.append(root / "scores-labels.json")
    locator.save(
        root / "scores-freeze.json",
        {
            "utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "scorer_sha256": locator.sha(Path(__file__).read_bytes()),
            "locator_sha256": locator.sha(Path(locator.__file__).read_bytes()),
            "inputs": {str(p.resolve()): locator.sha(p.read_bytes()) for p in inputs},
            "runtime": {
                m.__name__: locator.sha(Path(m.__file__).read_bytes())
                for m in (chunking, lang)
            },
            "postgres": server,
            "psycopg": importlib.metadata.version("psycopg"),
            "embedding": str(embedding.resolve()),
            "protocol": "Original query Qwen3-Embedding-4B2560 vectors; format6significantdigits then actual PG halfvec. Exact cosine over fixed eight-source pool in each arm; existing detected chunk language/config, reference lexical exclusion, full ts_rank_cd scores, current RRF k60/dense1/lex.5/exact1/top40/cap4+fill5. Stable ID order inside ties; report ties. Compare baseline and already-frozen original/punctuation locator promotions. All15 positive units remain denominator including zero-qrel. Canonical and raw-glyph labels separate; body versus inherited-prefix anchor coverage separate. No tuning or provider calls.",
        },
    )
    print("full ranking frozen", server)


def run(root):
    frozen = read(root / "scores-freeze.json")
    assert frozen["scorer_sha256"] == locator.sha(Path(__file__).read_bytes())
    assert frozen["locator_sha256"] == locator.sha(Path(locator.__file__).read_bytes())
    for path, expected in frozen["inputs"].items():
        assert locator.sha(Path(path).read_bytes()) == expected, path
    for module in (chunking, lang):
        assert (
            locator.sha(Path(module.__file__).read_bytes())
            == frozen["runtime"][module.__name__]
        )
    embedding = Path(frozen["embedding"])
    prepared = read(embedding / "prepared-v2.json")
    query_hashes = {q["id"]: q["query_sha256"] for q in prepared["queries"]}
    controls = read(Path(read(root / "freeze.json")["inputs"]["real_controls"]["path"]))
    labels = read(root / "scores-labels.json")
    with sqlite3.connect(
        f"file:{embedding / 'vectors.sqlite3'}?mode=ro", uri=True
    ) as cache:
        vectors = {}
        for key, value in cache.execute("SELECT sha256,value FROM vectors"):
            v = array.array("f")
            v.frombytes(value)
            assert len(v) == 2560 and all(math.isfinite(x) for x in v)
            vectors[key] = "[" + ",".join(format(x, ".6g") for x in v) + "]"
    features, results = [], []
    with psycopg.connect(DSN, row_factory=dict_row) as db:
        db.execute(
            "CREATE TEMP TABLE documents(id text PRIMARY KEY,scope text,lang text,search tsvector,embedding halfvec(2560))"
        )
        chunks = {}
        for arm in ARMS:
            for c in read(root / arm / "input.json")["chunks"]:
                language = lang.detect_lang(c["indexed_text"])
                vector = vectors[locator.sha(c["indexed_text"].encode())]
                search = (
                    ""
                    if c["reference"]
                    else chunking.tokenize_for_search(c["indexed_text"])
                )
                db.execute(
                    "INSERT INTO documents VALUES (%s,%s,%s,to_tsvector(%s::regconfig,%s),%s::halfvec)",
                    (c["id"], arm, language, lang.TS_CONFIG[language], search, vector),
                )
                chunks[c["id"]] = c | {"lang": language, "scope": arm}
        for arm in ARMS:
            primary = {r["id"]: r for r in read(root / arm / "external-results.json")}
            control = {
                r["id"]: r for r in read(root / arm / "punctuation-results.json")
            }
            for case in controls["cases"]:
                terms = chunking.search_query_terms(case["query"])
                parameters, parsed = [], {}
                for language in sorted(
                    {c["lang"] for c in chunks.values() if c["scope"] == arm}
                ):
                    cfg = lang.TS_CONFIG[language]
                    value = db.execute(
                        "SELECT websearch_to_tsquery(%s::regconfig,%s)::text AS any_of,websearch_to_tsquery(%s::regconfig,%s)::text AS all_of,%s BETWEEN 2 AND 3 AND coalesce(array_length(tsvector_to_array(to_tsvector(%s::regconfig,%s)),1),0)=coalesce(array_length(tsvector_to_array(to_tsvector('simple',%s)),1),0) AS lookup",
                        (
                            cfg,
                            terms.any_of,
                            cfg,
                            terms.all_of,
                            terms.terms,
                            cfg,
                            terms.latin,
                            terms.latin,
                        ),
                    ).fetchone()
                    parsed[language] = value
                    parameters.append(
                        (language, value["any_of"], value["all_of"], value["lookup"])
                    )
                sql = (
                    "WITH q AS (SELECT lang,any_of::tsquery,all_of::tsquery,lookup FROM (VALUES "
                    + ",".join(["(%s,%s,%s,%s)"] * len(parameters))
                    + ") v(lang,any_of,all_of,lookup)) SELECT c.id,ts_rank_cd(c.search,q.any_of) AS pg_score,c.search @@ q.any_of AS pg_match,c.search @@ q.all_of AS all_match,(c.search @@ q.all_of AND q.lookup) AS exact,1-(c.embedding <=> %s::halfvec) AS cosine FROM documents c JOIN q ON c.lang=q.lang WHERE c.scope=%s ORDER BY c.id"
                )
                rows = db.execute(
                    sql,
                    [v for p in parameters for v in p]
                    + [vectors[query_hashes[case["id"]]], arm],
                ).fetchall()
                for i, row in enumerate(rows):
                    row["pg_tie"] = i
                feature = {
                    "id": case["id"],
                    "arm": arm,
                    "parsed": parsed,
                    "rows": rows,
                    "dense_tie_groups": sum(
                        n > 1
                        for n in collections.Counter(r["cosine"] for r in rows).values()
                    ),
                    "lexical_tie_groups": sum(
                        n > 1
                        for n in collections.Counter(
                            (r["all_match"], r["pg_score"])
                            for r in rows
                            if r["pg_match"]
                        ).values()
                    ),
                }
                features.append(feature)
                baseline = locator.current(feature)
                for method, promotions in (
                    ("baseline", []),
                    ("locator", primary[case["id"]]["decision"]["promote"]),
                    ("punctuation", control[case["id"]]["decision"]["promote"]),
                ):
                    ordered = (
                        promotions + [c for c in baseline if c not in promotions]
                    )[:40]
                    hits = locator.capped(ordered, chunks)
                    target = labels[arm][case["id"]]
                    results.append(
                        {
                            "id": case["id"],
                            "arm": arm,
                            "method": method,
                            "locale": case["locale"],
                            "positive": case["expected"]["outcome"] == "resolve",
                            "hits": hits,
                            "ranked40": ordered,
                            "promoted": promotions,
                            "metrics": {
                                key: {
                                    "top5": metric(hits, target[key]["ids"]),
                                    "candidate40": metric(ordered, target[key]["ids"]),
                                    "body_top5": metric(hits, target[key]["body_ids"]),
                                    "label_chunks": len(target[key]["ids"]),
                                }
                                for key in ("canonical", "raw_glyph")
                            },
                            "source_page_top5": metric(hits, target["source_page_ids"]),
                        }
                    )
    locator.save(root / "scores-features.json", features)
    locator.save(root / "scores-results.json", results)
    summary = []
    for arm in ARMS:
        for method in ("baseline", "locator", "punctuation"):
            part = [
                r
                for r in results
                if r["arm"] == arm and r["method"] == method and r["positive"]
            ]
            assert len(part) == 15
            summary.append(
                {
                    "arm": arm,
                    "method": method,
                    "positive_denominator": 15,
                    "metrics": {
                        key: {
                            "hits5": sum(
                                r["metrics"][key]["top5"]["hit"] for r in part
                            ),
                            "candidate40_hits": sum(
                                r["metrics"][key]["candidate40"]["hit"] for r in part
                            ),
                            "body_hits5": sum(
                                r["metrics"][key]["body_top5"]["hit"] for r in part
                            ),
                            "discounted_first_hit5": sum(
                                r["metrics"][key]["top5"]["discounted_first_hit"]
                                for r in part
                            )
                            / 15,
                            "mrr5": sum(r["metrics"][key]["top5"]["mrr"] for r in part)
                            / 15,
                            "zero_qrel_ids": [
                                r["id"]
                                for r in part
                                if not r["metrics"][key]["label_chunks"]
                            ],
                        }
                        for key in ("canonical", "raw_glyph")
                    },
                }
            )
    locator.save(root / "scores-summary.json", summary)
    locator.save(
        root / "scores-receipt.json",
        {
            "queries_per_arm": 28,
            "scored_rows": len(results),
            "full_query_document_pairs": sum(len(f["rows"]) for f in features),
            "provider_calls": 0,
            "server": frozen["postgres"],
            "lang_counts": dict(
                collections.Counter(c["lang"] for c in chunks.values())
            ),
            "freeze_sha256": locator.sha((root / "scores-freeze.json").read_bytes()),
            "result_sha256": locator.sha((root / "scores-results.json").read_bytes()),
        },
    )
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    if sys.argv[1] == "freeze":
        freeze(Path(sys.argv[2]), Path(sys.argv[3]))
    elif sys.argv[1] == "run":
        run(Path(sys.argv[2]))
