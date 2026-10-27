"""Integration tests for per-part ingest failures (parts design tests 1 and 3)
and the publish-at-the-end alias rules they rely on.

A file descriptor is a part: when its summary call fails, the file's content
is still published and searchable, the descriptor is a missing row, and the
file ends failed with ``indexed`` true. A parts-only job then fills it from the
stored chunks, with no parse and no embedding, and every file sharing the
content goes ready. ``indexed`` follows what the file's alias serves. Real
store SQL and worker finalization on the migrated schema; the summary and
embedding calls are fakes that count.
"""

from __future__ import annotations

import json
from types import SimpleNamespace

import psycopg
import pytest

from pipeline.config import cfg
from pipeline.ingest import plan as ingest_plan
from pipeline.ingest import worker
from pipeline.retrieval import indexing, store
from pipeline.retrieval.chunking import Chunk, search_query_terms
from pipeline.store import db

pytestmark = pytest.mark.integration
IDENTITY = "plan-v2:fast:test:chunker-test"


def _one_hot(axis: int) -> list[float]:
    vector = [0.0] * cfg.embedding_dim
    vector[axis % cfg.embedding_dim] = 1.0
    return vector


def _chunks() -> list[Chunk]:
    return [
        Chunk(text=f"Page {p} explains osmosis across membranes.", page_start=p)
        for p in (1, 2, 3)
    ]


@pytest.fixture
def fakes(monkeypatch):
    counted = SimpleNamespace(embedded=[], summaries=0, summary="A descriptor.")

    async def embed(texts, *, spec):
        counted.embedded.extend(texts)
        return [_one_hot(i) for i in range(len(texts))]

    async def complete_text(*_args, **_kwargs):
        counted.summaries += 1
        if isinstance(counted.summary, Exception):
            raise counted.summary
        return counted.summary

    monkeypatch.setattr(indexing.models, "embed", embed)
    monkeypatch.setattr(indexing.models, "complete_text", complete_text)
    monkeypatch.setattr(worker.progress, "publish", lambda *_a, **_k: None)
    return counted


def _job(ws, file_id: str, job_id: str, **extra) -> tuple[dict, dict]:
    """A running ingest job row holding the file's current revision."""
    revision = ws.scalar("SELECT revision FROM files WHERE id = %s", (file_id,))
    payload = {
        "fileId": file_id,
        "workspaceId": ws.id,
        "actorUserId": ws.user_id,
        "reservationId": "",
        "sourceRevision": revision,
        "sourceETag": "",
        **extra,
    }
    with psycopg.connect(ws.dsn, autocommit=True) as conn:
        conn.execute(
            """INSERT INTO jobs (id, type, payload, status, attempts, lease_expires_at)
            VALUES (%s, 'ingest', %s, 'running', 1, now() + interval '5 minutes')""",
            (job_id, json.dumps(payload)),
        )
    return {"id": job_id, "type": "ingest", "attempts": 1}, payload


async def _publish(
    ws, file_id: str, chunks: list[Chunk], job_id: str, identity: str | None = IDENTITY
) -> dict:
    """The worker's attach, index and publish; returns the index result."""
    association = await store.attach_file_content(
        workspace_id=ws.id,
        file_id=file_id,
        content_hash=indexing.content_hash(chunks),
        pipeline_identity=identity,
        claim_job_id=job_id,
    )
    result = await indexing.index_file(
        workspace_id=ws.id,
        content_id=association["content_id"],
        file_id=file_id,
        file_name="report.pdf",
        chunks=chunks,
        claim_job_id=job_id,
    )
    await store.publish_file_content(
        workspace_id=ws.id,
        file_id=file_id,
        content_id=association["content_id"],
        claim_job_id=job_id,
    )
    return {**result, "content_id": association["content_id"]}


def _file(ws, file_id: str) -> tuple:
    with psycopg.connect(ws.dsn, autocommit=True) as conn:
        return conn.execute(
            "SELECT status, indexed FROM files WHERE id = %s", (file_id,)
        ).fetchone()


def _alias(ws, file_id: str) -> str | None:
    return ws.scalar(
        "SELECT content_id FROM rag_file_contents WHERE file_id = %s", (file_id,)
    )


def _set(ws, sql: str, params: tuple) -> None:
    with psycopg.connect(ws.dsn, autocommit=True) as conn:
        conn.execute(sql, params)


