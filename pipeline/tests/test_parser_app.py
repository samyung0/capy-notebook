"""Offline tests for the parser service runtime: bounded FIFO, hard deadline and
quarantine, the receipt keys the worker bills from, and the bundle contract."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import importlib.util
import io
import json
import sys
import time
import zipfile
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
PARSER_DIR = REPO_ROOT / "parser"
if str(PARSER_DIR) not in sys.path:
    sys.path.insert(0, str(PARSER_DIR))

spec = importlib.util.spec_from_file_location("app", PARSER_DIR / "app.py")
assert spec is not None and spec.loader is not None
parser_app = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = parser_app
spec.loader.exec_module(parser_app)


def _result(pages: int = 1, ocr: list[int] | None = None) -> dict:
    return {
        "content_list": [{"type": "text", "text": "a", "page_idx": 0}],
        "md": "a",
        "images": {},
        "_ocr_pages": ocr or [],
        "_page_count": pages,
        "_source_format": "pdf",
        "_parse_lane": "ocr" if ocr else "digital",
        "_phases": {"java": 0.5, "repairs": 0.25},
    }


def _runtime() -> parser_app.ParserRuntime:
    async def run(document):
        return await asyncio.to_thread(parser_app.run_document, document)

    return parser_app.ParserRuntime(run)


@pytest.mark.asyncio
async def test_parse_child_is_persistent_and_contains_document_errors(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(parser_app, "WORK_DIR", tmp_path)
    runtime = parser_app.ParserRuntime()
    await runtime.start()
    assert runtime._parse_process is not None
    assert runtime._parse_process._process is not None
    pid = runtime._parse_process._process.pid
    try:
        for name in ("first.txt", "second.txt"):
            with pytest.raises(
                ValueError, match="document parsing supports PDF and Office files"
            ):
                await runtime.parse(parser_app.Document(b"not a document", name))
            assert runtime.ready
            assert runtime._parse_process._process.pid == pid
    finally:
        await runtime.close()

    assert not list(tmp_path.glob("transfer-*"))


@pytest.mark.asyncio
async def test_documents_run_one_at_a_time_in_arrival_order(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    order: list[str] = []
    active = peak = 0

    def run_document(document):
        nonlocal active, peak
        active += 1
        peak = max(peak, active)
        time.sleep(0.01)
        order.append(document.name)
        active -= 1
        return _result()

    monkeypatch.setattr(parser_app, "run_document", run_document)
    monkeypatch.setattr(parser_app, "QUEUE_DEPTH", 4)
    runtime = _runtime()
    await runtime.start()
    try:
        results = await asyncio.gather(
            *(
                runtime.parse(parser_app.Document(b"pdf", f"{n}.pdf"))
                for n in ("first", "second", "third")
            )
        )
    finally:
        await runtime.close()

    assert order == ["first.pdf", "second.pdf", "third.pdf"]
    assert peak == 1
    assert all(queue_ms >= 0 for _result, queue_ms in results)
    assert runtime.documents_completed == 3


@pytest.mark.asyncio
async def test_a_fifth_document_is_refused_while_four_are_held(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    release = asyncio.Event()
    loop = asyncio.get_running_loop()

    def run_document(_document):
        asyncio.run_coroutine_threadsafe(release.wait(), loop).result()
        return _result()

    monkeypatch.setattr(parser_app, "run_document", run_document)
    monkeypatch.setattr(parser_app, "QUEUE_DEPTH", 4)
    runtime = _runtime()
    await runtime.start()
    try:
        held = [
            asyncio.create_task(runtime.parse(parser_app.Document(b"pdf", f"{n}.pdf")))
            for n in range(4)
        ]
        await asyncio.sleep(0.02)
        assert runtime.active_jobs == 4
        with pytest.raises(parser_app.ParserCapacity):
            await runtime.parse(parser_app.Document(b"pdf", "fifth.pdf"))
        release.set()
        await asyncio.gather(*held)
    finally:
        await runtime.close()
    assert runtime.active_jobs == 0


@pytest.mark.asyncio
async def test_cancelling_a_queued_request_removes_only_that_work(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(parser_app, "QUEUE_DEPTH", 2)
    first_started = asyncio.Event()
    release_first = asyncio.Event()
    executed: list[str] = []

    async def run(document):
        executed.append(document.name)
        if document.name == "first.pdf":
            first_started.set()
            await release_first.wait()
        return _result()

    runtime = parser_app.ParserRuntime(run)
    await runtime.start()
    try:
        first = asyncio.create_task(
            runtime.parse(parser_app.Document(b"", "first.pdf"))
        )
        await first_started.wait()
        cancelled = asyncio.create_task(
            runtime.parse(parser_app.Document(b"", "cancelled.pdf"))
        )
        await asyncio.sleep(0)
        assert runtime.active_jobs == 2

        cancelled.cancel()
        with pytest.raises(asyncio.CancelledError):
            await cancelled
        assert runtime.active_jobs == 1
        assert runtime.health()["queued_jobs"] == 0

        replacement = asyncio.create_task(
            runtime.parse(parser_app.Document(b"", "replacement.pdf"))
        )
        await asyncio.sleep(0)
        assert runtime.active_jobs == 2
        release_first.set()
        await asyncio.gather(first, replacement)
    finally:
        release_first.set()
        await runtime.close()

    assert executed == ["first.pdf", "replacement.pdf"]
    assert runtime.active_jobs == 0


@pytest.mark.asyncio
async def test_cancelling_an_executing_request_keeps_deadline_and_admission(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(parser_app, "QUEUE_DEPTH", 1)
    monkeypatch.setattr(parser_app, "PARSE_DOCUMENT_TIMEOUT_S", 0.05)
    monkeypatch.setattr(parser_app, "SHARED_DIR", tmp_path)
    monkeypatch.setattr(parser_app, "_schedule_restart_backstop", lambda: None)
    started = asyncio.Event()
    release = asyncio.Event()

    async def run(_document):
        started.set()
        await release.wait()
        return _result()

    runtime = parser_app.ParserRuntime(run)
    await runtime.start()
    try:
        request = asyncio.create_task(
            runtime.parse(parser_app.Document(b"", "cancelled.pdf"))
        )
        await started.wait()
        assert runtime._current is not None
        owned_future = runtime._current.future

        request.cancel()
        with pytest.raises(asyncio.CancelledError):
            await request
        assert runtime.active_jobs == 1
        assert not owned_future.done()
        with pytest.raises(parser_app.ParserCapacity):
            await runtime.parse(parser_app.Document(b"", "over-admitted.pdf"))

        for _ in range(20):
            if runtime.state == "failed":
                break
            await asyncio.sleep(0.01)
        assert runtime.state == "failed"
        assert isinstance(owned_future.exception(), parser_app.ParseHardTimeout)
        assert runtime.active_jobs == 1
        assert not (tmp_path / "quarantine").exists()

        release.set()
        for _ in range(20):
            if runtime.active_jobs == 0:
                break
            await asyncio.sleep(0.01)
        assert runtime.active_jobs == 0
    finally:
        release.set()
        await runtime.close()


@pytest.mark.asyncio
async def test_hard_deadline_quarantines_the_fingerprint_and_restarts(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The deadline starts when the document leaves the queue; the executing
    fingerprint is quarantined, waiting documents fail as runtime failures."""
    monkeypatch.setattr(parser_app, "SHARED_DIR", tmp_path)
    monkeypatch.setattr(parser_app, "PARSE_DOCUMENT_TIMEOUT_S", 0.05)
    monkeypatch.setattr(parser_app, "RESTART_BACKSTOP_S", 60)
    restarts: list[float] = []
    monkeypatch.setattr(
        parser_app, "_schedule_restart_backstop", lambda: restarts.append(1)
    )
    release = asyncio.Event()
    loop = asyncio.get_running_loop()

    def run_document(_document):
        asyncio.run_coroutine_threadsafe(release.wait(), loop).result()
        return _result()

    monkeypatch.setattr(parser_app, "run_document", run_document)
    runtime = _runtime()
    terminations = 0

    class ParseProcess:
        @property
        def alive(self):
            return True

        def terminate(self):
            nonlocal terminations
            terminations += 1

        def stop(self):
            pass

    runtime._parse_process = ParseProcess()
    await runtime.start()
    try:
        slow = asyncio.create_task(
            runtime.parse(
                parser_app.Document(b"pdf", "slow.pdf", fingerprint="slow-fp")
            )
        )
        waiting = asyncio.create_task(
            runtime.parse(
                parser_app.Document(b"pdf", "next.pdf", fingerprint="next-fp")
            )
        )
        with pytest.raises(parser_app.ParseHardTimeout):
            await slow
        with pytest.raises(parser_app.ParserRuntimeFailure):
            await waiting
        assert runtime.state == "failed" and restarts and terminations == 1
        release.set()
    finally:
        await runtime.close()

    marker = json.loads((tmp_path / "quarantine" / "slow-fp.json").read_text())
    assert marker["reason"] == "parse_hard_timeout"
    assert marker["parser_version"] == parser_app.PARSER_VERSION
    assert not (tmp_path / "quarantine" / "next-fp.json").exists()


