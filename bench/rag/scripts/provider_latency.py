"""Latency and timeout comparison: DeepInfra vs Alibaba, from this machine.

Interleaves the same workloads against each provider so network conditions hit
both equally. Every attempt is one sample: no retries, a 60 s backstop so the
tail beyond production's 15 s interactive bound is visible. httpx trace hooks
split each request into connect / TLS / wait-for-first-byte / body read, and a
bare TCP connect per host each cycle separates the network path from the API.

    .venv/Scripts/python.exe bench/rag/scripts/provider_latency.py run --minutes 30
    .venv/Scripts/python.exe bench/rag/scripts/provider_latency.py burst
    .venv/Scripts/python.exe bench/rag/scripts/provider_latency.py report

Samples land in the ignored data/provider-latency/. Keys are read from
.env.local into memory only; nothing logs text or credentials.
"""

from __future__ import annotations

import asyncio
import gzip
import json
import random
import re
import socket
import statistics
import sys
import time
from collections import defaultdict
from pathlib import Path
from urllib.parse import urlparse

import httpx

REPO = Path(__file__).resolve().parents[3]
OUT = REPO / "data" / "provider-latency"
SAMPLES = OUT / "samples.jsonl"
BACKSTOP_S = 60.0
INTERACTIVE_S = 15.0  # CAPY_INTERACTIVE_PROVIDER_TIMEOUT_S default
INGEST_S = 120.0  # CAPY_INGEST_PROVIDER_TIMEOUT_S default


def _env() -> dict[str, str]:
    env = {}
    for line in (REPO / ".env.local").read_text(encoding="utf-8").splitlines():
        m = re.match(r"\s*([A-Z_]+)\s*=\s*(.*)", line)
        if m:
            env[m[1]] = m[2].strip().strip("\"'")
    return env


ENV = _env()
SG = ENV["ALIBABA_SINGAPORE_BASE_URL"].rstrip("/").removesuffix("/compatible-mode/v1")
BJ = ENV["ALIBABA_BASE_URL"].rstrip("/").removesuffix("/compatible-mode/v1")
DI = "https://api.deepinfra.com"


def _chunks() -> list[str]:
    path = REPO / "data" / "qwen37-embedding" / "library" / "chunks.jsonl.gz"
    with gzip.open(path, "rt", encoding="utf-8") as f:
        return [t for t in (json.loads(line)["indexed_text"] for line in f) if 200 < len(t) < 4000]


def _queries() -> list[str]:
    path = REPO / "bench" / "rag" / "qwen37" / "fixtures" / "library-queries.json"
    return [q["query"] for q in json.loads(path.read_text(encoding="utf-8"))["queries"]]


CHUNKS = _chunks()
QUERIES = _queries()
QWEN3_PREFIX = "Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery:"


# (target, workload) -> builds (url, headers, body). Batch sizes are each
# provider's production-relevant maximum: DeepInfra 64 (CAPY_EMBEDDING_BATCH),
# Alibaba 20 (its per-request limit).
def _di_embed(texts):
    return (
        DI + "/v1/openai/embeddings",
        {"Authorization": "Bearer " + ENV["DEEPINFRA_API_KEY"]},
        {"model": "Qwen/Qwen3-Embedding-4B", "input": texts, "dimensions": 2560, "encoding_format": "float"},
    )


def _sg_embed(texts, role):
    return (
        SG + "/api/v1/services/embeddings/text-embedding/text-embedding",
        {"Authorization": "Bearer " + ENV["ALIBABA_SINGAPORE_API_KEY"]},
        {"model": "qwen3.7-text-embedding", "input": {"texts": texts}, "parameters": {"dimension": 2560, "text_type": role}},
    )


def _di_rerank(query, docs):
    return (
        DI + "/v1/inference/Qwen/Qwen3-Reranker-4B",
        {"Authorization": "Bearer " + ENV["DEEPINFRA_API_KEY"]},
        {"queries": [query] * len(docs), "documents": docs},
    )


def _ali_rerank(host, key, query, docs):
    return (
        host + "/compatible-api/v1/reranks",
        {"Authorization": "Bearer " + ENV[key]},
        {"model": "qwen3-rerank", "query": query, "documents": docs, "top_n": len(docs)},
    )


