"""The retrieval process's own capacity (rate-limit audit M13, Epo 2026-10-24):
chat and generate requests past the process's request slots answer
provider_busy, Office captures past their slots answer busy instead of
queueing at the parser, and page renders run on the render pool instead of
the default executor every model call's admission uses."""

from __future__ import annotations

import asyncio
import threading
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from pipeline.retrieval import capture, contract, limits
from pipeline.retrieve import service

SECRET = "s" * 32
CHAT = {
    "thinking": "low",
    "query": "q",
    "workspaceId": "ws_1",
    "contractVersion": contract.VERSION,
    "operations": [],
    "spendSessionId": "cr_1",
    "role": "editor",
}
GENERATE = {
    "thinking": "low",
    "workspaceId": "ws_1",
    "kind": "mindmap",
    "types": ["recall"],
    "detail": "brief",
    "diagramType": "flowchart",
}


def test_chat_and_generate_answer_busy_past_the_request_slots(monkeypatch):
    """(security regression: rate-limit audit M13) A full process answers the
    existing 503 provider_busy with Retry-After; a finished request gives its
    slot back."""
    monkeypatch.setattr(service.cfg, "pipeline_secret", SECRET)
    monkeypatch.setattr(limits, "REQUEST_SLOTS", limits.Slots(1))
    runs: list[str] = []

    async def events(_req):
        runs.append("chat")
        yield "data: {}\n\n"

    async def generate(_req):
        runs.append("generate")
        return {"kind": "mindmap"}

    monkeypatch.setattr(service, "_chat_events", events)
    monkeypatch.setattr(service, "_generate", generate)
    http = TestClient(service.app)  # no lifespan: no database
    headers = {"X-Pipeline-Secret": SECRET}

    assert http.post("/chat/stream", json=CHAT, headers=headers).status_code == 200
    assert http.post("/generate", json=GENERATE, headers=headers).status_code == 200
    assert limits.REQUEST_SLOTS.used == 0

    assert limits.REQUEST_SLOTS.take()  # another request is running
    for path, body in (("/chat/stream", CHAT), ("/generate", GENERATE)):
        busy = http.post(path, json=body, headers=headers)
        assert busy.status_code == 503
        assert busy.headers["Retry-After"] == "5"
        assert busy.json()["code"] == "provider_busy"
    assert runs == ["chat", "generate"]
    assert limits.REQUEST_SLOTS.used == 1


async def _office_row(_workspace_id: str, _file_id: str) -> dict:
    return {
        "kind": "doc",
        "ever_parsed_successfully": True,
        "parse_mode": "fast",
        "blob_path": "objects/f_1",
        "size_bytes": 10,
    }


async def test_a_second_office_capture_answers_busy_while_one_runs(monkeypatch):
    """(security regression: rate-limit audit M13) Office captures share the
    parser's queue with ingest: past the process's slots a capture answers
    busy instead of sending another document to the parser."""
    monkeypatch.setattr(limits, "OFFICE_CAPTURE_SLOTS", limits.Slots(1))
    monkeypatch.setattr(capture.store, "file_page_source", _office_row)
    started, finish = threading.Event(), threading.Event()
    sent: list[int] = []

    def office(_row, page, _bbox, _max_edge):
        sent.append(page)
        started.set()
        finish.wait(10)
        return b"\xff\xd8", [0.0, 0.0, 1000.0, 1000.0], (1, 1)

    monkeypatch.setattr(capture, "_office_capture", office)
    first = asyncio.create_task(capture.render_file("ws_1", "f_1", 1, None, 64))
    await asyncio.to_thread(started.wait, 10)

    with pytest.raises(capture.CaptureUnavailable, match="busy") as busy:
        await capture.render_file("ws_1", "f_1", 2, None, 64)
    assert busy.value.code == "unavailable_target"
    finish.set()
    await first
    assert sent == [1]
    assert limits.OFFICE_CAPTURE_SLOTS.used == 0

    await capture.render_file("ws_1", "f_1", 3, None, 64)
    assert sent == [1, 3]


async def test_page_renders_run_on_the_render_pool(monkeypatch, tmp_path):
    """(security regression: rate-limit audit M13) PDF and image captures run
    on the bounded render pool, never on the default executor."""
    threads: list[str] = []

    def rendered(*_args):
        threads.append(threading.current_thread().name)
        return b"\xff\xd8", [0.0, 0.0, 1000.0, 1000.0], (1, 1)

    async def pdf_path(_workspace_id, _file_id) -> Path:
        return tmp_path / "source.pdf"

    rows = iter([{"kind": "pdf"}, {"kind": "image", "blob_path": "objects/f_2"}])

    async def row(_workspace_id, _file_id):
        return next(rows)

    monkeypatch.setattr(capture.store, "file_page_source", row)
    monkeypatch.setattr(capture, "pdf_path", pdf_path)
    monkeypatch.setattr(capture, "render", rendered)
    monkeypatch.setattr(capture, "_image_capture", rendered)

    await capture.render_file("ws_1", "f_1", 1, None, 64)
    await capture.render_file("ws_1", "f_2", 1, None, 64)
    assert len(threads) == 2
    assert all(name.startswith("capy-render") for name in threads)
    assert limits._render_pool._max_workers == limits.RENDER_THREADS
