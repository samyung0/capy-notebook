"""Offline unit tests for the ingest worker's parse routing (no network).

Figure selection and captioning live in ``parse/figures.py`` and are tested
there. What is left here is the branching the worker owns: which parse route a
job's ``parseMode`` maps to, whether captioning runs at all, and — the ordering
the whole feature rests on — that captions are on the blocks before chunking, so
they reach embedding, summarization and concept extraction rather than arriving
after the passage they belong to has already been built.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from pipeline.ingest import worker
from pipeline.parse import modal_parser


@pytest.fixture
def parse_stub(monkeypatch):
    """Stand in for Modal and for the captioner; record how both were called."""
    state: dict[str, Any] = {
        "descriptor": None,
        "captioned": 0,
        "chunked": None,
    }
    content_list = [
        {"type": "text", "text": "Photosynthesis", "page_idx": 0, "text_level": 1},
        {"type": "image", "img_path": "images/fig.png", "page_idx": 0},
    ]

    def _parse(descriptor, _name, raw_dir: Path):
        state["descriptor"] = descriptor
        raw_dir.mkdir(parents=True, exist_ok=True)
        return content_list, "parsed/f_1/x.zip", "fp-1"

    async def _caption(*, content_list, raw_dir, file_name, source_sha256):
        state["captioned"] += 1
        content_list[1]["description"] = "A labelled chloroplast."
        return {
            "selected": 1,
            "cached": 0,
            "captioned": 1,
            "applied": 1,
            "key": "captions/k.json",
        }

    def _chunk(items):
        state["chunked"] = [dict(item) for item in items]
        return ["chunk"]

    monkeypatch.setattr(
        worker.blobstore, "object_info", lambda _p: {"etag": "e", "size": 9}
    )
    monkeypatch.setattr(worker.modal_parser, "parse_to_bundle", _parse)
    monkeypatch.setattr(worker.figures, "caption_figures", _caption)
    monkeypatch.setattr(worker, "chunk_content_list", _chunk)
    monkeypatch.setattr(worker, "_record_parse_artifact", lambda *a, **k: None)
    monkeypatch.setattr(worker, "_record_caption_blob", lambda *a, **k: None)
    monkeypatch.setattr(worker, "_touch_or_upsert_artifact", lambda **k: None)
    monkeypatch.setattr(worker.progress, "publish", lambda *_a, **_k: None)
    return state


async def _run(parse_mode: str, *, caption_images: bool = False):
    return await worker._chunks_for(
        payload={"blobPath": "sources/blob_1.pdf"},
        name="lecture.pdf",
        kind="pdf",
        parse_mode=parse_mode,
        caption_images=caption_images,
        ws="ws_1",
        file_id="f_1",
        source_sha256="aa" * 32,
    )


@pytest.mark.parametrize(
    ("parse_mode", "route"),
    [
        ("fast", modal_parser.ROUTE_FAST),
        ("accurate", modal_parser.ROUTE_FAST),
        # A job enqueued before the modes were renamed, or by a gateway running
        # older code: parse it rather than fail it.
        ("advanced", modal_parser.ROUTE_FAST),
    ],
)
async def test_the_parse_mode_selects_the_route(parse_stub, parse_mode, route):
    _, _, _, version = await _run(parse_mode)

    assert parse_stub["descriptor"]["route"] == route
    assert version == modal_parser.PARSER_VERSIONS[route]


async def test_an_unknown_parse_mode_fails_before_paying_for_a_parse(parse_stub):
    from pipeline.jobs import TerminalError

    with pytest.raises(TerminalError, match="unknown parse mode"):
        await _run("bogus")

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
                "payload": {"fileId": "f_1", "workspaceId": "ws_1"},
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
                "payload": {"fileId": "f_1", "workspaceId": "ws_1"},
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

    await worker.process_ingest_job(
        {
            "id": "job_1",
            "attempts": 1,
            "payload": {"fileId": "f_1", "workspaceId": "ws_1"},
        }
    )

    assert failed
    assert failed[0][0][0] == "f_1"


async def test_text_sources_never_reach_the_parse_service(parse_stub, monkeypatch):
    monkeypatch.setattr(
        worker.blobstore, "fetch_local", lambda _p: ("/tmp/notes.md", lambda: None)
    )
    monkeypatch.setattr(worker, "_read_text", lambda _p: "# Notes")
    monkeypatch.setattr(worker, "chunk_markdown", lambda text: [text])

    chunks, artifact_key, fingerprint, version = await worker._chunks_for(
        payload={"blobPath": "sources/notes.md"},
        name="notes.md",
        kind="md",
        parse_mode="fast",
        caption_images=True,
        ws="ws_1",
        file_id="f_1",
        source_sha256="aa" * 32,
    )

    assert chunks == ["# Notes"]
    assert (artifact_key, fingerprint, version) == (None, None, None)
    assert parse_stub["descriptor"] is None
    assert parse_stub["captioned"] == 0


async def test_json_sources_are_ingested_as_text(parse_stub, monkeypatch):
    monkeypatch.setattr(
        worker.blobstore, "fetch_local", lambda _p: ("/tmp/data.json", lambda: None)
    )
    monkeypatch.setattr(worker, "_read_text", lambda _p: '{"topic": "osmosis"}')
    monkeypatch.setattr(worker, "chunk_markdown", lambda text: [text])

    chunks, artifact_key, fingerprint, version = await worker._chunks_for(
        payload={"blobPath": "sources/data.json"},
        name="data.json",
        kind="json",
        parse_mode="none",
        caption_images=True,
        ws="ws_1",
        file_id="f_1",
        source_sha256="aa" * 32,
    )

    assert chunks == ['{"topic": "osmosis"}']
    assert (artifact_key, fingerprint, version) == (None, None, None)
    assert parse_stub["descriptor"] is None
    assert parse_stub["captioned"] == 0


async def test_captioning_is_off_unless_the_upload_asked_for_it(parse_stub):
    await _run("fast")

    assert parse_stub["captioned"] == 0
    assert "description" not in parse_stub["chunked"][1]


async def test_captions_reach_the_chunker(parse_stub):
    """The ordering the feature depends on: chunking must see the description,
    otherwise the figure is embedded as an empty block and stays unsearchable."""
    await _run("fast", caption_images=True)

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
        return {"selected": 0, "cached": 0, "captioned": 0, "applied": 0, "key": ""}

    monkeypatch.setattr(worker, "_record_parse_artifact", _record)
    monkeypatch.setattr(worker.figures, "caption_figures", _caption)

    await _run("fast", caption_images=True)

    assert order == ["parse", "caption"]


async def test_a_missing_source_blob_fails_before_paying_for_a_parse(
    parse_stub, monkeypatch
):
    from pipeline.jobs import TerminalError

    monkeypatch.setattr(worker.blobstore, "object_info", lambda _p: None)

    with pytest.raises(TerminalError, match="source blob is missing"):
        await _run("fast")

    assert parse_stub["descriptor"] is None


def test_the_source_hash_comes_from_the_bytes_not_the_stored_checksum(monkeypatch):
    """The uploader controls the checksum header, so it cannot be the cache key.

    Browsers PUT through a presigned URL that signs host and content-type only,
    leaving ``x-amz-checksum-sha256`` free for the client to set. Trusting it
    would let anyone claim the hash of a document they do not have and be handed
    that document's chunks, summary and concepts by the donor lookup.
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

    assert (
        blobstore.sha256_object("sources/f_1.pdf") == hashlib.sha256(body).hexdigest()
    )


