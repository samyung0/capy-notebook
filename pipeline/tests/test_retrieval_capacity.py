"""The retrieval process's own capacity (rate-limit audit M13, Epo 2026-10-24):
model calls in flight take call slots, one per call and not per turn, and wait
for one in arrival order with the waiting status (inner-turn slots); past the
turns-in-progress ceiling a chat waits in arrival order (Q268) and a generate
answers provider_busy; page renders run on the render pool instead of the
default executor every model call's admission uses."""

from __future__ import annotations

import asyncio
import contextvars
import json
import threading
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from pipeline.registry import ModelConfig
from pipeline.retrieval import agent, capture, contract, limits, models, pending
from pipeline.retrieval.stream import AssembledResponse, StreamEvent, ToolCall
from pipeline.retrieval.tools import ToolContext, ToolResult
from pipeline.retrieval.usage_extract import NormalizedUsage
from pipeline.retrieve import ai_adapter, service

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


def test_generate_answers_busy_past_the_turn_ceiling(monkeypatch):
    """(security regression: rate-limit audit M13) Past the turns-in-progress
    ceiling a generate request answers the existing 503 provider_busy with
    Retry-After at once (Q268: only chat waits); a finished request gives its
    turn slot back."""
    monkeypatch.setattr(service.cfg, "pipeline_secret", SECRET)
    monkeypatch.setattr(limits, "TURN_SLOTS", limits.Slots(1))
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
    assert limits.TURN_SLOTS.used == 0

    assert limits.TURN_SLOTS.take()  # another turn is in progress
    busy = http.post("/generate", json=GENERATE, headers=headers)
    assert busy.status_code == 503
    assert busy.headers["Retry-After"] == "5"
    assert busy.json()["code"] == "provider_busy"
    assert runs == ["chat", "generate"]
    assert limits.TURN_SLOTS.used == 1


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
PLANNING = {"type": "phase", "phase": "planning"}


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
    for _ in range(10_000):
        if condition():
            return
        await asyncio.sleep(0)
    raise AssertionError("the streams never got there")


def _chats(monkeypatch) -> list[str]:
    """Chats that ran, in order; each ends at once and frees its turn slot."""
    monkeypatch.setattr(limits, "TURN_SLOTS", limits.Slots(1))
    runs: list[str] = []

    async def events(req):
        runs.append(req.query)
        yield service._sse({"type": "done"})

    monkeypatch.setattr(service, "_chat_events", events)
    assert limits.TURN_SLOTS.take()  # another turn is in progress
    return runs


async def test_a_chat_past_the_slots_waits_and_takes_the_freed_slot(monkeypatch):
    """(security regression: rate-limit audit Q268, M13) Past the
    turns-in-progress ceiling a chat is not turned away: its stream says once
    that it is waiting, then, when a turn slot frees, goes back to its phase
    from before the wait (Q359), runs the turn and gives the slot back."""
    runs = _chats(monkeypatch)
    chat = _ChatStream("waits")
    await _until(lambda: chat.frames)
    assert chat.frames == [WAITING] and runs == []

    limits.TURN_SLOTS.release()
    await _until(chat.task.done)
    chat.task.result()
    assert chat.frames == [WAITING, PLANNING, {"type": "done"}]
    assert runs == ["waits"]
    assert limits.TURN_SLOTS.used == 0


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
    assert limits.TURN_SLOTS.used == 1


async def test_waiting_chats_take_slots_in_arrival_order(monkeypatch):
    """(security regression: rate-limit audit Q268) Freed slots go to the
    chats waiting longest first."""
    runs = _chats(monkeypatch)
    chats = []
    for query in ["first", "second", "third"]:
        chat = _ChatStream(query)
        await _until(lambda chat=chat: chat.frames == [WAITING])
        chats.append(chat)

    limits.TURN_SLOTS.release()
    await _until(lambda: all(chat.task.done() for chat in chats))
    assert runs == ["first", "second", "third"]
    assert limits.TURN_SLOTS.used == 0