async def test_failed_summary_leaves_the_file_indexed_and_pending(workspace, fakes):
    fakes.summary = RuntimeError("401 key revoked")
    file_id = workspace.add_file("report.pdf")
    chunks = _chunks()
    job, _payload = _job(workspace, file_id, "job_failed_summary")

    result = await _publish(workspace, file_id, chunks, "job_failed_summary")
    missing = worker.Missing(worker._summary_reason(job, result["summary_error"]))
    assert worker._finish_ok(
        file_id,
        job["id"],
        indexing.content_hash(chunks),
        actor_user_id=workspace.user_id,
        workspace_id=workspace.id,
        content_id=result["content_id"],
        missing=missing,
    )

    content_id = result["content_id"]
    assert fakes.embedded == [chunk.indexed_text() for chunk in chunks]
    assert (
        workspace.scalar(
            "SELECT count(*) FROM rag_content_summaries WHERE content_id = %s",
            (content_id,),
        )
        == 0
    )
    hits = await store.hybrid_search(
        workspace_id=workspace.id,
        vector=_one_hot(0),
        terms=search_query_terms("osmosis"),
        file_ids=[file_id],
        candidates=10,
    )
    assert hits and {hit["file_id"] for hit in hits} == {file_id}
    assert _file(workspace, file_id) == ("failed", True)
    note = workspace.scalar("SELECT error FROM jobs WHERE id = %s", (job["id"],))
    assert note.startswith("summary pending (file summary failed: 401 key revoked)")


async def test_parts_only_retry_fills_the_summary_without_parse_or_embedding(
    workspace, fakes
):
    """Two duplicate uploads share a content row whose descriptor failed. One
    parts-only job makes one summary call, embeds nothing, inserts the row
    only while it is absent, and completes both files."""
    fakes.summary = RuntimeError("503 upstream")
    first = workspace.add_file("report.pdf")
    second = workspace.add_file("report copy.pdf")
    chunks = _chunks()
    content_id = (await _publish(workspace, first, chunks, "job_first"))["content_id"]
    shared = await store.attach_file_content(
        workspace_id=workspace.id,
        file_id=second,
        content_hash=indexing.content_hash(chunks),
        claim_job_id="job_second",
    )
    assert shared == {"content_id": content_id, "ready": True, "created": False}
    with psycopg.connect(workspace.dsn, autocommit=True) as conn:
        conn.execute(
            "UPDATE files SET status='failed', indexed=true WHERE id IN (%s, %s)",
            (first, second),
        )
    fakes.embedded.clear()
    fakes.summaries = 0
    fakes.summary = "A report on osmosis."

    job, payload = _job(workspace, first, "job_parts", partsOnly=True)
    await worker._process_parts_bound(
        job,
        payload,
        first,
        worker.db.Scope(workspace.id),
        "report.pdf",
        ingest_plan.DOCUMENT_PARSE,
    )

    assert fakes.embedded == [] and fakes.summaries == 1
    with psycopg.connect(workspace.dsn, autocommit=True) as conn:
        row = conn.execute(
            "SELECT fingerprint, descriptor, change_share FROM rag_content_summaries "
            "WHERE content_id = %s",
            (content_id,),
        ).fetchone()
    assert row == (indexing.content_hash(chunks), "A report on osmosis.", 0.0)
    assert _file(workspace, first) == ("ready", True)
    assert _file(workspace, second) == ("ready", True)
    assert (
        await indexing.fill_descriptor(
            workspace_id=workspace.id, content_id=content_id, file_name="report.pdf"
        )
        is None
    )
    assert fakes.summaries == 1


async def test_a_parts_only_job_keeps_unread_pages_missing(workspace, fakes):
    """Content with unread pages (NULL pipeline_identity) stays partial after a
    parts-only fill: the file keeps failed with indexed content and the pages
    note, and no sibling goes ready on a content the row shows incomplete."""
    fakes.summary = RuntimeError("503 upstream")
    first = workspace.add_file("scan.pdf")
    second = workspace.add_file("scan copy.pdf")
    chunks = _chunks()
    content_id = (await _publish(workspace, first, chunks, "job_scan", None))[
        "content_id"
    ]
    await store.attach_file_content(
        workspace_id=workspace.id,
        file_id=second,
        content_hash=indexing.content_hash(chunks),
        claim_job_id="job_copy",
    )
    _set(
        workspace,
        "UPDATE files SET status='failed', indexed=true WHERE id IN (%s, %s)",
        (first, second),
    )
    fakes.summary = "A scanned report on osmosis."

    job, payload = _job(workspace, first, "job_parts_scan", partsOnly=True)
    await worker._process_parts_bound(
        job,
        payload,
        first,
        worker.db.Scope(workspace.id),
        "scan.pdf",
        ingest_plan.DOCUMENT_PARSE,
    )

    assert await store.has_content_summary(content_id)
    assert _file(workspace, first) == ("failed", True)
    assert workspace.scalar("SELECT error FROM jobs WHERE id = %s", (job["id"],)) == (
        "some pages could not be read; retry processing fills them in"
    )
    # Even a job that believes the content complete leaves its siblings.
    assert worker._finish_ok(
        first,
        "job_trusting",
        indexing.content_hash(chunks),
        actor_user_id=workspace.user_id,
        workspace_id=workspace.id,
        content_id=content_id,
    )
    assert _file(workspace, second) == ("failed", True)