@pytest.mark.asyncio
async def test_ordinary_child_failure_retries_all_jobs_without_quarantine(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(parser_app, "SHARED_DIR", tmp_path)
    monkeypatch.setattr(parser_app, "_schedule_restart_backstop", lambda: None)
    started = asyncio.Event()
    release = asyncio.Event()

    async def fail(_document):
        started.set()
        await release.wait()
        raise parser_app.ParserRuntimeFailure("child exited")

    runtime = parser_app.ParserRuntime(fail)
    await runtime.start()
    try:
        active = asyncio.create_task(
            runtime.parse(parser_app.Document(b"", "active.pdf", "active-fp"))
        )
        await started.wait()
        queued = asyncio.create_task(
            runtime.parse(parser_app.Document(b"", "queued.pdf", "queued-fp"))
        )
        await asyncio.sleep(0)
        assert runtime.active_jobs == 2
        release.set()
        for task in (active, queued):
            with pytest.raises(parser_app.ParserRuntimeFailure, match="child exited"):
                await task
    finally:
        await runtime.close()

    assert not (tmp_path / "quarantine").exists()


@pytest.mark.asyncio
async def test_java_timeout_is_a_hard_timeout(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(parser_app, "SHARED_DIR", tmp_path)
    monkeypatch.setattr(parser_app, "_schedule_restart_backstop", lambda: None)

    def run_document(_document):
        raise parser_app.JavaTimeout("OpenDataLoader exceeded 600 seconds")

    monkeypatch.setattr(parser_app, "run_document", run_document)
    runtime = _runtime()
    await runtime.start()
    try:
        with pytest.raises(parser_app.ParseHardTimeout):
            await runtime.parse(parser_app.Document(b"pdf", "a.pdf", fingerprint="fp"))
    finally:
        await runtime.close()
    assert (tmp_path / "quarantine" / "fp.json").exists()


def test_oom_kill_marks_only_executing_fingerprint_terminal(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(parser_app, "SHARED_DIR", tmp_path)
    monkeypatch.setattr(parser_app, "_schedule_restart_backstop", lambda: None)
    loop = asyncio.new_event_loop()
    try:
        active = parser_app._QueuedDocument(
            parser_app.Document(b"", "a.pdf", "active-fp"), 0.0, loop.create_future()
        )
        queued = parser_app._QueuedDocument(
            parser_app.Document(b"", "b.pdf", "queued-fp"), 0.0, loop.create_future()
        )
        runtime = parser_app.ParserRuntime()
        runtime._current = active
        runtime._queue.append(queued)
        runtime._record_oom_kill(1)

        assert isinstance(active.future.exception(), parser_app.ParseOOM)
        assert isinstance(queued.future.exception(), parser_app.ParserRuntimeFailure)
        marker = json.loads((tmp_path / "quarantine" / "active-fp.json").read_text())
        assert marker["reason"] == "parse_oom"
        assert not (tmp_path / "quarantine" / "queued-fp.json").exists()
    finally:
        loop.close()


def test_late_oom_event_does_not_quarantine_a_completed_document(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(parser_app, "SHARED_DIR", tmp_path)
    monkeypatch.setattr(parser_app, "_schedule_restart_backstop", lambda: None)
    loop = asyncio.new_event_loop()
    try:
        finished = parser_app._QueuedDocument(
            parser_app.Document(b"", "done.pdf", "done-fp"),
            0.0,
            loop.create_future(),
        )
        finished.future.set_result((_result(), 0))
        runtime = parser_app.ParserRuntime()
        runtime._current = finished

        runtime._record_oom_kill(1)

        assert finished.future.result() == (_result(), 0)
        assert not (tmp_path / "quarantine" / "done-fp.json").exists()
    finally:
        loop.close()


def test_receipt_keeps_the_metering_keys_and_counts_ocr_routed_pages() -> None:
    """Billing reads _page_count and _ocr_page_count; the other keys keep their
    names for usage_events and Ops even though documents are no longer sliced."""
    values = parser_app._measurements(_result(pages=40, ocr=[3, 7]), 1.5, 120)

    assert values["_page_count"] == 40
    assert values["_ocr_page_count"] == 2
    assert values["_slice_count"] == 1
    assert values["_queue_ms"] == 120
    assert values["_server_parse_ms"] == 1500
    assert values["_execution_ms"] == 750
    assert values["_parse_lane"] == "ocr"
    assert values["_source_format"] == "pdf"
    for key in (
        "_worker_cpu_ms",
        "_worker_rss_bytes",
        "_worker_pss_bytes",
        "_worker_io_read_bytes",
        "_worker_io_write_bytes",
        "_parse_method",
    ):
        assert key in values


@pytest.mark.asyncio
async def test_health_keeps_slice_keys_as_zeros() -> None:
    runtime = _runtime()
    await runtime.start()
    try:
        health = runtime.health()
    finally:
        await runtime.close()
    for key in ("active_slices", "queued_slices"):
        assert health[key] == 0
    for key in ("oldest_active_slice_s", "oldest_queued_slice_s"):
        assert health[key] == 0.0
    assert health["last_slice_completed_age_s"] is None
    assert health["cgroup_oom_kill_events"] == 0


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

    async def _result_task():
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
        return asyncio.create_task(_result_task())

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
async def test_artifact_request_rejects_a_foreign_parser_version() -> None:
    response = await parser_app._artifact_parse(
        {
            "source_key": "sources/source-1",
            "source_sha256": "a" * 64,
            "output_key": "artifacts/fp.zip",
            "source_fingerprint": "fp",
            "request_id": "job",
            "artifact_schema": parser_app.ARTIFACT_SCHEMA,
            "parser_version": "some-other-parser-v1+" + "0" * 40,
        }
    )
    assert response.status_code == 400


@pytest.mark.asyncio
async def test_hard_timeout_response_asks_for_a_restart(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
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


def test_bundle_layout_carries_receipt_preview_and_rewritten_image_paths() -> None:
    """The capy-parser-bundle-v3 entries the worker validates and extracts;
    ``parsed.pdf`` rides along only when font repair changed the bytes."""
    png = base64.b64encode(b"\x89PNG fake").decode()
    bundle = parser_app._bundle_bytes(
        {
            "content_list": [
                {"type": "image", "img_path": "document_images/imageFile1.png"},
                {"type": "text", "text": "body", "page_idx": 0},
            ],
            "md": "# doc",
            "images": {"imageFile1.png": png},
            "_preview_pdf": b"%PDF-1.7 preview",
            "_parsed_pdf": b"%PDF-1.7 repaired",
            "_furniture": ["Running header", "p."],
        },
        "fp",
        "job-1",
        {"_page_count": 3, "_server_parse_ms": 100},
    )

    with zipfile.ZipFile(io.BytesIO(bundle)) as archive:
        names = sorted(archive.namelist())
        manifest = json.loads(archive.read("manifest.json"))
        content = json.loads(archive.read("content_list.json"))
        assert archive.read("preview.pdf").startswith(b"%PDF")
        assert archive.read("parsed.pdf") == b"%PDF-1.7 repaired"
        assert json.loads(archive.read("refinement.json")) == {
            "furniture": ["Running header", "p."]
        }
    assert names == [
        "content_list.json",
        "document.md",
        "images/imageFile1.png",
        "manifest.json",
        "parsed.pdf",
        "preview.pdf",
        "refinement.json",
    ]
    assert manifest["schema"] == "capy-parser-bundle-v3"
    assert manifest["parser_version"] == parser_app.PARSER_VERSION
    assert manifest["source_fingerprint"] == "fp"
    assert manifest["parse_receipt"] == {
        "id": "fp",
        "request_id": "job-1",
        "measurements": {"_page_count": 3, "_server_parse_ms": 100},
    }
    assert content[0]["img_path"] == "images/imageFile1.png"


def test_bundle_without_font_repair_carries_no_parsed_pdf() -> None:
    bundle = parser_app._bundle_bytes(
        {"content_list": [], "md": "", "images": {}, "_furniture": []},
        "fp",
        "job-1",
        {},
    )
    with zipfile.ZipFile(io.BytesIO(bundle)) as archive:
        assert sorted(archive.namelist()) == [
            "content_list.json",
            "document.md",
            "manifest.json",
            "refinement.json",
        ]
