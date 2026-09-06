"""Offline unit tests for the ingest worker's processing-plan execution.

Figure selection and captioning live in ``parse/figures.py`` and are tested
there. What is left here is the branching the worker owns: which contract route
is executed, whether captioning runs at all, and the ordering
the whole feature rests on — that captions are on the blocks before chunking, so
they reach embedding and summarization rather than arriving
after the passage they belong to has already been built.
"""

from __future__ import annotations

import io
from pathlib import Path
from typing import Any

import pytest

from pipeline.ingest import plan as ingest_plan
from pipeline.ingest import worker
from pipeline.parse import parser_client


def test_audio_job_timeout_preserves_pre_provider_ingest_budget(monkeypatch):
    monkeypatch.setattr(worker.cfg, "elevenlabs_sync_timeout_s", 1_200)
    audio_job = {
        "type": "ingest",
        "payload": {"processingPlan": {"route": ingest_plan.AUDIO_TRANSCRIPTION}},
    }

    assert worker._job_timeout(audio_job, 900) == 900 + 1_200 + 300
    assert worker._job_timeout({"type": "ingest", "payload": {}}, 900) == 900


def test_heartbeat_cancels_work_when_the_exact_claim_is_gone(monkeypatch):
    cancelled: list[str] = []
    heartbeats: list[tuple[str, int, int]] = []

    class Connection:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def cursor(self):
            return self

        def commit(self):
            return None

    class StopAfterOneHeartbeat:
        def wait(self, _timeout):
            return False

    monkeypatch.setattr(worker.db, "connect", Connection)

    def heartbeat(_cur, job_id, lease_s, attempt):
        heartbeats.append((job_id, lease_s, attempt))
        return False

    monkeypatch.setattr(worker.db, "heartbeat_job", heartbeat)

    worker._heartbeat_loop(
        "job_1",
        180,
        2,
        StopAfterOneHeartbeat(),
        lambda: cancelled.append("cancel"),
    )

    assert heartbeats == [("job_1", 180, 2)]
    assert cancelled == ["cancel"]


@pytest.mark.parametrize(
    ("source", "accounts", "expected"),
    [
        (
            None,
            [
                ("u_actor", None, None, None),
                ("u_owner", None, None, None),
            ],
            ("failed", "lifecycle", "source_deleted", "source deleted"),
        ),
        (
            ("ws_1", "u_owner", 2, "etag-b"),
            [
                ("u_actor", None, None, None),
                ("u_owner", None, None, None),
            ],
            (
                "superseded",
                "superseded",
                "source_superseded",
                "superseded by file replacement",
            ),
        ),
        (
            ("ws_1", "u_owner", 1, "etag-a"),
            [
                ("u_actor", None, None, None),
                ("u_owner", None, None, object()),
            ],
            (
                "failed",
                "lifecycle",
                "account_deletion",
                "account deletion requested",
            ),
        ),
    ],
    ids=["file-deleted", "source-replaced", "owner-deleting"],
)
def test_heartbeat_closes_a_skipped_lifecycle_claim(source, accounts, expected):
    payload = {
        "actorUserId": "u_actor",
        "fileId": "f_1",
        "sourceETag": "etag-a",
        "sourceRevision": 1,
        "workspaceId": "ws_1",
    }

    class Cursor:
        rowcount = 1

        def __init__(self):
            self.calls: list[tuple[str, tuple]] = []
            self.result = None

        def execute(self, query, params):
            statement = " ".join(query.split())
            self.calls.append((statement, params))
            if "SELECT type, payload FROM jobs" in statement:
                self.result = ("ingest", payload)
            elif "FROM workspaces WHERE id=" in statement:
                self.result = ("u_owner",)
            elif "FROM files WHERE id=" in statement:
                self.result = source
            elif "FROM users" in statement:
                self.result = accounts
            elif "FROM workspace_members" in statement:
                self.result = ("editor",)
            elif "cancel_pipeline_jobs" in statement:
                self.result = (1,)
            else:
                self.result = None
            return self

        def fetchone(self):
            return self.result

        def fetchall(self):
            return self.result

    cur = Cursor()

    assert not worker.db.heartbeat_job(cur, "job_1", 180, 1)
    cancellation = next(
        params for query, params in cur.calls if "cancel_pipeline_jobs" in query
    )
    assert cancellation == ("job_1", *expected)
    assert any("DELETE FROM rag_contents" in query for query, _params in cur.calls)
    assert not any("UPDATE jobs SET locked_at" in query for query, _params in cur.calls)


@pytest.fixture
def parse_stub(monkeypatch):
    """Stand in for artifact extraction and captioning; record both calls."""
    state: dict[str, Any] = {
        "descriptor": None,
        "captioned": 0,
        "chunked": None,
    }
    content_list = [
        {"type": "text", "text": "Photosynthesis", "page_idx": 0, "text_level": 1},
        {"type": "image", "img_path": "images/fig.png", "page_idx": 0},
    ]

    def _extract(
        artifact,
        raw_dir: Path,
        *,
        route: str,
        require_office_preview: bool,
    ):
        state["descriptor"] = artifact
        state["route"] = route
        state["require_office_preview"] = require_office_preview
        raw_dir.mkdir(parents=True, exist_ok=True)
        if require_office_preview:
            (raw_dir / "preview.pdf").write_bytes(b"%PDF-preview")
        return content_list

    async def _caption(
        *, file_id, content_list, raw_dir, file_name, source_sha256, refresh_job_id=None
    ):
        state["captioned"] += 1
        content_list[1]["description"] = "A labelled chloroplast."
        return {
            "selected": 1,
            "cached": 0,
            "captioned": 1,
            "decorative": 0,
            "applied": 1,
            "key": "captions/k.json",
        }

    def _chunk(items):
        state["chunked"] = [dict(item) for item in items]
        return ["chunk"]

    monkeypatch.setattr(worker.parser_client, "extract_artifact", _extract)
    monkeypatch.setattr(worker.figures, "caption_figures", _caption)
    monkeypatch.setattr(worker, "chunk_content_list", _chunk)
    monkeypatch.setattr(worker, "_record_parse_artifact", lambda *a, **k: None)
    monkeypatch.setattr(worker, "_record_caption_blob", lambda *a, **k: None)
    monkeypatch.setattr(worker, "_touch_or_upsert_artifact", lambda **k: None)
    monkeypatch.setattr(
        worker,
        "_cache_office_preview",
        lambda **_kwargs: "previews/test.pdf",
    )
    monkeypatch.setattr(worker.progress, "publish", lambda *_a, **_k: None)
    return state


def _plan(
    route: str = ingest_plan.DOCUMENT_PARSE,
    *,
    caption_images: bool = False,
    format_name: str = "pdf",
    office_preview: bool = False,
    parser_route: str | None = None,
) -> ingest_plan.ProcessingPlan:
    if parser_route is None:
        parser_route = "fast" if route == ingest_plan.DOCUMENT_PARSE else ""
    return ingest_plan.ProcessingPlan(
        version=1,
        format=format_name,
        route=route,
        parser_route=parser_route,
        caption_mode="embedded"
        if caption_images
        else "standalone"
        if route == ingest_plan.IMAGE_CAPTION
        else "none",
        office_preview=office_preview,
        stages=(),
        resources=(),
    )


async def _run(*, caption_images: bool = False):
    return await worker._chunks_for(
        payload={
            "blobPath": "sources/blob_1.pdf",
            "parseArtifact": _artifact(),
        },
        name="lecture.pdf",
        processing_plan=_plan(caption_images=caption_images),
        local_path="/shared/sources/source-1",
        source_key="sources/source-1",
        ws="ws_1",
        file_id="f_1",
        source_sha256="aa" * 32,
    )


