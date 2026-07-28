"""Shared test configuration: VCR replay + ephemeral Docker infrastructure.

Why record-replay
-----------------
The pipeline's real cost is the model traffic: OpenRouter embeddings, DeepSeek
LLM extraction/queries, Gemini VLM captions and the Modal MineRU parse call.
We record those HTTP interactions ONCE into per-test YAML cassettes
(``tests/cassettes/``) and replay them for free forever after. Postgres and
Redis are raw TCP (not HTTP), so cassette tests start fresh containers for
each pytest invocation and tear them down when the session ends.

Two modes (see ``tests/README.md``):
- **replay** (default): ``EVO_TEST_RECORD`` unset. No network to model APIs;
  cassettes must exist. Provider keys can be dummies.
- **record**: ``EVO_TEST_RECORD=once`` (or ``new_episodes``) with real API keys
  + a deployed ``MODAL_PARSE_URL`` exported. Hits the real services and writes
  cassettes.

Both modes need Docker. The cassette fixture builds the custom pgvector+AGE
image, starts a disposable Postgres and Redis container, and points the
pipeline at their dynamically mapped ports.
"""

from __future__ import annotations

import json
import os
import tempfile
import uuid
from pathlib import Path

import pytest

# --------------------------------------------------------------------------
# Environment MUST be set before any ``pipeline.*`` import (pipeline.config
# snapshots os.environ at class-definition time). setdefault so a real
# exported environment (record mode) always wins over these replay defaults.
# Database and Redis URLs are installed by the cassette fixture after Docker
# assigns fresh host ports.
# --------------------------------------------------------------------------
FIXTURES = Path(__file__).parent / "fixtures"
CASSETTES = Path(__file__).parent / "cassettes"

_TEST_WORKING_DIR = tempfile.mkdtemp(prefix="evo_test_rag_")

os.environ.setdefault("WORKING_DIR", _TEST_WORKING_DIR)
os.environ.setdefault("INPUT_DIR", str(Path(_TEST_WORKING_DIR) / "inputs"))

# Deterministic ingest: no PG-cached extraction responses, so every run issues
# the same LLM calls (record-replay depends on this).
os.environ.setdefault("EVO_INGEST_LLM_CACHE", "false")

# Force single-slot concurrency so LLM/embedding calls fire in a stable order
# and embedding batches have reproducible composition — otherwise the recorded
# and replayed request bodies (lists of texts) group differently and never
# match. Tiny test docs, so serial is plenty fast.
os.environ.setdefault("MAX_ASYNC_LLM", "1")
os.environ.setdefault("EMBEDDING_FUNC_MAX_ASYNC", "1")
os.environ.setdefault("MAX_PARALLEL_INSERT", "1")
# Batch every pending vector into a single embedding request so its text-list
# composition is deterministic (the matcher additionally sorts that list).
os.environ.setdefault("EMBEDDING_BATCH_NUM", "1000")

# Request-shaping config is pinned HERE (not read from deploy/.env) so it is
# byte-identical between record and replay. Cassette matching ignores host/port
# (see match_on below) but DOES compare the request PATH and JSON body — so the
# model names and each provider's base-URL *path* must be stable. These values
# are also the real endpoints, so recording reaches the live services.
os.environ["EMBEDDING_DIM"] = os.environ.get("EMBEDDING_DIM", "2560")
os.environ["EVO_MODEL_EMBEDDING"] = "qwen/qwen3-embedding-4b"
os.environ["EVO_MODEL_EXTRACTION"] = "deepseek-v4-flash"
os.environ["EVO_QUERY_MODEL"] = "deepseek-v4-pro"
os.environ["EVO_QUERY_MODEL_ALT"] = "deepseek-v4-flash"
os.environ["EVO_MODEL_IMAGE_CAPTION"] = "gemini-3.1-flash-lite-preview"
os.environ["OPENROUTER_BASE_URL"] = "https://openrouter.ai/api/v1"
os.environ["DEEPSEEK_BASE_URL"] = "https://api.deepseek.com"
os.environ["GEMINI_BASE_URL"] = (
    "https://generativelanguage.googleapis.com/v1beta/openai/"
)
os.environ["EVO_PARSE_METHOD"] = "auto"

