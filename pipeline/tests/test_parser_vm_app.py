from __future__ import annotations

import asyncio
import base64
import importlib.util
import json
import os
import sys
import threading
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor
from concurrent.futures.process import BrokenProcessPool
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
PARSER_VM_DIR = REPO_ROOT / "parser-vm"
if str(PARSER_VM_DIR) not in sys.path:
    sys.path.insert(0, str(PARSER_VM_DIR))

spec = importlib.util.spec_from_file_location("parser_vm_app", PARSER_VM_DIR / "app.py")
assert spec is not None and spec.loader is not None
parser_vm_app = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = parser_vm_app
spec.loader.exec_module(parser_vm_app)


@pytest.mark.asyncio
async def test_crashed_child_marks_parser_unhealthy_and_requests_restart(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pool = ProcessPoolExecutor(max_workers=1)
    try:
        with pytest.raises(BrokenProcessPool):
            await asyncio.wrap_future(pool.submit(os._exit, 17))

        runtime = parser_vm_app.ParserRuntime()
        runtime.pool = pool
        runtime.state = "ready"
        exits = 0

        def _record_exit() -> None:
            nonlocal exits
            exits += 1

        monkeypatch.setattr(parser_vm_app, "_terminate_process", _record_exit)
        monkeypatch.setattr(parser_vm_app, "runtime", runtime)

        with pytest.raises(RuntimeError, match="process pool failed"):
            await runtime.parse(
                parser_vm_app.Document(b"document", "document.pdf", "marker_only")
            )
        await asyncio.sleep(0)

        assert exits == 1
        assert runtime.state == "failed"
        response = await parser_vm_app.healthz()
        assert response.status_code == 503
        body = json.loads(response.body)
        assert body["ok"] is False
        assert body["state"] == "failed"
    finally:
        pool.shutdown(wait=True, cancel_futures=True)


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

    monkeypatch.setattr(parser_vm_app, "_produce_artifact", _produce)
    parser_vm_app._artifact_tasks.clear()
    body = {"source_fingerprint": "same"}

    first, retry = await asyncio.gather(
        parser_vm_app._artifact_task("same", body, b"source", 1),
        parser_vm_app._artifact_task("same", body, b"source", 1),
    )

    assert first is retry
    assert started == 1
    release.set()
    assert await first == ({"artifact": {"key": "artifacts/result.zip"}}, 200)
    await asyncio.sleep(0)
    await asyncio.sleep(0)
    assert "same" not in parser_vm_app._artifact_tasks


@pytest.mark.asyncio
async def test_concurrent_artifact_waiter_does_not_receive_creator_receipt(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(parser_vm_app, "_quarantine", lambda _fingerprint: None)
    monkeypatch.setattr(parser_vm_app, "_artifact_descriptor", lambda *_args: None)
    monkeypatch.setattr(parser_vm_app, "_read_source", lambda *_args: b"source")

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

    monkeypatch.setattr(parser_vm_app, "_artifact_task", _task)
    response = await parser_vm_app._artifact_parse(
        {
            "source_key": "sources/source-1",
            "source_sha256": "a" * 64,
            "output_key": "artifacts/fp.zip",
            "source_fingerprint": "fp",
            "request_id": "waiting-job",
            "artifact_schema": parser_vm_app.ARTIFACT_SCHEMA,
            "parser_version": parser_vm_app.PARSER_VERSION,
        }
    )

    assert json.loads(response.body) == {"artifact": {"key": "artifacts/fp.zip"}}


@pytest.mark.asyncio
async def test_hard_deadline_marks_runtime_failed_without_waiting_for_child(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    release = threading.Event()
    pool = ThreadPoolExecutor(max_workers=1)
    runtime = parser_vm_app.ParserRuntime()
    runtime.pool = pool
    runtime.state = "ready"
    monkeypatch.setattr(parser_vm_app, "PARSE_HARD_TIMEOUT_S", 0.01)
    monkeypatch.setattr(
        parser_vm_app,
        "parse_document",
        lambda *_args: release.wait(),
    )
    try:
        with pytest.raises(parser_vm_app.ParseHardTimeout, match="exceeded"):
            await runtime.parse(
                parser_vm_app.Document(b"document", "document.pdf", "marker_only")
            )
        assert runtime.state == "failed"
    finally:
        release.set()
        pool.shutdown(wait=True, cancel_futures=True)


@pytest.mark.asyncio
async def test_hard_deadline_also_covers_selective_ocr_probe(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import scan_pages

    release = threading.Event()
    runtime = parser_vm_app.ParserRuntime()
    runtime.pool = ThreadPoolExecutor(max_workers=1)
    runtime.state = "ready"
    monkeypatch.setattr(parser_vm_app, "PARSE_HARD_TIMEOUT_S", 0.01)
    monkeypatch.setattr(scan_pages, "probe_pages", lambda _data: release.wait())
    try:
        with pytest.raises(parser_vm_app.ParseHardTimeout, match="probe exceeded"):
            await runtime.parse(
                parser_vm_app.Document(
                    b"%PDF-malformed", "document.pdf", "selective_rapidocr"
                )
            )
        assert runtime.state == "failed"
    finally:
        release.set()
        runtime.pool.shutdown(wait=True, cancel_futures=True)


@pytest.mark.asyncio
async def test_hard_timeout_writes_versioned_quarantine_before_restart(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(parser_vm_app, "SHARED_DIR", tmp_path)

    async def timed_out(_document):
        raise parser_vm_app.ParseHardTimeout("too slow")

    monkeypatch.setattr(parser_vm_app, "_run", timed_out)
    payload, status = await parser_vm_app._produce_artifact(
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
    assert marker["parser_version"] == parser_vm_app.PARSER_VERSION


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

    monkeypatch.setattr(parser_vm_app, "RESTART_BACKSTOP_S", 0)
    monkeypatch.setattr(parser_vm_app, "_terminate_process", terminate)

    parser_vm_app._schedule_restart_backstop()
    await asyncio.wait_for(terminated.wait(), timeout=0.1)

    assert exits == 1


def test_shared_source_is_verified_before_parse(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(parser_vm_app, "SHARED_DIR", tmp_path)
    source = tmp_path / "sources" / "source-1"
    source.parent.mkdir(parents=True)
    source.write_bytes(b"document")

    import hashlib

    assert (
        parser_vm_app._read_source(
            "sources/source-1", hashlib.sha256(b"document").hexdigest()
        )
        == b"document"
    )
    with pytest.raises(ValueError, match="checksum mismatch"):
        parser_vm_app._read_source("sources/source-1", "0" * 64)


def test_artifact_write_is_local_atomic_and_path_bounded(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(parser_vm_app, "SHARED_DIR", tmp_path)

    parser_vm_app._write_artifact("artifacts/fingerprint.zip", b"zip")

    assert (tmp_path / "artifacts" / "fingerprint.zip").read_bytes() == b"zip"
    assert not list((tmp_path / "artifacts").glob("*.tmp"))
    with pytest.raises(ValueError, match="shared spool key"):
        parser_vm_app._write_artifact("artifacts/../../outside", b"bad")


def test_bundle_rejects_content_beyond_configured_budget(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(parser_vm_app, "MAX_CONTENT_BYTES", 64)

    with pytest.raises(ValueError, match="content list exceeds"):
        parser_vm_app._bundle_bytes(
            {"content_list": [{"type": "text", "text": "x" * 128}]},
            "fp",
            "job-1",
            {},
        )


def test_bundle_rejects_image_bytes_beyond_configured_budget(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(parser_vm_app, "MAX_IMAGE_BYTES", 8)

    with pytest.raises(ValueError, match="image exceeds"):
        parser_vm_app._bundle_bytes(
            {
                "content_list": [],
                "images": {"figure.png": base64.b64encode(b"x" * 9).decode()},
            },
            "fp",
            "job-1",
            {},
        )


def test_bundle_carries_creator_owned_parse_receipt() -> None:
    bundle = parser_vm_app._bundle_bytes(
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