def _ingest_payload(**overrides):
    payload = {
        "fileId": "f_1",
        "workspaceId": "ws_1",
        "blobPath": "sources/blob_1.pdf",
        "kind": "pdf",
        "parseMode": "fast",
        "captionImages": False,
        "processingPlan": {
            "version": 1,
            "format": "pdf",
            "route": "document_parse",
            "parserRoute": "fast",
            "captionMode": "none",
            "officePreview": False,
            "stages": [
                "fetch_source",
                "parse_document",
                "chunk",
                "index",
                "generate_derivatives",
            ],
            "resources": [
                "object_storage_read",
                "embedding_model",
                "ingest_model",
                "document_parser",
                "shared_parse_spool",
            ],
        },
        "actorUserId": "u_1",
        "reservationId": "cr_1",
        "ingestProviderSlug": "deepseek",
        "ingestModelSlug": "ingest",
        "ingestModelVersion": 1,
        "captioningProviderSlug": "zai",
        "captioningModelSlug": "vision",
        "captioningModelVersion": 1,
        "sourceRevision": 1,
        "sourceETag": "etag-a",
        "parseArtifact": _artifact(),
        "parseJobId": "job_parse",
        "resourceRates": {
            "audio_transcription_second": {
                "version": 1,
                "unit": "second",
                "creditMicrosPerUnit": 250_000,
            },
            "digital_parse_page": {
                "version": 1,
                "unit": "page",
                "creditMicrosPerUnit": 31_000_000,
            },
            "ocr_parse_page": {
                "version": 1,
                "unit": "page",
                "creditMicrosPerUnit": 52_000_000,
            },
            "figure_caption_call": {
                "version": 1,
                "unit": "call",
                "creditMicrosPerUnit": 2_000_000,
            },
        },
    }
    payload.update(overrides)
    return payload


def _artifact() -> dict:
    fingerprint = "a" * 64
    return {
        "key": f"artifacts/{fingerprint}.zip",
        "size": 1024,
        "sha256": "b" * 64,
        "fingerprint": fingerprint,
        "version": parser_client.parser_version(parser_client.ROUTE_FAST),
    }


class _Conn:
    def execute(self, query, params):
        assert query.startswith("UPDATE files SET ever_parsed_successfully=true")

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def cursor(self):
        return self

    def commit(self):
        return None


def test_parse_handoff_atomically_enqueues_an_immutable_ingest_continuation(
    monkeypatch,
):
    events: list[tuple] = []
    payload = _ingest_payload()
    payload.pop("parseArtifact")
    payload.pop("parseJobId")
    payload["localSource"] = {
        "key": "sources/source-1",
        "sha256": "aa" * 32,
    }
    artifact = _artifact()
    artifact["durableKey"] = "parse-bundles/" + "a" * 64 + ".zip"
    monkeypatch.setattr(worker.db, "connect", lambda: _Conn())
    monkeypatch.setattr(worker, "_lost_claim", lambda *_a: False)
    monkeypatch.setattr(worker.db, "ingest_accounts_active", lambda *_a: True)
    monkeypatch.setattr(
        worker.db,
        "require_current_file_source",
        lambda *_a: events.append(("source",)),
    )
    monkeypatch.setattr(
        worker,
        "_touch_or_upsert_artifact",
        lambda **values: events.append(("cache", values)) or True,
    )
    monkeypatch.setattr(
        worker.db,
        "enqueue_job",
        lambda _cur, job_id, job_type, queued: events.append(
            ("enqueue", job_id, job_type, queued)
        ),
    )
    monkeypatch.setattr(
        worker.db,
        "set_job",
        lambda _cur, job_id, status: events.append(("set", job_id, status)),
    )
    monkeypatch.setattr(worker.obs, "take_parse_usage", worker.obs.ParseUsage)

    assert worker._handoff_parsed_artifact(
        job={"id": "job_parse", "attempts": 1},
        payload=payload,
        file_id="f_1",
        workspace_id="ws_1",
        artifact=artifact,
    )

    enqueue = next(event for event in events if event[0] == "enqueue")
    assert enqueue[1:3] == ("job_parse_ingest", "ingest")
    assert enqueue[3]["parseArtifact"] == artifact
    assert enqueue[3]["parseJobId"] == "job_parse"
    assert "parseArtifact" not in payload
    cache = next(event for event in events if event[0] == "cache")
    assert cache[1] == {
        "object_path": artifact["durableKey"],
        "kind": "parse_bundle",
        "source_sha256": "aa" * 32,
        "size_bytes": artifact["size"],
    }
    assert events[-1] == ("set", "job_parse", "done")


def test_invalid_artifact_returns_to_parse_only_once(monkeypatch):
    events: list[tuple] = []
    payload = _ingest_payload()
    monkeypatch.setattr(worker.db, "connect", lambda: _Conn())
    monkeypatch.setattr(worker, "_lost_claim", lambda *_a: False)
    monkeypatch.setattr(worker.db, "require_current_file_source", lambda *_a: None)
    monkeypatch.setattr(worker.db, "clear_file_parse_artifact", lambda *_a: None)
    monkeypatch.setattr(worker.db, "set_file_status", lambda *_a: None)
    monkeypatch.setattr(
        worker.db,
        "enqueue_job",
        lambda _cur, job_id, job_type, queued: events.append(
            (job_id, job_type, queued)
        ),
    )
    monkeypatch.setattr(worker.db, "set_job", lambda *_a: None)
    monkeypatch.setattr(worker.db, "ingest_accounts_active", lambda *_a: True)

    assert worker._handoff_for_artifact_repair(
        job={"id": "job_ingest", "attempts": 1},
        payload=payload,
        file_id="f_1",
    )

    job_id, job_type, queued = events[0]
    assert (job_id, job_type) == ("job_ingest_parse", "parse")
    assert "parseArtifact" not in queued
    assert queued["artifactRepairAttempts"] == 1


def test_reaped_superseded_final_attempt_only_runs_best_effort_cleanup(monkeypatch):
    cleaned: list[dict] = []
    published: list[tuple] = []
    monkeypatch.setattr(
        worker,
        "_cleanup_payload_source",
        lambda payload: cleaned.append(payload),
    )
    monkeypatch.setattr(
        worker.progress,
        "publish",
        lambda *args, **kwargs: published.append((args, kwargs)),
    )

    worker._announce_reclaimed(
        {
            "id": "job_old_source",
            "type": "ingest",
            "attempts": 3,
            "outcome": "failed",
            "file_failed": False,
            "payload": _ingest_payload(reservationId="cr_old_source"),
        }
    )

    assert cleaned == [_ingest_payload(reservationId="cr_old_source")]
    assert published == []


def test_optional_cache_registration_drops_a_row_for_a_reaped_object(monkeypatch):
    events: list[tuple] = []
    monkeypatch.setattr(worker.db, "connect", lambda: _Conn())
    monkeypatch.setattr(
        worker.db,
        "upsert_artifact_cache",
        lambda _cur, **values: events.append(("upsert", values)),
    )
    monkeypatch.setattr(
        worker.db,
        "drop_artifact_cache",
        lambda _cur, key: events.append(("drop", key)),
    )
    monkeypatch.setattr(worker.blobstore, "object_info", lambda _key: None)

    assert not worker._touch_or_upsert_artifact(
        object_path="derived-text/source/image-v1.json",
        kind="derived_text",
        source_sha256="aa" * 32,
    )
    assert [event[0] for event in events] == ["upsert", "drop"]


