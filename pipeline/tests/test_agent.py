"""Offline tests for the chat agent loop."""

from __future__ import annotations

import asyncio

import pytest

from pipeline import obs
from pipeline.retrieval import accounting, agent, tools
from pipeline.retrieval.search import Passage
from pipeline.retrieval.stream import AssembledResponse, StreamEvent, ToolCall
from pipeline.retrieval.tools import ToolContext, ToolResult, TurnFailed
from pipeline.retrieval.usage_extract import NormalizedUsage


def _passage(**kwargs) -> Passage:
    return Passage(
        chunk_id=kwargs.pop("chunk_id", "c1"),
        file_id=kwargs.pop("file_id", "f_1"),
        file_name=kwargs.pop("file_name", "bio.pdf"),
        chunk_idx=kwargs.pop("chunk_idx", 0),
        section_path=kwargs.pop("section_path", ""),
        text=kwargs.pop("text", "Chlorophyll absorbs mostly red and blue light."),
        hit_text=kwargs.pop(
            "hit_text", "Chlorophyll absorbs mostly red and blue light."
        ),
        **kwargs,
    )


def _assembled(
    text: str = "",
    calls: list[ToolCall] | None = None,
    usage: NormalizedUsage | None = None,
    items: list[dict] | None = None,
) -> AssembledResponse:
    return AssembledResponse(
        text=text,
        tool_calls=list(calls or []),
        usage=usage or NormalizedUsage(),
        output_items=list(items or []),
    )


def _call(name: str, arguments: str = "{}", call_id: str = "call_1") -> ToolCall:
    return ToolCall(id=call_id, name=name, arguments=arguments)


async def _collect(query: str, ctx: ToolContext, **kwargs) -> list[dict]:
    events = []
    async for event in agent.run_agent(
        query=query, ctx=ctx, history=None, model="deepseek-v4-flash", **kwargs
    ):
        events.append(event)
    return events