async def test_a_chat_that_leaves_while_waiting_gives_up_its_place(monkeypatch):
    """(security regression: rate-limit audit Q268) A client that hangs up
    while waiting leaves the queue; the freed slot goes to the next chat."""
    runs = _chats(monkeypatch)
    gone, kept = _ChatStream("gone"), _ChatStream("kept")
    await _until(lambda: gone.frames == kept.frames == [WAITING])

    gone.left.set()
    await _until(gone.task.done)
    limits.TURN_SLOTS.release()
    await _until(kept.task.done)
    assert runs == ["kept"] and gone.frames == [WAITING]
    assert limits.TURN_SLOTS.used == 0


def _model() -> ModelConfig:
    return ModelConfig(
        version=1,
        provider_name="DeepSeek",
        model_name="Flash",
        provider_slug="deepseek",
        model_slug="deepseek-v4-flash",
        thinking_levels=("low", "mid", "high", "max"),
        default_thinking="high",
        context_window_tokens=100_000,
        slots=("chat",),
    )


def _reply(text: str = "", calls: list[ToolCall] | None = None) -> AssembledResponse:
    return AssembledResponse(
        text=text, tool_calls=list(calls or []), usage=NormalizedUsage()
    )


TOOL = _reply(calls=[ToolCall(id="call_1", name="list_sources", arguments="{}")])
ANSWER = _reply("Done.\n")

# The user whose turn a model call or tool belongs to (each turn is a task).
USER: contextvars.ContextVar[str] = contextvars.ContextVar("user")


class _Provider:
    """The provider behind every model call: calls as they reach it, named by
    user and number (``A1``), with the call slots in use at that moment. A
    call named in ``held`` keeps its slot until its event is set."""

    def __init__(self, replies: dict[str, list[AssembledResponse]]) -> None:
        self.replies = replies
        self.calls: list[str] = []
        self.slots_used: list[int] = []
        self.held: dict[str, asyncio.Event] = {}

    async def __call__(self, _spec, _messages, _tools, _temperature, on_event, **_):
        user = USER.get()
        name = f"{user}{sum(call[0] == user for call in self.calls) + 1}"
        self.calls.append(name)
        self.slots_used.append(limits.CALL_SLOTS.used)
        if name in self.held:
            await self.held[name].wait()
        reply = self.replies[user].pop(0)
        if on_event is not None and reply.text:
            on_event(StreamEvent(kind="text", text=reply.text))
        return reply


class _Turn:
    """One user's chat turn through the agent loop, its events in order."""

    def __init__(
        self,
        user: str,
        history: list[dict] | None = None,
        client: agent.ClientDrop | None = None,
    ) -> None:
        self.events: list[dict] = []
        self.task = asyncio.create_task(self._run(user, history, client))

    async def _run(
        self, user: str, history: list[dict] | None, client: agent.ClientDrop | None
    ) -> None:
        USER.set(user)
        async for event in agent.run_agent(
            query=f"question from {user}",
            ctx=ToolContext(workspace_id=f"ws_{user}"),
            history=history,
            model=_model(),
            client=client,
        ):
            self.events.append(event)

    def waits(self) -> int:
        return self.events.count(WAITING)


def _turns(monkeypatch, replies: dict[str, list[AssembledResponse]]):
    """Turns over one call slot, with the real model call entry points: the
    provider, and tools that run until the user's gate (if any) opens."""
    monkeypatch.setattr(limits, "CALL_SLOTS", limits.Slots(1))
    provider = _Provider(replies)
    monkeypatch.setattr(models, "_stream_via_adapter", provider)
    tools_ran: list[str] = []
    gates: dict[str, asyncio.Event] = {}

    async def run(*_args):
        tools_ran.append(USER.get())
        if USER.get() in gates:
            await gates[USER.get()].wait()
        return ToolResult(text_parts=["Full source listing"])

    async def nothing(*_args, **_kwargs):
        return pending.PendingSources()

    async def no_chapters(*_args, **_kwargs):
        return [], None

    async def no_titles(*_args, **_kwargs):
        return {}

    monkeypatch.setattr(agent.tools, "run", run)
    monkeypatch.setattr(pending, "load", nothing)
    monkeypatch.setattr(agent.store, "workspace_chapters", no_chapters)
    monkeypatch.setattr(agent.store, "resource_titles", no_titles)
    return provider, tools_ran, gates