def test_a_vanished_source_reads_as_missing_rather_than_an_s3_error(monkeypatch):
    from botocore.exceptions import ClientError

    from pipeline.store import blobstore

    class FakeS3:
        def get_object(self, **_kwargs):
            raise ClientError({"Error": {"Code": "NoSuchKey"}}, "GetObject")

    monkeypatch.setattr(blobstore, "_s3_client", FakeS3)

    with pytest.raises(FileNotFoundError):
        blobstore.sha256_object("sources/gone.pdf")


async def test_a_full_parse_queue_puts_the_job_back_without_burning_an_attempt(
    parse_stub, monkeypatch
):
    """When every GPU slot is taken, the file stays pending and the attempt is undone."""
    from pipeline.jobs import CapacityWait

    yielded: list[str] = []

    async def _pin(_ws):
        return object()

    async def _no_donor(**_k):
        return None

    monkeypatch.setattr(worker, "_workspace_embedding_spec", _pin)
    monkeypatch.setattr(
        worker.registry, "pins_from_payload", lambda *_a, **_k: object()
    )
    monkeypatch.setattr(worker.registry, "set_job_pins", lambda *_a, **_k: None)
    monkeypatch.setattr(worker, "_file_exists", lambda *_a, **_k: True)
    monkeypatch.setattr(worker, "_read_name", lambda *_a, **_k: "notes.pdf")
    monkeypatch.setattr(worker, "_account_allows_ingest", lambda *_a, **_k: True)
    monkeypatch.setattr(worker, "_record_source_sha", lambda *_a, **_k: None)
    monkeypatch.setattr(worker.blobstore, "sha256_object", lambda *_a: "aa" * 32)
    monkeypatch.setattr(worker.store, "find_ready_donor", _no_donor)
    monkeypatch.setattr(worker.slots, "try_acquire", lambda *_a, **_k: False)
    monkeypatch.setattr(
        worker, "_yield_for_capacity", lambda job, *_a, **_k: yielded.append(job["id"])
    )

    with pytest.raises(CapacityWait):
        await worker.process_ingest_job(
            {
                "id": "job_wait",
                "attempts": 1,
                "payload": {
                    "fileId": "f_1",
                    "workspaceId": "ws_1",
                    "blobPath": "sources/blob_1.pdf",
                    "kind": "pdf",
                    "parseMode": "fast",
                    "actorUserId": "u_1",
                },
            }
        )

    assert yielded == ["job_wait"]
    assert parse_stub["descriptor"] is None


async def test_text_sources_do_not_take_a_gpu_slot(parse_stub, monkeypatch):
    taken: list[tuple] = []
    monkeypatch.setattr(
        worker.blobstore, "fetch_local", lambda _p: ("/tmp/notes.md", lambda: None)
    )
    monkeypatch.setattr(worker, "_read_text", lambda _p: "# Notes")
    monkeypatch.setattr(worker, "chunk_markdown", lambda text: [text])
    monkeypatch.setattr(worker, "_set_file_status", lambda *_a, **_k: None)
    monkeypatch.setattr(
        worker.slots, "try_acquire", lambda *a, **k: taken.append((a, k)) or True
    )

    await worker._chunks_for(
        payload={"blobPath": "sources/notes.md"},
        name="notes.md",
        kind="md",
        parse_mode="fast",
        caption_images=True,
        ws="ws_1",
        file_id="f_1",
        source_sha256="aa" * 32,
        job_id="job_1",
    )

    assert taken == []
