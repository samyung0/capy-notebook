"""Frozen BM25 comparison. Stages: freeze, extract, dev, heldout, check.

Only extract writes a disposable lab database at loopback:55438/bm25. No model
calls or application settings. All lexical scores are computed before top-k.
"""

import collections
import hashlib
import importlib.metadata
import json
import math
import sqlite3
import statistics
import sys
import time
from pathlib import Path

import numpy as np

PARAMS = [(1.2, 0.75)] + [
    (k, b)
    for k in (0.6, 1.2, 2.0)
    for b in (0.0, 0.5, 0.75, 1.0)
    if (k, b) != (1.2, 0.75)
]
ALPHAS = [i / 10 for i in range(11)]
DSN = "postgresql://postgres@127.0.0.1:55438/bm25"


def sha(value):
    return hashlib.sha256(
        value.encode() if isinstance(value, str) else value
    ).hexdigest()


def read(path):
    return json.loads(path.read_text())


def save(path, value):
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")
    tmp.replace(path)


def records(path):
    return [json.loads(line) for line in path.read_text().splitlines()]


def unit(value):
    value = np.asarray([float(f"{x:.6g}") for x in value], dtype=np.float16).astype(
        np.float32
    )
    return value / np.linalg.norm(value)


def freeze(root):
    from pipeline.prompts.retrieval import qwen3_query
    from pipeline.retrieval import chunking, lang

    assert not (root / "freeze.json").exists()
    multi, jlpt = root / "sources/multilingual", root / "sources/jlpt"
    prepared, snapshot = read(multi / "prepared.json"), read(jlpt / "snapshot.json")
    live = {c["id"]: c for c in read(root / "jlpt-lexical.json")}
    assert len(live) == len(snapshot["chunks"])
    baseline = {
        r["id"]: r
        for split in ("dev", "heldout")
        for r in records(multi / f"{split}.jsonl")
        if r["method"] == "baseline"
    }
    chunks = [c | {"scope": "multi:" + c["locale"]} for c in prepared["chunks"]]
    queries = [
        q
        | {
            "scope": "multi:" + q["locale"],
            "cohort": "natural" if q["kind"] == "natural_semantic" else "controlled",
            "label_unit": "file",
            "expected": [r["id"] for r in baseline[q["id"]]["hits"]],
        }
        for q in prepared["queries"]
    ]
    with sqlite3.connect(f"file:{multi / 'vectors.sqlite3'}?mode=ro", uri=True) as db:
        vectors = {
            k: np.frombuffer(v, dtype=np.float32)
            for k, v in db.execute("SELECT key,value FROM vectors")
        }
    document_vectors = [unit(vectors[sha(c["text"])]) for c in chunks]
    query_vectors = [unit(vectors[sha(qwen3_query(q["q"]))]) for q in queries]
    for c in snapshot["chunks"]:
        actual = live[c["id"]]
        assert actual["indexed_text"] == c["indexed_text"]
        chunks.append(
            {
                "id": c["id"],
                "file_id": c["file_id"],
                "locale": "ja",
                "lang": actual["lang"],
                "reference": not actual["search"],
                "scope": "jlpt",
                "text": c["indexed_text"],
                "stored_search": actual["search"],
            }
        )
        vector = np.asarray(json.loads(c["embedding"]), dtype=np.float64)
        document_vectors.append(vector / np.linalg.norm(vector))
    previous = [
        r
        for r in read(jlpt / "results.json")
        if r["variant"] == "stored_original" and r["mode"] == "current"
    ]
    embeddings = sorted(read(jlpt / "response.json")["data"], key=lambda r: r["index"])
    manifest = read(jlpt / "freeze.json")
    for i, (query, prior) in enumerate(zip(manifest["queries"], previous)):
        assert query == prior["query"]
        # Original JLPT analysis used float64 sums after identical half rounding.
        vector = np.asarray(
            [float(f"{x:.6g}") for x in embeddings[i]["embedding"]], dtype=np.float16
        ).astype(np.float64)
        vector /= np.linalg.norm(vector)
        query_vectors.append(vector)
        queries.append(
            {
                "id": f"jlpt-{i + 1}",
                "locale": "ja",
                "family": "jlpt-single-document",
                "split": "diagnostic",
                "kind": "section_lookup" if i < 4 else "subject",
                "cohort": "jlpt",
                "label_unit": "chunk",
                "q": query,
                "qrels": {manifest["target"]: 1},
                "scope": "jlpt",
                "expected": [r["id"] for r in prior["output"]],
            }
        )
    assert len(queries) == 629 and len(chunks) == 3500
    save(root / "prepared.json", {"chunks": chunks, "queries": queries})
    np.savez_compressed(
        root / "vectors.npz",
        documents=np.asarray(document_vectors, dtype=np.float64),
        queries=np.asarray(query_vectors, dtype=np.float64),
    )
    paths = [
        multi / name
        for name in ("prepared.json", "vectors.sqlite3", "dev.jsonl", "heldout.jsonl")
    ]
    paths += [
        jlpt / name
        for name in ("snapshot.json", "freeze.json", "results.json", "response.json")
    ]
    paths += [
        root / name
        for name in ("jlpt-lexical.json", "prepared.json", "vectors.npz", "protocol.md")
    ]
    save(
        root / "freeze.json",
        {
            "utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "script_sha256": sha(Path(__file__).read_bytes()),
            "sources": {str(p.relative_to(root)): sha(p.read_bytes()) for p in paths},
            "runtime_modules": {
                m.__name__: sha(Path(m.__file__).read_bytes()) for m in (chunking, lang)
            },
            "dependencies": {
                p: importlib.metadata.version(p) for p in ("numpy", "psycopg")
            },
            "bm25_grid": PARAMS,
            "alpha_grid": ALPHAS,
            "objective": "Equal populated locale/task-cell mean dev nDCG@5. BM25 ties: default then listed order; alpha ties: smaller lexical coefficient. No held-out selection.",
            "statistics": "N and average length count nonempty lexical documents in each full query scope; df counts normalized lexeme across same scope, retaining existing per-chunk analyzers.",
        },
    )
    print("frozen", len(chunks), len(queries), flush=True)


