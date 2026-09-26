"""Shared helpers for the knowledge-library reranker study.

Keys come from the ignored `.env.local` into memory only; they are never
printed, logged or written. Every provider attempt, failures included, is
appended to `data/rerank-eval/requests.jsonl` with model, document count,
usage, latency and status, never text or credentials. Accepted rerank
responses are cached in `data/rerank-eval/cache.sqlite3`, keyed by the exact
request identity (model, endpoint, instruction, query, documents in order), so
a rerun never bills twice.

The frozen 43-book library snapshot and the stored Qwen3-Embedding-4B vectors
come from the qwen3.7 study (`data/qwen37-embedding/`, read only). New query
vectors are embedded here the production way and cached under this study.
"""

from __future__ import annotations

import asyncio
import gzip
import hashlib
import json
import math
import random
import sqlite3
import sys
import time
from collections import defaultdict
from pathlib import Path

import httpx
import numpy as np

REPO = Path(__file__).resolve().parents[4]
DATA = REPO / "data" / "rerank-eval"
FIX = REPO / "bench" / "rag" / "rerank" / "fixtures"
SNAP = REPO / "data" / "qwen37-embedding" / "library"
Q37_SCRIPTS = REPO / "bench" / "rag" / "qwen37" / "scripts"
DATA.mkdir(parents=True, exist_ok=True)

# qwen3.7 helpers: the production query shape for the 4B pin, halfvec rounding
# and the stratified paired bootstrap. Its module reads the same .env.local.
sys.path.insert(0, str(Q37_SCRIPTS))
import common as q37  # noqa: E402


def load_env() -> dict[str, str]:
    env = {}
    for line in (REPO / ".env.local").read_text(encoding="utf-8").splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            key, value = line.split("=", 1)
            env[key.strip()] = value.strip().strip('"').strip("'")
    return env


ENV = load_env()
_SECRETS = [v for k, v in ENV.items() if v and ("KEY" in k or "URL" in k or k in {"OLLAMA", "TOKENHUB"})]


def scrub(text: str) -> str:
    for secret in _SECRETS:
        if len(secret) >= 8:
            text = text.replace(secret, "<redacted>")
    return text


def write_json(path: Path, value) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(value, ensure_ascii=False, indent=1) + "\n", encoding="utf-8", newline="\n")
    tmp.replace(path)


def read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def append_jsonl(path: Path, value) -> None:
    with path.open("a", encoding="utf-8") as out:
        out.write(json.dumps(value, ensure_ascii=False) + "\n")


def read_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    return [json.loads(s) for s in path.read_text(encoding="utf-8").splitlines() if s.strip()]


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def utc() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


# --- frozen snapshot -----------------------------------------------------------


def load_snapshot(verify: bool = True):
    """Chunks (list, snapshot order), excerpts by `content/id`, books."""
    if verify:
        recorded = read_json(SNAP / "snapshot.json")["sha256"]
        for name, digest in recorded.items():
            assert sha256_file(SNAP / name) == digest, f"snapshot file changed: {name}"
    chunks = [json.loads(s) for s in gzip.open(SNAP / "chunks.jsonl.gz", "rt", encoding="utf-8")]
    excerpts = {}
    for s in gzip.open(SNAP / "excerpts.jsonl.gz", "rt", encoding="utf-8"):
        e = json.loads(s)
        excerpts[f"{e['content_id']}/{e['id']}"] = e
    books = read_json(SNAP / "books.json")
    return chunks, excerpts, books


def excerpt_key(chunk: dict) -> str:
    return f"{chunk['content_id']}/{chunk['excerpt_id']}"


# --- rerankers -----------------------------------------------------------------