async def test_another_users_call_runs_while_a_turn_runs_a_tool(monkeypatch):
    """(security regression: rate-limit audit M13) A call slot is held for a
    model call, not for the turn: while A's turn runs a tool, B's call takes
    the only slot and B's turn ends before A's tool does."""
    provider, tools_ran, gates = _turns(
        monkeypatch, {"A": [TOOL, ANSWER], "B": [ANSWER]}
    )
    gates["A"] = asyncio.Event()
    a = _Turn("A")
    await _until(lambda: tools_ran == ["A"])

    b = _Turn("B")
    await _until(b.task.done)
    assert provider.calls == ["A1", "B1"]
    assert b.events[-1]["type"] == "done" and b.waits() == 0

    gates["A"].set()
    await _until(a.task.done)
    assert provider.calls == ["A1", "B1", "A2"]
    assert a.events[-1]["type"] == "done"
    assert limits.CALL_SLOTS.used == 0


async def test_a_turns_next_call_queues_behind_the_running_call(monkeypatch):
    """(security regression: rate-limit audit M13) When A's tool ends while
    B's call holds the only slot, A's next call waits behind it, saying so,
    and keeps its place ahead of a call that arrived after it (C's)."""
    provider, tools_ran, gates = _turns(
        monkeypatch, {"A": [TOOL, ANSWER], "B": [ANSWER], "C": [ANSWER]}
    )
    gates["A"] = asyncio.Event()
    provider.held["B1"] = asyncio.Event()
    a = _Turn("A")
    await _until(lambda: tools_ran == ["A"])
    b = _Turn("B")
    await _until(lambda: provider.calls == ["A1", "B1"])

    gates["A"].set()
    await _until(lambda: a.waits() == 1)
    c = _Turn("C")
    await _until(lambda: c.waits() == 1)
    assert provider.calls == ["A1", "B1"]

    provider.held["B1"].set()
    await _until(lambda: all(turn.task.done() for turn in (a, b, c)))
    assert provider.calls == ["A1", "B1", "A2", "C1"]
    assert all(turn.events[-1]["type"] == "done" for turn in (a, b, c))
    assert limits.CALL_SLOTS.used == 0


async def test_each_slot_wait_in_a_turn_sends_the_waiting_status(monkeypatch):
    """(security regression: rate-limit audit M13) A turn whose two model
    calls both find the slots full says it is waiting before each of them,
    and goes back to the planning phase the moment each gets its slot, before
    anything of the call (Q359)."""
    provider, tools_ran, gates = _turns(monkeypatch, {"A": [TOOL, ANSWER]})
    gates["A"] = asyncio.Event()
    assert limits.CALL_SLOTS.take()  # another call is running
    a = _Turn("A")
    await _until(lambda: a.waits() == 1)
    assert provider.calls == []

    limits.CALL_SLOTS.release()
    await _until(lambda: tools_ran == ["A"])
    assert limits.CALL_SLOTS.take()  # another call starts during the tool
    gates["A"].set()
    await _until(lambda: a.waits() == 2)
    assert provider.calls == ["A1"]

    limits.CALL_SLOTS.release()
    await _until(a.task.done)
    marks = [
        "waiting" if event == WAITING else event["type"]
        for event in a.events
        if event == WAITING or event["type"] in {"tool_start", "done"}
    ]
    assert marks == ["waiting", "tool_start", "waiting", "done"]
    assert provider.calls == ["A1", "A2"]
    granted = [a.events[i + 1] for i, event in enumerate(a.events) if event == WAITING]
    assert granted == [PLANNING, PLANNING]


async def test_the_compaction_summarizer_takes_a_call_slot(monkeypatch):
    """(security regression: rate-limit audit M13) The summarizer's call is a
    model call: a turn that folds its history waits for a slot first, saying
    so, and writes the summary holding it."""
    provider, _tools_ran, _gates = _turns(
        monkeypatch, {"A": [_reply("Earlier: a question."), ANSWER]}
    )
    folds = iter([True])  # the history is folded once, at the turn's start
    monkeypatch.setattr(
        agent.compact, "needs_compact", lambda *_a, **_k: next(folds, False)
    )
    assert limits.CALL_SLOTS.take()  # another call is running
    a = _Turn("A", history=[{"id": "u1", "role": "user", "content": "earlier"}])
    await _until(lambda: a.waits() == 1)
    assert provider.calls == []

    limits.CALL_SLOTS.release()
    await _until(a.task.done)
    assert provider.calls == ["A1", "A2"]  # the summary, then the answer
    assert provider.slots_used == [1, 1]
    assert a.events[a.events.index(WAITING) + 1] == PLANNING  # Q359
    assert a.events[-1]["type"] == "done"
    assert limits.CALL_SLOTS.used == 0


