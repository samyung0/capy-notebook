"""Shared test configuration: VCR replay + ephemeral Docker infrastructure.

Why record-replay
-----------------
The pipeline's real cost is model traffic: OpenRouter embeddings and DeepSeek
completions for summaries, concept extraction and answers. Those HTTP
interactions are recorded ONCE into per-test YAML cassettes
(``tests/cassettes/``) and replayed for free afterwards. Postgres and Redis are
raw TCP, not HTTP, so cassette tests start fresh containers per pytest session
and tear them down at the end.

Two modes (see ``tests/README.md``):
- **replay** (default): ``EVO_TEST_RECORD`` unset. No model traffic; cassettes
  must exist. Provider keys can be dummies.
- **record**: ``EVO_TEST_RECORD=once`` with real API keys exported.

Both modes need Docker. The retrieval index is owned by the Go schema now, so
the container is the stock ``pgvector/pgvector:pg16`` image and the fixture
applies every ``server/migrations/*.sql`` file in name order — the same way
the gateway's ``Store.Migrate`` does at boot. Nothing in the pipeline creates
tables.
"""

from __future__ import annotations

import json
import os
import secrets
from pathlib import Path

import pytest

# --------------------------------------------------------------------------
# Environment MUST be set before any ``pipeline.*`` import (pipeline.config
# snapshots os.environ at class-definition time). setdefault so a real exported
# environment (record mode) always wins over these replay defaults. Database and
# Redis URLs are installed by the infra fixture once Docker assigns host ports.
# --------------------------------------------------------------------------
FIXTURES = Path(__file__).parent / "fixtures"
CASSETTES = Path(__file__).parent / "cassettes"
REPO_ROOT = Path(__file__).resolve().parents[2]

# Request-shaping config is pinned HERE (not read from deploy/.env) so it is
# byte-identical between record and replay. Cassette matching ignores host/port
# (see match_on below) but DOES compare the request PATH and JSON body — so the
# model names and each provider's base-URL *path* must be stable. These are also
# the real endpoints, so recording reaches the live services.
# The model ids themselves now come from model_configs rows (seeded by the
# migration), not from env, so only the dimension and the provider base URLs are
# pinned here.
os.environ["EMBEDDING_DIM"] = os.environ.get("EMBEDDING_DIM", "2560")
os.environ["EVO_QUERY_MODEL"] = "deepseek-v4-flash"
os.environ["OPENROUTER_BASE_URL"] = "https://openrouter.ai/api/v1"
os.environ["DEEPSEEK_BASE_URL"] = "https://api.deepseek.com"
os.environ["GEMINI_BASE_URL"] = (
    "https://generativelanguage.googleapis.com/v1beta/openai/"
)
os.environ["EVO_PARSE_METHOD"] = "auto"
# One embedding request per file keeps the batch composition stable, which is
# what the body matcher compares.
os.environ["EVO_EMBEDDING_BATCH"] = "1000"

# Dummy provider keys for replay (never sent anywhere — VCR intercepts). Real
# keys come from the exported environment in record mode.
for _k in ("OPENROUTER_API_KEY", "DEEPSEEK_API_KEY", "GOOGLE_API_KEY"):
    os.environ.setdefault(_k, "test-dummy-key")

# Ryuk (testcontainers' container reaper) races its own port publication on
# Docker Desktop for Windows and fails the session before anything starts. Both
# containers below are context-managed and CI runners are ephemeral, so the
# reaper buys nothing here.
os.environ.setdefault("TESTCONTAINERS_RYUK_DISABLED", "true")

RECORD_MODE = os.getenv("EVO_TEST_RECORD", "none")

# Imported only after the environment above is in place, because pipeline.config
# snapshots os.environ at class-definition time. pytest-asyncio builds a loop
# per test from the active policy, so the choice has to be made at collection
# time; without it every database call on Windows dies as a pool timeout rather
# than an error naming the cause.
from pipeline import use_compatible_event_loop

use_compatible_event_loop()

MIGRATIONS = sorted((REPO_ROOT / "server" / "migrations").glob("*.sql"))


def pytest_runtest_setup(item):
    """Skip cassette tests with no recording, before any fixture runs.

    The check cannot live in the ``cassette`` fixture: ``_test_infra`` is
    session-scoped, so pytest would start Docker before a function-scoped
    fixture ever gets the chance to skip.
    """
    if RECORD_MODE != "none" or item.get_closest_marker("cassette") is None:
        return
    if not (CASSETTES / f"{item.name}.yaml").exists():
        pytest.skip(
            f"cassette {item.name}.yaml not recorded — run EVO_TEST_RECORD=once"
        )