def test_parse_handoff_drops_unregistered_durable_key(monkeypatch):
    payload = _ingest_payload()
    payload.pop("parseArtifact")
    payload.pop("parseJobId")
    payload["localSource"] = {"key": "sources/source-1", "sha256": "aa" * 32}
    artifact = _artifact()
    artifact["durableKey"] = "parse-bundles/" + "a" * 64 + ".zip"
    queued: list[dict] = []
    monkeypatch.setattr(worker.db, "connect", lambda: _Conn())
    monkeypatch.setattr(worker, "_lost_claim", lambda *_a: False)
    monkeypatch.setattr(worker, "_touch_or_upsert_artifact", lambda **_values: False)
    monkeypatch.setattr(worker.obs, "take_parse_usage", worker.obs.ParseUsage)
    monkeypatch.setattr(
        worker.db, "enqueue_job", lambda _c, _i, _t, p: queued.append(p)
    )
    monkeypatch.setattr(worker.db, "set_job", lambda *_a: None)

    assert worker._handoff_parsed_artifact(
        job={"id": "job_parse", "attempts": 1},
        payload=payload,
        file_id="f_1",
        workspace_id="ws_1",
        artifact=artifact,
    )
    assert "durableKey" not in queued[0]["parseArtifact"]


async def test_the_processing_plan_selects_the_route(parse_stub):
    _, _, _, version = await _run()

    assert parse_stub["route"] == parser_client.ROUTE_FAST
    assert version == parser_client.parser_version(parser_client.ROUTE_FAST)


@pytest.mark.parametrize("parser_route", ["accurate", "advanced", "bogus"])
async def test_unknown_contract_parser_routes_fail(parse_stub, parser_route):
    from pipeline.jobs import TerminalError

    with pytest.raises(TerminalError, match="unknown parse mode"):
        await worker._chunks_for(
            payload={"blobPath": "sources/blob_1.pdf", "parseArtifact": _artifact()},
            name="lecture.pdf",
            processing_plan=_plan(parser_route=parser_route),
            local_path="/shared/sources/source-1",
            source_key="sources/source-1",
            ws="ws_1",
            file_id="f_1",
            source_sha256="aa" * 32,
        )

    assert parse_stub["descriptor"] is None


async def test_a_missing_model_config_fails_the_job_without_retry(monkeypatch):
    from pipeline import registry
    from pipeline.jobs import TerminalError

    async def _pin(_ws):
        raise registry.RegistryError("model config not found: x v1")

    monkeypatch.setattr(worker, "_workspace_embedding_spec", _pin)

    with pytest.raises(TerminalError, match="model pins could not be resolved"):
        await worker.process_ingest_job(
            {
                "id": "job_1",
                "attempts": 1,
                "payload": _ingest_payload(),
            }
        )


async def test_a_database_blip_while_reading_pins_is_not_terminal(monkeypatch):
    import psycopg

    from pipeline.jobs import is_retryable

    async def _pin(_ws):
        raise psycopg.OperationalError("connection timed out")

    monkeypatch.setattr(worker, "_workspace_embedding_spec", _pin)

    with pytest.raises(psycopg.OperationalError, match="connection timed out"):
        await worker.process_ingest_job(
            {
                "id": "job_1",
                "attempts": 1,
                "payload": _ingest_payload(),
            }
        )
    assert is_retryable(psycopg.OperationalError("connection timed out"))


async def test_a_missing_actor_fails_the_file_without_retry(monkeypatch):
    """A job with no actorUserId must fail closed, not raise into the retry path."""
    failed: list[tuple] = []

    async def _pin(_ws):
        return object()

    monkeypatch.setattr(worker, "_workspace_embedding_spec", _pin)
    monkeypatch.setattr(
        worker.registry, "pins_from_payload", lambda *_a, **_k: object()
    )
    monkeypatch.setattr(worker.registry, "set_job_pins", lambda *_a, **_k: None)
    monkeypatch.setattr(worker, "_file_exists", lambda *_a, **_k: True)
    monkeypatch.setattr(worker, "_read_name", lambda *_a, **_k: "notes.pdf")
    monkeypatch.setattr(worker, "_finish_fail", lambda *a, **k: failed.append((a, k)))
    monkeypatch.setattr(worker.progress, "publish", lambda *_a, **_k: None)

    from pipeline.jobs import TerminalError

    with pytest.raises(TerminalError, match="actorUserId"):
        await worker.process_ingest_job(
            {
                "id": "job_1",
                "attempts": 1,
                "payload": _ingest_payload(actorUserId=""),
            }
        )

    assert failed == []


async def test_admission_refusal_passes_the_full_source_identity(monkeypatch):
    failed: list[dict] = []
    payload = _ingest_payload()
    monkeypatch.setattr(worker, "_file_exists", lambda *_a: True)
    monkeypatch.setattr(worker, "_read_name", lambda *_a: "notes.txt")
    monkeypatch.setattr(worker, "_require_current_source", lambda *_a: None)
    monkeypatch.setattr(worker, "_account_allows_ingest", lambda *_a: False)
    monkeypatch.setattr(
        worker, "_finish_fail", lambda **values: failed.append(values) or True
    )
    monkeypatch.setattr(worker.progress, "publish", lambda *_a, **_k: None)

    await worker._process_ingest_job(
        {"id": "job_refused", "type": "ingest", "attempts": 1},
        payload,
        "f_1",
        "ws_1",
        "txt",
        _plan(ingest_plan.RAW_TEXT, format_name="txt"),
    )

    assert failed == [
        {
            "file_id": "f_1",
            "job_id": "job_refused",
            "error": "notes.txt: ingest refused because the account is locked or over quota.",
            "attempt": 1,
            "reservation_id": "cr_1",
            "source_revision": 1,
            "source_etag": "etag-a",
            "actor_user_id": "u_1",
            "workspace_id": "ws_1",
            "error_category": "accounting",
            "error_code": "ingest_admission_refused",
        }
    ]


async def test_lost_claim_does_not_publish_a_stale_terminal_progress(monkeypatch):
    events: list[tuple] = []
    payload = _ingest_payload()
    monkeypatch.setattr(worker, "_file_exists", lambda *_a: True)
    monkeypatch.setattr(worker, "_read_name", lambda *_a: "notes.pdf")
    monkeypatch.setattr(worker, "_require_current_source", lambda *_a: None)
    monkeypatch.setattr(worker, "_account_allows_ingest", lambda *_a: True)
    monkeypatch.setattr(worker, "_finish_ok", lambda *_a, **_k: False)
    monkeypatch.setattr(
        worker.progress,
        "publish",
        lambda *args, **kwargs: events.append((args, kwargs)),
    )

    await worker._process_ingest_job(
        {"id": "job_lost", "attempts": 1},
        payload,
        "f_1",
        "ws_1",
        "pdf",
        _plan(ingest_plan.STORE_ONLY),
    )

    assert all(args[2] != "done" for args, _kwargs in events)


async def test_parsed_document_continuation_rechecks_account_lifecycle(monkeypatch):
    class ReachedPostProcessing(RuntimeError):
        pass

    async def _pin(_workspace_id):
        return {
            "embedding_dim": 2560,
            "embedding_provider_slug": "deepinfra",
            "embedding_model_slug": "Qwen/Qwen3-Embedding-4B",
            "embedding_model_version": 1,
        }

    async def _chunks(**_values):
        raise ReachedPostProcessing

    async def _no_donor(**_values):
        return None

    monkeypatch.setattr(worker, "_file_exists", lambda *_a: True)
    monkeypatch.setattr(worker, "_read_name", lambda *_a: "notes.pdf")
    monkeypatch.setattr(worker, "_require_current_source", lambda *_a: None)
    admission_checks: list[tuple] = []
    monkeypatch.setattr(
        worker,
        "_account_allows_ingest",
        lambda *args: admission_checks.append(args) or True,
    )
    monkeypatch.setattr(worker, "_record_source_sha", lambda *_a: None)
    monkeypatch.setattr(worker.store, "workspace_embedding_pin", _pin)
    monkeypatch.setattr(worker.store, "find_ready_donor", _no_donor)
    monkeypatch.setattr(
        worker,
        "_acquire_local_source",
        lambda *_a: (
            "/shared/sources/source-1",
            "sources/source-1",
            "aa" * 32,
            lambda: None,
        ),
    )
    monkeypatch.setattr(worker, "_chunks_for", _chunks)
    monkeypatch.setattr(worker.progress, "publish", lambda *_a, **_k: None)

    with pytest.raises(ReachedPostProcessing):
        await worker._process_ingest_job(
            {"id": "job_ingest", "type": "ingest", "attempts": 1},
            _ingest_payload(),
            "f_1",
            "ws_1",
            "pdf",
            _plan(),
        )

    assert admission_checks == [
        ("f_1", _ingest_payload()),
        ("f_1", _ingest_payload()),
    ]