def verify(root):
    frozen = read(root / "freeze.json")
    assert sha(Path(__file__).read_bytes()) == frozen["script_sha256"]
    for path, expected in frozen["sources"].items():
        assert sha((root / path).read_bytes()) == expected, path
    return read(root / "prepared.json")


def extract(root):
    import psycopg
    from psycopg.rows import dict_row

    from pipeline.retrieval import chunking, lang

    prepared = verify(root)
    for module in (chunking, lang):
        assert (
            sha(Path(module.__file__).read_bytes())
            == read(root / "freeze.json")["runtime_modules"][module.__name__]
        )
    outpath = root / "features.jsonl"
    assert not outpath.exists()
    chunks, queries = prepared["chunks"], prepared["queries"]
    vectors = np.load(root / "vectors.npz")
    lexical_documents = {}
    historical = {
        f"jlpt-{i + 1}": {r["id"]: r["rank"] for r in entry["rows"]}
        for i, entry in enumerate(read(root / "sources/jlpt/snapshot.json")["lexical"])
    }
    with psycopg.connect(DSN, row_factory=dict_row) as conn, outpath.open("w") as out:
        version = conn.execute("SELECT version() AS version").fetchone()["version"]
        conn.execute(
            "CREATE TEMP TABLE documents (id text PRIMARY KEY,scope text,lang text,search tsvector)"
        )
        for c in chunks:
            cfg = lang.TS_CONFIG[c["lang"]]
            value = "" if c["reference"] else chunking.tokenize_for_search(c["text"])
            row = conn.execute(
                "SELECT to_tsvector(%s::regconfig,%s)::text AS search", (cfg, value)
            ).fetchone()
            if "stored_search" in c:
                assert row["search"] == c["stored_search"], c["id"]
            tf = {
                r["lexeme"]: len(r["positions"])
                for r in conn.execute(
                    "SELECT * FROM unnest(%s::tsvector)", (row["search"],)
                ).fetchall()
            }
            debug = collections.Counter(
                w
                for r in conn.execute(
                    "SELECT lexemes FROM ts_debug(%s::regconfig,%s)", (cfg, value)
                ).fetchall()
                for w in (r["lexemes"] or [])
            )
            assert dict(debug) == tf, (c["id"], "analyzer/position frequency mismatch")
            lexical_documents[c["id"]] = {
                "tf": tf,
                "length": sum(tf.values()),
                "cfg": cfg,
            }
            conn.execute(
                "INSERT INTO documents VALUES (%s,%s,%s,%s::tsvector)",
                (c["id"], c["scope"], c["lang"], row["search"]),
            )
        save(root / "lexical-documents.json", lexical_documents)
        print("verified PostgreSQL token frequencies", len(chunks), flush=True)
        for qi, query in enumerate(queries):
            indices = [i for i, c in enumerate(chunks) if c["scope"] == query["scope"]]
            langs = sorted({chunks[i]["lang"] for i in indices})
            terms = chunking.search_query_terms(query["q"])
            parameters, query_lexemes, parsed = [], {}, {}
            for language in langs:
                cfg = lang.TS_CONFIG[language]
                value = conn.execute(
                    "SELECT websearch_to_tsquery(%s::regconfig,%s)::text AS any_of, websearch_to_tsquery(%s::regconfig,%s)::text AS all_of, %s BETWEEN 2 AND 3 AND coalesce(array_length(tsvector_to_array(to_tsvector(%s::regconfig,%s)),1),0)=coalesce(array_length(tsvector_to_array(to_tsvector('simple',%s)),1),0) AS lookup, tsvector_to_array(to_tsvector(%s::regconfig,%s)) AS lexemes",
                    (
                        cfg,
                        terms.any_of,
                        cfg,
                        terms.all_of,
                        terms.terms,
                        cfg,
                        terms.latin,
                        terms.latin,
                        cfg,
                        chunking.tokenize_for_search(query["q"]),
                    ),
                ).fetchone()
                parameters.append(
                    (language, value["any_of"], value["all_of"], value["lookup"])
                )
                query_lexemes[language] = value["lexemes"]
                parsed[language] = value
            sql = (
                "WITH q AS (SELECT lang,any_of::tsquery,all_of::tsquery,lookup FROM (VALUES "
                + ",".join(["(%s,%s,%s,%s)"] * len(parameters))
                + ") v(lang,any_of,all_of,lookup)) SELECT c.id,ts_rank_cd(c.search,q.any_of) AS pg_score,c.search @@ q.any_of AS pg_match,c.search @@ q.all_of AS all_match,(c.search @@ q.all_of AND q.lookup) AS exact FROM documents c JOIN q ON c.lang=q.lang WHERE c.scope=%s ORDER BY c.id"
            )
            lexical = {
                r["id"]: r
                for r in conn.execute(
                    sql, [v for p in parameters for v in p] + [query["scope"]]
                ).fetchall()
            }
            assert len(lexical) == len(indices)
            for order, (cid, row) in enumerate(lexical.items(), 1):
                row["pg_tie"] = (
                    historical[query["id"]][cid]
                    if query["scope"] == "jlpt" and row["pg_match"]
                    else order
                )
            matrix = vectors["documents"][indices]
            # Reuse exact frozen values; multilingual legacy used float32 dot.
            if query["scope"] != "jlpt":
                similarities = matrix.astype(np.float32) @ vectors["queries"][
                    qi
                ].astype(np.float32)
            else:
                similarities = matrix @ vectors["queries"][qi]
            rows = [
                lexical[chunks[i]["id"]] | {"cosine": float(score)}
                for i, score in zip(indices, similarities)
            ]
            out.write(
                json.dumps(
                    {
                        "id": query["id"],
                        "lexemes": query_lexemes,
                        "parsed": parsed,
                        "typed_terms": terms.__dict__,
                        "rows": rows,
                    },
                    ensure_ascii=False,
                )
                + "\n"
            )
            out.flush()
            if (qi + 1) % 100 == 0:
                print("full score extraction", qi + 1, flush=True)
    save(
        root / "extraction.json",
        {
            "postgres": version,
            "queries": len(queries),
            "chunks": len(chunks),
            "features_sha256": sha(outpath.read_bytes()),
            "lexical_documents_sha256": sha(
                (root / "lexical-documents.json").read_bytes()
            ),
            "analyzer_frequency_checks": len(chunks),
            "censored_scores": 0,
        },
    )


