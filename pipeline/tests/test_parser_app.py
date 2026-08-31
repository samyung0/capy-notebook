from __future__ import annotations

import asyncio
import base64
import importlib.util
import json
import sys
import threading
import time
from collections import deque
from concurrent.futures.process import BrokenProcessPool
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
PARSER_DIR = REPO_ROOT / "parser"
if str(PARSER_DIR) not in sys.path:
    sys.path.insert(0, str(PARSER_DIR))

spec = importlib.util.spec_from_file_location("parser_app", PARSER_DIR / "app.py")
assert spec is not None and spec.loader is not None
parser_app = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = parser_app
spec.loader.exec_module(parser_app)


@pytest.mark.asyncio
async def test_large_pdf_is_sliced_and_never_exceeds_four_parses(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    active = peak = calls = 0
    lock = threading.Lock()

    def parse_slice(_data, _name, page_slice, _method):
        nonlocal active, peak, calls
        with lock:
            active += 1
            calls += 1
            peak = max(peak, active)
        time.sleep(0.01)
        with lock:
            active -= 1
        return parser_app.SliceResult(
            page_slice=page_slice,
            content_list=[
                {
                    "type": "text",
                    "text": str(page_slice.start),
                    "page_idx": page_slice.start,
                }
            ],
            markdown=str(page_slice.start),
            images={},
            ocr_enabled=False,
        )

    monkeypatch.setattr(
        parser_app,
        "normalize_document",
        lambda data, name: parser_app.NormalizedDocument(data, name, "pdf"),
    )
    monkeypatch.setattr(parser_app, "pdf_page_count", lambda _data: 610)
    monkeypatch.setattr(parser_app, "parse_slice", parse_slice)
    monkeypatch.setattr(parser_app, "SLICE_PAGES", 26)
    monkeypatch.setattr(parser_app, "PARSE_CONCURRENCY", 4)
    runtime = parser_app.ParserRuntime()
    await runtime.start()
    try:
        result, _queue_ms = await runtime.parse(
            parser_app.Document(b"pdf", "biology.pdf", "auto")
        )
    finally:
        await runtime.close()

    assert calls == 24
    assert peak == 4
    assert result["_slice_count"] == 24
    assert result["content_list"][-1]["page_idx"] == 598
    assert runtime.models_loaded is True


@pytest.mark.asyncio
async def test_slice_queue_rotates_between_documents() -> None:
    runtime = parser_app.ParserRuntime()
    loop = asyncio.get_running_loop()
    document = parser_app.NormalizedDocument(b"pdf", "doc.pdf", "pdf")

    def work(document_id: str, page: int):
        return parser_app._QueuedSlice(
            document_id=document_id,
            document=document,
            page_slice=parser_app.PageSlice(page, page),
            parse_method="auto",
            enqueued_at=time.perf_counter(),
            future=loop.create_future(),
        )

    runtime._document_queues = {
        "a": deque([work("a", 0), work("a", 1)]),
        "b": deque([work("b", 0), work("b", 1)]),
    }
    runtime._document_order = deque(["a", "b"])
    runtime.queued_slices = 4

    claimed = [await runtime._next_slice() for _ in range(4)]

    assert [item.document_id for item in claimed] == ["a", "b", "a", "b"]


@pytest.mark.asyncio
async def test_slice_timeout_excludes_queue_wait(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    blocker_started = threading.Event()
    release_blocker = threading.Event()

    def parse_slice(_data, name, page_slice, _method):
        if name == "blocker.pdf":
            blocker_started.set()
            release_blocker.wait(timeout=1)
        return parser_app.SliceResult(
            page_slice=page_slice,
            content_list=[],
            markdown="",
            images={},
            ocr_enabled=False,
        )

    monkeypatch.setattr(parser_app, "PARSE_CONCURRENCY", 1)
    monkeypatch.setattr(parser_app, "PARSE_SLICE_TIMEOUT_S", 0.05)
    monkeypatch.setattr(parser_app, "parse_slice", parse_slice)
    monkeypatch.setattr(
        parser_app,
        "normalize_document",
        lambda data, name: parser_app.NormalizedDocument(data, name, "pdf"),
    )
    monkeypatch.setattr(parser_app, "pdf_page_count", lambda _data: 1)
    runtime = parser_app.ParserRuntime()
    loop = asyncio.get_running_loop()
    blocker_future = loop.create_future()
    blocker = parser_app._QueuedSlice(
        document_id="blocker",
        document=parser_app.NormalizedDocument(b"pdf", "blocker.pdf", "pdf"),
        page_slice=parser_app.PageSlice(0, 0),
        parse_method="auto",
        enqueued_at=time.perf_counter(),
        future=blocker_future,
    )
    await runtime.start()
    try:
        async with runtime._condition:
            runtime._document_queues["blocker"] = deque([blocker])
            runtime._document_order.append("blocker")
            runtime.queued_slices += 1
            runtime._condition.notify_all()
        assert await asyncio.to_thread(blocker_started.wait, 0.2)
        queued_parse = asyncio.create_task(
            runtime.parse(parser_app.Document(b"pdf", "queued.pdf", "auto"))
        )
        await asyncio.sleep(0.1)
        assert not queued_parse.done()
        release_blocker.set()
        await blocker_future
        result, queue_ms = await queued_parse
    finally:
        release_blocker.set()
        await runtime.close()

    assert result["_page_count"] == 1
    assert result["_execution_ms"] < 50
    assert queue_ms >= 50


@pytest.mark.asyncio
async def test_slice_timeout_stops_whole_document_after_lane_budget(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    release = threading.Event()
    started_pages: list[int] = []
    restarts = 0

    def schedule_restart() -> None:
        nonlocal restarts
        restarts += 1

    def parse_slice(_data, _name, page_slice, _method):
        started_pages.append(page_slice.start)
        release.wait(timeout=1)
        return parser_app.SliceResult(page_slice, [], "", {}, False)

    monkeypatch.setattr(parser_app, "PARSE_CONCURRENCY", 1)
    monkeypatch.setattr(parser_app, "PARSE_SLICE_TIMEOUT_S", 0.02)
    monkeypatch.setattr(parser_app, "SHARED_DIR", tmp_path)
    monkeypatch.setattr(parser_app, "_schedule_restart_backstop", schedule_restart)
    monkeypatch.setattr(parser_app, "parse_slice", parse_slice)
    monkeypatch.setattr(
        parser_app,
        "normalize_document",
        lambda data, name: parser_app.NormalizedDocument(data, name, "pdf"),
    )
    monkeypatch.setattr(parser_app, "pdf_page_count", lambda _data: 53)
    runtime = parser_app.ParserRuntime()
    await runtime.start()
    try:
        with pytest.raises(parser_app.ParseHardTimeout, match="parse slice pages 1-26"):
            await asyncio.wait_for(
                runtime.parse(
                    parser_app.Document(
                        b"pdf", "slow.pdf", "auto", fingerprint="slow-fp"
                    )
                ),
                timeout=0.2,
            )
        assert started_pages == [0]
        assert runtime.queued_slices == 0
        assert runtime.state == "failed"
        assert restarts == 1
        marker = json.loads((tmp_path / "quarantine" / "slow-fp.json").read_text())
        assert marker["reason"] == "parse_hard_timeout"
    finally:
        release.set()
        await runtime.close()


@pytest.mark.asyncio
async def test_document_admission_is_bounded_by_slice_concurrency(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    started = threading.Event()
    release = threading.Event()

    def parse_slice(_data, _name, page_slice, _method):
        started.set()
        release.wait(timeout=1)
        return parser_app.SliceResult(page_slice, [], "", {}, False)

    monkeypatch.setattr(parser_app, "PARSE_CONCURRENCY", 1)
    monkeypatch.setattr(parser_app, "parse_slice", parse_slice)
    monkeypatch.setattr(
        parser_app,
        "normalize_document",
        lambda data, name: parser_app.NormalizedDocument(data, name, "pdf"),
    )
    monkeypatch.setattr(parser_app, "pdf_page_count", lambda _data: 1)
    runtime = parser_app.ParserRuntime()
    await runtime.start()
    first = asyncio.create_task(
        runtime.parse(parser_app.Document(b"pdf", "first.pdf", "auto"))
    )
    try:
        assert await asyncio.to_thread(started.wait, 0.2)
        with pytest.raises(parser_app.ParserCapacity, match="queue is full"):
            await runtime.parse(parser_app.Document(b"pdf", "second.pdf", "auto"))
    finally:
        release.set()
        await first
        await runtime.close()


@pytest.mark.asyncio
async def test_broken_mineru_pool_marks_runtime_failed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    restarts = 0

    def schedule_restart() -> None:
        nonlocal restarts
        restarts += 1

    def parse_slice(*_args):
        raise BrokenProcessPool("A child process terminated abruptly")

    monkeypatch.setattr(parser_app, "PARSE_CONCURRENCY", 1)
    monkeypatch.setattr(parser_app, "_schedule_restart_backstop", schedule_restart)
    monkeypatch.setattr(parser_app, "parse_slice", parse_slice)
    monkeypatch.setattr(
        parser_app,
        "normalize_document",
        lambda data, name: parser_app.NormalizedDocument(data, name, "pdf"),
    )
    monkeypatch.setattr(parser_app, "pdf_page_count", lambda _data: 1)
    runtime = parser_app.ParserRuntime()
    await runtime.start()
    try:
        with pytest.raises(parser_app.ParserRuntimeFailure, match="process pool"):
            await runtime.parse(parser_app.Document(b"pdf", "broken.pdf", "auto"))
        assert runtime.state == "failed"
        assert restarts >= 1
    finally:
        await runtime.close()


def test_oom_kill_marks_only_executing_fingerprint_terminal(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(parser_app, "SHARED_DIR", tmp_path)
    monkeypatch.setattr(parser_app, "_schedule_restart_backstop", lambda: None)
    loop = asyncio.new_event_loop()
    try:
        active = loop.create_future()
        queued = loop.create_future()
        runtime = parser_app.ParserRuntime()
        runtime._executions = {
            "active": parser_app._DocumentExecution(
                "active-fp", [active], active_slices=1
            ),
            "queued": parser_app._DocumentExecution("queued-fp", [queued]),
        }
        runtime._record_oom_kill(1)

        assert isinstance(active.exception(), parser_app.ParseOOM)
        assert isinstance(queued.exception(), parser_app.ParserRuntimeFailure)
        marker = json.loads((tmp_path / "quarantine" / "active-fp.json").read_text())
        assert marker["reason"] == "parse_oom"
        assert not (tmp_path / "quarantine" / "queued-fp.json").exists()
    finally:
        loop.close()


@pytest.mark.asyncio
async def test_same_artifact_fingerprint_shares_inflight_parse(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    started = 0
    release = asyncio.Event()

    async def _produce(_body, _source, _source_read_ms):
        nonlocal started
        started += 1
        await release.wait()
        return {"artifact": {"key": "artifacts/result.zip"}}, 200

    monkeypatch.setattr(parser_app, "_produce_artifact", _produce)
    parser_app._artifact_tasks.clear()
    body = {"source_fingerprint": "same"}

    first, retry = await asyncio.gather(
        parser_app._artifact_task("same", body, b"source", 1),
        parser_app._artifact_task("same", body, b"source", 1),
    )

    assert first is retry
    assert started == 1
    release.set()
    assert await first == ({"artifact": {"key": "artifacts/result.zip"}}, 200)
    await asyncio.sleep(0)
    await asyncio.sleep(0)
    assert "same" not in parser_app._artifact_tasks


@pytest.mark.asyncio
async def test_concurrent_artifact_waiter_does_not_receive_creator_receipt(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(parser_app, "_quarantine", lambda _fingerprint: None)
    monkeypatch.setattr(parser_app, "_artifact_descriptor", lambda *_args: None)
    monkeypatch.setattr(parser_app, "_read_source", lambda *_args: b"source")

    async def _result():
        return (
            {
                "artifact": {"key": "artifacts/fp.zip"},
                "_receipt_request_id": "creator-job",
                "_receipt_id": "fp",
                "_page_count": 3,
            },
            200,
        )

    async def _task(*_args):
        return asyncio.create_task(_result())

    monkeypatch.setattr(parser_app, "_artifact_task", _task)
    response = await parser_app._artifact_parse(
        {
            "source_key": "sources/source-1",
            "source_sha256": "a" * 64,
            "output_key": "artifacts/fp.zip",
            "source_fingerprint": "fp",
            "request_id": "waiting-job",
            "artifact_schema": parser_app.ARTIFACT_SCHEMA,
            "parser_version": parser_app.PARSER_VERSION,
        }
    )

    assert json.loads(response.body) == {"artifact": {"key": "artifacts/fp.zip"}}


@pytest.mark.asyncio
async def test_hard_timeout_writes_versioned_quarantine_before_restart(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(parser_app, "SHARED_DIR", tmp_path)

    async def timed_out(_document):
        raise parser_app.ParseHardTimeout("too slow")

    monkeypatch.setattr(parser_app, "_run", timed_out)
    payload, status = await parser_app._produce_artifact(
        {
            "output_key": "artifacts/fp.zip",
            "source_fingerprint": "fp",
            "request_id": "job-1",
        },
        b"source",
        1,
    )

    assert status == 422
    assert payload["code"] == "parse_hard_timeout"
    assert payload["_restart_parser"] is True
    marker = json.loads((tmp_path / "quarantine" / "fp.json").read_text())
    assert marker["reason"] == "parse_hard_timeout"
    assert marker["parser_version"] == parser_app.PARSER_VERSION


@pytest.mark.asyncio
async def test_restart_backstop_does_not_depend_on_response_delivery(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    exits = 0
    terminated = asyncio.Event()

    def terminate() -> None:
        nonlocal exits
        exits += 1
        terminated.set()

    monkeypatch.setattr(parser_app, "RESTART_BACKSTOP_S", 0)
    monkeypatch.setattr(parser_app, "_terminate_process", terminate)

    parser_app._schedule_restart_backstop()
    await asyncio.wait_for(terminated.wait(), timeout=0.1)

    assert exits == 1


def test_shared_source_is_verified_before_parse(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(parser_app, "SHARED_DIR", tmp_path)
    source = tmp_path / "sources" / "source-1"
    source.parent.mkdir(parents=True)
    source.write_bytes(b"document")

    import hashlib

    assert (
        parser_app._read_source(
            "sources/source-1", hashlib.sha256(b"document").hexdigest()
        )
        == b"document"
    )
    with pytest.raises(ValueError, match="checksum mismatch"):
        parser_app._read_source("sources/source-1", "0" * 64)


def test_artifact_write_is_local_atomic_and_path_bounded(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(parser_app, "SHARED_DIR", tmp_path)

    parser_app._write_artifact("artifacts/fingerprint.zip", b"zip")

    assert (tmp_path / "artifacts" / "fingerprint.zip").read_bytes() == b"zip"
    assert not list((tmp_path / "artifacts").glob("*.tmp"))
    with pytest.raises(ValueError, match="shared spool key"):
        parser_app._write_artifact("artifacts/../../outside", b"bad")


def test_bundle_rejects_content_beyond_configured_budget(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(parser_app, "MAX_CONTENT_BYTES", 64)

    with pytest.raises(ValueError, match="content list exceeds"):
        parser_app._bundle_bytes(
            {"content_list": [{"type": "text", "text": "x" * 128}]},
            "fp",
            "job-1",
            {},
        )


def test_bundle_rejects_image_bytes_beyond_configured_budget(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(parser_app, "MAX_IMAGE_BYTES", 8)

    with pytest.raises(ValueError, match="image exceeds"):
        parser_app._bundle_bytes(
            {
                "content_list": [],
                "images": {"figure.png": base64.b64encode(b"x" * 9).decode()},
            },
            "fp",
            "job-1",
            {},
        )


def test_bundle_carries_creator_owned_parse_receipt() -> None:
    bundle = parser_app._bundle_bytes(
        {"content_list": [], "images": {}},
        "fp",
        "job-1",
        {"_page_count": 3, "_server_parse_ms": 100},
    )

    import io
    import zipfile

    with zipfile.ZipFile(io.BytesIO(bundle)) as archive:
        manifest = json.loads(archive.read("manifest.json"))
    assert manifest["parse_receipt"] == {
        "id": "fp",
        "request_id": "job-1",
        "measurements": {"_page_count": 3, "_server_parse_ms": 100},
    }
