"""Isolated language-handling experiment. Stages: freeze, embed, dev, heldout.

Requires the fixture generator output and retained broad/miracl.json under ROOT.
Only the disposable Postgres at loopback:55436/multilingual is writable. Provider
calls bypass application jobs/accounting and use a separate on-disk vector cache.
"""

import collections
import hashlib
import importlib.metadata
import json
import math
import os
import re
import sqlite3
import sys
import time
import unicodedata
from pathlib import Path

import numpy as np
import psycopg
from psycopg.rows import dict_row

from pipeline.prompts.retrieval import qwen3_query
from pipeline.retrieval.chunking import (
    CHUNKER_VERSION,
    chunk_markdown,
    estimate_tokens,
    search_query_terms,
    tokenize_for_search,
)
from pipeline.retrieval.lang import TS_CONFIG, detect_lang

ROOT = Path(sys.argv[2])
DSN = "postgresql://postgres@127.0.0.1:55436/multilingual"
METHODS = ["baseline", "normalized", "segmented", "content_terms", "dense"]
NATURAL = {"en": "en", "ja": "ja", "ko": "ko", "zh": "zh-CN", "es": "es", "fr": "fr"}


def save(name, data):
    (ROOT / name).write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")


def read(name):
    return json.loads((ROOT / name).read_text())


def sha(value):
    return hashlib.sha256(
        value.encode() if isinstance(value, str) else value
    ).hexdigest()


def query_splits(queries):
    groups = [{q["id"]} for q in queries]
    positives = {
        q["id"]: {d for d, grade in q["qrels"].items() if grade > 0} for q in queries
    }
    changed = True
    while changed:
        changed = False
        for i in range(len(groups)):
            a = set().union(*(positives[q] for q in groups[i]))
            for j in range(i + 1, len(groups)):
                if a & set().union(*(positives[q] for q in groups[j])):
                    groups[i] |= groups.pop(j)
                    changed = True
                    break
            if changed:
                break
    result = {}
    for i, group in enumerate(sorted(groups, key=lambda g: sha("|".join(sorted(g))))):
        family = sha("|".join(sorted(group)))[:12]
        for qid in group:
            result[qid] = ("dev" if i % 2 == 0 else "heldout", family)
    return result


def freeze():
    assert not (ROOT / "freeze.json").exists()
    fixture = read("fixtures/multilingual-language-handling.json")
    miracl = read("miracl.json")
    docs = list(fixture["documents"])
    queries = list(fixture["queries"])
    for language, locale in NATURAL.items():
        dataset = miracl["datasets"]["miracl-" + language]
        prefix = "miracl-" + language + "-"
        splits = query_splits(dataset["questions"])
        for did, doc in sorted(dataset["documents"].items()):
            docs.append(
                {
                    "id": prefix + did,
                    "locale": locale,
                    "title": doc["title"],
                    "text": doc["text"],
                }
            )
        for q in dataset["questions"]:
            split, family = splits[q["id"]]
            queries.append(
                {
                    "id": prefix + q["id"],
                    "locale": locale,
                    "family": prefix + family,
                    "split": split,
                    "kind": "natural_semantic",
                    "q": q["q"],
                    "qrels": {prefix + did: grade for did, grade in q["qrels"].items()},
                }
            )
    chunks = []
    for doc in docs:
        for i, chunk in enumerate(
            chunk_markdown("# " + doc["title"] + "\n\n" + doc["text"])
        ):
            text = chunk.indexed_text()
            chunks.append(
                {
                    "id": doc["id"] + ":" + str(i),
                    "file_id": doc["id"],
                    "locale": doc["locale"],
                    "text": text,
                    "lang": detect_lang(text),
                    "reference": chunk.reference,
                }
            )
    assert len(queries) == 624
    all_files = {c["file_id"] for c in chunks}
    assert all(set(q["qrels"]) <= all_files for q in queries)
    payloads = list(
        dict.fromkeys(
            [c["text"] for c in chunks] + [qwen3_query(q["q"]) for q in queries]
        )
    )
    estimated = sum(estimate_tokens(t) for t in payloads)
    assert estimated <= 2_000_000, estimated
    save(
        "prepared.json",
        {"documents": docs, "chunks": chunks, "queries": queries, "inputs": payloads},
    )
    save(
        "freeze.json",
        {
            "frozen_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "prepared_sha256": sha((ROOT / "prepared.json").read_bytes()),
            "fixture_sha256": sha(
                (ROOT / "fixtures/multilingual-language-handling.json").read_bytes()
            ),
            "miracl_sha256": sha((ROOT / "miracl.json").read_bytes()),
            "script_sha256": sha(Path(__file__).read_bytes()),
            "chunker": CHUNKER_VERSION,
            "provider": "deepinfra",
            "model": "Qwen/Qwen3-Embedding-4B",
            "version": 1,
            "dimensions": 2560,
            "methods": METHODS,
            "candidates": 40,
            "top_k": 5,
            "per_file_cap": 4,
            "rrf_k": 60,
            "documents": len(docs),
            "chunks": len(chunks),
            "queries": len(queries),
            "unique_inputs": len(payloads),
            "estimated_input_tokens": estimated,
            "dependencies": {
                p: importlib.metadata.version(p)
                for p in [
                    "SudachiPy",
                    "SudachiDict-core",
                    "kiwipiepy",
                    "kiwipiepy-model",
                    "jieba",
                    "OpenCC",
                    "numpy",
                    "psycopg",
                ]
            },
            "split_counts": dict(
                collections.Counter(
                    q["locale"] + "/" + q["split"] + "/" + q["kind"] for q in queries
                )
            ),
            "selection": "Equal-category dev nDCG; minimum +.02, preserve overall hit@5, no category loss worse than .03; ties prefer earlier method. Held-out unopened until selection freeze.",
        },
    )
    print(
        json.dumps(
            {
                k: v
                for k, v in read("freeze.json").items()
                if k not in {"split_counts", "dependencies"}
            },
            ensure_ascii=False,
        ),
        flush=True,
    )