def bm25_scores(query, rows, chunks, docs, stats, k1, b):
    scope_stats = stats[query["scope"]]
    n, avg, df = scope_stats["n"], scope_stats["average"], scope_stats["df"]
    output = {}
    for row in rows["rows"]:
        cid = row["id"]
        doc = docs[cid]
        value = 0.0
        for term in rows["lexemes"][chunks[cid]["lang"]]:
            tf = doc["tf"].get(term, 0)
            if tf:
                idf = math.log1p((n - df[term] + 0.5) / (df[term] + 0.5))
                value += (
                    idf * tf * (k1 + 1) / (tf + k1 * (1 - b + b * doc["length"] / avg))
                )
        output[cid] = value
    return output


def statistics_by_scope(chunks, docs):
    output = {}
    for scope in sorted({c["scope"] for c in chunks.values()}):
        indexed = [
            docs[cid]
            for cid, c in chunks.items()
            if c["scope"] == scope and docs[cid]["length"]
        ]
        df = collections.Counter(t for d in indexed for t in d["tf"])
        output[scope] = {
            "n": len(indexed),
            "average": statistics.mean(d["length"] for d in indexed),
            "df": df,
        }
    return output


def rank(scores, eligible=None):
    ids = scores if eligible is None else eligible
    return sorted(ids, key=lambda cid: (-scores[cid], cid))


