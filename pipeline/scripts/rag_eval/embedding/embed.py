"""Direct provider calls and an experiment-local binary embedding cache."""

from __future__ import annotations

import array
import asyncio
import hashlib
import json
import math
import sqlite3
import time
from pathlib import Path

import httpx

ROOT = Path("/lab/embedding")
CONDITIONS = {
    "qwen4": ("deepinfra", "Qwen/Qwen3-Embedding-4B", 2560, None),
    "qwen8_2560": ("deepinfra", "Qwen/Qwen3-Embedding-8B", 2560, None),
    "qwen8_4000": ("deepinfra", "Qwen/Qwen3-Embedding-8B", 4000, None),
    "pplx4": ("openrouter", "perplexity/pplx-embed-v1-4b", 2560, "perplexity"),
    "voyage4": ("openrouter", "voyageai/voyage-4-large", 2048, "voyageai"),
}
URLS = {
    "deepinfra": "https://api.deepinfra.com/v1/openai/embeddings",
    "openrouter": "https://openrouter.ai/api/v1/embeddings",
}
QWEN_TASK = (
    "Given a question about the user's notes and uploaded materials, "
    "retrieve relevant passages that answer the question"
)


def write_json(path, value):
    path.with_suffix(path.suffix + ".tmp").write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n"
    )
    path.with_suffix(path.suffix + ".tmp").replace(path)


def append(name, value):
    with (ROOT / name).open("a") as out:
        out.write(json.dumps(value, ensure_ascii=False) + "\n")


def payload(condition, texts, role):
    route, model, dim, provider = CONDITIONS[condition]
    assert role in {"query", "document"}
    if condition.startswith("qwen") and role == "query":
        texts = [f"Instruct: {QWEN_TASK}\nQuery:{text}" for text in texts]
    body = {
        "model": model,
        "input": texts,
        "dimensions": dim,
        "encoding_format": "float",
    }
    if provider:
        body["provider"] = {"only": [provider], "allow_fallbacks": False}
    if condition == "voyage4":
        body["input_type"] = role
    return route, body


def validate(data, count, dim):
    rows = sorted(data["data"], key=lambda row: row["index"])
    assert [row["index"] for row in rows] == list(range(count))
    vectors = [row["embedding"] for row in rows]
    for vector in vectors:
        assert isinstance(vector, list) and len(vector) == dim, (
            "Unexpected output shape",
            type(vector).__name__,
            len(vector),
            dim,
        )
        assert all(isinstance(x, (int, float)) and math.isfinite(x) for x in vector)
        assert sum(x * x for x in vector) > 0
    return vectors


async def request(client, condition, texts, role, *, phase):
    route, body = payload(condition, texts, role)
    keys = json.loads(Path("/lab/embedding-secrets.json").read_text())
    started = time.perf_counter()
    record = {
        "condition": condition,
        "role": role,
        "phase": phase,
        "count": len(texts),
        "chars": sum(map(len, texts)),
        "started_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    try:
        response = await client.post(
            URLS[route],
            json=body,
            headers={"Authorization": "Bearer " + keys[route]},
        )
        record["status"] = response.status_code
        if response.status_code != 200:
            raise RuntimeError(f"HTTP {response.status_code}: {response.text[:700]}")
        data = response.json()
        vectors = validate(data, len(texts), CONDITIONS[condition][2])
        record.update(
            {
                "usage": data.get("usage"),
                "response_model": data.get("model"),
                "provider": data.get("provider"),
                "id": data.get("id"),
                "response_bytes": len(response.content),
            }
        )
    except Exception as exc:
        record["error"] = f"{type(exc).__name__}: {exc}"
        raise
    finally:
        record["elapsed_ms"] = (time.perf_counter() - started) * 1000
        append("requests.jsonl", record)
    return vectors, record


def cache_key(condition, role, text):
    # Include the wire payload so instruction/role changes invalidate old entries.
    _, body = payload(condition, [text], role)
    return hashlib.sha256(json.dumps(body, sort_keys=True).encode()).hexdigest()


def cache():
    conn = sqlite3.connect(ROOT / "vectors.sqlite3", timeout=30)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute(
        "CREATE TABLE IF NOT EXISTS vectors (key TEXT PRIMARY KEY, value BLOB NOT NULL)"
    )
    return conn


def unpack(blob):
    result = array.array("f")
    result.frombytes(blob)
    return result.tolist()


async def cached(client, condition, texts, role, *, phase, concurrency=4):
    with cache() as conn:
        keys = [cache_key(condition, role, text) for text in texts]
        missing = {}
        for key, text in zip(keys, texts):
            if (
                conn.execute("SELECT 1 FROM vectors WHERE key=?", (key,)).fetchone()
                is None
            ):
                missing[key] = text
        items = list(missing.items())
        gate = asyncio.Semaphore(concurrency)
        completed = 0

        async def batch(entries):
            nonlocal completed
            async with gate:
                vectors, _ = await request(
                    client, condition, [x[1] for x in entries], role, phase=phase
                )
                conn.executemany(
                    "INSERT INTO vectors VALUES (?,?)",
                    [
                        (key, array.array("f", vector).tobytes())
                        for (key, _), vector in zip(entries, vectors)
                    ],
                )
                conn.commit()
                completed += len(entries)
                if completed % 1024 == 0 or completed == len(items):
                    print(condition, role, completed, "/", len(items), flush=True)

        # Wait for all submitted calls even after a failure, preserving paid successes.
        results = await asyncio.gather(
            *(batch(items[i : i + 64]) for i in range(0, len(items), 64)),
            return_exceptions=True,
        )
        failures = [r for r in results if isinstance(r, BaseException)]
        if failures:
            raise RuntimeError(
                f"{len(failures)} batches failed; successful batches cached; {failures[0]}"
            )
        return [
            unpack(
                conn.execute(
                    "SELECT value FROM vectors WHERE key=?", (key,)
                ).fetchone()[0]
            )
            for key in keys
        ]


def self_check():
    good = {
        "data": [{"index": 1, "embedding": [0, 1]}, {"index": 0, "embedding": [1, 0]}]
    }
    assert validate(good, 2, 2) == [[1, 0], [0, 1]]
    for bad in ([0, 0], [float("nan"), 1], [1]):
        try:
            validate({"data": [{"index": 0, "embedding": bad}]}, 1, 2)
        except AssertionError:
            pass
        else:
            raise AssertionError("invalid vector accepted")
    assert cache_key("qwen4", "query", "x") != cache_key("qwen4", "document", "x")
    assert cache_key("qwen4", "query", "x") != cache_key("qwen8_2560", "query", "x")
    assert cache_key("voyage4", "query", "x") != cache_key("voyage4", "document", "x")


async def preflight():
    ROOT.mkdir(exist_ok=True)
    self_check()
    records = {}
    async with httpx.AsyncClient(timeout=120) as client:
        for condition in CONDITIONS:
            pair = {}
            for role in ("query", "document"):
                vectors, record = await request(
                    client,
                    condition,
                    ["The sun is a star.", "DNA stores genetic information."],
                    role,
                    phase="preflight",
                )
                pair[role] = vectors
                records[condition + ":" + role] = record | {
                    "dimensions": len(vectors[0]),
                    "norms": [math.sqrt(sum(x * x for x in v)) for v in vectors],
                }
                print(condition, role, records[condition + ":" + role], flush=True)
            records[condition + ":role_max_difference"] = max(
                abs(a - b) for a, b in zip(pair["query"][0], pair["document"][0])
            )
            write_json(ROOT / "preflight.json", records)


if __name__ == "__main__":
    asyncio.run(preflight())