async def test_text_sources_never_reach_the_parse_service(parse_stub, monkeypatch):
    monkeypatch.setattr(worker, "_read_text", lambda _p: "# Notes")
    monkeypatch.setattr(worker, "chunk_markdown", lambda text: [text])

    chunks, artifact_key, fingerprint, version = await worker._chunks_for(
        payload={"blobPath": "sources/notes.md"},
        name="notes.md",
        processing_plan=_plan(ingest_plan.RAW_TEXT, format_name="md"),
        local_path="/shared/sources/source-1",
        source_key="sources/source-1",
        ws="ws_1",
        file_id="f_1",
        source_sha256="aa" * 32,
    )

    assert chunks == ["# Notes"]
    assert (artifact_key, fingerprint, version) == (None, None, None)
    assert parse_stub["descriptor"] is None
    assert parse_stub["captioned"] == 0


async def test_json_sources_are_ingested_as_text(parse_stub, monkeypatch):
    monkeypatch.setattr(worker, "_read_text", lambda _p: '{"topic": "osmosis"}')
    monkeypatch.setattr(worker, "chunk_markdown", lambda text: [text])

    chunks, artifact_key, fingerprint, version = await worker._chunks_for(
        payload={"blobPath": "sources/data.json"},
        name="data.json",
        processing_plan=_plan(ingest_plan.RAW_TEXT, format_name="json"),
        local_path="/shared/sources/source-1",
        source_key="sources/source-1",
        ws="ws_1",
        file_id="f_1",
        source_sha256="aa" * 32,
    )

    assert chunks == ['{"topic": "osmosis"}']
    assert (artifact_key, fingerprint, version) == (None, None, None)
    assert parse_stub["descriptor"] is None
    assert parse_stub["captioned"] == 0


async def test_captioning_is_off_unless_the_upload_asked_for_it(parse_stub):
    await _run()

    assert parse_stub["captioned"] == 0
    assert "description" not in parse_stub["chunked"][1]


async def test_captions_reach_the_chunker(parse_stub):
    """The ordering the feature depends on: chunking must see the description,
    otherwise the figure is embedded as an empty block and stays unsearchable."""
    await _run(caption_images=True)

    assert parse_stub["captioned"] == 1
    assert parse_stub["chunked"][1]["description"] == "A labelled chloroplast."


@pytest.mark.parametrize("format_name", ["docx", "pptx", "xlsx"])
async def test_supported_office_routes_caption_parser_image_blocks(
    parse_stub, format_name: str
):
    await worker._chunks_for(
        payload={
            "blobPath": f"sources/lesson.{format_name}",
            "parseArtifact": _artifact(),
        },
        name=f"lesson.{format_name}",
        processing_plan=_plan(
            caption_images=True,
            format_name=format_name,
            office_preview=True,
        ),
        local_path="/shared/sources/source-1",
        source_key="sources/source-1",
        ws="ws_1",
        file_id="f_1",
        source_sha256="aa" * 32,
    )

    assert parse_stub["captioned"] == 1
    assert parse_stub["chunked"][1]["description"] == "A labelled chloroplast."


async def test_a_successful_parse_is_recorded_before_captioning(
    parse_stub, monkeypatch
):
    """A later vision failure must not leave the zip untracked for the reaper."""
    order: list[str] = []

    def _record(*_a, **_k):
        order.append("parse")

    async def _caption(**_k):
        order.append("caption")
        return {
            "selected": 0,
            "cached": 0,
            "captioned": 0,
            "decorative": 0,
            "applied": 0,
            "key": "",
        }

    monkeypatch.setattr(worker, "_record_parse_artifact", _record)
    monkeypatch.setattr(worker.figures, "caption_figures", _caption)

    await _run(caption_images=True)

    assert order == ["parse", "caption"]


def test_office_preview_is_shared_and_uploaded_as_pdf(tmp_path, monkeypatch):
    preview = tmp_path / "preview.pdf"
    preview.write_bytes(b"%PDF-coordinate-source")
    writes: list[tuple[str, bytes, str]] = []
    cache_rows: list[dict] = []
    file_rows: list[tuple[str, str]] = []
    monkeypatch.setattr(worker.blobstore, "object_info", lambda _key: None)
    monkeypatch.setattr(
        worker.blobstore,
        "write_bytes",
        lambda key, data, content_type: writes.append((key, data, content_type)),
    )
    monkeypatch.setattr(
        worker, "_touch_or_upsert_artifact", lambda **values: cache_rows.append(values)
    )
    monkeypatch.setattr(
        worker,
        "_record_preview_blob",
        lambda file_id, key, *_source: file_rows.append((file_id, key)),
    )

    key = worker._cache_office_preview(
        raw_dir=tmp_path,
        file_id="f_1",
        source_sha256="aa" * 32,
        parser_version="marker-v1",
        fingerprint="fp-1",
        source_revision=1,
        source_etag="etag-a",
        actor_user_id="u_actor",
    )

    assert key == f"previews/{'aa' * 32}/marker-v1/fp-1.pdf"
    assert writes == [(key, b"%PDF-coordinate-source", "application/pdf")]
    assert cache_rows[0]["kind"] == "office_preview"
    assert file_rows == [("f_1", key)]


def test_oversized_office_preview_is_not_read_uploaded_or_recorded(
    tmp_path, monkeypatch
):
    preview = tmp_path / "preview.pdf"
    preview.write_bytes(b"%PDF-too-large")
    events: list[str] = []
    monkeypatch.setattr(
        worker.cfg, "office_preview_max_bytes", preview.stat().st_size - 1
    )
    monkeypatch.setattr(
        worker.Path,
        "read_bytes",
        lambda _path: events.append("read") or b"",
    )
    monkeypatch.setattr(
        worker.blobstore,
        "object_info",
        lambda _key: events.append("inspect") or None,
    )
    monkeypatch.setattr(
        worker.blobstore,
        "write_bytes",
        lambda *_args: events.append("write"),
    )
    monkeypatch.setattr(
        worker, "_touch_or_upsert_artifact", lambda **_values: events.append("touch")
    )
    monkeypatch.setattr(
        worker, "_record_preview_blob", lambda *_args: events.append("record")
    )

    key = worker._cache_office_preview(
        raw_dir=tmp_path,
        file_id="f_1",
        source_sha256="aa" * 32,
        parser_version="marker-v1",
        fingerprint="fp-1",
        source_revision=1,
        source_etag="etag-a",
        actor_user_id="u_actor",
    )

    assert key is None
    assert events == []


def test_office_preview_growth_during_read_is_not_uploaded_or_recorded(
    tmp_path, monkeypatch
):
    preview = tmp_path / "preview.pdf"
    original = b"%PDF-safe"
    preview.write_bytes(original)
    reads: list[int] = []
    events: list[str] = []

    class ChangedPreview(io.BytesIO):
        def read(self, size=-1):
            reads.append(size)
            return super().read(size)

    monkeypatch.setattr(worker.cfg, "office_preview_max_bytes", len(original))
    monkeypatch.setattr(
        worker.Path,
        "open",
        lambda *_args, **_kwargs: ChangedPreview(original + b"-grown"),
    )
    monkeypatch.setattr(worker.blobstore, "object_info", lambda _key: None)
    monkeypatch.setattr(
        worker.blobstore,
        "write_bytes",
        lambda *_args: events.append("write"),
    )
    monkeypatch.setattr(
        worker, "_touch_or_upsert_artifact", lambda **_values: events.append("touch")
    )
    monkeypatch.setattr(
        worker, "_record_preview_blob", lambda *_args: events.append("record")
    )

    key = worker._cache_office_preview(
        raw_dir=tmp_path,
        file_id="f_1",
        source_sha256="aa" * 32,
        parser_version="marker-v1",
        fingerprint="fp-1",
        source_revision=1,
        source_etag="etag-a",
        actor_user_id="u_actor",
    )

    assert key is None
    assert reads == [len(original) + 1]
    assert events == []