def minmax(scores, ids):
    low, high = min(scores[c] for c in ids), max(scores[c] for c in ids)
    return {c: (scores[c] - low) / (high - low) if high > low else 0.0 for c in ids}


def capped(ids, chunks):
    count, kept, overflow = collections.Counter(), [], []
    for cid in ids:
        fid = chunks[cid]["file_id"]
        if count[fid] < 4:
            kept.append(cid)
            count[fid] += 1
        else:
            overflow.append(cid)
    return (kept + overflow)[:5]


def label(cid, query, chunks):
    return cid if query["label_unit"] == "chunk" else chunks[cid]["file_id"]


def recall(ids, query, chunks):
    found = {label(c, query, chunks) for c in ids}
    relevant = {k for k, g in query["qrels"].items() if g > 0}
    return len(found & relevant) / len(relevant)


def metric(ids, query, chunks):
    seen, dcg, reciprocal = set(), 0.0, 0.0
    for i, cid in enumerate(ids, 1):
        key = label(cid, query, chunks)
        grade = query["qrels"].get(key, 0) if key not in seen else 0
        seen.add(key)
        if grade:
            dcg += (2**grade - 1) / math.log2(i + 1)
            reciprocal = reciprocal or 1 / i
    ideal = sum(
        (2**g - 1) / math.log2(i + 2)
        for i, g in enumerate(sorted(query["qrels"].values(), reverse=True)[:5])
    )
    return {
        "hit5": int(reciprocal > 0),
        "recall5": recall(ids, query, chunks),
        "ndcg5": dcg / ideal,
        "mrr5": reciprocal,
    }


def evaluate(query, features, chunks, lexical_scores, method, weight=0.5, alpha=None):
    raw = {r["id"]: r for r in features["rows"]}
    dense_scores = {cid: r["cosine"] for cid, r in raw.items()}
    dense_all = rank(dense_scores)
    dense = dense_all[:40]
    if method in ("current", "lex_current", "bm25_current"):
        lexical_all = sorted(
            (cid for cid, r in raw.items() if r["pg_match"]),
            key=lambda cid: (
                -raw[cid]["all_match"],
                -lexical_scores[cid],
                raw[cid]["pg_tie"] if method in ("current", "lex_current") else cid,
                cid,
            ),
        )
    else:
        lexical_all = rank(lexical_scores, [c for c in raw if lexical_scores[c] > 0])
    lexical = lexical_all[:40]
    union = sorted(set(dense) | set(lexical))
    if method == "dense":
        ordered, candidates = dense, dense
    elif method.startswith("lex_"):
        ordered, candidates = lexical, lexical
    elif alpha is not None:
        dn, ln = minmax(dense_scores, union), minmax(lexical_scores, union)
        scores = {c: (1 - alpha) * dn[c] + alpha * ln[c] for c in union}
        ordered = rank(
            scores, [c for c in union if lexical_scores[c] > 0] if alpha == 1 else union
        )[:40]
        candidates = union
    else:
        scores = {c: 1 / (60 + i) for i, c in enumerate(dense, 1)}
        for i, cid in enumerate(lexical, 1):
            lw = (
                1.0
                if method in ("current", "bm25_current") and raw[cid]["exact"]
                else weight
            )
            scores[cid] = scores.get(cid, 0.0) + lw / (60 + i)
        ordered, candidates = rank(scores)[:40], union
    hits = capped(ordered, chunks)
    return {
        "id": query["id"],
        "split": query["split"],
        "locale": query["locale"],
        "cohort": query["cohort"],
        "kind": query["kind"],
        "family": query["family"],
        "metrics": metric(hits, query, chunks),
        "hits": hits,
        "lexical40_recall": recall(lexical, query, chunks),
        "candidate_recall": recall(candidates, query, chunks),
        "candidate_count": len(candidates),
        "ranked40_recall": recall(ordered, query, chunks),
        "lexical_relevant_ranks": {
            cid: i
            for i, cid in enumerate(lexical_all, 1)
            if query["qrels"].get(label(cid, query, chunks), 0) > 0
        },
        "dense_relevant_ranks": {
            cid: i
            for i, cid in enumerate(dense_all, 1)
            if query["qrels"].get(label(cid, query, chunks), 0) > 0
        },
        "relevant_ranks": {
            cid: i
            for i, cid in enumerate(ordered, 1)
            if query["qrels"].get(label(cid, query, chunks), 0) > 0
        },
    }


