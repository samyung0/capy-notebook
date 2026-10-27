"""Standalone files (no workspace, todo-standalone-files.md): their jobs run as
the owner, their progress goes to the owner's notification channel, a first
index takes the embedding space Go put on the payload and a re-ingest keeps
the one its content holds, and their index work is scoped to the owner."""

from __future__ import annotations

import json
import secrets

import psycopg
import pytest

from pipeline import progress
from pipeline.ingest import plan as ingest_plan
from pipeline.ingest import worker
from pipeline.store import db

_PIN = {
    "embedding_provider_slug": "deepinfra",
    "embedding_model_slug": "Qwen/Qwen3-Embedding-4B",
    "embedding_model_version": 1,
    "embedding_dim": 2560,
}


def _standalone_payload(**overrides):
    payload = {
        "fileId": "f_1",
        "blobPath": "sources/blob_1.txt",
        "kind": "txt",
        "actorUserId": "u_owner",
        "reservationId": "cr_1",
        "ingestProviderSlug": "deepseek",
        "ingestModelSlug": "deepseek-chat",
        "ingestModelVersion": 1,
        "captioningProviderSlug": "openai",
        "captioningModelSlug": "gpt-vision",
        "captioningModelVersion": 1,
        "embeddingProviderSlug": _PIN["embedding_provider_slug"],
        "embeddingModelSlug": _PIN["embedding_model_slug"],
        "embeddingModelVersion": _PIN["embedding_model_version"],
        "embeddingDim": _PIN["embedding_dim"],
        "sourceRevision": 1,
        "sourceETag": "etag-a",
    }
    payload.update(overrides)
    return payload


def test_progress_goes_to_the_owners_notification_channel(monkeypatch):
    published: list[tuple[str, dict]] = []

    class Redis:
        def publish(self, channel, message):
            published.append((channel, json.loads(message)))

    monkeypatch.setattr(progress, "_redis", Redis)

    progress.publish(db.Scope(None, "u_owner"), "f_1", "indexing", 55)
    progress.publish(db.Scope("ws_1"), "f_2", "done", 100, status="ready", indexed=True)

    assert published == [
        (
            "notif:u_owner",
            {
                "fileId": "f_1",
                "type": "ingest",
                "stage": "indexing",
                "pct": 55,
                "status": "processing",
                "message": "",
            },
        ),
        (
            "ingest:ws_1",
            {
                "fileId": "f_2",
                "workspaceId": "ws_1",
                "stage": "done",
                "pct": 100,
                "status": "ready",
                "message": "",
                "indexed": True,
            },
        ),
    ]


def test_a_standalone_job_carries_an_embedding_pin_instead_of_a_workspace():
    worker._require_ingest_payload(_standalone_payload())

    with pytest.raises(worker.TerminalError, match="embeddingDim"):
        worker._require_ingest_payload(_standalone_payload(embeddingDim=None))


async def test_a_first_index_takes_the_payloads_embedding_space(monkeypatch):
    monkeypatch.setattr(worker, "_recorded_embedding_pin", lambda _file_id: None)

    assert await worker._standalone_pin("f_1", _standalone_payload()) == _PIN


async def test_a_reingest_keeps_the_space_its_content_was_indexed_in(monkeypatch):
    recorded = {**_PIN, "embedding_dim": 2560}
    monkeypatch.setattr(worker, "_recorded_embedding_pin", lambda _file_id: recorded)
    moved_default = _standalone_payload(embeddingModelVersion=7)

    assert await worker._standalone_pin("f_1", moved_default) is recorded


async def test_a_standalone_ingest_works_in_its_owners_scope(monkeypatch):
    """Donor lookup, content claim and the index write all name the owner and
    no workspace; the index is written in the job's resolved space."""
    calls: dict[str, dict] = {}

    class Indexed(RuntimeError):
        pass

    async def find_ready_donor(**values):
        calls["donor"] = values

    async def attach_file_content(**values):
        calls["attach"] = values
        return {"content_id": "rgc_1", "ready": False, "created": True}

    async def index_file(**values):
        calls["index"] = values
        raise Indexed

    async def abandon_content(_content_id):
        return None

    async def chunks_for(**values):
        calls["chunks"] = values
        return worker.chunk_markdown("# Notes\n\nPhotosynthesis."), [], None

    monkeypatch.setattr(worker, "_file_exists", lambda *_a: True)
    monkeypatch.setattr(worker, "_read_name", lambda *_a: "notes.txt")
    monkeypatch.setattr(worker, "_require_current_source", lambda *_a: None)
    monkeypatch.setattr(worker, "_account_allows_ingest", lambda *_a: True)
    monkeypatch.setattr(worker, "_record_source_sha", lambda *_a: None)
    monkeypatch.setattr(
        worker,
        "_acquire_local_source",
        lambda *_a: ("/shared/sources/s", "sources/s", "aa" * 32, lambda: None),
    )
    monkeypatch.setattr(worker, "_chunks_for", chunks_for)
    monkeypatch.setattr(worker.store, "find_ready_donor", find_ready_donor)
    monkeypatch.setattr(worker.store, "attach_file_content", attach_file_content)
    monkeypatch.setattr(worker.store, "abandon_content", abandon_content)
    monkeypatch.setattr(worker.indexing, "index_file", index_file)
    monkeypatch.setattr(worker.progress, "publish", lambda *_a, **_k: None)
    scope = db.Scope(None, "u_owner", _PIN)

    with pytest.raises(Indexed):
        await worker._process_ingest_job(
            {"id": "job_1", "type": "ingest", "attempts": 1},
            _standalone_payload(),
            "f_1",
            scope,
            "txt",
            ingest_plan.ProcessingPlan(
                version=2,
                format="txt",
                route=ingest_plan.RAW_TEXT,
                parser_route="",
                caption_mode="none",
                office=False,
                stages=(),
                resources=(),
            ),
        )

    assert calls["donor"]["workspace_id"] is None
    assert calls["donor"]["owner_user_id"] == "u_owner"
    assert calls["donor"]["embedding_model_slug"] == _PIN["embedding_model_slug"]
    assert calls["chunks"]["scope"] == scope
    assert calls["attach"]["workspace_id"] is None
    assert calls["attach"]["owner_user_id"] == "u_owner"
    assert calls["index"]["workspace_id"] is None
    assert calls["index"]["pin"] == _PIN