@pytest.mark.parametrize(
    ("cached", "info"),
    [
        (b"not-a-pdf-object", {"size": 16, "content_type": "application/pdf"}),
        (b"", {"size": 0, "content_type": "application/pdf"}),
        (b"%PDF-old", {"size": 8, "content_type": "application/octet-stream"}),
    ],
    ids=["wrong-bytes", "empty", "wrong-content-type"],
)
def test_invalid_existing_office_preview_is_replaced_from_validated_bundle(
    tmp_path, monkeypatch, cached: bytes, info: dict
):
    preview = tmp_path / "preview.pdf"
    local = b"%PDF-current-preview"
    preview.write_bytes(local)
    writes: list[tuple[str, bytes, str]] = []
    monkeypatch.setattr(worker.blobstore, "object_info", lambda _key: info)
    monkeypatch.setattr(worker.blobstore, "read_bytes", lambda _key, _limit: cached)
    monkeypatch.setattr(
        worker.blobstore,
        "write_bytes",
        lambda key, data, content_type: writes.append((key, data, content_type)),
    )
    monkeypatch.setattr(worker, "_touch_or_upsert_artifact", lambda **_values: None)
    monkeypatch.setattr(worker, "_record_preview_blob", lambda *_values: None)

    key = worker._cache_office_preview(
        raw_dir=tmp_path,
        file_id="f_1",
        source_sha256="aa" * 32,
        parser_version="marker-v1",
        fingerprint="fp-1",
        source_revision=1,
        source_etag="etag-a",
        actor_user_id="u_actor",
    )

    assert key is not None
    assert writes == [(key, local, "application/pdf")]


async def test_required_office_preview_failure_stops_ingest_ready_path(
    parse_stub, monkeypatch
):
    monkeypatch.setattr(worker, "_cache_office_preview", lambda **_kwargs: None)

    with pytest.raises(worker.RetryableError, match="required Office preview"):
        await worker._chunks_for(
            payload={
                "actorUserId": "u_actor",
                "blobPath": "sources/lesson.docx",
                "parseArtifact": _artifact(),
                "sourceETag": "etag-a",
                "sourceRevision": 1,
            },
            name="lesson.docx",
            processing_plan=_plan(format_name="docx", office_preview=True),
            local_path="/shared/sources/source-1",
            source_key="sources/source-1",
            ws="ws_1",
            file_id="f_1",
            source_sha256="aa" * 32,
        )


def test_office_donor_requires_an_existing_exact_preview(monkeypatch):
    donor = {"preview_blob_path": "previews/source/marker/fingerprint.pdf"}

    monkeypatch.setattr(worker.blobstore, "object_info", lambda _key: None)
    assert worker._donor_office_preview("lesson.docx", donor) is None

    preview = b"%PDF-" + b"x" * 2043
    monkeypatch.setattr(
        worker.blobstore,
        "object_info",
        lambda _key: {"size": len(preview), "content_type": "application/pdf"},
    )
    monkeypatch.setattr(worker.blobstore, "read_bytes", lambda _key, _limit: preview)
    assert (
        worker._donor_office_preview("lesson.docx", donor) == donor["preview_blob_path"]
    )
    assert worker._donor_office_preview("lesson.pdf", {}) == ""

    monkeypatch.setattr(
        worker.blobstore,
        "object_info",
        lambda _key: (_ for _ in ()).throw(OSError("B2 unavailable")),
    )
    assert worker._donor_office_preview("lesson.docx", donor) is None


def test_reused_preview_is_attached_only_when_the_object_exists(monkeypatch):
    touched: list[dict] = []
    attached: list[tuple[str, str]] = []
    monkeypatch.setattr(worker.blobstore, "object_info", lambda _key: None)
    monkeypatch.setattr(
        worker, "_touch_or_upsert_artifact", lambda **values: touched.append(values)
    )
    monkeypatch.setattr(
        worker,
        "_record_preview_blob",
        lambda file_id, key, *_source: attached.append((file_id, key)),
    )

    values = {
        "file_id": "f_1",
        "source_sha256": "aa" * 32,
        "preview_blob_path": "previews/source/marker/fingerprint.pdf",
        "source_revision": 1,
        "source_etag": "etag-a",
        "actor_user_id": "u_actor",
    }
    assert not worker._reuse_office_preview(**values)
    assert touched == []
    assert attached == []

    preview = b"%PDF-" + b"x" * 2043
    monkeypatch.setattr(
        worker.blobstore,
        "object_info",
        lambda _key: {"size": len(preview), "content_type": "application/pdf"},
    )
    monkeypatch.setattr(worker.blobstore, "read_bytes", lambda _key, _limit: preview)
    assert worker._reuse_office_preview(**values)
    assert touched == [
        {
            "object_path": values["preview_blob_path"],
            "kind": "office_preview",
            "source_sha256": values["source_sha256"],
            "size_bytes": 2048,
            "strict": True,
        }
    ]
    assert attached == [("f_1", values["preview_blob_path"])]

    touched.clear()
    attached.clear()
    monkeypatch.setattr(
        worker.blobstore,
        "object_info",
        lambda _key: (_ for _ in ()).throw(OSError("B2 unavailable")),
    )
    assert not worker._reuse_office_preview(**values)
    assert touched == []
    assert attached == []


def test_oversized_cached_preview_is_not_reused_or_recorded(monkeypatch):
    touched: list[dict] = []
    attached: list[tuple] = []
    monkeypatch.setattr(worker.cfg, "office_preview_max_bytes", 1024)
    monkeypatch.setattr(worker.blobstore, "object_info", lambda _key: {"size": 1025})
    monkeypatch.setattr(
        worker, "_touch_or_upsert_artifact", lambda **values: touched.append(values)
    )
    monkeypatch.setattr(
        worker, "_record_preview_blob", lambda *values: attached.append(values)
    )

    assert not worker._reuse_office_preview(
        file_id="f_1",
        source_sha256="aa" * 32,
        preview_blob_path="previews/source/marker/fingerprint.pdf",
        source_revision=1,
        source_etag="etag-a",
        actor_user_id="u_actor",
    )
    assert (
        worker._donor_office_preview(
            "lesson.docx",
            {"preview_blob_path": "previews/source/marker/fingerprint.pdf"},
        )
        is None
    )
    assert touched == []
    assert attached == []


