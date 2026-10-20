"""Note indexing end to end: a note job carrying Go's payload keys goes through
the real claim, heartbeat, provider admission and settlement. Only the provider
HTTP call (``elitellm.embed_batch``) and Go's note text endpoint are stubbed;
stubbing ``models.embed`` or accounting would hide the source boundary, which
is what kept every note job from finishing. Migration 0082's trigger on
``jobs`` releases the note when its job ends.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import secrets

import pytest

from pipeline import elitellm, registry
from pipeline.config import cfg
from pipeline.elitellm.client import _as_obj
from pipeline.ingest import telemetry, worker
from pipeline.jobs import TerminalError
from pipeline.retrieval.chunking import chunk_markdown
from pipeline.store import db

pytestmark = pytest.mark.integration

_SECTIONS = {
    "Light": "Chlorophyll absorbs red and blue light and splits water.",
    "Calvin": "Carbon fixation builds sugar from carbon dioxide in the stroma.",
    "Transport": "Phloem carries sucrose from leaves to the roots.",
}


def _text(**changed: str) -> str:
    sections = {**_SECTIONS, **changed}
    return "\n\n".join(f"# {name}\n\n{body}" for name, body in sections.items())


def _blocks(text: str) -> list[dict]:
    """Go's MaterialIndexText.Blocks for a text: one block per paragraph."""
    return [
        {"id": f"p{i}", "text": part, "kind": "p"}
        for i, part in enumerate(text.split("\n\n"))
    ]


def _rows(workspace, sql: str, params: tuple = ()) -> list[tuple]:
    with workspace._connect() as conn:
        return conn.execute(sql, params).fetchall()


def _note(workspace) -> str:
    material_id = "mat_" + secrets.token_hex(6)
    with workspace._connect() as conn:
        conn.execute(
            "INSERT INTO materials (id, workspace_id, owner_user_id, created_by, kind, title) "
            "VALUES (%s, %s, %s, %s, 'note', 'Photosynthesis')",
            (material_id, workspace.id, workspace.user_id, workspace.user_id),
        )
    return material_id


def _admit(workspace, material_id: str) -> str:
    """What Go's RequestMaterialIndex writes: an owner-paid ingest session and
    one ingest job naming the note, recorded on the note."""
    reservation_id = "cr_" + secrets.token_hex(6)
    job_id = "job_" + secrets.token_hex(6)
    ingest = registry.registry.default(registry.Slot.INGEST)
    captioning = registry.registry.default(registry.Slot.CAPTIONING)
    rate = {"version": 1, "unit": "page", "creditMicrosPerUnit": 1}
    payload = {
        "materialId": material_id,
        "workspaceId": workspace.id,
        "revision": 1,
        "reservationId": reservation_id,
        "automatic": True,
        "actorUserId": workspace.user_id,
        "ingestProviderSlug": ingest.provider_slug,
        "ingestModelSlug": ingest.model_slug,
        "ingestModelVersion": ingest.version,
        "captioningProviderSlug": captioning.provider_slug,
        "captioningModelSlug": captioning.model_slug,
        "captioningModelVersion": captioning.version,
        "resourceRates": {"digital_parse_page": rate, "vlm_ingest_page": rate},
    }
    with workspace._connect() as conn:
        conn.execute(
            "INSERT INTO provider_sessions (id, actor_user_id, workspace_id, surface, reserved_micros, expires_at) "
            "VALUES (%s, %s, %s, 'ingest', 0, now() + interval '1 hour')",
            (reservation_id, workspace.user_id, workspace.id),
        )
        conn.execute(
            "INSERT INTO jobs (id, type, payload) VALUES (%s, 'ingest', %s::jsonb)",
            (job_id, json.dumps(payload)),
        )
        conn.execute(
            "UPDATE materials SET index_job_id=%s, index_dirty_at=NULL WHERE id=%s",
            (job_id, material_id),
        )
    return job_id


def _claim(workspace, job_id: str) -> dict:
    """Claim the job like the worker loop."""
    with workspace._connect() as conn:
        conn.execute(
            "UPDATE jobs SET not_before=now()+interval '7 days' WHERE status='pending' AND id<>%s",
            (job_id,),
        )
    with db.connect() as conn, conn.cursor() as cur:
        job = db.claim_job(cur, "ingest", 180)
        assert job is not None and job["id"] == job_id
        job["attemptId"] = db.start_job_attempt(
            cur,
            job=job,
            trace_id="trace_note",
            environment="test",
            host_id="test-host",
            worker_instance_id="test-worker",
            release_sha="test-release",
        )
        conn.commit()
    return job


async def _run(workspace, job_id: str) -> dict:
    """Claim the job and run it, failure handling included."""
    job = _claim(workspace, job_id)
    token = telemetry.begin_job(job)
    try:
        await worker.process_ingest_job(job)
    except Exception as exc:  # noqa: BLE001 - the worker loop's own handoff
        await worker._handle_job_failure(job, exc)
    finally:
        telemetry.reset_job(token)
    return job