# Prices checked 2026-09-25: DeepInfra model pages (USD per 1M input tokens);
# Model Studio / Qianwen model pages for Beijing (CNY per 1M input tokens).
RERANKERS = {
    "ali-qwen3-rerank": {"provider": "alibaba", "model": "qwen3-rerank", "endpoint": "compat", "price": 0.5},
    "di-0.6b": {"provider": "deepinfra", "model": "Qwen/Qwen3-Reranker-0.6B", "endpoint": "inference", "price": 0.010},
    "di-4b": {"provider": "deepinfra", "model": "Qwen/Qwen3-Reranker-4B", "endpoint": "inference", "price": 0.025},
    "di-8b": {"provider": "deepinfra", "model": "Qwen/Qwen3-Reranker-8B", "endpoint": "inference", "price": 0.050},
}
# Probed but out of scope: the Beijing workspace answers 403 AccessDenied for it
# (Singapore: 404 Model not exist), see probe.py.
PROBE_ONLY = {
    "ali-qwen3.7-rerank": {"provider": "alibaba", "model": "qwen3.7-text-rerank", "endpoint": "native", "price": 0.5},
}
CURRENCY = {"alibaba": "CNY", "deepinfra": "USD"}
EMBED_PRICE_USD = 0.02  # Qwen3-Embedding-4B on DeepInfra, per 1M tokens
# Availability probes of models outside the study (gte-rerank-v2's last listed
# Beijing price; the probes bill a few dozen tokens).
PROBE_PRICES = {"gte-rerank-v2": 0.8}
# Hard caps from the task; requests stop at 90% of each.
CAPS = {"alibaba": 30.0, "deepinfra": 3.0}

ALIBABA_COMPAT_PATH = "/compatible-api/v1/reranks"
ALIBABA_NATIVE_PATH = "/api/v1/services/rerank/text-rerank/text-rerank"
DEEPINFRA_INFERENCE = "https://api.deepinfra.com/v1/inference/"


def alibaba_host(region: str = "beijing") -> str:
    """Workspace host, derived from the OpenAI-compatible base URL of the region."""
    name, marker = {
        "beijing": ("ALIBABA_BASE_URL", ".cn-beijing.maas.aliyuncs.com"),
        "singapore": ("ALIBABA_SINGAPORE_BASE_URL", ".ap-southeast-1.maas.aliyuncs.com"),
    }[region]
    base = ENV[name].rstrip("/")
    assert base.endswith("/compatible-mode/v1"), f"unexpected {name} shape"
    host = base.removesuffix("/compatible-mode/v1")
    assert marker in host, f"{name} is not a {region} workspace host"
    return host


def instructions() -> dict[str, str]:
    return {k: v["text"] for k, v in read_json(FIX / "instructions.json")["instructions"].items()}


def build_request(spec: dict, query: str, docs: list[str], instruction: str | None):
    provider, model, endpoint = spec["provider"], spec["model"], spec["endpoint"]
    if provider == "deepinfra":
        body = {"queries": [query] * len(docs), "documents": docs}
        if instruction is not None:
            body["instruction"] = instruction
        return DEEPINFRA_INFERENCE + model, {"Authorization": "Bearer " + ENV["DEEPINFRA_API_KEY"]}, body
    region = spec.get("region", "beijing")
    key_name = "ALIBABA_API_KEY" if region == "beijing" else "ALIBABA_SINGAPORE_API_KEY"
    headers = {"Authorization": "Bearer " + ENV[key_name]}
    if endpoint == "compat":
        body = {"model": model, "query": query, "documents": docs, "top_n": len(docs)}
        if instruction is not None:
            body["instruct"] = instruction
        return alibaba_host(region) + ALIBABA_COMPAT_PATH, headers, body
    parameters = {"top_n": len(docs)}
    if instruction is not None:
        parameters["instruct"] = instruction
    body = {"model": model, "input": {"query": query, "documents": docs}, "parameters": parameters}
    return alibaba_host(region) + ALIBABA_NATIVE_PATH, headers, body