# Dummy provider keys for replay (never sent anywhere — VCR intercepts). Real
# keys come from the exported environment in record mode.
for _k in (
    "OPENROUTER_API_KEY",
    "DEEPSEEK_API_KEY",
    "GOOGLE_API_KEY",
    "MODAL_PARSE_TOKEN",
):
    os.environ.setdefault(_k, "test-dummy-key")
# Modal host is ignored by the matcher; only the ``/file_parse`` path matters.
os.environ.setdefault("MODAL_PARSE_URL", "https://modal.test/file_parse")


RECORD_MODE = os.getenv("EVO_TEST_RECORD", "none")


# --------------------------------------------------------------------------
# Ephemeral integration infrastructure
# --------------------------------------------------------------------------
def _configure_test_infrastructure(postgres, redis) -> None:
    """Point imported pipeline modules at the freshly started containers."""
    db_host = postgres.get_container_host_ip()
    db_host = f"[{db_host}]" if ":" in db_host else db_host
    db_port = postgres.get_exposed_port(5432)
    redis_host = redis.get_container_host_ip()
    redis_host = f"[{redis_host}]" if ":" in redis_host else redis_host
    redis_port = redis.get_exposed_port(6379)

    database_url = f"postgres://evo:evo@{db_host}:{db_port}/evo?sslmode=disable"
    redis_url = f"redis://{redis_host}:{redis_port}/0"
    os.environ.update(
        {
            "DATABASE_URL": database_url,
            "REDIS_URL": redis_url,
            "POSTGRES_HOST": db_host.strip("[]"),
            "POSTGRES_PORT": str(db_port),
            "POSTGRES_USER": "evo",
            "POSTGRES_PASSWORD": "evo",
            "POSTGRES_DATABASE": "evo",
        }
    )

    # pipeline.config is imported while pytest collects test modules, before
    # this fixture runs. Update its snapshot as well as the environment that
    # LightRAG reads when each RAG instance is constructed.
    from pipeline.config import cfg

    cfg.dsn = database_url
    cfg.redis_url = redis_url


@pytest.fixture(scope="session")
def _test_infra():
    """Build and run fresh Postgres/Redis containers for cassette tests."""
    from testcontainers.core.container import DockerContainer
    from testcontainers.core.image import DockerImage
    from testcontainers.core.wait_strategies import LogMessageWaitStrategy

    repo_root = Path(__file__).resolve().parents[2]
    postgres_image = DockerImage(
        path=repo_root / "deploy" / "postgres",
        tag=f"evo-pipeline-test-postgres:{uuid.uuid4().hex}",
    )

    with postgres_image as image:
        postgres = DockerContainer(
            str(image),
            command=["postgres", "-c", "shared_preload_libraries=age"],
            env={
                "POSTGRES_USER": "evo",
                "POSTGRES_PASSWORD": "evo",
                "POSTGRES_DB": "evo",
            },
            ports=[5432],
        ).waiting_for(
            LogMessageWaitStrategy(
                "database system is ready to accept connections"
            ).with_startup_timeout(180)
        )
        with postgres:
            redis = DockerContainer("redis:7-alpine", ports=[6379]).waiting_for(
                LogMessageWaitStrategy("Ready to accept connections").with_startup_timeout(
                    60
                )
            )
            with redis:
                _configure_test_infrastructure(postgres, redis)
                yield


def _ensure_tiktoken_encoding() -> None:
    """Download LightRAG's public tokenizer data before VCR is enabled."""
    import tiktoken

    tiktoken.encoding_for_model("gpt-4o-mini")


# --------------------------------------------------------------------------
# VCR
# --------------------------------------------------------------------------
import re as _re