def _vector(text: str) -> list[float]:
    vector = [0.0] * cfg.embedding_dim
    vector[int(hashlib.sha256(text.encode()).hexdigest(), 16) % cfg.embedding_dim] = 1.0
    return vector


@pytest.fixture
def provider(workspace, monkeypatch):
    """The embedding provider's HTTP call, and Go's note text endpoint. The
    model's capacity row is environment config (deploy/model-capacities.sql)."""
    state: dict = {"text": _text(), "inputs": [], "during": None}
    spec = registry.current_job_pins().embedding
    capacity = (spec.provider_slug, spec.model_slug)
    with workspace._connect() as conn:
        added = conn.execute(
            "INSERT INTO model_capacities VALUES (%s, %s, 4, 1) ON CONFLICT DO NOTHING",
            capacity,
        ).rowcount

    async def embed_batch(spec, texts, *, dimensions):
        state["inputs"].extend(texts)
        if state["during"] is not None:
            await state["during"]()
        return _as_obj(
            {
                "data": [
                    {"index": i, "embedding": _vector(text)}
                    for i, text in enumerate(texts)
                ],
                "usage": {
                    "prompt_tokens": 10 * len(texts),
                    "total_tokens": 10 * len(texts),
                },
            }
        )

    monkeypatch.setattr(elitellm, "embed_batch", embed_batch)
    monkeypatch.setattr(
        worker,
        "_fetch_material_text",
        lambda *_a: {"text": state["text"], "blocks": _blocks(state["text"])},
    )
    yield state
    if added:
        with workspace._connect() as conn:
            conn.execute(
                "DELETE FROM model_capacities WHERE provider=%s AND model=%s", capacity
            )


def _alias(workspace, material_id: str) -> tuple[str, str] | None:
    rows = _rows(
        workspace,
        "SELECT c.id, c.status FROM rag_material_contents a JOIN rag_contents c ON c.id=a.content_id "
        "WHERE a.material_id=%s",
        (material_id,),
    )
    return rows[0] if rows else None


def _baseline(workspace, material_id: str) -> list[dict] | None:
    return _rows(
        workspace, "SELECT indexed_blocks FROM materials WHERE id=%s", (material_id,)
    )[0][0]


def _note_state(workspace, material_id: str) -> tuple:
    return _rows(
        workspace,
        "SELECT index_job_id, index_error, index_dirty_at IS NOT NULL, index_failures "
        "FROM materials WHERE id=%s",
        (material_id,),
    )[0]


async def test_a_note_job_indexes_through_the_real_boundaries(workspace, provider):
    assert len(chunk_markdown(_text())) == 3
    material_id = _note(workspace)
    job_id = _admit(workspace, material_id)
    renewed: list[bool] = []

    def heartbeat() -> bool:
        with db.connect() as conn, conn.cursor() as cur:
            live = db.heartbeat_job(cur, job_id, 180, 1)
            conn.commit()
        return live

    async def during():
        renewed.append(await asyncio.to_thread(heartbeat))

    provider["during"] = during
    job = await _run(workspace, job_id)

    assert renewed == [True]
    assert _rows(
        workspace, "SELECT status, error FROM jobs WHERE id=%s", (job_id,)
    ) == [("done", None)]
    assert _rows(
        workspace,
        "SELECT status, chunks_created, details->>'chunks_embedded' FROM ingest_job_attempts WHERE id=%s",
        (job["attemptId"],),
    ) == [("succeeded", 3, "3")]
    content_id, status = _alias(workspace, material_id)
    assert status == "ready"
    assert _rows(
        workspace, "SELECT count(*) FROM rag_chunks WHERE content_id=%s", (content_id,)
    ) == [(3,)]
    assert _rows(
        workspace,
        "SELECT count(*) FROM rag_chunk_vectors_2560 v JOIN rag_chunks c ON c.id=v.chunk_id "
        "WHERE c.content_id=%s",
        (content_id,),
    ) == [(3,)]
    reservation = json.loads(
        _rows(workspace, "SELECT payload::text FROM jobs WHERE id=%s", (job_id,))[0][0]
    )["reservationId"]
    assert _rows(
        workspace,
        "SELECT status, job_attempt_id FROM provider_calls WHERE reservation_id=%s",
        (reservation,),
    ) == [("applied", job["attemptId"])]
    assert _rows(
        workspace, "SELECT status FROM provider_sessions WHERE id=%s", (reservation,)
    ) == [("settled",)]
    assert _note_state(workspace, material_id) == (None, None, False, 0)