# --------------------------------------------------------------------------
# Ephemeral integration infrastructure
# --------------------------------------------------------------------------
def _configure_test_infrastructure(postgres, redis) -> str:
    """Point the imported pipeline config at the freshly started containers."""
    db_host = postgres.get_container_host_ip()
    db_host = f"[{db_host}]" if ":" in db_host else db_host
    redis_host = redis.get_container_host_ip()
    redis_host = f"[{redis_host}]" if ":" in redis_host else redis_host

    dsn = (
        f"postgres://evo:evo@{db_host}:{postgres.get_exposed_port(5432)}"
        "/evo?sslmode=disable"
    )
    redis_url = f"redis://{redis_host}:{redis.get_exposed_port(6379)}/0"
    os.environ.update({"DATABASE_URL": dsn, "REDIS_URL": redis_url})

    # pipeline.config is imported while pytest collects test modules, before
    # this fixture runs, so its snapshot has to be corrected in place.
    from pipeline.config import cfg

    cfg.dsn = dsn
    cfg.redis_url = redis_url
    return dsn


def _await_postgres(dsn: str, attempts: int = 60) -> None:
    """Poll until the server accepts a real connection.

    The log line the wait strategy matches is printed twice: once by initdb
    while the server is listening on the unix socket only, and again once it is
    actually up on TCP. Matching the first one wins the race often enough to
    look like a flaky test suite.
    """
    import time

    import psycopg

    last: Exception | None = None
    for _ in range(attempts):
        try:
            with psycopg.connect(dsn, connect_timeout=3) as conn:
                conn.execute("SELECT 1")
            return
        except psycopg.Error as exc:
            last = exc
            time.sleep(1)
    raise RuntimeError(f"postgres never became reachable: {last}")


def _apply_migration(dsn: str) -> None:
    """Apply the gateway's baseline schema, which owns the retrieval index."""
    import psycopg

    # No parameters, so psycopg uses the simple query protocol and each file
    # (DO blocks included) goes over as one statement batch — the same way
    # internal/store.Migrate sends it.
    with psycopg.connect(dsn, autocommit=True) as conn:
        for path in MIGRATIONS:
            conn.execute(path.read_text(encoding="utf-8"))