def build(target: str, workload: str):
    q = random.choice(QUERIES)
    if workload == "embed_query":
        if target == "deepinfra":
            return _di_embed([f"{QWEN3_PREFIX}{q}"]), 1
        return _sg_embed([q], "query"), 1
    if workload == "embed_batch":
        n = 64 if target == "deepinfra" else 20
        docs = random.sample(CHUNKS, n)
        return (_di_embed(docs) if target == "deepinfra" else _sg_embed(docs, "document")), n
    docs = random.sample(CHUNKS, 20)
    if target == "deepinfra":
        return _di_rerank(q, docs), 20
    if target == "alibaba-bj":
        return _ali_rerank(BJ, "ALIBABA_API_KEY", q, docs), 20
    return _ali_rerank(SG, "ALIBABA_SINGAPORE_API_KEY", q, docs), 20


JOBS = [
    ("deepinfra", "embed_query"),
    ("alibaba-sg", "embed_query"),
    ("deepinfra", "embed_batch"),
    ("alibaba-sg", "embed_batch"),
    ("deepinfra", "rerank20"),
    ("alibaba-bj", "rerank20"),
    ("alibaba-sg", "rerank20"),
]
HOSTS = {"deepinfra": DI, "alibaba-sg": SG, "alibaba-bj": BJ}


def _tokens(body: dict) -> int:
    usage = body.get("usage") or {}
    return int(usage.get("total_tokens") or usage.get("prompt_tokens") or usage.get("input_tokens") or 0)


async def attempt(client: httpx.AsyncClient, target: str, workload: str, phase: str) -> dict:
    (url, headers, body), items = build(target, workload)
    marks: dict[str, float] = {}

    async def trace(name: str, info: dict) -> None:
        marks.setdefault(name, time.perf_counter())

    t0 = time.perf_counter()
    rec = {"ts": time.time(), "phase": phase, "target": target, "workload": workload, "items": items}
    try:
        async with asyncio.timeout(BACKSTOP_S):
            resp = await client.post(url, headers=headers, json=body, extensions={"trace": trace})
            data = resp.json() if resp.content else {}
        rec["status"] = resp.status_code
        rec["ok"] = resp.status_code == 200
        rec["tokens"] = _tokens(data) if rec["ok"] else 0
        if not rec["ok"]:
            rec["error"] = f"HTTP {resp.status_code}: {str(data)[:160]}"
    except TimeoutError:
        rec.update(ok=False, status=None, error="backstop>60s")
    except httpx.HTTPError as exc:
        rec.update(ok=False, status=None, error=type(exc).__name__)
    rec["ms"] = round((time.perf_counter() - t0) * 1000)

    def span(a: str, b: str) -> int | None:
        return round((marks[b] - marks[a]) * 1000) if a in marks and b in marks else None

    rec["connect_ms"] = span("connection.connect_tcp.started", "connection.connect_tcp.complete")
    rec["tls_ms"] = span("connection.start_tls.started", "connection.start_tls.complete")
    rec["wait_ms"] = span("http11.send_request_body.complete", "http11.receive_response_headers.complete")
    rec["body_ms"] = span("http11.receive_response_body.started", "http11.receive_response_body.complete")
    rec["new_conn"] = "connection.connect_tcp.started" in marks
    return rec


def tcp_probe(target: str) -> dict:
    host = urlparse(HOSTS[target]).hostname
    t0 = time.perf_counter()
    try:
        ip = socket.gethostbyname(host)
        dns = time.perf_counter()
        with socket.create_connection((ip, 443), timeout=10):
            pass
        return {"ts": time.time(), "phase": "tcp", "target": target, "ok": True, "ip": ip,
                "dns_ms": round((dns - t0) * 1000), "ms": round((time.perf_counter() - dns) * 1000)}
    except OSError as exc:
        return {"ts": time.time(), "phase": "tcp", "target": target, "ok": False, "error": type(exc).__name__,
                "ms": round((time.perf_counter() - t0) * 1000)}


def _client() -> httpx.AsyncClient:
    # Production shape: one long-lived pooled client, httpx timeouts off so the
    # asyncio backstop decides (pipeline/pipeline/elitellm/client.py).
    return httpx.AsyncClient(timeout=httpx.Timeout(None), limits=httpx.Limits(max_keepalive_connections=32))