def parse_response(spec: dict, data: dict, n: int) -> tuple[list[float], dict, dict]:
    """Scores aligned to the input documents, usage, and response metadata."""
    if spec["provider"] == "deepinfra":
        scores = data["scores"]
        assert isinstance(scores, list) and len(scores) == n, "incomplete DeepInfra scores"
        status = data.get("inference_status") or {}
        usage = {"input_tokens": data.get("input_tokens"), "tokens_input": status.get("tokens_input"), "cost": status.get("cost")}
        meta = {"request_id": data.get("request_id"), "runtime_ms": status.get("runtime_ms")}
    else:
        rows = data["results"] if spec["endpoint"] == "compat" else data["output"]["results"]
        assert isinstance(rows, list) and len(rows) == n, "incomplete Alibaba results"
        assert sorted(r["index"] for r in rows) == list(range(n)), "missing or duplicate indices"
        scores = [0.0] * n
        for r in rows:
            scores[r["index"]] = r["relevance_score"]
        usage = dict(data.get("usage") or {})
        meta = {"request_id": data.get("id") or data.get("request_id"), "model": data.get("model")}
        if spec["endpoint"] == "compat":
            assert data.get("model") == spec["model"], ("unexpected response model", data.get("model"))
    for s in scores:
        assert isinstance(s, (int, float)) and not isinstance(s, bool) and math.isfinite(s), "non-finite score"
    return [float(s) for s in scores], usage, meta


def billed_tokens(provider: str, usage: dict) -> int:
    if provider == "deepinfra":
        return int(usage.get("input_tokens") or usage.get("tokens_input") or 0)
    return int(usage.get("total_tokens") or usage.get("prompt_tokens") or 0)


def list_cost(key: str, usage: dict) -> float:
    spec = RERANKERS[key]
    return billed_tokens(spec["provider"], usage) * spec["price"] / 1e6


# --- logging, spend and cache ----------------------------------------------------

REQUEST_LOG = DATA / "requests.jsonl"


def spend() -> dict[str, dict]:
    """Spend by provider from the request log, at list price (plus DeepInfra's own cost field)."""
    out = defaultdict(lambda: {"requests": 0, "errors": 0, "tokens": 0, "list_cost": 0.0, "provider_cost": 0.0})
    for r in read_jsonl(REQUEST_LOG):
        s = out[r["provider"]]
        s["requests"] += 1
        s["errors"] += "error" in r
        usage = r.get("usage") or {}
        if r.get("kind") == "embed":
            tokens = int(usage.get("prompt_tokens") or usage.get("total_tokens") or 0)
            s["tokens"] += tokens
            s["list_cost"] += tokens * EMBED_PRICE_USD / 1e6
            s["provider_cost"] += float(usage.get("estimated_cost") or 0.0)
            continue
        tokens = billed_tokens(r["provider"], usage)
        spec = RERANKERS.get(r["key"]) or PROBE_ONLY.get(r["key"])
        price = spec["price"] if spec else PROBE_PRICES.get(r["model"], 0.5)
        s["tokens"] += tokens
        s["list_cost"] += tokens * price / 1e6
        s["provider_cost"] += float(usage.get("cost") or 0.0)
    return dict(out)


_spent = {p: s["list_cost"] for p, s in spend().items()}


def guard(provider: str) -> None:
    if _spent.get(provider, 0.0) >= CAPS[provider] * 0.9:
        raise SystemExit(f"spend guard: {provider} at {_spent[provider]:.3f} {CURRENCY[provider]}")


def cache_db() -> sqlite3.Connection:
    conn = sqlite3.connect(DATA / "cache.sqlite3", timeout=60)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute(
        "CREATE TABLE IF NOT EXISTS responses (key TEXT PRIMARY KEY, reranker TEXT NOT NULL, n INT NOT NULL,"
        " scores TEXT NOT NULL, usage TEXT NOT NULL, meta TEXT NOT NULL)"
    )
    return conn


def request_key(key: str, query: str, docs: list[str], instruction: str | None) -> str:
    spec = RERANKERS[key]
    blob = json.dumps([spec["provider"], spec["model"], spec["endpoint"], instruction, query, docs], ensure_ascii=False)
    return hashlib.sha256(blob.encode()).hexdigest()


def cached(conn: sqlite3.Connection, rkey: str):
    row = conn.execute("SELECT scores, usage, meta FROM responses WHERE key = ?", (rkey,)).fetchone()
    return None if row is None else (json.loads(row[0]), json.loads(row[1]), json.loads(row[2]))