async def test_a_call_waiting_for_its_slot_gives_up_its_place_on_stop(monkeypatch):
    """(security regression: rate-limit audit M13) When the user presses Stop
    while a turn's call waits for a slot, the call leaves the queue at once and
    starts nothing, the turn ends stopped, and the slot goes to the next call."""
    provider, _tools_ran, _gates = _turns(monkeypatch, {"A": [ANSWER], "B": [ANSWER]})
    assert limits.CALL_SLOTS.take()  # another call is running
    client = agent.ClientDrop()
    a = _Turn("A", client=client)
    await _until(lambda: a.waits() == 1)
    b = _Turn("B")
    await _until(lambda: b.waits() == 1)

    client.stop()
    await _until(a.task.done)
    assert provider.calls == []
    assert a.events[-1]["type"] == "turn_checkpoint" and a.events[-1]["stopped"]

    limits.CALL_SLOTS.release()
    await _until(b.task.done)
    assert provider.calls == ["B1"]
    assert limits.CALL_SLOTS.used == 0


def test_a_generate_call_answers_busy_past_the_call_slots(monkeypatch):
    """(security regression: rate-limit audit M13) Generate has no waiting
    status (Q268): past the call slots its model call answers the existing 503
    provider_busy at once, without reaching the provider."""
    monkeypatch.setattr(service.cfg, "pipeline_secret", SECRET)
    monkeypatch.setattr(limits, "CALL_SLOTS", limits.Slots(1))
    provider = _Provider({"G": [ANSWER, ANSWER]})
    monkeypatch.setattr(models, "_stream_via_adapter", provider)

    async def generate(_req):
        USER.set("G")
        await models.complete_text([{"role": "user", "content": "q"}], model=_model())
        return {"kind": "mindmap"}

    monkeypatch.setattr(service, "_generate", generate)
    http = TestClient(service.app)  # no lifespan: no database
    headers = {"X-Pipeline-Secret": SECRET}
    assert http.post("/generate", json=GENERATE, headers=headers).status_code == 200
    assert provider.calls == ["G1"] and provider.slots_used == [1]

    assert limits.CALL_SLOTS.take()  # another call is running
    busy = http.post("/generate", json=GENERATE, headers=headers)
    assert busy.status_code == 503
    assert busy.headers["Retry-After"] == "5"
    assert busy.json()["code"] == "provider_busy"
    assert provider.calls == ["G1"]


@pytest.mark.parametrize("ticks", [0, 1, 2])
async def test_a_call_cancelled_as_its_slot_arrives_passes_the_slot_on(
    monkeypatch, ticks
):
    """(security regression: rate-limit audit M13, Q359) A chat call handed
    the freed slot just as it is cancelled gives the slot to the next waiting
    call, so no slot is lost and the next waiter is not skipped (Q340)."""
    monkeypatch.setattr(limits, "CALL_SLOTS", limits.Slots(1))
    assert limits.CALL_SLOTS.take()  # another call is running
    waits: list[str] = []
    ran: list[str] = []

    async def call(name: str) -> None:
        policy = limits.CallSlotPolicy(60, lambda: waits.append(name), asyncio.Event())
        limits.bind_call_slots(policy)
        async with models.call_slot():
            ran.append(name)

    first = asyncio.create_task(call("first"))
    await _until(lambda: waits == ["first"])
    second = asyncio.create_task(call("second"))
    await _until(lambda: waits == ["first", "second"])

    limits.CALL_SLOTS.release()  # handed to the first
    for _ in range(ticks):
        await asyncio.sleep(0)
    first.cancel()
    await _until(second.done)
    assert "second" in ran
    assert limits.CALL_SLOTS.used == 0 and limits.CALL_SLOTS.take()