def _text_chunks(text: str) -> list[str]:
    if not text:
        return []
    if len(text) <= 4:
        return [text]
    mid = max(1, len(text) // 2)
    return [text[:mid], text[mid:]]


def _script_stream(responses: list[AssembledResponse]):
    seen: list[dict] = []

    async def _stream(
        messages, *, model, tools=None, on_event=None, call_purpose="agent"
    ):
        del model, call_purpose
        seen.append({"tools": tools, "messages": list(messages)})
        assembled = responses.pop(0)
        if on_event is not None:
            for part in _text_chunks(assembled.text):
                on_event(StreamEvent(kind="text", text=part))
        return assembled

    return _stream, seen


def test_priming_message_with_no_hits_points_at_list_sources():
    assert "list_sources" in agent._priming_message([])


def test_priming_message_numbers_passages():
    message = agent._priming_message([(1, _passage())])

    assert message.startswith("Passages retrieved for this question:")
    assert "[1]" in message
    assert "Chlorophyll absorbs" in message


async def test_search_embedding_count_is_telemetry_not_a_cap(monkeypatch):
    async def _search(**_kwargs):
        return [_passage()]

    monkeypatch.setattr(tools, "search", _search)
    budget = agent.TurnBudget(embedding_calls=8)
    ctx = ToolContext(workspace_id="ws_1", budget=budget)
    result = await tools._search_workspace({"query": "chlorophyll"}, ctx)

    assert not result.refused
    assert budget.embedding_calls == 9


async def test_block_deltas_emit_while_provider_stream_is_open(monkeypatch):
    released = asyncio.Event()

    async def _search(**_k):
        return [_passage()]

    async def _stream(
        messages, *, model, tools=None, on_event=None, call_purpose="agent"
    ):
        del messages, model, tools, call_purpose
        if on_event is not None:
            on_event(StreamEvent(kind="text", text="Hel"))
            on_event(StreamEvent(kind="text", text="lo"))
        await released.wait()
        return _assembled("Hello")

    monkeypatch.setattr(agent, "search", _search)
    monkeypatch.setattr(agent.models, "stream_agent_response", _stream)

    events: list[dict] = []

    async def _consume() -> None:
        async for ev in agent.run_agent(
            query="q",
            ctx=ToolContext(workspace_id="ws_1"),
            history=None,
            model="deepseek-v4-flash",
        ):
            events.append(ev)
            if ev.get("type") == "block_delta" and not released.is_set():
                released.set()

    await asyncio.wait_for(_consume(), timeout=2)
    assert [e["text"] for e in events if e["type"] == "block_delta"] == ["Hel", "lo"]


async def test_run_agent_primes_then_emits_answer_block(monkeypatch):
    async def _search(**_k):
        return [_passage()]

    stream, seen = _script_stream([_assembled("Chlorophyll absorbs red [1].")])
    monkeypatch.setattr(agent, "search", _search)
    monkeypatch.setattr(agent.models, "stream_agent_response", stream)
    monkeypatch.setattr(agent.tools.cfg, "gateway_url", "")

    events = await _collect(
        "What does chlorophyll absorb?", ToolContext(workspace_id="ws_1")
    )
    kinds = [e["type"] for e in events]
    assert kinds[:4] == ["tool_start", "tool_end", "citations", "phase"]
    assert "block_start" in kinds
    assert "block_delta" in kinds
    assert {"type": "block_end", "blockId": "b1", "kind": "answer"} in events
    assert events[-1]["type"] == "done"
    assert events[-1]["answer"] == "Chlorophyll absorbs red [1]."
    assert seen[0]["tools"] is not None
    assert "generate_material" not in [s["function"]["name"] for s in seen[0]["tools"]]


async def test_the_last_planning_round_drops_tools(monkeypatch):
    async def _search(**_k):
        return [_passage()]

    stream, seen = _script_stream([_assembled("ok")])
    monkeypatch.setattr(agent, "search", _search)
    monkeypatch.setattr(agent.models, "stream_agent_response", stream)
    monkeypatch.setattr(agent.cfg, "agent_max_steps", 1)

    await _collect("What does chlorophyll absorb?", ToolContext(workspace_id="ws_1"))
    assert seen[0]["tools"] is None


async def test_planning_text_with_tools_is_narration_then_answer(monkeypatch):
    async def _search(**_k):
        return [_passage()]

    stream, seen = _script_stream(
        [
            _assembled("Looking that up.", [_call("list_sources")]),
            _assembled("Chlorophyll absorbs red [1]."),
        ]
    )

    async def _run(name, args, ctx):
        del args, ctx
        return ToolResult(text_parts=[f"ran {name}"])

    monkeypatch.setattr(agent, "search", _search)
    monkeypatch.setattr(agent.models, "stream_agent_response", stream)
    monkeypatch.setattr(agent.tools, "run", _run)

    events = await _collect(
        "What does chlorophyll absorb?", ToolContext(workspace_id="ws_1")
    )
    assert any(e.get("kind") == "narration" for e in events if e["type"] == "block_end")
    assert any(e.get("kind") == "answer" for e in events if e["type"] == "block_end")
    assert len(seen) == 2
    tool_roles = [m["role"] for m in seen[1]["messages"] if m.get("role") == "tool"]
    assert tool_roles == ["tool"]
    assert events[-1]["answer"] == "Chlorophyll absorbs red [1]."
    assert not any(
        isinstance(m.get("content"), str) and '"kind": "narration"' in m["content"]
        for m in seen[1]["messages"]
    )


async def test_overlapping_passages_keep_stable_numbers(monkeypatch):
    ctx = ToolContext(workspace_id="ws_1")
    first = tools.assign_citations(
        ctx, [_passage(chunk_id="c1"), _passage(chunk_id="c2")]
    )
    second = tools.assign_citations(
        ctx, [_passage(chunk_id="c2"), _passage(chunk_id="c3")]
    )
    assert [n for n, _ in first] == [1, 2]
    assert [n for n, _ in second] == [2, 3]


async def test_citation_sse_matches_numbers_shown_to_the_model(monkeypatch):
    extra = _passage(chunk_id="c2", text="Calvin cycle fixes carbon.")

    async def _search(**_k):
        return [_passage()]

    stream, _seen = _script_stream(
        [
            _assembled("", [_call("read_document", '{"file_id":"f_1"}')]),
            _assembled("See [1] and [2]."),
        ]
    )

    async def _run(name, args, ctx):
        del name, args
        return ToolResult(passages=[_passage(), extra])

    monkeypatch.setattr(agent, "search", _search)
    monkeypatch.setattr(agent.models, "stream_agent_response", stream)
    monkeypatch.setattr(agent.tools, "run", _run)

    events = await _collect("q", ToolContext(workspace_id="ws_1"))
    cite_events = [e for e in events if e["type"] == "citations"]
    assert cite_events[0]["version"] == 1
    assert cite_events[-1]["version"] == 2
    assert [c["chunkId"] for c in cite_events[-1]["citations"]] == ["c1", "c2"]


async def test_read_batch_runs_concurrently_in_call_order(monkeypatch):
    overlap = {"active": 0, "peak": 0}

    async def _search(**_k):
        return [_passage()]

    stream, _seen = _script_stream(
        [
            _assembled(
                "",
                [
                    _call("list_sources", "{}", "c1"),
                    _call("describe_documents", "{}", "c2"),
                ],
            ),
            _assembled("done"),
        ]
    )

    async def _run(name, args, ctx):
        del args, ctx
        overlap["active"] += 1
        overlap["peak"] = max(overlap["peak"], overlap["active"])
        await asyncio.sleep(0.04)
        overlap["active"] -= 1
        return ToolResult(text_parts=[f"ran {name}"])

    monkeypatch.setattr(agent, "search", _search)
    monkeypatch.setattr(agent.models, "stream_agent_response", stream)
    monkeypatch.setattr(agent.tools, "run", _run)

    events = await _collect("q", ToolContext(workspace_id="ws_1"))
    assert overlap["peak"] == 2
    ends = [
        e["callId"]
        for e in events
        if e["type"] == "tool_end" and e["callId"] != "prime"
    ]
    assert ends == ["c1", "c2"]


async def test_mixed_mutation_stays_serial(monkeypatch):
    overlap = {"active": 0, "peak": 0}

    async def _search(**_k):
        return [_passage()]

    stream, _seen = _script_stream(
        [
            _assembled(
                "",
                [
                    _call("list_sources", "{}", "c1"),
                    _call("generate_material", '{"kind":"note"}', "c2"),
                ],
            ),
            _assembled("made it"),
        ]
    )

    async def _run(name, args, ctx):
        del args, ctx
        overlap["active"] += 1
        overlap["peak"] = max(overlap["peak"], overlap["active"])
        await asyncio.sleep(0.03)
        overlap["active"] -= 1
        return ToolResult(text_parts=[f"ran {name}"])

    monkeypatch.setattr(agent, "search", _search)
    monkeypatch.setattr(agent.models, "stream_agent_response", stream)
    monkeypatch.setattr(agent.tools, "run", _run)
    monkeypatch.setattr(agent.tools.cfg, "gateway_url", "http://gw")
    monkeypatch.setattr(agent.tools.cfg, "pipeline_secret", "s")

    await _collect("q", ToolContext(workspace_id="ws_1", user_id="u1"))
    assert overlap["peak"] == 1


async def test_per_response_and_turn_caps_return_one_result_per_id(monkeypatch):
    async def _search(**_k):
        return [_passage()]

    calls = [_call("list_sources", "{}", f"c{i}") for i in range(5)]
    stream, seen = _script_stream([_assembled("", calls), _assembled("ok")])
    ran: list[str] = []

    async def _run(name, args, ctx):
        del args, ctx
        ran.append(name)
        return ToolResult(text_parts=[f"ran {name}"])

    monkeypatch.setattr(agent, "search", _search)
    monkeypatch.setattr(agent.models, "stream_agent_response", stream)
    monkeypatch.setattr(agent.tools, "run", _run)

    await _collect("q", ToolContext(workspace_id="ws_1"))
    assert len(ran) == 4
    tool_msgs = [m for m in seen[1]["messages"] if m.get("role") == "tool"]
    assert [m["tool_call_id"] for m in tool_msgs] == [f"c{i}" for i in range(5)]
    assert "4 tool-call limit" in tool_msgs[-1]["content"]


async def test_cumulative_input_measurement_does_not_strip_tools(monkeypatch):
    async def _search(**_k):
        return [_passage()]

    stream, seen = _script_stream(
        [
            _assembled(
                "more",
                [_call("list_sources")],
                NormalizedUsage(input_tokens=80),
            ),
            _assembled("final"),
        ]
    )

    async def _run(name, args, ctx):
        del args, ctx
        return ToolResult(text_parts=[f"ran {name}"])

    monkeypatch.setattr(agent, "search", _search)
    monkeypatch.setattr(agent.models, "stream_agent_response", stream)
    monkeypatch.setattr(agent.tools, "run", _run)

    events = await _collect("q", ToolContext(workspace_id="ws_1"))
    assert seen[1]["tools"] is not None
    assert events[-1]["telemetry"]["reportedInputTokens"] == 80
    assert events[-1]["telemetry"]["stopReason"] == "answer"


async def test_exhausting_tool_response_runs_tools_then_one_terminal_call(
    monkeypatch,
):
    async def _search(**_k):
        return [_passage()]

    state = accounting.RequestAccounting(session_id="cr_1")
    token = accounting._accounting.set(state)
    calls = []
    purposes = []

    async def _stream(
        messages, *, model, tools=None, on_event=None, call_purpose="agent"
    ):
        del messages, model, on_event
        purposes.append(call_purpose)
        if len(purposes) == 1:
            assert tools is not None
            state.credits_exhausted = True
            state.terminal_call_allowed = True
            return _assembled("I found more.", [_call("list_sources")])
        assert tools is None
        state.terminal_call_allowed = False
        return _assembled("Final from the paid tool result.")

    async def _run(name, args, ctx):
        del args, ctx
        calls.append(name)
        return ToolResult(text_parts=["paid result"])

    monkeypatch.setattr(agent, "search", _search)
    monkeypatch.setattr(agent.models, "stream_agent_response", _stream)
    monkeypatch.setattr(agent.tools, "run", _run)
    try:
        events = await _collect("q", ToolContext(workspace_id="ws_1"))
    finally:
        accounting._accounting.reset(token)

    assert calls == ["list_sources"]
    assert purposes == ["agent", "terminal"]
    assert events[-1]["answer"] == "Final from the paid tool result."


async def test_estimated_tokens_accumulate_across_rounds(monkeypatch):
    async def _search(**_k):
        return [_passage()]

    stream, _seen = _script_stream(
        [
            _assembled("more", [_call("list_sources")]),
            _assembled("final"),
        ]
    )

    async def _run(name, args, ctx):
        del args, ctx
        return ToolResult(text_parts=[f"ran {name}"])

    monkeypatch.setattr(agent, "search", _search)
    monkeypatch.setattr(agent.models, "stream_agent_response", stream)
    monkeypatch.setattr(agent.tools, "run", _run)
    monkeypatch.setattr(agent.compact, "estimate_messages", lambda _m: 10)
    monkeypatch.setattr(agent.compact, "estimate_schemas", lambda _s: 0)
    monkeypatch.setattr(agent.compact, "needs_compact", lambda *_a, **_k: False)

    events = await _collect("q", ToolContext(workspace_id="ws_1"))
    assert events[-1]["telemetry"]["estimatedInputTokens"] == 20


async def test_compaction_completion_count_does_not_stop_the_turn(monkeypatch):
    async def _search(**_k):
        return [_passage()]

    stream, _seen = _script_stream([_assembled("final")])

    async def _compact(messages, _spec, *, on_compact=None, **_kwargs):
        for _ in range(20):
            if on_compact is not None:
                on_compact()
        return messages

    monkeypatch.setattr(agent, "search", _search)
    monkeypatch.setattr(agent.models, "stream_agent_response", stream)
    monkeypatch.setattr(agent.compact, "compact_messages", _compact)

    events = await _collect("q", ToolContext(workspace_id="ws_1"))
    assert events[-1]["answer"] == "final"
    assert events[-1]["telemetry"]["completionCalls"] == 21
    assert events[-1]["telemetry"]["compactionCalls"] == 20


async def test_empty_response_does_not_resend(monkeypatch):
    async def _search(**_k):
        return [_passage()]

    stream, seen = _script_stream([_assembled(""), _assembled("should not run")])
    monkeypatch.setattr(agent, "search", _search)
    monkeypatch.setattr(agent.models, "stream_agent_response", stream)

    events = await _collect("q", ToolContext(workspace_id="ws_1"))
    assert len(seen) == 1
    assert events[-1]["telemetry"]["stopReason"] == "planning_cap"


async def test_internal_error_is_sanitized_and_carries_usage(monkeypatch):
    async def _search(**_k):
        return [_passage()]

    async def _boom(*_a, **_k):
        raise RuntimeError("psycopg connection to postgres.internal failed")

    monkeypatch.setattr(agent, "search", _search)
    monkeypatch.setattr(agent.models, "stream_agent_response", _boom)

    usage = obs.start_usage()
    usage.add_completion("deepseek", "deepseek-v4-flash", 10, 4)
    events = await _collect("q", ToolContext(workspace_id="ws_1"))
    err = next(e for e in events if e["type"] == "error")
    assert err["code"] == "agent_failed"
    assert "psycopg" not in err["message"]
    assert err["usage"]["inputTokens"] == 10


async def test_admit_checkpoint_clips_without_summarizing_when_unpinnable(
    monkeypatch,
):
    called = {"n": 0}

    async def _fold(**_k):
        called["n"] += 1
        return {"summary": "x", "source_refs": []}

    monkeypatch.setattr(agent.compact, "needs_compact", lambda *_a, **_k: True)
    monkeypatch.setattr(agent.compact, "summarize_checkpoint", _fold)
    monkeypatch.setattr(
        agent.compact, "clip_messages", lambda messages, _spec: messages
    )

    spec = agent.models._as_spec("deepseek-v4-flash")
    messages, replacement = await agent._admit_checkpoint(
        messages=[
            {"role": "system", "content": "sys"},
            {"role": "user", "content": "q", "_kind": "query"},
            {"role": "user", "content": "prime", "_kind": "prime"},
        ],
        history=[
            {"id": "u1", "role": "user", "content": "old"},
            {"id": "", "role": "assistant", "content": "no id"},
            {"id": "u2", "role": "user", "content": "a"},
            {"id": "u3", "role": "user", "content": "b"},
            {"id": "u4", "role": "user", "content": "c"},
            {"id": "u5", "role": "user", "content": "d"},
        ],
        checkpoint=None,
        spec=spec,
        schemas=[],
        budget=agent.TurnBudget(),
        query_msg={"role": "user", "content": "q", "_kind": "query"},
        prime_msg={"role": "user", "content": "prime", "_kind": "prime"},
    )
    assert called["n"] == 0
    assert replacement is None
    assert messages[0]["role"] == "system"


async def test_missing_provider_usage_falls_back_to_estimates(monkeypatch):
    async def _search(**_k):
        return [_passage()]

    stream, _seen = _script_stream([_assembled("short answer")])
    monkeypatch.setattr(agent, "search", _search)
    monkeypatch.setattr(agent.models, "stream_agent_response", stream)

    events = await _collect("q", ToolContext(workspace_id="ws_1"))
    tel = events[-1]["telemetry"]
    assert tel["reportedInputTokens"] == 0
    assert tel["estimatedInputTokens"] > 0


async def test_done_carries_usage_when_the_meter_is_set(monkeypatch):
    async def _search(**_k):
        return [_passage()]

    stream, _seen = _script_stream([_assembled("ok")])
    monkeypatch.setattr(agent, "search", _search)
    monkeypatch.setattr(agent.models, "stream_agent_response", stream)

    usage = obs.start_usage()
    usage.add_completion("deepseek", "deepseek-v4-flash", 10, 4)
    events = await _collect("q", ToolContext(workspace_id="ws_1"))
    done = events[-1]
    assert done["usage"]["inputTokens"] == 10
    assert done["tokenCount"] == 14


async def test_checkpoint_rewrite_does_not_duplicate_the_question(monkeypatch):
    async def _search(**_k):
        return [_passage()]

    stream, seen = _script_stream([_assembled("ok")])

    async def _fold(**_k):
        return {"summary": "prior facts", "source_refs": []}

    monkeypatch.setattr(agent, "search", _search)
    monkeypatch.setattr(agent.models, "stream_agent_response", stream)
    seen_needs = {"n": 0}

    def _needs(*_a, **_k):
        seen_needs["n"] += 1
        return seen_needs["n"] == 1

    monkeypatch.setattr(agent.compact, "needs_compact", _needs)
    monkeypatch.setattr(agent.compact, "summarize_checkpoint", _fold)

    history = [
        {"id": "m1", "role": "user", "content": "old question"},
        {"id": "m2", "role": "assistant", "content": "old answer"},
        {"id": "m3", "role": "user", "content": "mid question"},
        {"id": "m4", "role": "assistant", "content": "mid answer"},
        {"id": "m5", "role": "user", "content": "recent question"},
        {"id": "m6", "role": "assistant", "content": "recent answer"},
    ]
    events = []
    async for event in agent.run_agent(
        query="current question",
        ctx=ToolContext(workspace_id="ws_1"),
        history=history,
        model="deepseek-v4-flash",
        checkpoint={"summary": "older", "sourceRefs": []},
    ):
        events.append(event)

    assert any(e["type"] == "checkpoint" for e in events)
    contents = [m.get("content") for m in seen[0]["messages"]]
    assert contents.count("current question") == 1


def test_material_id_is_deterministic_and_wide():
    first = tools.material_id("m_1", "call_9")
    second = tools.material_id("m_1", "call_9")
    other = tools.material_id("m_1", "call_8")
    assert first == second
    assert first != other
    assert first.startswith("mat_")
    assert len(first) >= len("mat_") + 16


async def test_material_confirmed_404_is_a_tool_failure(monkeypatch):
    ctx = ToolContext(workspace_id="ws_1", user_id="u1", assistant_message_id="m_1")
    monkeypatch.setattr(tools.cfg, "gateway_url", "http://gw")
    monkeypatch.setattr(tools.cfg, "pipeline_secret", "s")

    class _Resp:
        def __init__(self, status, body=None):
            self.status_code = status
            self._body = body or {}

        def json(self):
            return self._body

    posts = {"n": 0}

    def _post(*_a, **_k):
        posts["n"] += 1
        raise tools.requests.ConnectionError("down")

    got = {}

    def _get(*_a, **kwargs):
        got["params"] = kwargs.get("params")
        return _Resp(404)

    async def _nosleep(*_a, **_k):
        return None

    monkeypatch.setattr(tools.requests, "post", _post)
    monkeypatch.setattr(tools.requests, "get", _get)
    monkeypatch.setattr(tools.asyncio, "sleep", _nosleep)

    result = await tools._generate_material(
        {"kind": "note", "_tool_call_id": "call_1"}, ctx
    )
    assert result.refused
    assert posts["n"] == 4
    assert got["params"] == {"workspaceId": "ws_1", "userId": "u1"}


async def test_material_uncertain_get_fails_the_turn(monkeypatch):
    ctx = ToolContext(workspace_id="ws_1", user_id="u1", assistant_message_id="m_1")
    monkeypatch.setattr(tools.cfg, "gateway_url", "http://gw")
    monkeypatch.setattr(tools.cfg, "pipeline_secret", "s")

    def _post(*_a, **_k):
        raise tools.requests.ConnectionError("down")

    def _get(*_a, **_k):
        raise tools.requests.Timeout("slow")

    async def _nosleep(*_a, **_k):
        return None

    monkeypatch.setattr(tools.requests, "post", _post)
    monkeypatch.setattr(tools.requests, "get", _get)
    monkeypatch.setattr(tools.asyncio, "sleep", _nosleep)

    with pytest.raises(TurnFailed):
        await tools._generate_material({"kind": "note", "_tool_call_id": "call_1"}, ctx)


async def test_repeated_material_post_returns_original(monkeypatch):
    ctx = ToolContext(workspace_id="ws_1", user_id="u1", assistant_message_id="m_1")
    monkeypatch.setattr(tools.cfg, "gateway_url", "http://gw")
    monkeypatch.setattr(tools.cfg, "pipeline_secret", "s")

    class _Resp:
        status_code = 200

        def json(self):
            return {"kind": "note", "title": "Note", "materialId": "mat_abc"}

    monkeypatch.setattr(tools.requests, "post", lambda *_a, **_k: _Resp())
    first = await tools._generate_material(
        {"kind": "note", "_tool_call_id": "call_1"}, ctx
    )
    second = await tools._generate_material(
        {"kind": "note", "_tool_call_id": "call_1"}, ctx
    )
    assert first.created_material == second.created_material
