"""Shared helpers for the qwen3.7-text-embedding comparison.

Keys are read from the ignored `.env.local` into memory only. Every provider
attempt (including failures and retries) is appended to
`data/qwen37-embedding/requests.jsonl` with model, counts, usage and latency,
never input text or credentials. Accepted vectors are cached in
`data/qwen37-embedding/vectors.sqlite3`, keyed by the exact wire identity, so a
rerun never bills twice.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import math
import random
import sqlite3
import time
from collections import defaultdict
from pathlib import Path

import httpx
import numpy as np

REPO = Path(__file__).resolve().parents[4]
DATA = REPO / "data" / "qwen37-embedding"
FIXTURES = REPO / "bench" / "rag" / "qwen37" / "fixtures"
DATA.mkdir(parents=True, exist_ok=True)

# Production query shaping for the Qwen3-Embedding pin, imported rather than
# copied so the baseline arm cannot drift from pipeline/prompts/retrieval.py.
from pipeline.prompts.retrieval import QWEN3_QUERY_TASK, qwen3_query  # noqa: E402

DEEPINFRA_URL = "https://api.deepinfra.com/v1/openai/embeddings"
ALIBABA_NATIVE_PATH = "/api/v1/services/embeddings/text-embedding/text-embedding"

# USD per million input tokens, checked 2026-09-25 on the DeepInfra model page
# and the Model Studio embedding page (Singapore).
PRICE_PER_M = {"deepinfra": 0.02, "alibaba": 0.07}
# Hard spend caps for this study; requests stop at 90% of each.
CAPS = {"deepinfra": 3.0, "alibaba": 5.0}

# Arms. `q4` is production: documents raw, queries with the Qwen3 instruct
# prefix. `q37` uses Alibaba's native endpoint, the only one that accepts
# text_type/instruct (the OpenAI-compatible route embeds every input as
# text_type=query, measured in probe.py).
MODELS = {
    "q4": ("deepinfra", "Qwen/Qwen3-Embedding-4B"),
    "q37": ("alibaba", "qwen3.7-text-embedding"),
}
DIM = 2560


def load_env() -> dict[str, str]:
    env = {}
    for line in (REPO / ".env.local").read_text(encoding="utf-8").splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            key, value = line.split("=", 1)
            env[key.strip()] = value.strip().strip('"').strip("'")
    return env


ENV = load_env()
_SECRETS = [
    v
    for k, v in ENV.items()
    if v and ("KEY" in k or "URL" in k or k in {"OLLAMA", "TOKENHUB"})
]


def scrub(text: str) -> str:
    for secret in _SECRETS:
        if len(secret) >= 8:
            text = text.replace(secret, "<redacted>")
    return text


def alibaba_host() -> str:
    base = ENV["ALIBABA_SINGAPORE_BASE_URL"].rstrip("/")
    assert base.endswith("/compatible-mode/v1"), "unexpected Singapore base URL shape"
    return base.removesuffix("/compatible-mode/v1")


def write_json(path: Path, value) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)


def append_jsonl(path: Path, value) -> None:
    with path.open("a", encoding="utf-8") as out:
        out.write(json.dumps(value, ensure_ascii=False) + "\n")


def read_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    return [json.loads(s) for s in path.read_text(encoding="utf-8").splitlines() if s.strip()]


# --- wire shapes -----------------------------------------------------------


class Spec:
    """One embedding request shape: model, endpoint, role handling, width."""

    def __init__(
        self,
        arm: str,
        role: str,
        *,
        endpoint: str = "native",
        instruct: str | None = None,
        dim: int = DIM,
    ):
        assert arm in MODELS and role in {"query", "document"}
        self.arm, self.role, self.dim = arm, role, dim
        self.provider, self.model = MODELS[arm]
        self.endpoint = "openai" if arm == "q4" else endpoint
        assert self.endpoint in {"openai", "native", "compat"}
        if instruct is not None:
            assert arm == "q37" and role == "query" and self.endpoint == "native"
        self.instruct = instruct

    @property
    def variant(self) -> str:
        if self.arm == "q4":
            return "prod-prefix" if self.role == "query" else "raw"
        if self.endpoint == "compat":
            return "compat"
        if self.role == "document":
            return "text_type=document"
        return "text_type=query" + ("+instruct" if self.instruct else "")

    def text(self, raw: str) -> str:
        # Only the q4 query side is reshaped, exactly like models.format_query.
        return qwen3_query(raw) if self.arm == "q4" and self.role == "query" else raw

    def identity(self) -> list:
        return [self.provider, self.model, self.endpoint, self.dim, self.variant, self.instruct]

    def cache_key(self, raw: str) -> str:
        blob = json.dumps(self.identity() + [self.text(raw)], ensure_ascii=False)
        return hashlib.sha256(blob.encode()).hexdigest()

    def batch_limit(self) -> int:
        # DeepInfra: production's CAPY_EMBEDDING_BATCH. Alibaba: documented 20.
        return 64 if self.provider == "deepinfra" else 20

    def request(self, texts: list[str]) -> tuple[str, dict, dict]:
        if self.provider == "deepinfra":
            body = {
                "model": self.model,
                "input": texts,
                "dimensions": self.dim,
                "encoding_format": "float",
            }
            return DEEPINFRA_URL, {"Authorization": "Bearer " + ENV["DEEPINFRA_API_KEY"]}, body
        headers = {"Authorization": "Bearer " + ENV["ALIBABA_SINGAPORE_API_KEY"]}
        if self.endpoint == "compat":
            body = {
                "model": self.model,
                "input": texts,
                "dimensions": self.dim,
                "encoding_format": "float",
            }
            return ENV["ALIBABA_SINGAPORE_BASE_URL"].rstrip("/") + "/embeddings", headers, body
        parameters = {"dimension": self.dim, "text_type": self.role}
        if self.instruct:
            parameters["instruct"] = self.instruct
        body = {"model": self.model, "input": {"texts": texts}, "parameters": parameters}
        return alibaba_host() + ALIBABA_NATIVE_PATH, headers, body


def parse(spec: Spec, data: dict, count: int) -> tuple[list[list[float]], dict]:
    if spec.endpoint == "native":
        rows = sorted(data["output"]["embeddings"], key=lambda r: r["text_index"])
        assert [r["text_index"] for r in rows] == list(range(count))
    else:
        rows = sorted(data["data"], key=lambda r: r["index"])
        assert [r["index"] for r in rows] == list(range(count))
    vectors = [r["embedding"] for r in rows]
    for v in vectors:
        assert len(v) == spec.dim, ("dimension mismatch", len(v), spec.dim)
        assert all(math.isfinite(x) for x in v) and any(v)
    return vectors, data.get("usage") or {}


def billed_tokens(usage: dict) -> int:
    return int(usage.get("prompt_tokens") or usage.get("total_tokens") or 0)


# --- spend and logging -----------------------------------------------------

REQUEST_LOG = DATA / "requests.jsonl"


def spend() -> dict[str, dict]:
    out = defaultdict(lambda: {"requests": 0, "errors": 0, "tokens": 0, "usd": 0.0})
    for r in read_jsonl(REQUEST_LOG):
        s = out[r["provider"]]
        s["requests"] += 1
        s["errors"] += "error" in r
        tokens = billed_tokens(r.get("usage") or {})
        s["tokens"] += tokens
        s["usd"] += tokens * PRICE_PER_M[r["provider"]] / 1e6
    return dict(out)


_spent = {p: s["usd"] for p, s in spend().items()}


class ProviderError(RuntimeError):
    def __init__(self, message: str, status: int | None, retry_after: float | None = None):
        super().__init__(message)
        self.status = status
        self.retry_after = retry_after


async def call(
    client: httpx.AsyncClient, spec: Spec, raw_texts: list[str], *, phase: str
) -> tuple[list[list[float]], dict]:
    """One attempt, always logged. Raises ProviderError on any failure."""
    if _spent.get(spec.provider, 0.0) >= CAPS[spec.provider] * 0.9:
        raise SystemExit(f"spend guard: {spec.provider} at ${_spent[spec.provider]:.3f}")
    texts = [spec.text(t) for t in raw_texts]
    url, headers, body = spec.request(texts)
    record = {
        "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "phase": phase,
        "arm": spec.arm,
        "provider": spec.provider,
        "model": spec.model,
        "endpoint": spec.endpoint,
        "variant": spec.variant,
        "dim": spec.dim,
        "count": len(texts),
        "chars": sum(map(len, texts)),
    }
    started = time.perf_counter()
    try:
        response = await client.post(url, json=body, headers=headers)
        record["status"] = response.status_code
        record["request_id"] = response.headers.get("x-request-id") or response.headers.get(
            "x-dashscope-request-id"
        )
        if response.status_code != 200:
            retry_after = response.headers.get("retry-after")
            raise ProviderError(
                scrub(f"HTTP {response.status_code}: {response.text[:500]}"),
                response.status_code,
                float(retry_after) if retry_after and retry_after.replace(".", "").isdigit() else None,
            )
        data = response.json()
        vectors, usage = parse(spec, data, len(texts))
        record["usage"] = usage
        record["response_bytes"] = len(response.content)
        _spent[spec.provider] = _spent.get(spec.provider, 0.0) + billed_tokens(usage) * PRICE_PER_M[
            spec.provider
        ] / 1e6
        return vectors, usage
    except ProviderError as exc:
        record["error"] = str(exc)
        raise
    except Exception as exc:  # timeouts, transport, malformed body
        record["error"] = scrub(f"{type(exc).__name__}: {exc}")[:500]
        raise ProviderError(record["error"], record.get("status")) from exc
    finally:
        record["latency_ms"] = round((time.perf_counter() - started) * 1000, 1)
        append_jsonl(REQUEST_LOG, record)


def client(timeout: float = 60.0) -> httpx.AsyncClient:
    return httpx.AsyncClient(timeout=httpx.Timeout(timeout, connect=15.0))


# --- cache -------------------------------------------------------------------


def cache_db() -> sqlite3.Connection:
    conn = sqlite3.connect(DATA / "vectors.sqlite3", timeout=60)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute(
        "CREATE TABLE IF NOT EXISTS vectors (key TEXT PRIMARY KEY, dim INT NOT NULL, value BLOB NOT NULL)"
    )
    return conn


def cached_keys(conn: sqlite3.Connection, keys: list[str]) -> set[str]:
    found = set()
    for i in range(0, len(keys), 900):
        part = keys[i : i + 900]
        q = "SELECT key FROM vectors WHERE key IN (%s)" % ",".join("?" * len(part))
        found.update(k for (k,) in conn.execute(q, part))
    return found


def load_vectors(conn: sqlite3.Connection, spec: Spec, raw_texts: list[str]) -> np.ndarray:
    keys = [spec.cache_key(t) for t in raw_texts]
    out = np.empty((len(keys), spec.dim), dtype=np.float32)
    lookup = {}
    unique = list(dict.fromkeys(keys))
    for i in range(0, len(unique), 900):
        part = unique[i : i + 900]
        q = "SELECT key, value FROM vectors WHERE key IN (%s)" % ",".join("?" * len(part))
        for k, v in conn.execute(q, part):
            lookup[k] = np.frombuffer(v, dtype=np.float32)
    for i, k in enumerate(keys):
        out[i] = lookup[k]
    return out


class TokenPacer:
    """Keep estimated tokens sent in any 60 s window under a budget.

    Alibaba enforces an account-wide TPM (1,000,000 for qwen3.7-text-embedding
    in Singapore) and answers 429 Throttling.AllocationQuota beyond it.
    """

    def __init__(self, tpm: int):
        self.tpm, self.sent, self.lock = tpm, [], asyncio.Lock()

    async def wait(self, tokens: int) -> list:
        async with self.lock:
            while True:
                now = time.monotonic()
                self.sent = [e for e in self.sent if now - e[0] < 60]
                if sum(e[1] for e in self.sent) + tokens <= self.tpm:
                    entry = [now, tokens]
                    self.sent.append(entry)
                    return entry
                await asyncio.sleep(0.5)

    @staticmethod
    def settle(entry: list, actual: int):
        entry[1] = actual  # replace the estimate with billed tokens


def estimate_tokens(texts: list[str]) -> int:
    # ~3 chars per token plus the ~17-token template qwen3.7 adds per input.
    return int(sum(len(t) / 3.0 + 17 for t in texts))


async def embed_cached(
    spec: Spec,
    raw_texts: list[str],
    *,
    phase: str,
    concurrency: int = 4,
    attempts: int = 5,
    tpm: int | None = None,
) -> np.ndarray:
    """Embed missing texts in batches, retrying transient failures, then load all."""
    if tpm is None and spec.provider == "alibaba":
        tpm = 900_000
    pacer = TokenPacer(tpm) if tpm else None
    conn = cache_db()
    keys = [spec.cache_key(t) for t in raw_texts]
    have = cached_keys(conn, keys)
    missing = list({k: t for k, t in zip(keys, raw_texts) if k not in have}.items())
    limit = spec.batch_limit()
    batches = [missing[i : i + limit] for i in range(0, len(missing), limit)]
    gate = asyncio.Semaphore(concurrency)
    done = 0

    async def run(batch):
        nonlocal done
        async with gate:
            for attempt in range(attempts):
                entry = await pacer.wait(estimate_tokens([spec.text(t) for _, t in batch])) if pacer else None
                try:
                    vectors, usage = await call(http, spec, [t for _, t in batch], phase=phase)
                    if entry:
                        pacer.settle(entry, billed_tokens(usage))
                    break
                except ProviderError as exc:
                    if attempt == attempts - 1 or (exc.status in {400, 401, 403, 404}):
                        raise
                    wait = exc.retry_after or min(60, 2 ** (attempt + 1)) + random.random()
                    await asyncio.sleep(wait)
            conn.executemany(
                "INSERT OR REPLACE INTO vectors VALUES (?,?,?)",
                [
                    (k, spec.dim, np.asarray(v, dtype=np.float32).tobytes())
                    for (k, _), v in zip(batch, vectors)
                ],
            )
            conn.commit()
            done += len(batch)
            if done % (limit * 25) < limit or done == len(missing):
                print(f"  {spec.arm}/{spec.variant} {done}/{len(missing)}", flush=True)

    if batches:
        async with client() as http:
            results = await asyncio.gather(*(run(b) for b in batches), return_exceptions=True)
        failures = [r for r in results if isinstance(r, BaseException)]
        if failures:
            raise RuntimeError(f"{len(failures)} batches failed (successes cached): {failures[0]}")
    vectors = load_vectors(conn, spec, raw_texts)
    conn.close()
    return vectors


# --- live library (read-only) --------------------------------------------------


def library_conn():
    """The shared live library, forced read-only at the session level."""
    import psycopg

    conn = psycopg.connect(
        ENV["LIBRARY_DATABASE_URL"],
        options="-c default_transaction_read_only=on -c statement_timeout=600000",
    )
    assert conn.execute("SHOW default_transaction_read_only").fetchone()[0] == "on"
    conn.rollback()  # end the implicit transaction so callers can pick isolation
    return conn


# Eligibility of plain (no topic/role) production library search:
# library._VERIFIED at the default CAPY_LIBRARY_TAG_MIN_CONFIDENCE of 0.8, on
# searchable chunks of each book's current content.
ELIGIBLE_SQL = """
    FROM library_chunks c
    JOIN rag_file_contents fc ON fc.content_id = c.content_id AND fc.workspace_id = 'library'
    JOIN library_excerpts e ON e.content_id = c.content_id AND e.id = c.excerpt_id
    WHERE c.searchable AND e.tag_status = 'tagged' AND e.evidence_verified
      AND e.confidence >= 0.8 AND NOT ('non_teaching' = ANY(e.roles))