# LightRAG stamps each entity/relation/chunk with its ingest-time ``created_at``
# and renders it into the query context as ``YYYY-MM-DD HH:MM:SS`` (operate.py).
# Those wall-clock strings differ between record and replay (ingest runs fresh
# each time), so the query LLM request body would never match verbatim. Blank
# them on both sides before comparing — they carry no semantic weight for the
# request identity.
_VOLATILE_TIMESTAMP = _re.compile(r"\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}")


def _sort_json_line_runs(text: str) -> str:
    """Sort contiguous runs of newline-delimited JSON-object lines.

    LightRAG renders the retrieved knowledge-graph context as blocks of
    ``{"entity": ...}`` / ``{"relationship": ...}`` records, one per line. Two
    records with equal retrieval score come back from Postgres in an arbitrary
    order, so the query LLM prompt's bytes differ run-to-run even though the
    content is identical. Sorting each maximal run of JSON-object lines makes the
    prompt order-insensitive without touching surrounding prose or chunk text.
    """
    lines = text.split("\n")
    out: list[str] = []
    run: list[str] = []

    def _flush():
        out.extend(sorted(run))
        run.clear()

    for line in lines:
        s = line.strip()
        if s.startswith("{") and s.endswith("}"):
            try:
                json.loads(s)
                run.append(line)
                continue
            except ValueError:
                pass
        _flush()
        out.append(line)
    _flush()
    return "\n".join(out)


def _normalize_body(raw) -> str:
    if isinstance(raw, bytes):
        raw = raw.decode("utf-8", "replace")
    text = raw if isinstance(raw, str) else json.dumps(raw, sort_keys=True)
    try:
        obj = json.loads(text)
    except (TypeError, ValueError):
        return None  # non-JSON (multipart upload / empty)
    # Embedding requests carry a list of texts whose ordering across concurrent
    # batches is not stable; sort it so the request identity is order-insensitive.
    if isinstance(obj, dict) and isinstance(obj.get("input"), list):
        obj["input"] = sorted(str(x) for x in obj["input"])
    # Chat requests embed the retrieved KG context; neutralize its record order.
    if isinstance(obj, dict) and isinstance(obj.get("messages"), list):
        for msg in obj["messages"]:
            if isinstance(msg.get("content"), str):
                msg["content"] = _sort_json_line_runs(msg["content"])
    return _VOLATILE_TIMESTAMP.sub("<TS>", json.dumps(obj, sort_keys=True))


def _json_body_matcher(r1, r2) -> None:
    """Match requests by normalized JSON body.

    LLM/embedding/VLM calls share a host+path (e.g. ``/chat/completions``) and
    are only told apart by their JSON payload (prompt / input texts). We compare
    the payloads with keys sorted and volatile ingest timestamps blanked. The
    Modal parse upload is ``multipart/form-data`` (boundary differs every time)
    so its body isn't JSON — we skip body comparison there and rely on
    method+host+path (there is exactly one Modal endpoint).
    """
    n1, n2 = _normalize_body(r1.body), _normalize_body(r2.body)
    if n1 is None or n2 is None:
        return  # at least one side is non-JSON — disambiguated by path
    assert n1 == n2, "request JSON body mismatch"


@pytest.fixture(scope="session")
def _vcr():
    import vcr

    v = vcr.VCR(
        cassette_library_dir=str(CASSETTES),
        record_mode=RECORD_MODE,
        # Secrets never land in a cassette.
        filter_headers=[
            "authorization",
            "api-key",
            "x-api-key",
            "x-goog-api-key",
            "cookie",
            "set-cookie",
        ],
        filter_query_parameters=["key"],
        decode_compressed_response=True,
    )
    v.register_matcher("evo_json_body", _json_body_matcher)
    # Deliberately NOT matching scheme/host/port: each provider owns a distinct
    # PATH (/api/v1/embeddings, /chat/completions, /v1beta/openai/..., /file_parse)
    # so path + JSON body uniquely identifies every call, and the real provider
    # hostnames never need to be reproduced at replay time.
    v.match_on = ("method", "path", "evo_json_body")
    return v