async def test_a_slot_freed_as_a_call_is_refused_goes_to_that_call(monkeypatch):
    """(security regression: rate-limit audit M13, Q359) A refused call is in
    the queue from the moment it is refused: a slot freed then is handed to
    it, not to a call that arrives after it."""
    monkeypatch.setattr(limits, "CALL_SLOTS", limits.Slots(1))
    assert limits.CALL_SLOTS.take()  # another call is running
    later: list[bool] = []
    ran: list[str] = []

    def running_call_ends() -> None:
        limits.CALL_SLOTS.release()
        later.append(limits.CALL_SLOTS.take())  # a call arriving after it

    limits.bind_call_slots(limits.CallSlotPolicy(1, running_call_ends))
    async with models.call_slot():
        ran.append("refused first")
    assert later == [False] and ran == ["refused first"]
    assert limits.CALL_SLOTS.used == 0


@pytest.mark.parametrize("slots_full", [True, False])
async def test_a_stopped_turn_starts_no_summarizer_and_says_no_wait(
    monkeypatch, slots_full
):
    """(security regression: rate-limit audit M13, Q359) After Stop no model
    call starts, the compaction summarizer's included, and no waiting status
    is sent, whether a slot is free or not; the turn ends stopped."""
    provider, _tools_ran, _gates = _turns(
        monkeypatch, {"A": [_reply("Earlier: a question."), ANSWER]}
    )
    client = agent.ClientDrop()
    folds = iter([True])  # the history is folded once, at the turn's start

    def stop_then_fold(*_args, **_kwargs) -> bool:
        client.stop()  # pressed as the history is about to be folded
        return next(folds, False)

    monkeypatch.setattr(agent.compact, "needs_compact", stop_then_fold)
    if slots_full:
        assert limits.CALL_SLOTS.take()  # another call is running
    a = _Turn(
        "A",
        history=[{"id": "u1", "role": "user", "content": "earlier"}],
        client=client,
    )
    await _until(a.task.done)
    a.task.result()
    assert provider.calls == [] and a.waits() == 0
    assert a.events[-1]["type"] == "turn_checkpoint" and a.events[-1]["stopped"]


@pytest.mark.parametrize("raising", ["on_wait", "on_granted"])
async def test_a_failing_slot_callback_gives_the_slot_back(monkeypatch, raising):
    """(security regression: rate-limit audit M13, Q359) A call whose waiting
    or granted callback raises still gives back, or passes on, the slot it
    was queued for or handed: none is lost."""
    monkeypatch.setattr(limits, "CALL_SLOTS", limits.Slots(1))
    assert limits.CALL_SLOTS.take()  # another call is running
    waited: list[bool] = []

    def fail() -> None:
        raise RuntimeError("callback failed")

    callbacks = {"on_wait": lambda: waited.append(True), "on_granted": lambda: None}
    callbacks[raising] = fail

    async def call() -> None:
        limits.bind_call_slots(limits.CallSlotPolicy(60, **callbacks))
        async with models.call_slot():
            pass

    task = asyncio.create_task(call())
    await _until(task.done if raising == "on_wait" else lambda: waited)
    limits.CALL_SLOTS.release()  # the running call ends
    await _until(task.done)
    with pytest.raises(RuntimeError):
        task.result()
    assert limits.CALL_SLOTS.used == 0 and limits.CALL_SLOTS.take()


async def test_a_slot_granted_as_the_user_stops_sends_no_phase(monkeypatch):
    """(Q359) When Stop lands just after the summarizer's call gets its slot,
    the planning phase that call queued is not sent: the turn ends stopped
    with nothing after the wait but the stopped checkpoint."""
    provider, _tools_ran, _gates = _turns(
        monkeypatch, {"A": [_reply("Earlier: a question."), ANSWER]}
    )
    folds = iter([True])  # the history is folded once, at the turn's start
    monkeypatch.setattr(
        agent.compact, "needs_compact", lambda *_a, **_k: next(folds, False)
    )
    client = agent.ClientDrop()
    granted = agent._SlotWaits.granted

    def granted_then_stop(self) -> None:
        granted(self)
        client.stop()

    monkeypatch.setattr(agent._SlotWaits, "granted", granted_then_stop)
    assert limits.CALL_SLOTS.take()  # another call is running
    a = _Turn(
        "A",
        history=[{"id": "u1", "role": "user", "content": "earlier"}],
        client=client,
    )
    await _until(lambda: a.waits() == 1)

    limits.CALL_SLOTS.release()
    await _until(a.task.done)
    a.task.result()
    after = a.events[a.events.index(WAITING) + 1 :]
    assert PLANNING not in after
    assert after[-1]["type"] == "turn_checkpoint" and after[-1]["stopped"]
    assert provider.calls == ["A1"]  # the summary already running finishes