def cache():
    db = sqlite3.connect(ROOT / "vectors.sqlite3")
    db.execute(
        "CREATE TABLE IF NOT EXISTS vectors (key TEXT PRIMARY KEY, value BLOB NOT NULL)"
    )
    return db


def embed():
    import httpx

    manifest = read("freeze.json")
    assert sha((ROOT / "prepared.json").read_bytes()) == manifest["prepared_sha256"]
    inputs = read("prepared.json")["inputs"]
    with cache() as db, httpx.Client(timeout=60) as client:
        have = {r[0] for r in db.execute("SELECT key FROM vectors")}
        pending = [t for t in inputs if sha(t) not in have]
        assert len(pending) == len(inputs), (
            "An attempted run requires an explicit continuation record."
        )
        total_tokens = 0
        for offset in range(0, len(pending), 64):
            texts = pending[offset : offset + 64]
            started = time.perf_counter()
            response = client.post(
                "https://api.deepinfra.com/v1/openai/embeddings",
                headers={"Authorization": "Bearer " + os.environ["DEEPINFRA_API_KEY"]},
                json={
                    "model": manifest["model"],
                    "input": texts,
                    "dimensions": 2560,
                    "encoding_format": "float",
                },
            )
            receipt = {
                "offset": offset,
                "count": len(texts),
                "status": response.status_code,
                "elapsed_ms": 1000 * (time.perf_counter() - started),
                "input_hashes": [sha(t) for t in texts],
            }
            if response.status_code != 200:
                with (ROOT / "requests.jsonl").open("a") as out:
                    out.write(json.dumps(receipt) + "\n")
                response.raise_for_status()
            data = response.json()
            rows = sorted(data["data"], key=lambda r: r["index"])
            assert [r["index"] for r in rows] == list(range(len(texts)))
            for text, row in zip(texts, rows):
                vector = np.asarray(row["embedding"], dtype=np.float32)
                assert (
                    vector.shape == (2560,)
                    and np.isfinite(vector).all()
                    and np.linalg.norm(vector) > 0
                )
                db.execute(
                    "INSERT INTO vectors VALUES (?,?)", (sha(text), vector.tobytes())
                )
            db.commit()
            receipt.update(usage=data.get("usage"), response_model=data.get("model"))
            total_tokens += data.get("usage", {}).get("prompt_tokens", 0)
            with (ROOT / "requests.jsonl").open("a") as out:
                out.write(json.dumps(receipt) + "\n")
            assert total_tokens <= 2_000_000
            print(
                "embedded",
                offset + len(texts),
                "/",
                len(inputs),
                "tokens",
                total_tokens,
                flush=True,
            )
    save(
        "embedding-complete.json",
        {
            "total_tokens": total_tokens,
            "inputs": len(inputs),
            "manifest_sha256": sha((ROOT / "freeze.json").read_bytes()),
        },
    )