class _FenceCursor:
    """The rows the source fence reads for a standalone file owned by
    ``u_owner``; ``accounts`` are the locked account rows."""

    def __init__(self, accounts):
        self.accounts = accounts
        self.statements: list[str] = []
        self.result = None

    def execute(self, query, _params=()):
        statement = " ".join(query.split())
        self.statements.append(statement)
        if statement.startswith("SELECT user_id FROM files"):
            self.result = ("u_owner",)
        elif "FROM users" in statement:
            self.result = self.accounts
        elif "FROM files WHERE id=" in statement:
            self.result = (None, "u_owner", 1, "etag-a")
        else:
            self.result = None
        return self

    def fetchone(self):
        return self.result

    def fetchall(self):
        return self.result


@pytest.mark.parametrize(
    ("actor", "accounts", "expected"),
    [
        ("u_owner", [("u_owner", None, None, None)], None),
        (
            "u_other",
            [("u_other", None, None, None), ("u_owner", None, None, None)],
            "file_access_revoked",
        ),
        ("u_owner", [("u_owner", None, object(), None)], "account_suspended"),
    ],
    ids=["owner", "another-actor", "owner-suspended"],
)
def test_the_source_fence_admits_only_a_live_owner(actor, accounts, expected):
    cur = _FenceCursor(accounts)
    payload = {
        "actorUserId": actor,
        "fileId": "f_1",
        "sourceETag": "etag-a",
        "sourceRevision": 1,
    }

    cancellation = db._pipeline_source_cancellation(cur, payload, file_lock="UPDATE")

    assert (cancellation and cancellation[2]) == expected
    assert not any("FROM workspaces" in s for s in cur.statements)


# ----------------------------------------------------------------- database


@pytest.fixture
def owner(_test_infra):
    """A user with a workspace file and two standalone files of the same bytes;
    the first file of each scope carries a thumbnail."""
    dsn = _test_infra
    user_id = f"u_{secrets.token_hex(6)}"
    workspace_id = f"ws_{secrets.token_hex(6)}"
    ids = {name: f"f_{secrets.token_hex(6)}" for name in ("ws", "first", "second")}
    sha = "b" * 64
    with psycopg.connect(dsn, autocommit=True) as conn:
        conn.execute(
            "INSERT INTO users (id, name, email) VALUES (%s, 'Owner', %s)",
            (user_id, f"{user_id}@capynotebook.test"),
        )
        conn.execute(
            "INSERT INTO workspaces (id, user_id, name) VALUES (%s, %s, 'Owned')",
            (workspace_id, user_id),
        )
        for name, file_id in ids.items():
            conn.execute(
                """
                INSERT INTO files (id, workspace_id, user_id, name, kind,
                                   size_bytes, status, blob_path, source_sha256,
                                   thumbnail_key)
                VALUES (%s, %s, %s, 'deck.pdf', 'pdf', 1024, 'ready', %s, %s, %s)
                """,
                (
                    file_id,
                    workspace_id if name == "ws" else None,
                    user_id,
                    f"sources/{file_id}",
                    sha,
                    f"thumbs/{file_id}/{'c' * 64}.webp" if name != "second" else None,
                ),
            )
    try:
        yield {
            "dsn": dsn,
            "id": user_id,
            "workspace": workspace_id,
            "files": ids,
            "sha": sha,
        }
    finally:
        with psycopg.connect(dsn, autocommit=True) as conn:
            conn.execute("DELETE FROM files WHERE user_id = %s", (user_id,))
            conn.execute("DELETE FROM workspaces WHERE id = %s", (workspace_id,))
            conn.execute("DELETE FROM users WHERE id = %s", (user_id,))


