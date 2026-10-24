"""The retrieval process's own capacity (rate-limit audit M13, Epo 2026-10-24):
generate requests past the process's request slots answer provider_busy and
chats wait for a slot in arrival order (Q268), Office captures past their
slots answer busy instead of queueing at the parser, and page renders run on
the render pool instead of the default executor every model call's admission
uses."""

from __future__ import annotations

import asyncio
import json
import threading
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from pipeline.retrieval import capture, contract, limits, models
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


def test_generate_answers_busy_past_the_request_slots(monkeypatch):
    """(security regression: rate-limit audit M13) A full process answers a
    generate request the existing 503 provider_busy with Retry-After; a
    finished request gives its slot back."""
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
    busy = http.post("/generate", json=GENERATE, headers=headers)
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


WAITING = {"type": "phase", "phase": "waiting_capacity"}


class _ChatStream:
    """One /chat/stream response driven over ASGI; ``left`` set is the client
    hanging up."""

    def __init__(self, query: str) -> None:
        self.left = asyncio.Event()
        self.frames: list[dict] = []
        self.task = asyncio.create_task(self._run(query))

    async def _run(self, query: str) -> None:
        response = await service.chat_stream(
            service.ChatStreamReq(**CHAT | {"query": query})
        )

        async def receive() -> dict:
            await self.left.wait()
            return {"type": "http.disconnect"}

        async def send(message: dict) -> None:
            if message["type"] == "http.response.body" and message.get("body"):
                text = message["body"].decode().removeprefix("data: ")
                self.frames.append(json.loads(text))

        await response({"type": "http"}, receive, send)


async def _until(condition) -> None:
    """Let the loop run until ``condition`` holds, a bounded number of steps."""
    for _ in range(1000):
        if condition():
            return
        await asyncio.sleep(0)
    raise AssertionError("the streams never got there")


def _chats(monkeypatch) -> list[str]:
    """Chats that ran, in order; each ends at once and frees its slot."""
    monkeypatch.setattr(limits, "REQUEST_SLOTS", limits.Slots(1))
    runs: list[str] = []

    async def events(req):
        runs.append(req.query)
        yield service._sse({"type": "done"})

    monkeypatch.setattr(service, "_chat_events", events)
    assert limits.REQUEST_SLOTS.take()  # another request is running
    return runs


async def test_a_chat_past_the_slots_waits_and_takes_the_freed_slot(monkeypatch):
    """(security regression: rate-limit audit Q268) A full process does not
    turn a chat away: its stream says once that it is waiting, then runs the
    turn when a slot frees, and gives the slot back."""
    runs = _chats(monkeypatch)
    chat = _ChatStream("waits")
    await _until(lambda: chat.frames)
    assert chat.frames == [WAITING] and runs == []

    limits.REQUEST_SLOTS.release()
    await _until(chat.task.done)
    chat.task.result()
    assert chat.frames == [WAITING, {"type": "done"}]
    assert runs == ["waits"]
    assert limits.REQUEST_SLOTS.used == 0


async def test_a_chat_that_waits_past_its_budget_ends_busy(monkeypatch):
    """(security regression: rate-limit audit Q268) A chat waits up to 60 s
    (Q293); past its wait the stream ends with the provider_busy event a busy
    model call sends, never running the turn."""
    runs = _chats(monkeypatch)
    budgets: list[float] = []
    wait = limits.Slots.wait

    async def spent_wait(self, budget_s: float) -> bool:
        budgets.append(budget_s)
        return await wait(self, 0)  # the budget runs out at once

    monkeypatch.setattr(limits.Slots, "wait", spent_wait)
    chat = _ChatStream("late")
    await _until(chat.task.done)
    chat.task.result()

    assert chat.frames == [
        WAITING,
        {
            "type": "error",
            "message": models.BUSY_ERROR,
            "code": "provider_busy",
            "retryAfterSeconds": 5,
        },
    ]
    assert budgets == [60.0]
    assert runs == []
    assert limits.REQUEST_SLOTS.used == 1


async def test_waiting_chats_take_slots_in_arrival_order(monkeypatch):
    """(security regression: rate-limit audit Q268) Freed slots go to the
    chats waiting longest first."""
    runs = _chats(monkeypatch)
    chats = []
    for query in ["first", "second", "third"]:
        chat = _ChatStream(query)
        await _until(lambda chat=chat: chat.frames == [WAITING])
        chats.append(chat)

    limits.REQUEST_SLOTS.release()
    await _until(lambda: all(chat.task.done() for chat in chats))
    assert runs == ["first", "second", "third"]
    assert limits.REQUEST_SLOTS.used == 0


async def test_a_chat_that_leaves_while_waiting_gives_up_its_place(monkeypatch):
    """(security regression: rate-limit audit Q268) A client that hangs up
    while waiting leaves the queue; the freed slot goes to the next chat."""
    runs = _chats(monkeypatch)
    gone, kept = _ChatStream("gone"), _ChatStream("kept")
    await _until(lambda: gone.frames == kept.frames == [WAITING])

    gone.left.set()
    await _until(gone.task.done)
    limits.REQUEST_SLOTS.release()
    await _until(kept.task.done)
    assert runs == ["kept"] and gone.frames == [WAITING]
    assert limits.REQUEST_SLOTS.used == 0
