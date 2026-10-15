"""Integration tests for per-part ingest failures (parts design tests 1 and 3).

A file descriptor is a part: when its summary call fails, the file's content
is still published and searchable, the descriptor is a missing row, and the
file ends failed with ``indexed`` true. A parts-only job then fills it from the
stored chunks, with no parse and no embedding, and every file sharing the
content goes ready. Real store SQL and worker finalization on the migrated
schema; the summary and embedding calls are fakes that count.
"""

from __future__ import annotations

import json
from types import SimpleNamespace

import psycopg
import pytest

from pipeline.config import cfg
from pipeline.ingest import worker
from pipeline.retrieval import indexing, store
from pipeline.retrieval.chunking import Chunk, search_query_terms

pytestmark = pytest.mark.integration


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


async def _publish(ws, file_id: str, chunks: list[Chunk], job_id: str) -> dict:
    """The worker's attach, index and publish; returns the index result."""
    association = await store.attach_file_content(
        workspace_id=ws.id,
        file_id=file_id,
        content_hash=indexing.content_hash(chunks),
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
    await worker._process_parts_bound(job, payload, first, workspace.id, "report.pdf")

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