async def test_a_failed_retry_stays_indexed_while_its_previous_index_serves(
    workspace, fakes
):
    """indexed follows what search serves: a failed retry of an indexed file
    keeps its alias, so it stays indexed; a first ingest that fails has none."""
    served = workspace.add_file("report.pdf")
    await _publish(workspace, served, _chunks(), "job_first")
    fresh = workspace.add_file("new.pdf")
    # Go's Retry processing resets both before the job runs.
    _set(
        workspace,
        "UPDATE files SET status='pending', indexed=false WHERE id IN (%s, %s)",
        (served, fresh),
    )

    for file_id in (served, fresh):
        # The terminal progress event publishes the indexed it returns.
        assert worker._finish_fail(
            file_id,
            f"job_fail_{file_id}",
            "parse failed",
            actor_user_id=workspace.user_id,
            workspace_id=workspace.id,
        ) is (file_id == served)

    assert _file(workspace, served) == ("failed", True)
    assert _file(workspace, fresh) == ("failed", False)
    # The lease reaper's failure follows the same rule, and hands the written
    # indexed to the reclaimed job's announcement.
    _set(workspace, "UPDATE files SET status='processing' WHERE id = %s", (served,))
    _job(workspace, served, "job_reaped")
    _set(
        workspace,
        "UPDATE jobs SET lease_expires_at = now() - interval '1 minute' WHERE id = %s",
        ("job_reaped",),
    )
    with psycopg.connect(workspace.dsn) as conn, conn.cursor() as cur:
        reclaimed = db.reclaim_expired_leases(
            cur, max_attempts={"ingest": 1}, backoff_base_s={"ingest": 30}
        )
        conn.commit()
    assert [
        (row["file_failed"], row["file_indexed"])
        for row in reclaimed
        if row["id"] == "job_reaped"
    ] == [(True, True)]
    assert _file(workspace, served) == ("failed", True)


async def test_an_account_deletion_keeps_a_served_index(workspace, fakes):
    """cancel_user_async_work sets indexed as db.SERVES_INDEX does: a cancelled
    re-ingest keeps answering search with its previous index; a first ingest
    whose alias points at its own processing content serves nothing."""
    served = workspace.add_file("report.pdf")
    await _publish(workspace, served, _chunks(), "job_first")
    fresh = workspace.add_file("new.pdf")
    claimed = workspace.add_file("draft.pdf")
    _set(
        workspace,
        "UPDATE files SET status='processing', indexed=false WHERE id IN (%s, %s, %s)",
        (served, fresh, claimed),
    )
    for file_id in (served, fresh, claimed):
        _job(workspace, file_id, f"job_cancelled_{file_id}")
    draft = await store.attach_file_content(
        workspace_id=workspace.id,
        file_id=claimed,
        content_hash="draft-hash",
        claim_job_id=f"job_cancelled_{claimed}",
    )
    assert _alias(workspace, claimed) == draft["content_id"]

    _set(workspace, "SELECT cancel_user_async_work(%s)", (workspace.user_id,))

    assert _file(workspace, served) == ("failed", True)
    assert _file(workspace, fresh) == ("failed", False)
    assert _file(workspace, claimed) == ("failed", False)


async def test_a_file_over_a_limit_drops_its_previous_index(workspace, fakes):
    file_id = workspace.add_file("report.pdf")
    previous = (await _publish(workspace, file_id, _chunks(), "job_first"))[
        "content_id"
    ]

    assert (
        worker._finish_fail(
            file_id,
            "job_limit",
            "over the page limit",
            actor_user_id=workspace.user_id,
            workspace_id=workspace.id,
            index_limit="page_limit",
        )
        is False
    )

    assert _file(workspace, file_id) == ("ready", False)
    assert _alias(workspace, file_id) is None
    assert (
        workspace.scalar("SELECT count(*) FROM rag_contents WHERE id = %s", (previous,))
        == 0
    )
    assert workspace.scalar(
        "SELECT index_limit FROM files WHERE id = %s", (file_id,)
    ) == ("page_limit")