"""


def parse_halfvec(text: str) -> np.ndarray:
    return np.array(text.strip("[]").split(","), dtype=np.float32)


# --- math ----------------------------------------------------------------------


def as_stored(matrix: np.ndarray, dim: int | None = None) -> np.ndarray:
    """Production stores halfvec: round to float16, optionally Matryoshka-truncate,
    then L2-normalize so a dot product is the cosine pgvector ranks by."""
    m = np.asarray(matrix, dtype=np.float16).astype(np.float32)
    if dim is not None:
        m = m[:, :dim]
    norms = np.linalg.norm(m, axis=1, keepdims=True)
    return m / np.where(norms == 0, 1, norms)


def paired_bootstrap(deltas: dict[str, float], cohort_of: dict[str, str], *, seed: int, n: int = 2000):
    """Cohort-stratified paired bootstrap of the mean change (Sept 6 method)."""
    groups = defaultdict(list)
    for key, value in deltas.items():
        groups[cohort_of[key]].append(value)
    rng = random.Random(seed)
    means = sorted(
        sum(rng.choice(vals) for vals in groups.values() for _ in vals) / len(deltas)
        for _ in range(n)
    )
    lo, hi = int(0.025 * n) - 1, int(0.975 * n) - 1
    return sum(deltas.values()) / len(deltas), [means[lo], means[hi]]
