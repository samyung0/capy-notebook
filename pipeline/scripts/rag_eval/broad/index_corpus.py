"""Install benchmark text into only the disposable lab retrieval index.

This exercises the real chunker, embedding model, and index writer, but bypasses
upload/parse/summary generation. Source titles are the fixture descriptors.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import sqlite3
import sys
import time
from pathlib import Path

import psycopg
from psycopg.conninfo import conninfo_to_dict
from psycopg.rows import dict_row

from pipeline import registry
from pipeline.config import cfg
from pipeline.retrieval import indexing, models, store
from pipeline.retrieval.chunking import (
    CHUNKER_VERSION,
    chunk_markdown,
    estimate_tokens,
    tokenize_for_search,
)
from pipeline.retrieval.lang import detect_lang

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "curated"))
if Path("/lab/upload_corpus.py").exists():
    sys.path.insert(0, "/lab")
from upload_corpus import request

ROOT = Path("/lab/broad")


def guard():
    assert cfg.gateway_url == "http://127.0.0.1:8082", (
        "Only the isolated lab is allowed."
    )
    connection = conninfo_to_dict(cfg.dsn)
    assert connection["host"] == "127.0.0.1" and connection["port"] == "55434"


def uid(prefix, value):
    return prefix + "_" + hashlib.sha256(value.encode()).hexdigest()[:24]


def write_json(path, value):
    path.with_suffix(path.suffix + ".tmp").write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n"
    )
    path.with_suffix(path.suffix + ".tmp").replace(path)


def open_cache():
    cache = sqlite3.connect(ROOT / "embeddings.sqlite3", timeout=30)
    cache.execute(
        "CREATE TABLE IF NOT EXISTS embeddings (key TEXT PRIMARY KEY, vector TEXT NOT NULL)"
    )
    return cache


def cache_key(text, spec):
    return uid(
        "emb",
        json.dumps(
            [
                spec.provider_slug,
                spec.model_slug,
                spec.version,
                spec.embedding_dim,
                text,
            ],
            ensure_ascii=False,
        ),
    )


async def embed_cached(texts, spec, cache):
    keys = [cache_key(text, spec) for text in texts]
    missing = {}
    for key, text in zip(keys, texts):
        if (
            cache.execute("SELECT 1 FROM embeddings WHERE key=?", (key,)).fetchone()
            is None
        ):
            missing[key] = text
    items = list(missing.items())
    for offset in range(0, len(items), cfg.embedding_batch):
        batch = items[offset : offset + cfg.embedding_batch]
        started = time.monotonic()
        vectors = await models.embed([text for _, text in batch], spec=spec)
        assert len(vectors) == len(batch)
        cache.executemany(
            "INSERT INTO embeddings(key,vector) VALUES (?,?)",
            [(key, json.dumps(vector)) for (key, _), vector in zip(batch, vectors)],
        )
        cache.commit()
        print(
            "embedded",
            offset + len(batch),
            "/",
            len(items),
            f"{time.monotonic() - started:.2f}s",
            flush=True,
        )
    return [
        json.loads(
            cache.execute(
                "SELECT vector FROM embeddings WHERE key=?", (key,)
            ).fetchone()[0]
        )
        for key in keys
    ]


def make_documents(dataset):
    result = []
    for docid, doc in sorted(dataset["documents"].items()):
        title = doc["title"].strip()
        markdown = ("# " + title + "\n\n" if title else "") + doc["text"]
        chunks = chunk_markdown(markdown)
        assert chunks, (docid, "document chunked to empty")
        result.append(
            {
                "docid": docid,
                "title": title,
                "markdown": markdown,
                "chunks": chunks,
                "hash": indexing.content_hash(chunks),
            }
        )
    return result


async def index_dataset(label, dataset, state, cache):
    state_path = ROOT / "retrieval-workspaces.json"
    if label not in state:
        ws = request(
            cfg.gateway_url + "/api/workspaces",
            {"name": "Broad retrieval 20260905 " + label},
        )
        state[label] = {
            "id": ws["id"],
            "source": dataset["source"],
            "language": dataset["language"],
            "files": {},
        }
        write_json(state_path, state)
    entry = state[label]
    pin = await store.workspace_embedding_pin(entry["id"])
    assert (
        pin["embedding_provider_slug"],
        pin["embedding_model_slug"],
        pin["embedding_model_version"],
        pin["embedding_dim"],
    ) == ("deepinfra", "Qwen/Qwen3-Embedding-4B", 1, 2560)
    spec = registry.resolve_pinned(
        pin["embedding_provider_slug"],
        pin["embedding_model_slug"],
        pin["embedding_model_version"],
        registry.Slot.RETRIEVAL,
    )
    documents = make_documents(dataset)
    source_hash = hashlib.sha256(
        json.dumps(dataset, ensure_ascii=False, sort_keys=True).encode()
    ).hexdigest()
    if "source_hash" in entry:
        assert entry["source_hash"] == source_hash, (
            "Source changed underneath an existing fixture."
        )
    entry.update({"source_hash": source_hash, "pin": pin, "chunker": CHUNKER_VERSION})
    write_json(state_path, state)
    with psycopg.connect(cfg.dsn, row_factory=dict_row) as conn:
        owner = conn.execute(
            "SELECT user_id FROM workspaces WHERE id=%s", (entry["id"],)
        ).fetchone()["user_id"]
        for doc in documents:
            fid = uid("f", entry["id"] + ":" + doc["docid"])
            cid = uid("rc", entry["id"] + ":" + doc["hash"])
            name = (doc["title"] or doc["docid"]) + ".md"
            conn.execute(
                """INSERT INTO files(id,workspace_id,user_id,created_by,name,kind,status,indexed,content,content_hash)
                            VALUES(%s,%s,%s,%s,%s,'md','processing',false,%s,%s) ON CONFLICT(id) DO NOTHING""",
                (fid, entry["id"], owner, owner, name, doc["markdown"], doc["hash"]),
            )
            conn.execute(
                """INSERT INTO rag_contents(id,workspace_id,content_hash,pipeline_identity)
                            VALUES(%s,%s,%s,'broad-direct-text-v1') ON CONFLICT(id) DO NOTHING""",
                (cid, entry["id"], doc["hash"]),
            )
            conn.execute(
                "INSERT INTO rag_file_contents(file_id,workspace_id,content_id) VALUES(%s,%s,%s) ON CONFLICT(file_id) DO NOTHING",
                (fid, entry["id"], cid),
            )
            doc.update({"file_id": fid, "content_id": cid, "file_name": name})
            entry["files"][doc["docid"]] = {
                "id": fid,
                "content_id": cid,
                "name": name,
                "chunks": len(doc["chunks"]),
            }
    write_json(state_path, state)
    texts = list(
        dict.fromkeys(
            chunk.indexed_text() for doc in documents for chunk in doc["chunks"]
        )
    )
    print(
        label, len(documents), "documents", len(texts), "unique chunk texts", flush=True
    )
    # Bound materialized vector lists; the cache preserves progress across failures.
    for start in range(0, len(texts), 256):
        await embed_cached(texts[start : start + 256], spec, cache)
    completed = set()
    for number, doc in enumerate(documents, 1):
        if doc["content_id"] not in completed:
            vectors = await embed_cached(
                [chunk.indexed_text() for chunk in doc["chunks"]], spec, cache
            )
            rows = []
            for idx, (chunk, vector) in enumerate(zip(doc["chunks"], vectors)):
                text = chunk.indexed_text()
                rows.append(
                    {
                        "id": uid("chk", doc["content_id"] + ":" + str(idx)),
                        "chunk_idx": idx,
                        "section_path": chunk.section_path,
                        "text": chunk.text,
                        "indexed_text": text,
                        "token_count": max(1, estimate_tokens(text)),
                        "page_start": None,
                        "page_end": None,
                        "regions": [],
                        "lang": detect_lang(chunk.text),
                        "search_text": ""
                        if chunk.reference
                        else tokenize_for_search(text),
                        "embedding": store.vector_literal(vector),
                    }
                )
            await store.replace_content_chunks(
                workspace_id=entry["id"], content_id=doc["content_id"], rows=rows
            )
            await store.upsert_content_summary(
                workspace_id=entry["id"],
                content_id=doc["content_id"],
                fingerprint=doc["hash"],
                descriptor=doc["title"],
                summary=doc["markdown"],
                summary_version=1,
            )
            await store.mark_content_ready(doc["content_id"])
            completed.add(doc["content_id"])
        if number % 500 == 0:
            print("indexed", label, number, "/", len(documents), flush=True)
    with psycopg.connect(cfg.dsn, row_factory=dict_row) as conn:
        conn.execute(
            "UPDATE files SET status='ready',indexed=true WHERE workspace_id=%s",
            (entry["id"],),
        )
        counts = conn.execute(
            "SELECT lang,count(*) AS n FROM rag_chunks WHERE workspace_id=%s GROUP BY lang ORDER BY lang",
            (entry["id"],),
        ).fetchall()
    entry["counts_by_detected_language"] = counts
    entry["ready"] = True
    write_json(state_path, state)
    print("INDEX READY", label, counts, flush=True)


async def main(source):
    guard()
    registry.registry.start()
    state_path = ROOT / "retrieval-workspaces.json"
    state = json.loads(state_path.read_text()) if state_path.exists() else {}
    data = json.loads((ROOT / (source + ".json")).read_text())
    datasets = data["datasets"] if source == "miracl" else data
    with open_cache() as cache:
        for label, dataset in datasets.items():
            await index_dataset(label, dataset, state, cache)
    await store.close_pool()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("source", choices=("miracl", "beir"))
    asyncio.run(main(parser.parse_args().source))