def write(rec: dict) -> None:
    with SAMPLES.open("a", encoding="utf-8") as f:
        f.write(json.dumps(rec) + "\n")


async def run(minutes: float) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    clients = {t: _client() for t in HOSTS}
    end = time.time() + minutes * 60
    cycle = 0
    while time.time() < end:
        cycle += 1
        for t in HOSTS:
            write(await asyncio.to_thread(tcp_probe, t))
        jobs = JOBS[:]
        random.shuffle(jobs)
        for target, workload in jobs:
            rec = await attempt(clients[target], target, workload, "sequential")
            rec["cycle"] = cycle
            write(rec)
            if not rec["ok"]:
                print(f"cycle {cycle} {target} {workload}: {rec.get('error')} after {rec['ms']} ms", flush=True)
        if cycle % 10 == 0:
            print(f"cycle {cycle} done", flush=True)
        await asyncio.sleep(3)
    for c in clients.values():
        await c.aclose()


async def burst(concurrency: int = 8, rounds: int = 4) -> None:
    """Concurrent embed batches and reranks, like a local ingest or eval fan-out."""
    OUT.mkdir(parents=True, exist_ok=True)
    for target, workload in [j for j in JOBS if j[1] != "embed_query"]:
        async with _client() as client:
            for r in range(rounds):
                recs = await asyncio.gather(
                    *(attempt(client, target, workload, f"burst{concurrency}") for _ in range(concurrency))
                )
                for rec in recs:
                    write(rec)
                bad = [x for x in recs if not x["ok"]]
                print(f"{target} {workload} round {r + 1}: {len(bad)}/{concurrency} failed", flush=True)
                await asyncio.sleep(5)


def pct(xs: list[int], p: float) -> int:
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(round(p / 100 * (len(xs) - 1))))]


def report() -> None:
    rows = [json.loads(line) for line in SAMPLES.read_text(encoding="utf-8").splitlines()]
    groups: dict[tuple, list[dict]] = defaultdict(list)
    for r in rows:
        groups[(r["phase"], r["target"], r.get("workload", "tcp"))].append(r)
    print("| phase | target | workload | n | fail | p50 | p90 | p95 | p99 | max | >15s | errors |")
    print("|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|")
    for (phase, target, workload), rs in sorted(groups.items()):
        ok = [r["ms"] for r in rs if r["ok"]]
        errs = defaultdict(int)
        for r in rs:
            if not r["ok"]:
                errs[(r.get("error") or "?")[:40]] += 1
        slow = sum(1 for r in rs if r["ms"] > INTERACTIVE_S * 1000 or not r["ok"])
        if not ok:
            print(f"| {phase} | {target} | {workload} | {len(rs)} | {len(rs)} | - | - | - | - | - | {slow} | {dict(errs)} |")
            continue
        print(
            f"| {phase} | {target} | {workload} | {len(rs)} | {len(rs) - len(ok)} | {pct(ok, 50)} | {pct(ok, 90)} | "
            f"{pct(ok, 95)} | {pct(ok, 99)} | {max(ok)} | {slow} | {dict(errs) or ''} |"
        )
    # Where the time went on the slowest decile of successful API calls.
    print("\nSlowest 10% of successful calls: median ms per stage")
    for (phase, target, workload), rs in sorted(groups.items()):
        ok = sorted((r for r in rs if r["ok"] and phase != "tcp"), key=lambda r: r["ms"])
        tail = ok[int(len(ok) * 0.9):]
        if len(tail) < 2:
            continue
        med = lambda k: statistics.median([r[k] for r in tail if r.get(k) is not None] or [0])  # noqa: E731
        print(f"  {phase} {target} {workload}: total {med('ms'):.0f}, wait {med('wait_ms'):.0f}, body {med('body_ms'):.0f}, "
              f"new-conn {sum(r['new_conn'] for r in tail)}/{len(tail)}")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "report"
    if cmd == "run":
        minutes = float(sys.argv[sys.argv.index("--minutes") + 1]) if "--minutes" in sys.argv else 30
        asyncio.run(run(minutes))
    elif cmd == "burst":
        asyncio.run(burst())
    else:
        report()