@pytest.mark.parametrize("failing", ["record", "reset"])
async def test_a_turns_cleanup_runs_every_step_when_one_fails(
    monkeypatch, tmp_path, failing
):
    """(Q359) However a turn ends, its deck folder goes, its searches are
    recorded and its call-slot policy is unbound, even when one of those steps
    fails (the policy reset raises when the turn is finalized elsewhere)."""
    _turns(monkeypatch, {"A": [ANSWER]})
    done: list[str] = []
    reset = agent.reset_call_slots

    async def record(*_args) -> None:
        done.append("record")
        if failing == "record":
            raise RuntimeError("record failed")

    def reset_slots(token) -> None:
        reset(token)
        done.append("reset")
        if failing == "reset":
            raise ValueError("another context")

    monkeypatch.setattr(agent, "_record_searches", record)
    monkeypatch.setattr(agent, "reset_call_slots", reset_slots)
    deck = tmp_path / "deck"
    deck.mkdir()
    ctx = ToolContext(workspace_id="ws_A", deck_dir=str(deck))
    USER.set("A")

    with pytest.raises((RuntimeError, ValueError)):
        async for _event in agent.run_agent(
            query="q", ctx=ctx, history=None, model=_model()
        ):
            pass
    assert not deck.exists()
    assert done[-2:] == ["record", "reset"]  # after the answer's own record
    assert limits.call_slot_policy() is None


_GHOST_TEXT_REQUEST = {"workspaceId": "ws_1", "thinking": "low", "before": "Hello "}


def test_ghost_text_takes_a_call_slot_and_answers_busy_past_capacity(monkeypatch):
    """(security regression: rate-limit audit M13, Q339, Q359) A ghost text
    call holds a call slot for its model call; with every call slot taken, or
    at the turns-in-progress ceiling, /plate-ai/copilot answers the existing
    503 provider_busy with Retry-After before reaching the provider."""
    monkeypatch.setattr(service.cfg, "pipeline_secret", SECRET)
    monkeypatch.setattr(limits, "CALL_SLOTS", limits.Slots(1))
    monkeypatch.setattr(limits, "TURN_SLOTS", limits.Slots(1))
    slots_used: list[int] = []

    async def provider(*_args, **_kwargs):
        slots_used.append(limits.CALL_SLOTS.used)
        return _reply("[]")

    monkeypatch.setattr(models, "_stream_via_adapter", provider)
    monkeypatch.setattr(ai_adapter, "_editor_spec", lambda _req: _model())
    monkeypatch.setattr(ai_adapter, "_ensure_provider", lambda _spec: None)
    http = TestClient(service.app)  # no lifespan: no database
    headers = {"X-Pipeline-Secret": SECRET}
    path, body = "/plate-ai/copilot", _GHOST_TEXT_REQUEST

    assert http.post(path, json=body, headers=headers).status_code == 200
    assert slots_used == [1]
    assert limits.CALL_SLOTS.used == 0

    for full in (limits.CALL_SLOTS, limits.TURN_SLOTS):
        assert full.take()  # another call, or another turn, is running
        busy = http.post(path, json=body, headers=headers)
        assert busy.status_code == 503
        assert busy.headers["Retry-After"] == "5"
        assert busy.json()["detail"]["code"] == "provider_busy"
        full.release()
    assert slots_used == [1]


def _jpeg(shade: str) -> bytes:
    import io

    from PIL import Image

    buffer = io.BytesIO()
    Image.new("RGB", (64, 48), shade).save(buffer, "JPEG", quality=80)
    return buffer.getvalue()


def _image_encodes(monkeypatch, urls: list[str]) -> list[str]:
    """Images of ``urls`` (whole, or their base64 alone) the JSON encoder
    escapes, as httpx's encoding does with every string."""
    encoded: list[str] = []
    plain = json.encoder.encode_basestring
    images = [url.split(",", 1)[1] for url in urls]

    def counting(text: str) -> str:
        if any(text.endswith(image) for image in images):
            encoded.append(text)
        return plain(text)

    monkeypatch.setattr(json.encoder, "encode_basestring", counting)
    return encoded