@pytest.fixture
def cassette(request, _vcr):
    """Open a VCR cassette named after the test function.

    Replay mode fails loudly if the cassette is missing (record it first).
    """
    name = f"{request.node.name}.yaml"
    path = CASSETTES / name
    if RECORD_MODE == "none" and not path.exists():
        pytest.skip(f"cassette {name} not recorded yet — run with EVO_TEST_RECORD=once")
    # Resolve lazily so a missing cassette can skip without requiring Docker.
    request.getfixturevalue("_test_infra")
    # LightRAG initializes its tokenizer inside the cassette context. The
    # public BPE download is not a model call and is intentionally not in the
    # provider cassettes; populate tiktoken's local cache first.
    _ensure_tiktoken_encoding()
    # allow_playback_repeats: concurrent entity extraction can fire an identical
    # prompt more than once; let a single recorded interaction satisfy them all.
    with _vcr.use_cassette(str(path), allow_playback_repeats=True):
        yield


# --------------------------------------------------------------------------
# Live Postgres helpers: unique workspace per test + full purge on teardown.
# A fresh workspace means the LLM prompts (content-based) are identical between
# record and replay while the KG storage starts empty every time.
# --------------------------------------------------------------------------
_LIGHTRAG_TABLES = (
    "lightrag_doc_chunks",
    "lightrag_llm_cache",
    "lightrag_doc_full",
    "lightrag_doc_status",
    "lightrag_full_entities",
    "lightrag_full_relations",
    "lightrag_entity_chunks",
    "lightrag_relation_chunks",
    "lightrag_vdb_entity",
    "lightrag_vdb_relation",
    "lightrag_vdb_chunks",
)


def _purge_workspace(workspace: str) -> None:
    """Delete all LightRAG rows + the AGE graph for one workspace."""
    import psycopg

    dsn = os.environ["DATABASE_URL"]
    graph = f"{workspace}_chunk_entity_relation"
    with psycopg.connect(dsn, autocommit=True) as conn, conn.cursor() as cur:
        for table in _LIGHTRAG_TABLES:
            try:
                cur.execute(
                    f"DELETE FROM {table} WHERE workspace = %s", (workspace,)
                )
            except psycopg.Error:
                conn.rollback()
        try:
            cur.execute(
                "SELECT 1 FROM ag_catalog.ag_graph WHERE name = %s", (graph,)
            )
            if cur.fetchone():
                cur.execute("SELECT ag_catalog.drop_graph(%s, true)", (graph,))
        except psycopg.Error:
            conn.rollback()


@pytest.fixture(autouse=True)
def _serial_graph_phase(monkeypatch):
    """Force LightRAG's entity/relation merge phase to run strictly serially.

    ``merge_nodes_and_edges`` guards that phase with
    ``asyncio.Semaphore(llm_model_max_async * 2)``. With any concurrency >1 the
    graph workers interleave, so the composition/direction of the merged
    relations (and thus the text embedded per relation) varies run-to-run — which
    changes the outbound embedding request bodies and breaks cassette replay.
    Pinning the semaphore to 1 makes ingest fully deterministic for recording and
    replay. Production keeps its real concurrency.
    """
    import asyncio as _asyncio

    import lightrag.operate as _operate

    real_semaphore = _asyncio.Semaphore

    def _serial_semaphore(_value=1):
        return real_semaphore(1)

    monkeypatch.setattr(_operate.asyncio, "Semaphore", _serial_semaphore)


@pytest.fixture
def workspace():
    """A unique, isolated workspace id; its LightRAG data is purged afterwards."""
    ws = f"test_{uuid.uuid4().hex[:12]}"
    yield ws
    _purge_workspace(ws)


@pytest.fixture
def sample_txt() -> str:
    return (FIXTURES / "sample.txt").read_text(encoding="utf-8")


@pytest.fixture
def sample_pdf() -> Path:
    return FIXTURES / "sample.pdf"