async def test_donor_preview_is_attached_before_the_destination_becomes_ready(
    monkeypatch,
):
    order: list[str] = []

    async def _pin(_workspace_id):
        return {
            "embedding_provider_slug": "deepinfra",
            "embedding_model_slug": "Qwen/Qwen3-Embedding-4B",
            "embedding_model_version": 1,
            "embedding_dim": 2560,
        }

    async def _attach(**_kwargs):
        return {"content_id": "rgc_dest", "created": True, "ready": False}

    async def _wait(association, **_kwargs):
        return association

    async def _copy(**_kwargs):
        order.append("copy")
        return True

    async def _ready(*_args, **_kwargs):
        order.append("ready")

    monkeypatch.setattr(worker.store, "workspace_embedding_pin", _pin)
    monkeypatch.setattr(worker.store, "attach_file_content", _attach)
    monkeypatch.setattr(worker, "_wait_for_content", _wait)
    monkeypatch.setattr(worker.store, "copy_content_from_donor", _copy)
    monkeypatch.setattr(worker.store, "mark_content_ready", _ready)
    monkeypatch.setattr(
        worker,
        "_reuse_office_preview",
        lambda **_kwargs: order.append("preview") or True,
    )
    monkeypatch.setattr(
        worker,
        "_finish_ok",
        lambda *_args, **_kwargs: order.append("file-ready") or True,
    )
    monkeypatch.setattr(worker.progress, "publish", lambda *_args, **_kwargs: None)

    reused = await worker._reuse_donor(
        job={"id": "job_1", "attempts": 1},
        payload={
            "actorUserId": "u_1",
            "reservationId": "cr_1",
            "sourceRevision": 1,
            "sourceETag": "etag-a",
        },
        file_id="f_1",
        ws="ws_1",
        name="lesson.docx",
        kind="doc",
        route=ingest_plan.DOCUMENT_PARSE,
        donor={
            "id": "rgc_donor",
            "content_hash": "content-hash",
            "embedding_provider_slug": "deepinfra",
            "embedding_model_slug": "Qwen/Qwen3-Embedding-4B",
            "embedding_model_version": 1,
            "embedding_dim": 2560,
        },
        identity="pipeline-v1",
        source_sha256="aa" * 32,
        preview_blob_path="previews/source/marker/fingerprint.pdf",
    )

    assert reused
    assert order == ["copy", "preview", "ready", "file-ready"]


def test_content_hash_includes_citation_geometry():
    from pipeline.retrieval.chunking import Chunk, Region

    first = [
        Chunk(
            text="Identical words",
            page_start=1,
            page_end=1,
            regions=[Region(page=1, bbox=[10, 20, 30, 40])],
        )
    ]
    same = [
        Chunk(
            text="Identical words",
            page_start=1,
            page_end=1,
            regions=[Region(page=1, bbox=[10, 20, 30, 40])],
        )
    ]
    moved = [
        Chunk(
            text="Identical words",
            page_start=2,
            page_end=2,
            regions=[Region(page=2, bbox=[100, 200, 300, 400])],
        )
    ]

    assert worker.indexing.content_hash(first) == worker.indexing.content_hash(same)
    assert worker.indexing.content_hash(first) != worker.indexing.content_hash(moved)


def test_the_source_is_downloaded_once_while_hashing_real_bytes(monkeypatch, tmp_path):
    """The uploader controls the checksum header, so it cannot be the cache key.

    Browsers PUT through a presigned URL that signs host and content-type only,
    leaving ``x-amz-checksum-sha256`` free for the client to set. Trusting it
    would let anyone claim the hash of a document they do not have and be handed
    that document's chunks and summary by the donor lookup.
    """
    import hashlib
    import io

    from pipeline.store import blobstore

    body = b"the real bytes"
    forged = hashlib.sha256(b"someone else's document").hexdigest()

    class FakeS3:
        def head_object(self, **_kwargs):
            return {"ContentLength": len(body), "ChecksumSHA256": forged}

        def get_object(self, **_kwargs):
            return {"Body": io.BytesIO(body)}

    monkeypatch.setattr(blobstore, "_s3_client", FakeS3)

    local_path, source_key, digest, cleanup = blobstore.fetch_local_hashed(
        "sources/f_1.pdf", str(tmp_path)
    )
    try:
        assert Path(local_path).read_bytes() == body
        assert source_key.startswith("sources/source-")
        assert digest == hashlib.sha256(body).hexdigest()
    finally:
        cleanup()


def test_a_vanished_source_reads_as_missing_rather_than_an_s3_error(
    monkeypatch, tmp_path
):
    from botocore.exceptions import ClientError

    from pipeline.store import blobstore

    class FakeS3:
        def get_object(self, **_kwargs):
            raise ClientError({"Error": {"Code": "NoSuchKey"}}, "GetObject")

    monkeypatch.setattr(blobstore, "_s3_client", FakeS3)

    with pytest.raises(FileNotFoundError):
        blobstore.fetch_local_hashed("sources/gone.pdf", str(tmp_path))


def test_persisted_local_source_is_checksum_verified_before_reuse(tmp_path):
    import hashlib

    from pipeline.store import blobstore

    source = tmp_path / "sources" / "source-1"
    source.parent.mkdir()
    source.write_bytes(b"document")
    digest = hashlib.sha256(b"document").hexdigest()

    local_path, key, actual, cleanup = blobstore.reuse_local_hashed(
        "sources/source-1", digest, str(tmp_path)
    )
    assert Path(local_path) == source
    assert key == "sources/source-1"
    assert actual == digest

    source.write_bytes(b"tampered")
    with pytest.raises(ValueError, match="checksum mismatch"):
        blobstore.reuse_local_hashed("sources/source-1", digest, str(tmp_path))
    assert not source.exists()
    cleanup()


async def test_a_full_parse_queue_puts_the_job_back_without_burning_an_attempt(
    parse_stub, monkeypatch, tmp_path
):
    """When every parser slot is taken, the file stays pending and the attempt is undone."""
    from pipeline.jobs import CapacityWait

    yielded: list[str] = []
    downloads = 0

    async def _pin(_ws):
        return object()

    async def _embed_pin(_ws):
        return {
            "embedding_dim": 2560,
            "embedding_provider_slug": "deepinfra",
            "embedding_model_slug": "Qwen/Qwen3-Embedding-4B",
            "embedding_model_version": 1,
        }

    async def _no_donor(**_k):
        return None

    monkeypatch.setattr(worker, "_workspace_embedding_spec", _pin)
    monkeypatch.setattr(worker.store, "workspace_embedding_pin", _embed_pin)
    monkeypatch.setattr(
        worker.registry, "pins_from_payload", lambda *_a, **_k: object()
    )
    monkeypatch.setattr(worker.registry, "set_job_pins", lambda *_a, **_k: None)
    monkeypatch.setattr(worker, "_file_exists", lambda *_a, **_k: True)
    monkeypatch.setattr(worker, "_read_name", lambda *_a, **_k: "notes.pdf")
    monkeypatch.setattr(worker, "_account_allows_ingest", lambda *_a, **_k: True)
    monkeypatch.setattr(worker, "_record_source_sha", lambda *_a, **_k: None)
    monkeypatch.setattr(worker, "_require_current_source", lambda *_a, **_k: None)

    class FakeS3:
        def get_object(self, **_kwargs):
            nonlocal downloads
            downloads += 1
            return {"Body": io.BytesIO(b"document")}

    monkeypatch.setattr(worker.cfg, "parse_shared_dir", str(tmp_path))
    monkeypatch.setattr(worker.blobstore, "_s3_client", FakeS3)
    monkeypatch.setattr(worker, "_remember_local_source", lambda *_a, **_k: None)
    monkeypatch.setattr(worker.store, "find_ready_donor", _no_donor)
    monkeypatch.setattr(worker.slots, "try_acquire", lambda *_a, **_k: False)
    monkeypatch.setattr(
        worker, "_yield_for_capacity", lambda job, *_a, **_k: yielded.append(job["id"])
    )

    job = {
        "id": "job_wait",
        "type": "parse",
        "attempts": 1,
        "payload": _ingest_payload(),
    }
    for _ in range(2):
        with pytest.raises(CapacityWait):
            await worker.process_ingest_job(job)

    assert yielded == ["job_wait", "job_wait"]
    assert downloads == 1
    assert parse_stub["descriptor"] is None
    worker._cleanup_payload_source(job["payload"])