async def test_a_turns_second_call_does_not_encode_its_captures_again(monkeypatch):
    """(security regression: rate-limit audit M13, Q299) A capture's image is
    encoded once, when it is taken: neither of a turn's two model calls encodes
    it again, and both requests carry it whole."""
    import httpx
    import yaml

    from pipeline import registry
    from pipeline.elitellm import client as transport

    cassette = Path(__file__).parent / "cassettes/replay/zai__glm_5_3_flash.yaml"
    recorded = yaml.safe_load(cassette.read_text())["interactions"][0]["response"]
    sent: list[dict] = []

    def answer(request: httpx.Request) -> httpx.Response:
        sent.append(json.loads(request.content))
        return httpx.Response(200, content=recorded["body"]["string"].encode())

    client = httpx.AsyncClient(transport=httpx.MockTransport(answer))
    monkeypatch.setattr(transport, "_client", lambda: client)
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-test")
    registry.bind_request_llm(thinking="max")
    glm = ModelConfig(
        version=1,
        provider_name="Z.ai",
        model_name="GLM-5.3-Flash",
        provider_slug="zai",
        model_slug="glm-5.3-flash",
        thinking_levels=("low", "high", "max"),
        default_thinking="max",
        slots=("chat",),
    )
    calls = [
        {"id": f"c{n}", "type": "function", "function": {"name": "capture_page"}}
        for n in (1, 2)
    ]
    messages = [
        {"role": "system", "content": "sys"},
        {"role": "user", "content": "q"},
        {"role": "assistant", "content": "", "tool_calls": calls},
        {"role": "tool", "tool_call_id": "c1", "content": "captured"},
        {"role": "tool", "tool_call_id": "c2", "content": "captured"},
    ]
    urls = [capture.data_url(_jpeg("white")), capture.data_url(_jpeg("black"))]
    images = {"c1": ("capture 1", urls[0]), "c2": ("capture 2", urls[1])}
    encoded = _image_encodes(monkeypatch, urls)
    try:
        for _ in range(2):
            request = capture.inject_images(messages, images, glm.provider_slug)
            await models.stream_agent_response(request, model=glm)
    finally:
        await client.aclose()

    assert encoded == []
    for body in sent:
        parts = body["messages"][-1]["content"]
        assert [p["image_url"]["url"] for p in parts if "image_url" in p] == urls
    assert len(sent) == 2


@pytest.mark.parametrize("route", ["anthropic", "responses", "chat"])
def test_each_request_shape_carries_a_capture_as_it_was_encoded(monkeypatch, route):
    """(security regression: rate-limit audit M13, Q299) Every provider's
    request shape copies the capture in without encoding it, byte for byte
    the body the JSON encoder would write."""
    from pipeline.elitellm import client as transport

    url = capture.data_url(_jpeg("white"))
    provider = "anthropic" if route == "anthropic" else "openai"
    spec = _model()
    content = [{"type": "text", "text": "see"}, capture.image_part(url, provider)]
    messages = [{"role": "user", "content": content}]
    if route == "anthropic":
        body = transport.anthropic_request(
            spec, messages, temperature=None, tools=None, max_tokens=64, thinking=""
        )
    elif route == "responses":
        body = transport.openai_responses_request(
            spec,
            models.messages_to_responses_input(messages),
            tools=None,
            max_tokens=64,
            thinking="high",
            stream=True,
            response_format=None,
            tool_choice=None,
        )
    else:
        body = transport.openai_chat_request(
            spec,
            messages,
            temperature=None,
            tools=None,
            response_format=None,
            max_tokens=64,
            thinking="high",
            stream=True,
            tool_choice=None,
        )
    encoded = _image_encodes(monkeypatch, [url])
    sent = transport.encode_json(body)
    assert encoded == []
    monkeypatch.undo()
    expected = json.dumps(
        body, ensure_ascii=False, separators=(",", ":"), allow_nan=False
    ).encode()
    assert sent == expected and url.split(",", 1)[1].encode() in sent