async def test_a_waiter_aliases_the_content_once_it_is_ready(
    workspace, fakes, monkeypatch
):
    """A re-ingest that waits on another job's claim keeps serving its old
    index, then moves onto the content when the creator publishes it."""
    monkeypatch.setattr(cfg, "poll_interval", 0.01)
    waiter = workspace.add_file("second.pdf")
    previous = (await _publish(workspace, waiter, _chunks()[:2], "job_old"))[
        "content_id"
    ]
    creator = workspace.add_file("first.pdf")
    digest = indexing.content_hash(_chunks())
    created = await store.attach_file_content(
        workspace_id=workspace.id,
        file_id=creator,
        content_hash=digest,
        claim_job_id="job_creator",
    )
    waiting = await store.attach_file_content(
        workspace_id=workspace.id,
        file_id=waiter,
        content_hash=digest,
        claim_job_id="job_waiter",
    )
    assert not waiting["ready"] and not waiting["created"]
    assert _alias(workspace, waiter) == previous
    await store.publish_file_content(
        workspace_id=workspace.id,
        file_id=creator,
        content_id=created["content_id"],
        claim_job_id="job_creator",
    )

    association = await worker._wait_for_content(
        dict(waiting),
        scope=worker.db.Scope(workspace.id),
        file_id=waiter,
        content_hash=digest,
        claim_job_id="job_waiter",
    )

    assert association["ready"]
    assert _alias(workspace, waiter) == created["content_id"]


async def test_publish_refuses_a_superseded_file_revision(workspace, fakes):
    file_id = workspace.add_file("report.pdf")
    revision = workspace.scalar("SELECT revision FROM files WHERE id = %s", (file_id,))
    association = await store.attach_file_content(
        workspace_id=workspace.id,
        file_id=file_id,
        content_hash=indexing.content_hash(_chunks()),
        claim_job_id="job_stale",
        source_revision=revision,
        source_etag="",
    )
    _set(
        workspace, "UPDATE files SET revision = revision + 1 WHERE id = %s", (file_id,)
    )

    with pytest.raises(db.SourceSupersededError):
        await store.publish_file_content(
            workspace_id=workspace.id,
            file_id=file_id,
            content_id=association["content_id"],
            claim_job_id="job_stale",
            source_revision=revision,
            source_etag="",
        )

    assert (
        workspace.scalar(
            "SELECT status FROM rag_contents WHERE id = %s",
            (association["content_id"],),
        )
        == "processing"
    )


async def test_finishing_refuses_when_the_files_index_moved(workspace, fakes):
    file_id = workspace.add_file("report.pdf")
    first = await _publish(workspace, file_id, _chunks()[:2], "job_a")
    await _publish(workspace, file_id, _chunks(), "job_b")
    _set(workspace, "UPDATE files SET status='pending' WHERE id = %s", (file_id,))
    worker.obs.start_usage()  # the attempt's accumulator, which a refusal restores

    with pytest.raises(db.SourceSupersededError):
        worker._finish_ok(
            file_id,
            "job_a",
            first["fingerprint"],
            actor_user_id=workspace.user_id,
            workspace_id=workspace.id,
            content_id=first["content_id"],
        )

    assert _file(workspace, file_id)[0] == "pending"


async def test_attaching_ready_content_moves_a_served_alias_at_once(workspace, fakes):
    file_id = workspace.add_file("report.pdf")
    previous = (await _publish(workspace, file_id, _chunks()[:2], "job_old"))[
        "content_id"
    ]
    other = workspace.add_file("same text.pdf")
    target = (await _publish(workspace, other, _chunks(), "job_other"))["content_id"]

    association = await store.attach_file_content(
        workspace_id=workspace.id,
        file_id=file_id,
        content_hash=indexing.content_hash(_chunks()),
        claim_job_id="job_reuse",
    )

    assert association == {"content_id": target, "ready": True, "created": False}
    assert _alias(workspace, file_id) == target
    assert (
        workspace.scalar("SELECT count(*) FROM rag_contents WHERE id = %s", (previous,))
        == 0
    )