class Tokens:
    def __init__(self):
        import jieba.posseg
        from kiwipiepy import Kiwi
        from opencc import OpenCC
        from sudachipy import Dictionary, SplitMode

        self.cc = OpenCC("t2s")
        self.ja = Dictionary().create()
        self.ja_mode = SplitMode.A
        self.ko = Kiwi(num_workers=1)
        self.zh = jieba.posseg

    def normalized(self, text, lang):
        text = unicodedata.normalize("NFKC", text)
        return self.cc.convert(text) if lang == "zh" else text

    def terms(self, text, lang, method):
        if method == "baseline":
            return tokenize_for_search(text), search_query_terms(text)
        text = self.normalized(text, lang)
        if method == "normalized" or lang not in {"ja", "ko", "zh"}:
            return tokenize_for_search(text), search_query_terms(text)
        content = method == "content_terms"
        result = []
        for part in re.split(r"([A-Za-z0-9]+(?:[-.][A-Za-z0-9]+)+)", text):
            if re.fullmatch(r"[A-Za-z0-9]+(?:[-.][A-Za-z0-9]+)+", part):
                result.append(part)
            elif lang == "ja":
                result.extend(
                    m.dictionary_form()
                    for m in self.ja.tokenize(part, self.ja_mode)
                    if (
                        not content
                        or m.part_of_speech()[0] in {"名詞", "動詞", "形容詞", "形状詞"}
                    )
                    and any(c.isalnum() for c in m.surface())
                )
            elif lang == "ko":
                result.extend(
                    m.form
                    for m in self.ko.tokenize(part)
                    if (
                        not content
                        or m.tag.startswith(("N", "VV", "VA", "SL", "SH", "SN", "XR"))
                    )
                    and any(c.isalnum() for c in m.form)
                )
            else:
                result.extend(
                    m.word
                    for m in self.zh.cut(part)
                    if (not content or m.flag.startswith(("n", "v", "a", "m", "eng")))
                    and any(c.isalnum() for c in m.word)
                )
        return " ".join(result), result[:40]


def build_lexical(conn, chunks):
    token = Tokens()
    conn.execute(
        "CREATE TEMP TABLE lex (id text, locale text, lang text, method text, search tsvector)"
    )
    for method in METHODS[:-1]:
        rows = []
        for c in chunks:
            value, _ = token.terms(c["text"], c["lang"], method)
            rows.append(
                (
                    c["id"],
                    c["locale"],
                    c["lang"],
                    method,
                    "" if c["reference"] else value,
                    TS_CONFIG[c["lang"]],
                )
            )
        with conn.cursor() as cur:
            cur.executemany(
                "INSERT INTO lex VALUES (%s,%s,%s,%s,to_tsvector(%s::regconfig,%s))",
                [(a, b, c, d, cfg, text) for a, b, c, d, text, cfg in rows],
            )
        print("lexical index", method, len(rows), flush=True)
    return token


def lexical_search(conn, token, query, locale, method, langs):
    parameters = []
    query_tokens = {}
    for lang in langs:
        value, terms = token.terms(query, lang, method)
        cfg = TS_CONFIG[lang]
        if isinstance(terms, list):
            words = [w.replace('"', "") for w in terms]
            any_of = " or ".join('"' + w + '"' for w in words)
            all_of = " ".join('"' + w + '"' for w in words)
            lookup = 2 <= len(words) <= 3
            query_tokens[lang] = words
        elif method == "content_terms":
            words = conn.execute(
                "SELECT tsvector_to_array(to_tsvector(%s::regconfig,%s)) AS words",
                (cfg, value),
            ).fetchone()["words"]
            any_of = " or ".join('"' + w + '"' for w in words)
            all_of = " ".join('"' + w + '"' for w in words)
            lookup = True
            query_tokens[lang] = words
        else:
            any_of, all_of = terms.any_of, terms.all_of
            lookup = conn.execute(
                "SELECT %s BETWEEN 2 AND 3 AND coalesce(array_length(tsvector_to_array(to_tsvector(%s::regconfig,%s)),1),0)=coalesce(array_length(tsvector_to_array(to_tsvector('simple',%s)),1),0) AS lookup",
                (terms.terms, cfg, terms.latin, terms.latin),
            ).fetchone()["lookup"]
            query_tokens[lang] = terms.__dict__
        if method == "content_terms":
            lookup = True
        parameters.append((lang, cfg, any_of, all_of, lookup))
    sql = (
        """WITH q AS (
        SELECT lang, websearch_to_tsquery(cfg::regconfig,any_of) AS any_of,
            websearch_to_tsquery(cfg::regconfig,all_of) AS all_of,lookup
        FROM (VALUES """
        + ",".join(["(%s,%s,%s,%s,%s)"] * len(parameters))
        + """
        ) AS v(lang,cfg,any_of,all_of,lookup)
    ) SELECT c.id,c.search @@ q.all_of AS all_match,
       (c.search @@ q.all_of AND q.lookup) AS exact,ts_rank_cd(c.search,q.any_of) AS score
       FROM lex c JOIN q ON q.lang=c.lang WHERE c.locale=%s AND c.method=%s
       AND c.search @@ q.any_of ORDER BY all_match DESC,score DESC,c.id LIMIT 40"""
    )
    rows = conn.execute(
        sql, [v for p in parameters for v in p] + [locale, method]
    ).fetchall()
    return {r["id"]: r | {"rank": i + 1} for i, r in enumerate(rows)}, query_tokens