async def test_an_edit_embeds_only_its_chunk_and_a_failure_keeps_the_index(
    workspace, provider
):
    material_id = _note(workspace)
    await _run(workspace, _admit(workspace, material_id))
    first, _ = _alias(workspace, material_id)
    assert _baseline(workspace, material_id) == _blocks(_text())
    provider["inputs"].clear()

    # Edit one section. Until the new content is ready the old one still
    # serves search and lends its vectors to the unchanged chunks.
    provider["text"] = _text(Transport="Xylem carries water up from the roots.")
    seen_during: list = []

    async def during():
        seen_during.append(_alias(workspace, material_id))
        seen_during.append(_baseline(workspace, material_id))

    provider["during"] = during
    job = await _run(workspace, _admit(workspace, material_id))

    # The baseline Go diffs pending note changes against moves with the alias.
    assert seen_during == [(first, "ready"), _blocks(_text())]
    assert _baseline(workspace, material_id) == _blocks(provider["text"])
    assert len(provider["inputs"]) == 1 and "Xylem" in provider["inputs"][0]
    second, status = _alias(workspace, material_id)
    assert second != first and status == "ready"
    assert _rows(
        workspace, "SELECT count(*) FROM rag_contents WHERE id=%s", (first,)
    ) == [(0,)]
    assert _rows(
        workspace,
        "SELECT chunks_created, details->>'chunks_embedded' FROM ingest_job_attempts WHERE id=%s",
        (job["attemptId"],),
    ) == [(3, "1")]

    # A failed job keeps the published index and leaves the note due: it is
    # retried at most twice before it is parked (Epo 2026-10-20).
    provider["text"] = _text(Light="Chlorophyll reflects green light.")

    async def refuse():
        raise TerminalError("embedding refused")

    provider["during"] = refuse
    failed = _admit(workspace, material_id)
    await _run(workspace, failed)

    assert _rows(workspace, "SELECT status FROM jobs WHERE id=%s", (failed,)) == [
        ("failed",)
    ]
    assert _alias(workspace, material_id) == (second, "ready")
    assert _baseline(workspace, material_id) == _blocks(
        _text(Transport="Xylem carries water up from the roots.")
    )
    assert _rows(
        workspace,
        "SELECT count(*) FROM rag_contents WHERE workspace_id=%s AND status='processing'",
        (workspace.id,),
    ) == [(0,)]
    assert _note_state(workspace, material_id) == (None, None, True, 1)


def test_the_lease_reaper_parks_a_note_whose_worker_died(workspace):
    """The third failed job parks the note until its next edit."""
    material_id = _note(workspace)
    job_id = _admit(workspace, material_id)
    with workspace._connect() as conn:
        conn.execute(
            "UPDATE materials SET index_failures=2 WHERE id=%s", (material_id,)
        )
    _claim(workspace, job_id)
    with workspace._connect() as conn:
        conn.execute(
            "UPDATE jobs SET lease_expires_at=now()-interval '1 second' WHERE id=%s",
            (job_id,),
        )
    with db.connect() as conn, conn.cursor() as cur:
        db.reclaim_expired_leases(
            cur, max_attempts={"ingest": 1}, backoff_base_s={"ingest": 30}
        )
        conn.commit()

    assert _rows(workspace, "SELECT status FROM jobs WHERE id=%s", (job_id,)) == [
        ("failed",)
    ]
    assert _note_state(workspace, material_id) == (None, "lease expired", True, 3)


def test_a_note_job_stops_while_the_notes_payer_is_deleting(workspace):
    """A note's payer is its creator (uploader pays), fenced beside the
    workspace owner and the actor."""
    payer = "u_" + secrets.token_hex(6)
    material_id = "mat_" + secrets.token_hex(6)
    with workspace._connect() as conn:
        conn.execute(
            "INSERT INTO users (id,name,email) VALUES (%s,'Payer',%s)",
            (payer, payer + "@example.com"),
        )
        conn.execute(
            "INSERT INTO materials (id, workspace_id, owner_user_id, created_by, kind, title) "
            "VALUES (%s, %s, %s, %s, 'note', 'Payer note')",
            (material_id, workspace.id, payer, payer),
        )
    payload = {
        "materialId": material_id,
        "workspaceId": workspace.id,
        "actorUserId": workspace.user_id,
    }

    def cancellation():
        with workspace._connect() as conn, conn.transaction(), conn.cursor() as cur:
            return db._pipeline_source_cancellation(cur, payload, file_lock="SHARE")

    assert cancellation() is None
    with workspace._connect() as conn:
        conn.execute(
            "UPDATE users SET deletion_requested_at=now(), purge_after=now()+interval '30 days' WHERE id=%s",
            (payer,),
        )
    try:
        assert cancellation() == (
            "failed",
            "lifecycle",
            "account_deletion",
            "account deletion requested",
        )
    finally:
        with workspace._connect() as conn:
            conn.execute("DELETE FROM materials WHERE id=%s", (material_id,))
            conn.execute("DELETE FROM users WHERE id=%s", (payer,))