class ProviderError(RuntimeError):
    def __init__(self, message: str, status: int | None, retry_after: float | None = None):
        super().__init__(message)
        self.status = status
        self.retry_after = retry_after


def client(timeout: float = 90.0) -> httpx.AsyncClient:
    return httpx.AsyncClient(timeout=httpx.Timeout(timeout, connect=15.0))


async def attempt(http: httpx.AsyncClient, key: str, query: str, docs: list[str], instruction: str | None, *,
                  phase: str, tag: dict | None = None, instruction_id: str | None = None):
    """One provider request, always logged. Returns (scores, usage, meta, latency_ms)."""
    spec = RERANKERS[key]
    guard(spec["provider"])
    url, headers, body = build_request(spec, query, docs, instruction)
    record = {
        "ts": utc(),
        "phase": phase,
        "kind": "rerank",
        "key": key,
        "provider": spec["provider"],
        "model": spec["model"],
        "endpoint": spec["endpoint"],
        "n_docs": len(docs),
        "instruction": instruction_id,
        "chars": len(query) + sum(map(len, docs)),
    } | (tag or {})
    started = time.perf_counter()
    try:
        response = await http.post(url, json=body, headers=headers)
        record["status"] = response.status_code
        if response.status_code != 200:
            retry_after = response.headers.get("retry-after")
            raise ProviderError(
                scrub(f"HTTP {response.status_code}: {response.text[:400]}"),
                response.status_code,
                float(retry_after) if retry_after and retry_after.replace(".", "").isdigit() else None,
            )
        data = response.json()
        scores, usage, meta = parse_response(spec, data, len(docs))
        record["usage"] = usage
        record["request_id"] = meta.get("request_id")
        record["response_model"] = meta.get("model")
        _spent[spec["provider"]] = _spent.get(spec["provider"], 0.0) + list_cost(key, usage)
        latency = (time.perf_counter() - started) * 1000
        return scores, usage, meta, latency
    except ProviderError as exc:
        record["error"] = str(exc)
        raise
    except Exception as exc:  # timeouts, transport, malformed body
        record["error"] = scrub(f"{type(exc).__name__}: {exc}")[:400]
        raise ProviderError(record["error"], record.get("status")) from exc
    finally:
        record["latency_ms"] = round((time.perf_counter() - started) * 1000, 1)
        append_jsonl(REQUEST_LOG, record)


async def rerank(http: httpx.AsyncClient, conn: sqlite3.Connection, key: str, query: str, docs: list[str],
                 instruction_id: str | None, *, phase: str, tag: dict | None = None, use_cache: bool = True):
    """Scores for `docs`, from the cache or the provider.

    Retry policy: Alibaba retries only HTTP 429 (the task allows no other
    automatic retries); DeepInfra retries timeouts, 429 and 5xx up to four
    attempts, since its calls are known to time out now and then.
    """
    instruction = None if instruction_id is None else instructions()[instruction_id]
    rkey = request_key(key, query, docs, instruction)
    if use_cache:
        hit = cached(conn, rkey)
        if hit is not None:
            return hit[0], hit[1], hit[2] | {"cached": True}
    provider = RERANKERS[key]["provider"]
    tries = 8 if provider == "alibaba" else 4
    for n in range(tries):
        try:
            scores, usage, meta, latency = await attempt(http, key, query, docs, instruction, phase=phase, tag=tag,
                                                         instruction_id=instruction_id)
            break
        except ProviderError as exc:
            retryable = exc.status == 429 if provider == "alibaba" else (exc.status in (None, 429) or (exc.status or 0) >= 500)
            if not retryable or n == tries - 1:
                raise
            await asyncio.sleep(exc.retry_after or min(30, 2 ** (n + 1)) + random.random())
    meta = meta | {"latency_ms": latency}
    conn.execute(
        "INSERT OR REPLACE INTO responses VALUES (?,?,?,?,?,?)",
        (rkey, key, len(docs), json.dumps(scores), json.dumps(usage), json.dumps(meta)),
    )
    conn.commit()
    return scores, usage, meta