def cap(rows, files):
    seen, kept, overflow = collections.Counter(), [], []
    for row in rows:
        if seen[files[row["id"]]] < 4:
            kept.append(row)
            seen[files[row["id"]]] += 1
        else:
            overflow.append(row)
    return (kept + overflow)[:5]


def metrics(hits, qrels, files):
    seen, found, dcg, reciprocal = set(), set(), 0.0, 0.0
    for i, row in enumerate(hits, 1):
        fid = files[row["id"]]
        grade = qrels.get(fid, 0) if fid not in seen else 0
        seen.add(fid)
        if grade > 0:
            found.add(fid)
            dcg += (2**grade - 1) / math.log2(i + 1)
            reciprocal = reciprocal or 1 / i
    ideal = sum(
        (2**g - 1) / math.log2(i + 2)
        for i, g in enumerate(sorted(qrels.values(), reverse=True)[:5])
    )
    return {
        "hit5": int(bool(found)),
        "ndcg5": dcg / ideal,
        "mrr5": reciprocal,
        "recall5": len(found) / sum(g > 0 for g in qrels.values()),
    }


def score(split):
    manifest = read("freeze.json")
    assert sha((ROOT / "prepared.json").read_bytes()) == manifest["prepared_sha256"]
    if split == "heldout":
        assert (ROOT / "selection.json").exists()
    prepared = read("prepared.json")
    chunks = prepared["chunks"]
    queries = [q for q in prepared["queries"] if q["split"] == split]
    files = {c["id"]: c["file_id"] for c in chunks}
    with cache() as db:
        vectors = {
            k: np.frombuffer(v, dtype=np.float32)
            for k, v in db.execute("SELECT key,value FROM vectors")
        }

    def unit(v):
        # Preserve the same six-digit serialization and halfvec precision.
        v = np.asarray([float(f"{x:.6g}") for x in v], dtype=np.float16).astype(
            np.float32
        )
        return v / np.linalg.norm(v)

    matrix = np.asarray([unit(vectors[sha(c["text"])]) for c in chunks])
    outpath = ROOT / (split + ".jsonl")
    assert not outpath.exists()
    results = []
    with psycopg.connect(DSN, row_factory=dict_row) as conn, outpath.open("w") as out:
        token = build_lexical(conn, chunks)
        for number, query in enumerate(queries):
            indices = [
                i for i, c in enumerate(chunks) if c["locale"] == query["locale"]
            ]
            qvector = unit(vectors[sha(qwen3_query(query["q"]))])
            distances = 1 - matrix[indices] @ qvector
            ordered = sorted(
                zip(indices, distances.tolist()),
                key=lambda r: (r[1], chunks[r[0]]["id"]),
            )
            dense = {
                chunks[i]["id"]: {"rank": rank + 1, "distance": dist}
                for rank, (i, dist) in enumerate(ordered)
            }
            langs = sorted({chunks[i]["lang"] for i in indices})
            for method in METHODS:
                lexical, tokens = (
                    ({}, {})
                    if method == "dense"
                    else lexical_search(
                        conn, token, query["q"], query["locale"], method, langs
                    )
                )
                candidates = {cid for cid, r in dense.items() if r["rank"] <= 40} | set(
                    lexical
                )
                fused = []
                for cid in candidates:
                    dr, lr = dense[cid], lexical.get(cid)
                    score_value = 1 / (60 + dr["rank"]) if dr["rank"] <= 40 else 0
                    if lr:
                        score_value += (1 if lr["exact"] else 0.5) / (60 + lr["rank"])
                    fused.append(
                        {"id": cid, "score": score_value, "dense": dr, "lexical": lr}
                    )
                fused.sort(key=lambda r: (-r["score"], r["id"]))
                hits = cap(fused[:40], files)
                record = {
                    "id": query["id"],
                    "locale": query["locale"],
                    "kind": query["kind"],
                    "family": query["family"],
                    "method": method,
                    "tokens": tokens,
                    "metrics": metrics(hits, query["qrels"], files),
                    "hits": hits,
                    "candidates": fused,
                }
                out.write(json.dumps(record, ensure_ascii=False) + "\n")
                out.flush()
                results.append(record)
            if number % 20 == 0:
                print(split, number + 1, "/", len(queries), flush=True)
    summary = summarize(results)
    save(split + "-summary.json", summary)
    if split == "dev":
        selection = {}
        for locale, methods in summary.items():
            baseline = methods["baseline"]
            chosen = "baseline"
            for method in METHODS[1:-1]:
                row = methods[method]
                if (
                    row["macro_ndcg"] >= baseline["macro_ndcg"] + 0.02
                    and row["hit5"] >= baseline["hit5"]
                    and all(
                        row["categories"][k]["ndcg5"]
                        >= baseline["categories"][k]["ndcg5"] - 0.03
                        for k in baseline["categories"]
                    )
                ) and (
                    chosen == "baseline"
                    or row["macro_ndcg"] > methods[chosen]["macro_ndcg"] + 1e-12
                ):
                    chosen = method
            selection[locale] = chosen
        save(
            "selection.json",
            {
                "selected": selection,
                "dev_sha256": sha(outpath.read_bytes()),
                "frozen_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            },
        )
        print("selection", selection, flush=True)
    print(
        json.dumps(
            {
                l: {
                    m: {k: v for k, v in r.items() if k != "categories"}
                    for m, r in methods.items()
                }
                for l, methods in summary.items()
            },
            ensure_ascii=False,
        ),
        flush=True,
    )


def summarize(rows):
    result = {}
    for locale in sorted({r["locale"] for r in rows}):
        result[locale] = {}
        for method in METHODS:
            subset = [
                r for r in rows if r["locale"] == locale and r["method"] == method
            ]
            categories = {}
            for kind in sorted({r["kind"] for r in subset}):
                group = [r for r in subset if r["kind"] == kind]
                categories[kind] = {"n": len(group)} | {
                    metric: sum(r["metrics"][metric] for r in group) / len(group)
                    for metric in ["hit5", "ndcg5", "mrr5", "recall5"]
                }
            result[locale][method] = {
                "n": len(subset),
                "hit5": sum(r["metrics"]["hit5"] for r in subset),
                "macro_ndcg": sum(r["ndcg5"] for r in categories.values())
                / len(categories),
                "categories": categories,
            }
    return result


def check():
    files = {"a1": "a", "a2": "a", "b": "b"}
    scores = metrics([{"id": "a1"}, {"id": "a2"}, {"id": "b"}], {"a": 1, "b": 1}, files)
    assert scores["recall5"] == 1
    assert abs(scores["ndcg5"] - 1.5 / (1 + 1 / math.log2(3))) < 1e-12
    assert metrics([], {"a": 1}, files)["hit5"] == 0
    rows = [{"id": str(i)} for i in range(6)]
    assert [
        r["id"] for r in cap(rows, {str(i): "a" if i < 5 else "b" for i in range(6)})
    ] == ["0", "1", "2", "3", "5"]
    splits = query_splits(
        [
            {"id": "a", "qrels": {"same": 1}},
            {"id": "b", "qrels": {"same": 1}},
            {"id": "c", "qrels": {"different": 1}},
        ]
    )
    assert splits["a"] == splits["b"] and splits["c"][0] != splits["a"][0]
    print("metric, cap, and source-group split checks passed")


if __name__ == "__main__":
    {
        "freeze": freeze,
        "embed": embed,
        "dev": lambda: score("dev"),
        "heldout": lambda: score("heldout"),
        "check": check,
    }[sys.argv[1]]()