@pytest.mark.integration
def test_a_standalone_file_shares_only_its_owners_standalone_thumbnail(owner):
    files = owner["files"]
    with psycopg.connect(owner["dsn"], autocommit=True) as conn, conn.cursor() as cur:
        assert db.share_file_thumbnail(
            cur, files["second"], db.Scope(None, owner["id"]), owner["sha"]
        )
        key = conn.execute(
            "SELECT thumbnail_key FROM files WHERE id = %s", (files["second"],)
        ).fetchone()[0]

    assert key == f"thumbs/{files['first']}/{'c' * 64}.webp"


@pytest.fixture
def standalone_pins():
    """The job pins a standalone file's ingest holds: the payload's space."""
    from pipeline import registry

    registry.registry.refresh()
    registry.set_job_pins(
        registry.JobPins(
            ingest=registry.registry.default(registry.Slot.INGEST),
            embedding=registry.resolve_pinned(
                _PIN["embedding_provider_slug"],
                _PIN["embedding_model_slug"],
                _PIN["embedding_model_version"],
                registry.Slot.RETRIEVAL,
            ),
            captioning=registry.registry.default(registry.Slot.CAPTIONING),
        )
    )
    yield
    registry.set_job_pins(None)


@pytest.mark.integration
async def test_a_standalone_index_is_owner_scoped_in_its_jobs_space(
    owner, standalone_pins, monkeypatch
):
    from pipeline.config import cfg
    from pipeline.retrieval import indexing, store

    async def embed(texts, *, spec):
        return [[1.0] + [0.0] * (cfg.embedding_dim - 1) for _ in texts]

    async def complete_text(_messages, **_kwargs):
        return "Notes on photosynthesis."

    monkeypatch.setattr(indexing.models, "embed", embed)
    monkeypatch.setattr(indexing.models, "complete_text", complete_text)
    file_id = owner["files"]["first"]
    association = await store.attach_file_content(
        workspace_id=None,
        owner_user_id=owner["id"],
        file_id=file_id,
        content_hash="standalone-hash",
        claim_job_id="job_standalone",
    )
    await indexing.index_file(
        workspace_id=None,
        pin=_PIN,
        content_id=association["content_id"],
        file_id=file_id,
        file_name="deck.pdf",
        chunks=worker.chunk_markdown("# Notes\n\nChloroplasts convert light."),
        claim_job_id="job_standalone",
    )
    await store.publish_file_content(
        workspace_id=None,
        file_id=file_id,
        content_id=association["content_id"],
        claim_job_id="job_standalone",
    )

    content_id = association["content_id"]
    table = store.vector_table_for_pin(_PIN)
    with psycopg.connect(owner["dsn"], autocommit=True) as conn, conn.cursor() as cur:
        assert conn.execute(
            """SELECT workspace_id, user_id, status, embedding_model_slug,
                      embedding_dim FROM rag_contents WHERE id = %s""",
            (content_id,),
        ).fetchone() == (
            None,
            owner["id"],
            "ready",
            _PIN["embedding_model_slug"],
            _PIN["embedding_dim"],
        )
        chunks, vectors, rows = conn.execute(
            f"""SELECT count(*) FILTER (WHERE c.workspace_id IS NULL),
                       count(*) FILTER (WHERE v.workspace_id IS NULL), count(*)
                FROM rag_chunks c JOIN {table} v ON v.chunk_id = c.id
                WHERE c.content_id = %s""",
            (content_id,),
        ).fetchone()
        assert rows > 0 and chunks == vectors == rows
        assert conn.execute(
            "SELECT workspace_id, descriptor FROM rag_content_summaries WHERE content_id = %s",
            (content_id,),
        ).fetchone() == (None, "Notes on photosynthesis.")
        # A re-ingest of this file keeps the space its content was indexed in.
        assert db.file_embedding_pin(cur, file_id) == _PIN


@pytest.mark.integration
async def test_a_donor_stays_within_its_owners_standalone_files(owner):
    from pipeline.retrieval import store

    first = owner["files"]["first"]
    association = await store.attach_file_content(
        workspace_id=None,
        owner_user_id=owner["id"],
        file_id=first,
        content_hash="donor-hash",
        source_sha256=owner["sha"],
        pipeline_identity="identity-1",
        claim_job_id="job_donor",
    )
    await store.publish_file_content(
        workspace_id=None,
        file_id=first,
        content_id=association["content_id"],
        claim_job_id="job_donor",
    )
    space = {
        "source_sha256": owner["sha"],
        "pipeline_identity": "identity-1",
        "embedding_provider_slug": _PIN["embedding_provider_slug"],
        "embedding_model_slug": _PIN["embedding_model_slug"],
        "embedding_model_version": _PIN["embedding_model_version"],
        "embedding_dim": _PIN["embedding_dim"],
    }

    donor = await store.find_ready_donor(
        workspace_id=None, owner_user_id=owner["id"], **space
    )
    from_workspace = await store.find_ready_donor(
        workspace_id=owner["workspace"], **space
    )

    assert donor is not None and donor["id"] == association["content_id"]
    assert from_workspace is None