# --- query vectors (Qwen3-Embedding-4B, production query shape) --------------------

QSPEC = q37.Spec("q4", "query")


def _qcache_own() -> sqlite3.Connection:
    conn = sqlite3.connect(DATA / "query_vectors.sqlite3", timeout=60)
    conn.execute("CREATE TABLE IF NOT EXISTS vectors (key TEXT PRIMARY KEY, dim INT NOT NULL, value BLOB NOT NULL)")
    return conn


def _qcache_q37() -> sqlite3.Connection:
    # Immutable read of the qwen3.7 cache: nothing here writes to it.
    path = (REPO / "data" / "qwen37-embedding" / "vectors.sqlite3").as_posix()
    return sqlite3.connect(f"file:{path}?immutable=1", uri=True)


def query_vectors(texts: list[str]) -> np.ndarray:
    """Stored 4B query vectors for `texts` (qwen3.7 cache first, then this study's)."""
    keys = [QSPEC.cache_key(t) for t in texts]
    found: dict[str, np.ndarray] = {}
    for conn in (_qcache_q37(), _qcache_own()):
        unique = [k for k in dict.fromkeys(keys) if k not in found]
        for i in range(0, len(unique), 900):
            part = unique[i : i + 900]
            q = "SELECT key, value FROM vectors WHERE key IN (%s)" % ",".join("?" * len(part))
            for k, v in conn.execute(q, part):
                found[k] = np.frombuffer(v, dtype=np.float32)
        conn.close()
    missing = [t for t, k in zip(texts, keys) if k not in found]
    if missing:
        raise KeyError(f"{len(missing)} query vectors missing; run first_stage.py embed")
    return np.stack([found[k] for k in keys])


async def embed_missing(texts: list[str], *, phase: str = "embed-queries") -> int:
    """Embed query texts absent from both caches (DeepInfra 4B, exactly the production shape)."""
    try:
        query_vectors(texts)
        return 0
    except KeyError:
        pass
    have = set()
    for conn in (_qcache_q37(), _qcache_own()):
        for k in {QSPEC.cache_key(t) for t in texts}:
            if conn.execute("SELECT 1 FROM vectors WHERE key = ?", (k,)).fetchone():
                have.add(k)
        conn.close()
    todo = list({QSPEC.cache_key(t): t for t in texts if QSPEC.cache_key(t) not in have}.items())
    own = _qcache_own()
    async with client(60.0) as http:
        for i in range(0, len(todo), 64):
            batch = todo[i : i + 64]
            guard("deepinfra")
            url, headers, body = QSPEC.request([QSPEC.text(t) for _, t in batch])
            for n in range(4):
                record = {"ts": utc(), "phase": phase, "kind": "embed", "provider": "deepinfra",
                          "model": QSPEC.model, "count": len(batch)}
                started = time.perf_counter()
                try:
                    response = await http.post(url, json=body, headers=headers)
                    record["status"] = response.status_code
                    if response.status_code != 200:
                        raise ProviderError(scrub(f"HTTP {response.status_code}: {response.text[:300]}"), response.status_code)
                    data = response.json()
                    vectors, usage = q37.parse(QSPEC, data, len(batch))
                    record["usage"] = usage
                    break
                except Exception as exc:
                    record["error"] = scrub(f"{type(exc).__name__}: {exc}")[:300]
                    if n == 3:
                        raise
                    await asyncio.sleep(2 ** (n + 1))
                finally:
                    record["latency_ms"] = round((time.perf_counter() - started) * 1000, 1)
                    append_jsonl(REQUEST_LOG, record)
            own.executemany(
                "INSERT OR REPLACE INTO vectors VALUES (?,?,?)",
                [(k, QSPEC.dim, np.asarray(v, dtype=np.float32).tobytes()) for (k, _), v in zip(batch, vectors)],
            )
            own.commit()
    own.close()
    return len(todo)