def objective(rows):
    groups = collections.defaultdict(list)
    for row in rows:
        groups[(row["locale"], row["kind"])].append(row["metrics"]["ndcg5"])
    return statistics.mean(statistics.mean(g) for g in groups.values())


def summarize(rows):
    groups = collections.defaultdict(list)
    for row in rows:
        for group, key in (
            ("overall", "all"),
            ("cohort", row["cohort"]),
            ("locale", row["locale"]),
            ("task", row["kind"]),
            ("locale_task", row["locale"] + "/" + row["kind"]),
        ):
            groups[(row["split"], row["arm"], group, key)].append(row)
    return [
        {
            "split": split,
            "arm": arm,
            "group": group,
            "key": key,
            "n": len(items),
            "hits": sum(r["metrics"]["hit5"] for r in items),
            **{
                m: statistics.mean(r["metrics"][m] for r in items)
                for m in ("recall5", "ndcg5", "mrr5")
            },
            **{
                m: statistics.mean(r[m] for r in items)
                for m in (
                    "lexical40_recall",
                    "candidate_recall",
                    "ranked40_recall",
                    "candidate_count",
                )
            },
        }
        for (split, arm, group, key), items in sorted(groups.items())
    ]


def score(root, split):
    prepared = verify(root)
    audit = read(root / "baseline-audit.json")
    assert audit["verified"] == len(prepared["queries"]) and not audit["mismatches"]
    assert audit["before_dev_selection"]
    assert audit["features_sha256"] == sha((root / "features.jsonl").read_bytes())
    receipt = read(root / "extraction.json")
    assert sha((root / "features.jsonl").read_bytes()) == receipt["features_sha256"]
    assert (
        sha((root / "lexical-documents.json").read_bytes())
        == receipt["lexical_documents_sha256"]
    )
    chunks = {c["id"]: c for c in prepared["chunks"]}
    queries = [
        q
        for q in prepared["queries"]
        if q["split"] == split or (split == "heldout" and q["split"] == "diagnostic")
    ]
    features = {r["id"]: r for r in records(root / "features.jsonl")}
    docs = read(root / "lexical-documents.json")
    stats = statistics_by_scope(chunks, docs)
    out = root / f"{split}.jsonl"
    assert not out.exists()
    selected = read(root / "selection.json") if split == "heldout" else None
    if selected:
        assert (
            sha((root / "selection.json").read_bytes())
            == read(root / "dev-receipt.json")["selection_sha256"]
        )
        assert selected["runner_sha256"] == sha(Path(__file__).read_bytes())
        assert selected["features_sha256"] == receipt["features_sha256"]
    grid, scored = {}, []
    for pair in PARAMS:
        arm = f"lex_bm25_k{pair[0]:g}_b{pair[1]:g}"
        grid[arm] = []
        for q in queries:
            scores = bm25_scores(q, features[q["id"]], chunks, docs, stats, *pair)
            row = evaluate(q, features[q["id"]], chunks, scores, "lex_bm25") | {
                "arm": arm
            }
            grid[arm].append(row)
        scored.extend(grid[arm])
    if split == "dev":
        choice = max(range(len(PARAMS)), key=lambda i: objective(grid[list(grid)[i]]))
        selected = {
            "bm25": list(PARAMS[choice]),
            "bm25_arm": list(grid)[choice],
            "bm25_dev_grid": {a: objective(r) for a, r in grid.items()},
            "utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
        save(root / "bm25-selection.json", selected)
    calibrated = collections.defaultdict(list)
    baseline_mismatches, selected_scores = [], []
    for q in queries:
        f = features[q["id"]]
        pg = {r["id"]: r["pg_score"] for r in f["rows"]}
        bm = bm25_scores(q, f, chunks, docs, stats, *selected["bm25"])
        selected_scores.append(
            {"id": q["id"], "parameters": selected["bm25"], "scores": bm}
        )
        specifications = [
            ("current", pg, "current", 0.5, None),
            ("dense", pg, "dense", 0.5, None),
            ("lex_current", pg, "lex_current", 0.5, None),
            ("lex_pg", pg, "lex_pg", 0.5, None),
            ("lex_bm25_selected", bm, "lex_bm25", 0.5, None),
            ("bm25_current_rules", bm, "bm25_current", 0.5, None),
            ("bm25_rrf_half", bm, "rrf", 0.5, None),
            ("bm25_rrf_equal", bm, "rrf", 1, None),
        ]
        for kind, values in (("pg", pg), ("bm25", bm)):
            for alpha in ALPHAS:
                specifications.append(
                    (f"cc_{kind}_a{alpha:g}", values, "cc", 0.5, alpha)
                )
        for arm, values, method, weight, alpha in specifications:
            row = evaluate(q, f, chunks, values, method, weight, alpha) | {"arm": arm}
            scored.append(row)
            if arm.startswith("cc_"):
                calibrated[arm].append(row)
            if arm == "current" and row["hits"] != q["expected"]:
                baseline_mismatches.append(
                    {"id": q["id"], "expected": q["expected"], "actual": row["hits"]}
                )
    assert not baseline_mismatches, baseline_mismatches[:5]
    if split == "dev":
        for kind in ("pg", "bm25"):
            selected["alpha_" + kind] = max(
                ALPHAS, key=lambda a: objective(calibrated[f"cc_{kind}_a{a:g}"])
            )
        selected["fusion_dev_grid"] = {a: objective(r) for a, r in calibrated.items()}
        selected["runner_sha256"] = sha(Path(__file__).read_bytes())
        selected["features_sha256"] = receipt["features_sha256"]
        save(root / "selection.json", selected)
    for kind in ("pg", "bm25"):
        for row in calibrated[f"cc_{kind}_a{selected['alpha_' + kind]:g}"]:
            scored.append(row | {"arm": "cc_" + kind + "_selected"})
    with out.open("w") as stream:
        for row in scored:
            stream.write(json.dumps(row, ensure_ascii=False) + "\n")
    save(root / f"{split}-summary.json", summarize(scored))
    with (root / f"{split}-bm25-scores.jsonl").open("w") as stream:
        for row in selected_scores:
            stream.write(json.dumps(row, ensure_ascii=False) + "\n")
    save(
        root / f"{split}-receipt.json",
        {
            "utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "rows": len(scored),
            "baseline_queries_verified": len(queries),
            "baseline_mismatches": baseline_mismatches,
            "result_sha256": sha(out.read_bytes()),
            "selection_sha256": sha((root / "selection.json").read_bytes()),
        },
    )
    print(
        "scored",
        split,
        len(scored),
        "selected",
        {k: v for k, v in selected.items() if k in ("bm25", "alpha_pg", "alpha_bm25")},
        flush=True,
    )


def check():
    chunks = {
        "a": {"scope": "s", "lang": "en", "file_id": "a"},
        "b": {"scope": "s", "lang": "en", "file_id": "b"},
        "c": {"scope": "s", "lang": "en", "file_id": "c"},
    }
    docs = {
        "a": {"tf": {"cat": 2, "sat": 1}, "length": 3},
        "b": {"tf": {"cat": 1}, "length": 1},
        "c": {"tf": {"dog": 1, "sat": 1}, "length": 2},
    }
    q = {"scope": "s", "label_unit": "file", "qrels": {"a": 1}}
    f = {"rows": [{"id": c} for c in chunks], "lexemes": {"en": ["cat"]}}
    actual = bm25_scores(
        q, f, chunks, docs, statistics_by_scope(chunks, docs), 1.2, 0.75
    )
    idf = math.log(1.6)
    assert math.isclose(actual["a"], idf * 4.4 / 3.65)
    assert math.isclose(actual["b"], idf * 2.2 / 1.75)
    assert actual["c"] == 0 and actual["b"] > actual["a"]
    assert minmax({"a": 3, "b": 3}, ["a", "b"]) == {"a": 0, "b": 0}
    assert metric(["a", "b"], q, chunks)["ndcg5"] == 1
    assert recall(["b"], q, chunks) == 0
    print("BM25 hand calculation, constant score and metric checks passed")


if __name__ == "__main__":
    if sys.argv[1] == "check":
        check()
    else:
        stage, root = sys.argv[1], Path(sys.argv[2])
        {
            "freeze": freeze,
            "extract": extract,
            "dev": lambda r: score(r, "dev"),
            "heldout": lambda r: score(r, "heldout"),
        }[stage](root)