async def test_confirmed_parser_oom_is_terminal_and_releases_its_slot(monkeypatch):
    from pipeline.jobs import TerminalError

    released: list[tuple[str, str]] = []
    monkeypatch.setattr(worker.slots, "try_acquire", lambda *_a: True)
    monkeypatch.setattr(
        worker.slots,
        "release",
        lambda route, job_id: released.append((route, job_id)),
    )
    monkeypatch.setattr(worker, "_set_file_status", lambda *_a: None)
    monkeypatch.setattr(worker.progress, "publish", lambda *_a, **_k: None)
    monkeypatch.setattr(
        worker.parser_client,
        "ensure_artifact",
        lambda *_a: (_ for _ in ()).throw(
            parser_client.ParserOOMError("memory exhausted")
        ),
    )

    with pytest.raises(TerminalError, match="terminal parser resource limit"):
        await worker._ensure_document_artifact(
            job={"id": "job_parse", "attempts": 1},
            payload=_ingest_payload(),
            name="notes.pdf",
            processing_plan=_plan(),
            source_key="sources/source-1",
            source_sha256="aa" * 32,
            workspace_id="ws_1",
            file_id="f_1",
        )

    assert released == [(parser_client.ROUTE_FAST, "job_parse")]


async def test_text_sources_do_not_take_a_gpu_slot(parse_stub, monkeypatch):
    taken: list[tuple] = []
    monkeypatch.setattr(worker, "_read_text", lambda _p: "# Notes")
    monkeypatch.setattr(worker, "chunk_markdown", lambda text: [text])
    monkeypatch.setattr(worker, "_set_file_status", lambda *_a, **_k: None)
    monkeypatch.setattr(
        worker.slots, "try_acquire", lambda *a, **k: taken.append((a, k)) or True
    )

    await worker._chunks_for(
        payload={"blobPath": "sources/notes.md"},
        name="notes.md",
        processing_plan=_plan(ingest_plan.RAW_TEXT, format_name="md"),
        local_path="/shared/sources/source-1",
        source_key="sources/source-1",
        ws="ws_1",
        file_id="f_1",
        source_sha256="aa" * 32,
        job_id="job_1",
    )

    assert taken == []


async def test_audio_ingest_downloads_source_before_synchronous_transcription(
    monkeypatch,
):
    from pipeline.jobs import CapacityWait

    async def _pin(_workspace_id):
        return {
            "embedding_dim": 2560,
            "embedding_provider_slug": "deepinfra",
            "embedding_model_slug": "Qwen/Qwen3-Embedding-4B",
            "embedding_model_version": 1,
        }

    async def _chunks(**values):
        assert values["local_path"] == "/shared/lecture.mp3"
        assert values["source_key"] == "sources/lecture.mp3"
        assert values["source_sha256"] == "aa" * 32
        raise CapacityWait("provider capacity")

    async def _donor(**_values):
        return None

    monkeypatch.setattr(worker, "_file_exists", lambda *_a: True)
    monkeypatch.setattr(worker, "_read_name", lambda *_a: "lecture.mp3")
    monkeypatch.setattr(worker, "_require_current_source", lambda *_a: None)
    monkeypatch.setattr(worker, "_account_allows_ingest", lambda *_a: True)
    monkeypatch.setattr(worker, "_record_source_sha", lambda *_a: None)
    monkeypatch.setattr(worker.store, "workspace_embedding_pin", _pin)
    monkeypatch.setattr(
        worker,
        "_acquire_local_source",
        lambda *_a: (
            "/shared/lecture.mp3",
            "sources/lecture.mp3",
            "aa" * 32,
            lambda: None,
        ),
    )
    monkeypatch.setattr(worker.store, "find_ready_donor", _donor)
    monkeypatch.setattr(worker, "_chunks_for", _chunks)
    monkeypatch.setattr(worker.progress, "publish", lambda *_a, **_k: None)

    payload = _ingest_payload(
        blobPath="sources/lecture.mp3",
        kind="audio",
    )
    plan = _plan(ingest_plan.AUDIO_TRANSCRIPTION, format_name="mp3")
    with pytest.raises(CapacityWait):
        await worker._process_ingest_job(
            {"id": "job_audio", "attempts": 1},
            payload,
            "f_1",
            "ws_1",
            "audio",
            plan,
        )


async def test_a_missing_ingest_field_fails_without_retry():
    from pipeline.jobs import TerminalError

    payload = _ingest_payload()
    del payload["processingPlan"]
    with pytest.raises(TerminalError, match="processing plan"):
        await worker.process_ingest_job(
            {"id": "job_1", "attempts": 1, "payload": payload}
        )


async def test_a_missing_source_etag_fails_explicitly():
    from pipeline.jobs import TerminalError

    payload = _ingest_payload()
    del payload["sourceETag"]
    with pytest.raises(TerminalError, match="sourceETag"):
        await worker.process_ingest_job(
            {"id": "job_1", "attempts": 1, "payload": payload}
        )


def test_caption_blob_pointer_is_best_effort(monkeypatch, caplog):
    def fail_pointer_write(*_args, **_kwargs):
        raise RuntimeError("database unavailable")

    monkeypatch.setattr(worker, "_record_caption_blob", fail_pointer_write)

    worker._record_caption_blob_best_effort(
        "f_1",
        "captions/source/v1.json",
        1,
        "etag-a",
        "u_1",
    )

    assert "could not record optional caption cache identity" in caplog.text


async def test_legacy_route_hints_are_not_required(monkeypatch):
    from pipeline.jobs import TerminalError

    async def _pin(_ws):
        raise TerminalError("stop after payload")

    monkeypatch.setattr(worker, "_workspace_embedding_spec", _pin)
    with pytest.raises(TerminalError, match="stop after payload"):
        await worker.process_ingest_job(
            {
                "id": "job_1",
                "attempts": 1,
                "payload": {
                    key: value
                    for key, value in _ingest_payload().items()
                    if key not in {"captionImages", "parseMode"}
                },
            }
        )


async def test_unknown_job_type_is_terminal():
    from pipeline.jobs import TerminalError

    with pytest.raises(TerminalError, match="unknown job type"):
        await worker.process_job({"id": "job_1", "type": "summarize", "payload": {}})


async def test_blank_job_type_is_terminal():
    from pipeline.jobs import TerminalError

    with pytest.raises(TerminalError, match="missing job type"):
        await worker.process_job({"id": "job_1", "type": "", "payload": {}})


async def test_retry_records_parse_attempt_before_requeue(monkeypatch):
    from pipeline.jobs import RetryableError

    order: list[tuple[str, str]] = []

    def _record(*_args, **kwargs):
        order.append(("record", kwargs.get("outcome", _args[-1])))

    def _requeue(job, _error, **_classification):
        order.append(("requeue", job["id"]))
        return "pending"

    monkeypatch.setattr(worker, "_record_parse_attempt", _record)
    monkeypatch.setattr(worker, "_requeue", _requeue)
    monkeypatch.setattr(worker, "_require_current_source", lambda *_a, **_k: None)
    job = {
        "id": "job_metered_retry",
        "type": "parse",
        "attempts": 1,
        "payload": _ingest_payload(),
    }

    await worker._handle_job_failure(job, RetryableError("temporary"))

    assert order == [
        ("record", "retrying"),
        ("requeue", "job_metered_retry"),
    ]


async def test_post_parse_resource_failure_retries_without_parse_quarantine(
    monkeypatch,
):
    from pipeline.jobs import RetryableError

    events: list[tuple[str, str]] = []
    monkeypatch.setattr(worker, "_require_current_source", lambda *_a: None)
    monkeypatch.setattr(
        worker,
        "_record_parse_attempt",
        lambda *_a, **_k: events.append(("parse", "recorded")),
    )
    monkeypatch.setattr(
        worker,
        "_requeue",
        lambda job, _error, **_classification: (
            events.append(("requeue", job["id"])) or "pending"
        ),
    )

    await worker._handle_job_failure(
        {
            "id": "job_ingest",
            "type": "ingest",
            "attempts": 1,
            "payload": _ingest_payload(),
        },
        RetryableError("worker exceeded its memory allowance"),
    )

    assert events == [("requeue", "job_ingest")]