@pytest.fixture(scope="session")
def _test_infra():
    """Fresh Postgres/Redis containers, migrated, for cassette tests."""
    from testcontainers.core.container import DockerContainer
    from testcontainers.core.wait_strategies import LogMessageWaitStrategy

    postgres = DockerContainer(
        "pgvector/pgvector:pg16",
        env={"POSTGRES_USER": "evo", "POSTGRES_PASSWORD": "evo", "POSTGRES_DB": "evo"},
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
            dsn = _configure_test_infrastructure(postgres, redis)
            _await_postgres(dsn)
            _apply_migration(dsn)
            yield dsn


@pytest.fixture(autouse=True)
async def _close_pool():
    """Drop the async pool between tests.

    pytest-asyncio gives each test its own event loop, and a psycopg pool is
    bound to the loop that opened it. Reusing one across tests fails in ways
    that look like unrelated connection errors.
    """
    yield
    from pipeline.retrieval import store

    await store.close_pool()


# --------------------------------------------------------------------------
# VCR
# --------------------------------------------------------------------------
def _normalize_body(raw):
    if isinstance(raw, bytes):
        raw = raw.decode("utf-8", "replace")
    text = raw if isinstance(raw, str) else json.dumps(raw, sort_keys=True)
    try:
        obj = json.loads(text)
    except (TypeError, ValueError):
        return None  # non-JSON (multipart upload / empty)
    return json.dumps(obj, sort_keys=True)


def _json_body_matcher(r1, r2) -> None:
    """Match requests by normalized JSON body.

    Completion and embedding calls share a host+path (``/chat/completions``,
    ``/embeddings``) and are told apart only by their payload — the prompt, or
    the list of texts. Compare those with keys sorted. A non-JSON body (a
    multipart upload) skips the comparison and relies on method+path.
    """
    n1, n2 = _normalize_body(r1.body), _normalize_body(r2.body)
    if n1 is None or n2 is None:
        return
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
    # PATH, so path + JSON body identifies every call and the real provider
    # hostnames never need to be reproduced at replay time.
    v.match_on = ("method", "path", "evo_json_body")
    return v


@pytest.fixture
def cassette(request, _test_infra, _vcr):
    """Open a VCR cassette named after the test function.

    A missing cassette has already skipped the test in ``pytest_runtest_setup``.
    """
    path = CASSETTES / f"{request.node.name}.yaml"
    # allow_playback_repeats: identical prompts can legitimately fire twice
    # (two chunk groups with the same text); let one interaction satisfy both.
    with _vcr.use_cassette(str(path), allow_playback_repeats=True):
        yield


# --------------------------------------------------------------------------
# Live Postgres helpers
#
# A workspace per test, deleted on teardown. Every rag_* row cascades from it,
# so isolation needs no table-by-table cleanup and a leaked row is impossible.
# --------------------------------------------------------------------------
_SEED_USER = "u_1"  # created by the migration's development seed


class Workspace:
    """A throwaway workspace plus helpers to put content in it."""

    def __init__(self, dsn: str, workspace_id: str):
        self.dsn = dsn
        self.id = workspace_id
        self.user_id = _SEED_USER

    def _connect(self):
        import psycopg

        return psycopg.connect(self.dsn, autocommit=True)

    def add_chapter(self, name: str) -> str:
        chapter_id = f"ch_{secrets.token_hex(6)}"
        with self._connect() as conn:
            conn.execute(
                "INSERT INTO chapters (id, workspace_id, name) VALUES (%s, %s, %s)",
                (chapter_id, self.id, name),
            )
        return chapter_id

    def add_file(self, name: str, chapter_id: str | None = None) -> str:
        """Register a source file row. Indexing it is the test's job.

        user_id is omitted on purpose: a trigger derives the storage owner from
        the workspace, and setting it here would test the fixture, not the
        schema.
        """
        file_id = f"f_{secrets.token_hex(6)}"
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO files (id, workspace_id, chapter_id, name, kind,
                                   size_bytes, status, blob_path)
                VALUES (%s, %s, %s, %s, 'txt', 1024, 'ready', %s)
                """,
                (file_id, self.id, chapter_id, name, f"sources/{file_id}"),
            )
        return file_id

    def scalar(self, sql: str, params: tuple = ()):
        with self._connect() as conn:
            row = conn.execute(sql, params).fetchone()
        return row[0] if row else None


@pytest.fixture
def workspace(_test_infra) -> Workspace:
    """A throwaway workspace, with the job pins a worker would be holding.

    The embedding columns are left to their defaults, which the migration keeps
    equal to the seeded embedding row — so the workspace is pinned to a real
    model without the fixture having to resolve a registry.

    Installing pins is not incidental setup: no surface resolves its own default
    any more, so ``index_file`` and ``search`` raise without them. The tests call
    those functions directly instead of going through ``process_ingest_job``, so
    the fixture has to stand in for the part of the worker that reads the
    workspace's embedding pin and snapshots the ingest and vision defaults.
    """
    dsn = _test_infra
    import psycopg

    from pipeline import registry

    workspace_id = f"ws_{secrets.token_hex(6)}"
    with psycopg.connect(dsn, autocommit=True) as conn:
        conn.execute(
            "INSERT INTO workspaces (id, user_id, name, color) VALUES (%s, %s, %s, 'green')",
            (workspace_id, _SEED_USER, "Cassette workspace"),
        )
        row = conn.execute(
            "SELECT embedding_model_key, embedding_model_version FROM workspaces "
            "WHERE id = %s",
            (workspace_id,),
        ).fetchone()

    registry.registry.refresh()
    registry.set_job_pins(
        registry.JobPins(
            ingest=registry.registry.default(registry.SURFACE_INGEST),
            embedding=registry.resolve_pinned(
                row[0], row[1], registry.SURFACE_EMBEDDING
            ),
            vision=registry.registry.default(registry.SURFACE_VISION),
        )
    )
    try:
        yield Workspace(dsn, workspace_id)
    finally:
        registry.set_job_pins(None)
        with psycopg.connect(dsn, autocommit=True) as conn:
            conn.execute("DELETE FROM workspaces WHERE id = %s", (workspace_id,))


@pytest.fixture
def sample_txt() -> str:
    return (FIXTURES / "sample.txt").read_text(encoding="utf-8")


@pytest.fixture
def sample_pdf() -> Path:
    return FIXTURES / "sample.pdf"