async def test_final_provider_receipt_failure_does_not_requeue_ingest(monkeypatch):
    events: list[tuple[str, str]] = []
    monkeypatch.setattr(worker, "_require_current_source", lambda *_a: None)
    monkeypatch.setattr(worker.obs, "capture_error", lambda *_a, **_k: None)
    monkeypatch.setattr(
        worker,
        "_requeue",
        lambda job, *_a, **_k: events.append(("requeue", job["id"])),
    )
    monkeypatch.setattr(
        worker,
        "_notify_ingest_terminal",
        lambda *_a, **_k: events.append(("terminal", "job_ingest")),
    )

    await worker._handle_job_failure(
        {
            "id": "job_ingest",
            "type": "ingest",
            "attempts": 1,
            "payload": _ingest_payload(),
        },
        worker.accounting.SettlementError("receipt rejected"),
    )

    assert events == [("terminal", "job_ingest")]


@pytest.mark.parametrize("direct", ["image", "audio"])
async def test_direct_donor_cache_failure_falls_through(monkeypatch, direct):
    async def embedding_pin(_workspace_id):
        return {
            "embedding_provider_slug": "provider",
            "embedding_model_slug": "model",
            "embedding_model_version": 1,
            "embedding_dim": 1024,
        }

    monkeypatch.setattr(worker.store, "workspace_embedding_pin", embedding_pin)

    async def unavailable_caption(*_args):
        raise OSError("B2 unavailable")

    monkeypatch.setattr(worker.caption_cache, "lookup", unavailable_caption)
    monkeypatch.setattr(
        worker.blobstore,
        "object_info",
        lambda _key: (_ for _ in ()).throw(OSError("B2 unavailable")),
    )
    monkeypatch.setattr(
        worker.store,
        "attach_file_content",
        lambda **_kwargs: (_ for _ in ()).throw(
            AssertionError("donor must not attach without its cache object")
        ),
    )

    reused = await worker._reuse_donor(
        job={"id": "job_ingest", "attempts": 1},
        payload=_ingest_payload(),
        file_id="f_1",
        ws="ws_1",
        name="diagram.png",
        kind="image",
        route=(
            ingest_plan.IMAGE_CAPTION
            if direct == "image"
            else ingest_plan.AUDIO_TRANSCRIPTION
        ),
        donor={
            "id": "content_donor",
            "content_hash": "hash",
            "embedding_provider_slug": "provider",
            "embedding_model_slug": "model",
            "embedding_model_version": 1,
            "embedding_dim": 1024,
        },
        identity="pipeline",
        source_sha256="ab" * 32,
    )

    assert reused is False


async def test_image_donor_reuses_authorized_caption_without_an_empty_artifact_key(
    monkeypatch,
):
    async def pin(_workspace):
        return {
            "embedding_provider_slug": "provider",
            "embedding_model_slug": "model",
            "embedding_model_version": 1,
            "embedding_dim": 1024,
        }

    async def caption(file_id, asset_id, digest, published, *, require_source_job):
        assert require_source_job
        assert (file_id, asset_id, digest, published) == ("f_1", None, "ab" * 32, True)
        return "caption", "image-captions/eligible.json", 20

    async def attached(**_kwargs):
        return {"ready": True, "content_id": "content_donor"}

    async def wait(association, **_kwargs):
        return association

    async def captions(**_kwargs):
        return True

    monkeypatch.setattr(worker.store, "workspace_embedding_pin", pin)
    monkeypatch.setattr(worker.caption_cache, "lookup", caption)
    monkeypatch.setattr(worker.store, "attach_file_content", attached)
    monkeypatch.setattr(worker, "_wait_for_content", wait)
    monkeypatch.setattr(worker.store, "attach_donor_captions", captions)
    monkeypatch.setattr(worker, "_finish_ok", lambda *_a, **_k: True)
    monkeypatch.setattr(worker, "_publish_progress", lambda *_a, **_k: None)
    monkeypatch.setattr(
        worker.blobstore,
        "object_info",
        lambda _key: (_ for _ in ()).throw(
            AssertionError("image captions use resource lookup")
        ),
    )
    assert await worker._reuse_donor(
        job={"id": "job_ingest", "attempts": 1},
        payload=_ingest_payload(),
        file_id="f_1",
        ws="ws_1",
        name="diagram.png",
        kind="image",
        route=ingest_plan.IMAGE_CAPTION,
        donor={"id": "content_donor", "content_hash": "hash"},
        identity="pipeline",
        source_sha256="ab" * 32,
    )


@pytest.mark.parametrize("during", ["requeue", "terminal"])
async def test_replacement_between_failure_check_and_job_write_closes_job(
    monkeypatch, during
):
    from pipeline.jobs import RetryableError, TerminalError

    finished: list[tuple[str, int, str]] = []
    job = {
        "id": "job_raced_replacement",
        "type": "ingest",
        "attempts": 1,
        "payload": _ingest_payload(),
    }
    monkeypatch.setattr(worker, "_require_current_source", lambda *_a: None)
    monkeypatch.setattr(worker, "_record_parse_attempt", lambda *_a, **_k: None)
    monkeypatch.setattr(
        worker,
        "_finish_superseded",
        lambda job_id, attempt, reservation_id: finished.append(
            (job_id, attempt, reservation_id)
        ),
    )

    if during == "requeue":
        monkeypatch.setattr(
            worker,
            "_requeue",
            lambda *_a, **_k: (_ for _ in ()).throw(
                worker.db.SourceSupersededError("replaced during requeue")
            ),
        )
        error = RetryableError("temporary")
    else:
        monkeypatch.setattr(worker.obs, "capture_error", lambda *_a, **_k: None)
        monkeypatch.setattr(
            worker,
            "_notify_ingest_terminal",
            lambda *_a, **_k: (_ for _ in ()).throw(
                worker.db.SourceSupersededError("replaced during terminal write")
            ),
        )
        error = TerminalError("permanent")

    await worker._handle_job_failure(job, error)

    assert finished == [("job_raced_replacement", 1, "cr_1")]


async def test_provider_busy_repends_until_the_cap_then_fails_the_file(monkeypatch):
    """A busy provider hands the attempt back at most PROVIDER_WAITS_MAX times."""
    from pipeline import elitellm
    from pipeline.jobs import PROVIDER_WAITS_MAX

    yields: list = []
    terminal: list = []
    requeued: list = []
    monkeypatch.setattr(worker, "_require_current_source", lambda *_a, **_k: None)
    monkeypatch.setattr(worker, "_read_name", lambda _fid: "notes.pdf")
    monkeypatch.setattr(
        worker, "_yield_for_capacity", lambda *a, **k: yields.append((a, k))
    )
    monkeypatch.setattr(worker, "_cleanup_payload_source", lambda _p: None)
    monkeypatch.setattr(
        worker, "_notify_ingest_terminal", lambda *a: terminal.append(a)
    )
    monkeypatch.setattr(worker.obs, "capture_error", lambda *_a, **_k: None)
    monkeypatch.setattr(
        worker, "_requeue", lambda *a, **_k: requeued.append(a) or "pending"
    )

    busy = elitellm.ProviderBusy(
        "slow down", status_code=429, retry_after=12, provider_retry_after=12
    )
    payload = _ingest_payload()
    payload["sourceRevision"] = 3
    job = {
        "id": "job_1",
        "type": "ingest",
        "attempts": 1,
        "provider_waits": 0,
        "payload": payload,
    }
    await worker._handle_job_failure(job, busy)
    assert requeued == [] and terminal == []
    ((args, kwargs),) = yields
    assert args[0] is job and args[1] == "f_1" and args[2] == "ws_1"
    assert args[7] == "waiting for the model to free up"
    assert args[8] == 12 and args[9] == "provider_busy"
    assert kwargs == {"count_provider_wait": True}

    job["provider_waits"] = PROVIDER_WAITS_MAX
    await worker._handle_job_failure(job, busy)
    assert len(yields) == 1 and requeued == []
    ((_fid, _ws, _job_id, _message, _attempts, _payload, category, code),) = terminal
    assert (category, code) == ("provider", "provider_busy")
