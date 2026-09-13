"""Offline tests for the chat agent loop."""

from __future__ import annotations

import asyncio
import io
import json
import re

import pytest
from PIL import Image

from pipeline import obs
from pipeline.registry import ModelConfig
from pipeline.retrieval import accounting, agent, contract, pending, tools
from pipeline.retrieval.limits import TOOLS_PER_RESPONSE
from pipeline.retrieval.search import Passage
from pipeline.retrieval.stream import AssembledResponse, StreamEvent, ToolCall
from pipeline.retrieval.tools import ToolContext, ToolResult, TurnFailed
from pipeline.retrieval.usage_extract import NormalizedUsage


@pytest.fixture(autouse=True)
def no_pending_sources(monkeypatch):
    async def load(*_args, **_kwargs):
        return pending.PendingSources()

    monkeypatch.setattr(pending, "load", load)


def _model() -> ModelConfig:
    return ModelConfig(
        version=1,
        provider_name="DeepSeek",
        model_name="Flash",
        provider_slug="deepseek",
        model_slug="deepseek-v4-flash",
        thinking_levels=("instant", "low", "mid", "high", "max"),
        default_thinking="instant",
        context_window_tokens=100_000,
        slots=("chat",),
    )


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
        query=query, ctx=ctx, history=None, model=_model(), **kwargs
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


def _answer(*claims: tuple[str, list[int]]) -> str:
    """The structured final answer the prompt asks for."""
    return json.dumps({"answer": [{"text": t, "passages": p} for t, p in claims]})


def _script_stream(responses: list[AssembledResponse]):
    seen: list[dict] = []

    async def _stream(
        messages,
        *,
        model,
        tools=None,
        on_event=None,
        call_purpose="agent",
        response_format=None,
    ):
        del model, call_purpose
        seen.append(
            {
                "tools": tools,
                "messages": list(messages),
                "response_format": response_format,
            }
        )
        assert responses, "unexpected extra completion"
        assembled = responses.pop(0)
        if on_event is not None:
            for part in _text_chunks(assembled.text):
                on_event(StreamEvent(kind="text", text=part))
        return assembled

    return _stream, seen


async def test_completed_tool_evidence_is_reused_in_the_next_turn(monkeypatch):
    from dataclasses import asdict

    passage = _passage()
    stream, seen = _script_stream(
        [
            _assembled(
                "",
                [
                    _call("read_document", '{"file_id":"f_1"}'),
                    _call("describe_documents", '{"file_ids":["f_1"]}', "describe"),
                ],
            ),
            _assembled(_answer(("First answer.", [1]))),
            _assembled(_answer(("Follow-up from the same passage.", [1]))),
        ]
    )

    async def run(name, *_):
        if name == "describe_documents":
            return ToolResult(text_parts=["Full document description"])
        return ToolResult(
            passages=[passage, _passage(chunk_id="unused", text="Uncited")],
            text_parts=["Continue at start=1"],
        )

    async def current(*_):
        return [{**asdict(passage), "id": passage.chunk_id}]

    monkeypatch.setattr(agent.models, "stream_agent_response", stream)
    monkeypatch.setattr(agent.tools, "run", run)
    monkeypatch.setattr(agent.store, "history_passages", current)
    first = await _collect("First question", ToolContext(workspace_id="ws_1"))
    done = first[-1]
    history = [
        {
            "id": "a1",
            "role": "assistant",
            "content": done["answer"],
            "toolEvidence": done["toolEvidence"],
        }
    ]
    second = [
        event
        async for event in agent.run_agent(
            query="Explain that",
            ctx=ToolContext(workspace_id="ws_1"),
            history=history,
            model=_model(),
        )
    ]
    assert len(seen) == 3 and not any(e["type"] == "tool_start" for e in second)
    replay = "\n".join(m["content"] for m in seen[-1]["messages"])
    assert passage.text in replay and "Full document description" in replay
    assert "Continue at start=1" not in replay and "Uncited" not in replay
    final = [e for e in second if e["type"] == "citations"][-1]
    assert final["citations"][0]["chunkId"] == passage.chunk_id
    assert second[-1]["toolEvidence"]["passages"][0]["chunk_id"] == passage.chunk_id


async def test_search_embedding_count_is_telemetry_not_a_cap(monkeypatch):
    async def _search(**_kwargs):
        return [_passage()]

    monkeypatch.setattr(tools, "search", _search)
    budget = agent.TurnBudget(embedding_calls=8)
    ctx = ToolContext(workspace_id="ws_1", budget=budget)
    ctx._scope_outline = {
        "chapters": [],
        "files": [{"id": "f_1", "name": "bio.pdf", "chapter_id": None, "chunks": 1}],
    }
    result = await tools._search_workspace({"query": "chlorophyll"}, ctx)

    assert not result.refused
    assert budget.embedding_calls == 9
    assert result.text() == ""


async def test_a_repeat_search_is_told_it_found_nothing_new(monkeypatch):
    """A reworded search that mostly re-finds passages the model already holds
    gets a stop signal in the result; a search that finds new ground does not."""

    async def _search(**_kwargs):
        return [
            _passage(chunk_id="c1"),
            _passage(chunk_id="c2"),
            _passage(chunk_id="c3"),
        ]

    monkeypatch.setattr(tools, "search", _search)
    ctx = ToolContext(workspace_id="ws_1", budget=agent.TurnBudget())
    ctx._scope_outline = {
        "chapters": [],
        "files": [{"id": "f_1", "name": "bio.pdf", "chapter_id": None, "chunks": 1}],
    }

    first = await tools._search_workspace({"query": "Hardy-Weinberg"}, ctx)
    assert first.text() == ""
    tools.assign_citations(ctx, first.passages)

    second = await tools._search_workspace(
        {"query": "allele frequency equilibrium"}, ctx
    )
    assert "3 of these 3 passages were already returned" in second.text()
    assert "rather than searching again" in second.text()

    assert [e["search_index"] for e in ctx.search_events] == [1, 2]
    assert [e["prior_overlap"] for e in ctx.search_events] == [0, 3]
    assert ctx.search_events[1]["chunk_ids"] == ["c1", "c2", "c3"]
    assert ctx.search_events[1]["hits"] == 3


async def test_search_hit_location_can_be_used_for_a_document_read(monkeypatch):
    passage = _passage(file_id="f_opaque", file_name="notes.md", chunk_idx=7)

    async def _search(**_kwargs):
        return [passage]

    read_args = {}

    async def _read_range(**kwargs):
        read_args.update(kwargs)
        return [
            {
                "id": passage.chunk_id,
                "file_id": passage.file_id,
                "file_name": passage.file_name,
                "chunk_idx": passage.chunk_idx,
                "text": passage.text,
            }
        ]

    monkeypatch.setattr(tools, "search", _search)
    monkeypatch.setattr(tools.store, "read_file_range", _read_range)
    ctx = ToolContext(workspace_id="ws_1", budget=agent.TurnBudget())
    ctx._scope_outline = {
        "chapters": [],
        "files": [
            {"id": "f_opaque", "name": "notes.md", "chapter_id": None, "chunks": 12}
        ],
    }
    tools.assign_citations(ctx, [_passage(chunk_id="prior", file_id="f_opaque")])
    result = await tools._search_workspace({"query": "chlorophyll"}, ctx)
    rendered = tools.render_result(result, tools.assign_citations(ctx, result.passages))
    location = re.search(r"\[2\] file_id=([^,\s]+), start=(\d+)", rendered)
    assert location is not None, (
        "Search hits must expose a usable document-read location."
    )

    read = await tools._read_document(
        {"file_id": location[1], "start": int(location[2])}, ctx
    )
    assert not read.refused
    assert read_args == {
        "workspace_id": "ws_1",
        "file_id": "f_opaque",
        "start": 7,
        "count": 4,
    }
    page = tools.render_result(read, tools.assign_citations(ctx, read.passages))
    assert "(next start = 8)" in page
    assert "[2] file_id=f_opaque, start=7" in page


async def test_turn_end_marks_which_hits_the_answer_cited(monkeypatch):
    """Citation numbers are answer-local; the telemetry row has to translate
    them back to the hit positions of the search that produced them."""
    written: list[list[dict]] = []

    async def _record(events):
        written.append(events)

    monkeypatch.setattr(agent.store, "record_search_events", _record)
    ctx = ToolContext(workspace_id="ws_1", user_id="u_1", assistant_message_id="m_1")
    hits = [_passage(chunk_id="c1"), _passage(chunk_id="c2"), _passage(chunk_id="c3")]
    tools.assign_citations(ctx, hits)
    ctx.search_events.append(
        tools._search_event(
            index=1,
            stats=tools.SearchStats(hits_lang="en", query_terms=2),
            scope_files=1,
            passages=hits,
            overlap=0,
        )
    )

    await agent._record_searches(ctx, [1, 3, 9])

    (events,) = written
    (event,) = events
    assert event["cited"] == [True, False, True]
    assert (event["workspace_id"], event["actor_user_id"], event["message_id"]) == (
        "ws_1",
        "u_1",
        "m_1",
    )
    assert event["hits_lang"] == "en"


async def test_telemetry_failure_does_not_fail_the_turn(monkeypatch):
    async def _boom(_events):
        raise RuntimeError("db away")

    monkeypatch.setattr(agent.store, "record_search_events", _boom)
    ctx = ToolContext(workspace_id="ws_1")
    ctx.search_events.append(
        tools._search_event(
            index=1, stats=tools.SearchStats(), scope_files=0, passages=[], overlap=0
        )
    )
    await agent._record_searches(ctx, [])


async def test_search_rejects_one_invalid_file_without_running_search(monkeypatch):
    called = {"n": 0}

    async def _search(**_kwargs):
        called["n"] += 1
        return []

    monkeypatch.setattr(tools, "search", _search)
    budget = agent.TurnBudget()
    ctx = ToolContext(workspace_id="ws_1", budget=budget)
    ctx._scope_outline = {
        "chapters": [],
        "files": [{"id": "f_1", "name": "one.pdf", "chapter_id": None, "chunks": 1}],
    }
    result = await tools._search_workspace(
        {"query": "q", "file_ids": ["f_1", "f_missing"]}, ctx
    )

    assert result.refused
    assert called["n"] == 0
    assert budget.embedding_calls == 0
    assert "invalid or unavailable" in result.text()


async def test_describe_requires_ids_and_read_rejects_foreign_file(monkeypatch):
    ctx = ToolContext(workspace_id="ws_1", file_ids=["f_1"])
    ctx._scope_outline = {
        "chapters": [],
        "files": [
            {"id": "f_1", "name": "one.pdf", "chapter_id": None, "chunks": 1},
            {"id": "f_2", "name": "two.pdf", "chapter_id": None, "chunks": 1},
        ],
    }
    described = await tools._describe_documents({}, ctx)
    read = await tools._read_document({"file_id": "f_2"}, ctx)

    assert described.refused
    assert "at least one file id" in described.text()
    assert read.refused
    assert read.text() == tools._INVALID_SCOPE


async def test_create_material_persists_resolved_scope(monkeypatch):
    ctx = ToolContext(
        workspace_id="ws_1",
        user_id="u1",
        operations=frozenset(contract.OPERATIONS),
        assistant_message_id="m_1",
    )
    ctx._scope_outline = {
        "chapters": [{"id": "ch_1", "name": "Chapter one"}],
        "files": [{"id": "f_1", "name": "one.pdf", "chapter_id": "ch_1", "chunks": 1}],
    }
    monkeypatch.setattr(tools.cfg, "gateway_url", "http://gw")
    monkeypatch.setattr(tools.cfg, "pipeline_secret", "s")
    seen = {}

    class _Resp:
        status_code = 200

        def json(self):
            return {
                "operationId": "op_x",
                "outcome": "succeeded",
                "effect": {
                    "operation": "created",
                    "operationId": "op_x",
                    "resource": {
                        "kind": "material",
                        "id": "mat_abc",
                        "title": "Note",
                        "materialKind": "note",
                    },
                },
            }

    def _post(*_args, **kwargs):
        seen.update(json.loads(kwargs["data"]))
        return _Resp()

    monkeypatch.setattr(tools.requests, "post", _post)
    result = await tools._create_material(
        {
            "kind": "note",
            "content": "body",
            "scope": {"chapter_ids": ["ch_1"]},
            "_tool_call_id": "call_1",
        },
        ctx,
    )

    assert not result.refused
    assert seen["fileIds"] == ["f_1"]
    assert seen["chapterIds"] == ["ch_1"]
    assert seen["assistantMessageId"] == "m_1"
    assert seen["toolCallId"] == "call_1"


async def test_create_material_clamps_model_title(monkeypatch):
    ctx = ToolContext(
        workspace_id="ws_1",
        user_id="u1",
        operations=frozenset(contract.OPERATIONS),
        assistant_message_id="m_1",
    )
    ctx._scope_outline = {
        "chapters": [],
        "files": [{"id": "f_1", "name": "one.pdf", "chapter_id": None, "chunks": 1}],
    }
    monkeypatch.setattr(tools.cfg, "gateway_url", "http://gw")
    monkeypatch.setattr(tools.cfg, "pipeline_secret", "s")
    seen = {}

    class _Resp:
        status_code = 200

        def json(self):
            return {
                "operationId": "op_x",
                "outcome": "succeeded",
                "effect": {
                    "operation": "created",
                    "operationId": "op_x",
                    "resource": {
                        "kind": "material",
                        "id": "mat_abc",
                        "title": "Note",
                        "materialKind": "note",
                    },
                },
            }

    def _post(*_args, **kwargs):
        seen.update(json.loads(kwargs["data"]))
        return _Resp()

    monkeypatch.setattr(tools.requests, "post", _post)
    await tools._create_material(
        {
            "kind": "note",
            "content": "body",
            "title": "光" * 300,
            "_tool_call_id": "call_1",
        },
        ctx,
    )

    assert len(seen["title"]) == tools.MATERIAL_TITLE_MAX


async def test_create_material_rejects_scope_without_indexed_content(monkeypatch):
    ctx = ToolContext(
        workspace_id="ws_1",
        user_id="u1",
        operations=frozenset(contract.OPERATIONS),
        assistant_message_id="m_1",
    )
    ctx._scope_outline = {
        "chapters": [],
        "files": [{"id": "f_1", "name": "one.pdf", "chapter_id": None, "chunks": 0}],
    }
    monkeypatch.setattr(tools.cfg, "gateway_url", "http://gw")
    monkeypatch.setattr(tools.cfg, "pipeline_secret", "s")

    result = await tools._create_material(
        {"kind": "note", "_tool_call_id": "call_1"}, ctx
    )

    assert result.refused
    assert "no indexed content" in result.text()


async def test_block_deltas_emit_while_provider_stream_is_open(monkeypatch):
    released = asyncio.Event()

    async def _stream(
        messages,
        *,
        model,
        tools=None,
        on_event=None,
        call_purpose="agent",
        response_format=None,
    ):
        del messages, model, tools, call_purpose
        if on_event is not None:
            on_event(StreamEvent(kind="text", text='{"answer":[{"text":"Hel'))
            on_event(StreamEvent(kind="text", text='lo","passages":[]}]}'))
        await released.wait()
        return _assembled(_answer(("Hello", [])))

    monkeypatch.setattr(agent.models, "stream_agent_response", _stream)

    events: list[dict] = []

    async def _consume() -> None:
        async for ev in agent.run_agent(
            query="q",
            ctx=ToolContext(workspace_id="ws_1"),
            history=None,
            model=_model(),
        ):
            events.append(ev)
            if ev.get("type") == "block_delta" and not released.is_set():
                released.set()

    await asyncio.wait_for(_consume(), timeout=2)
    assert [e["text"] for e in events if e["type"] == "block_delta"] == ["Hel", "lo"]


async def test_run_agent_answers_without_a_prime_search(monkeypatch):
    stream, seen = _script_stream(
        [_assembled(_answer(("Chlorophyll absorbs red.", [])))]
    )
    monkeypatch.setattr(agent.models, "stream_agent_response", stream)
    monkeypatch.setattr(agent.tools.cfg, "gateway_url", "")

    events = await _collect(
        "What does chlorophyll absorb?", ToolContext(workspace_id="ws_1")
    )
    kinds = [e["type"] for e in events]
    assert kinds[0] == "phase"
    assert "tool_start" not in kinds
    assert "block_start" in kinds
    assert "block_delta" in kinds
    assert {"type": "block_end", "blockId": "b1", "kind": "answer"} in events
    assert events[-1]["type"] == "done"
    assert events[-1]["answer"] == "Chlorophyll absorbs red."
    assert seen[0]["tools"] is not None
    assert seen[0]["response_format"] is None
    assert "create_material" not in [s["function"]["name"] for s in seen[0]["tools"]]


async def test_second_search_in_the_same_response_is_refused(monkeypatch):
    stream, _seen = _script_stream(
        [
            _assembled(
                "",
                [
                    _call("search_workspace", '{"query":"a"}', "s1"),
                    _call("search_workspace", '{"query":"b"}', "s2"),
                ],
            ),
            _assembled(_answer(("done", []))),
        ]
    )
    ran: list[str] = []

    async def _run(name, args, ctx):
        del args, ctx
        ran.append(name)
        return ToolResult(passages=[_passage(chunk_id=f"c_{len(ran)}")])

    monkeypatch.setattr(agent.models, "stream_agent_response", stream)
    monkeypatch.setattr(agent.tools, "run", _run)

    events = await _collect("q", ToolContext(workspace_id="ws_1"))
    assert ran == ["search_workspace"]
    ends = {e["callId"]: e["outcome"] for e in events if e["type"] == "tool_end"}
    assert ends["s1"] == "succeeded"
    assert ends["s2"] == "refused"


async def test_the_last_planning_round_drops_tools(monkeypatch):
    stream, seen = _script_stream([_assembled(_answer(("ok", [])))])
    monkeypatch.setattr(agent.models, "stream_agent_response", stream)
    monkeypatch.setattr(agent.cfg, "agent_max_steps", 1)

    await _collect("What does chlorophyll absorb?", ToolContext(workspace_id="ws_1"))
    assert seen[0]["tools"] is None


async def test_planning_text_with_tools_is_narration_then_answer(monkeypatch):
    stream, seen = _script_stream(
        [
            _assembled("Looking that up.", [_call("list_sources")]),
            _assembled(_answer(("Chlorophyll absorbs red.", []))),
        ]
    )

    async def _run(name, args, ctx):
        del args, ctx
        return ToolResult(text_parts=[f"ran {name}"])

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
    assert events[-1]["answer"] == "Chlorophyll absorbs red."
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

    stream, _seen = _script_stream(
        [
            _assembled("", [_call("read_document", '{"file_id":"f_1"}')]),
            _assembled(_answer(("See both.", [1, 2]))),
        ]
    )

    async def _run(name, args, ctx):
        del name, args
        return ToolResult(passages=[_passage(), extra])

    monkeypatch.setattr(agent.models, "stream_agent_response", stream)
    monkeypatch.setattr(agent.tools, "run", _run)

    events = await _collect("q", ToolContext(workspace_id="ws_1"))
    cite_events = [e for e in events if e["type"] == "citations"]
    # The tool round sends no list; the answer's own list arrives as its
    # markers appear, in the order used, and is final for the relay to persist.
    assert [e["version"] for e in cite_events] == [1]
    assert cite_events[0]["final"] is True
    assert [c["chunkId"] for c in cite_events[0]["citations"]] == ["c1", "c2"]
    assert events[-1]["answer"] == "See both. [1][2]"


async def test_read_batch_runs_concurrently_in_call_order(monkeypatch):
    overlap = {"active": 0, "peak": 0}

    stream, _seen = _script_stream(
        [
            _assembled(
                "",
                [
                    _call("list_sources", "{}", "c1"),
                    _call("describe_documents", "{}", "c2"),
                ],
            ),
            _assembled(_answer(("done", []))),
        ]
    )

    async def _run(name, args, ctx):
        del args, ctx
        overlap["active"] += 1
        overlap["peak"] = max(overlap["peak"], overlap["active"])
        await asyncio.sleep(0.04)
        overlap["active"] -= 1
        return ToolResult(text_parts=[f"ran {name}"])

    monkeypatch.setattr(agent.models, "stream_agent_response", stream)
    monkeypatch.setattr(agent.tools, "run", _run)

    events = await _collect("q", ToolContext(workspace_id="ws_1"))
    assert overlap["peak"] == 2
    # Each read reports its own completion as it finishes; only the tool
    # results handed to the model keep call order.
    ends = [e["callId"] for e in events if e["type"] == "tool_end"]
    assert sorted(ends) == ["c1", "c2"]
    tool_msgs = [m for m in _seen[1]["messages"] if m.get("role") == "tool"]
    assert [m["tool_call_id"] for m in tool_msgs] == ["c1", "c2"]


async def test_mixed_mutation_stays_serial(monkeypatch):
    overlap = {"active": 0, "peak": 0}

    stream, _seen = _script_stream(
        [
            _assembled(
                "",
                [
                    _call("list_sources", "{}", "c1"),
                    _call("create_material", '{"kind":"note"}', "c2"),
                ],
            ),
            _assembled(_answer(("made it", []))),
        ]
    )

    async def _run(name, args, ctx):
        del args, ctx
        overlap["active"] += 1
        overlap["peak"] = max(overlap["peak"], overlap["active"])
        await asyncio.sleep(0.03)
        overlap["active"] -= 1
        return ToolResult(text_parts=[f"ran {name}"])

    monkeypatch.setattr(agent.models, "stream_agent_response", stream)
    monkeypatch.setattr(agent.tools, "run", _run)
    monkeypatch.setattr(agent.tools.cfg, "gateway_url", "http://gw")
    monkeypatch.setattr(agent.tools.cfg, "pipeline_secret", "s")

    await _collect("q", ToolContext(workspace_id="ws_1", user_id="u1"))
    assert overlap["peak"] == 1


async def test_per_response_and_turn_caps_return_one_result_per_id(monkeypatch):
    calls = [_call("list_sources", "{}", f"c{i}") for i in range(5)]
    stream, seen = _script_stream(
        [_assembled("", calls), _assembled(_answer(("ok", [])))]
    )
    ran: list[str] = []

    async def _run(name, args, ctx):
        del args, ctx
        ran.append(name)
        return ToolResult(text_parts=[f"ran {name}"])

    monkeypatch.setattr(agent.models, "stream_agent_response", stream)
    monkeypatch.setattr(agent.tools, "run", _run)

    await _collect("q", ToolContext(workspace_id="ws_1"))
    assert len(ran) == TOOLS_PER_RESPONSE == 2
    tool_msgs = [m for m in seen[1]["messages"] if m.get("role") == "tool"]
    assert [m["tool_call_id"] for m in tool_msgs] == [f"c{i}" for i in range(5)]
    assert "2 tool-call limit" in tool_msgs[-1]["content"]


async def test_cumulative_input_measurement_does_not_strip_tools(monkeypatch):
    stream, seen = _script_stream(
        [
            _assembled(
                "more",
                [_call("list_sources")],
                NormalizedUsage(input_tokens=80),
            ),
            _assembled(_answer(("final", []))),
        ]
    )

    async def _run(name, args, ctx):
        del args, ctx
        return ToolResult(text_parts=[f"ran {name}"])

    monkeypatch.setattr(agent.models, "stream_agent_response", stream)
    monkeypatch.setattr(agent.tools, "run", _run)

    events = await _collect("q", ToolContext(workspace_id="ws_1"))
    assert seen[1]["tools"] is not None
    assert events[-1]["telemetry"]["reportedInputTokens"] == 80
    assert events[-1]["telemetry"]["stopReason"] == "answer"


async def test_exhausting_tool_response_runs_tools_then_one_terminal_call(
    monkeypatch,
):
    state = accounting.RequestAccounting(session_id="cr_1")
    token = accounting._accounting.set(state)
    calls = []
    purposes = []
    formats = []

    async def _stream(
        messages,
        *,
        model,
        tools=None,
        on_event=None,
        call_purpose="agent",
        response_format=None,
    ):
        del messages, model, on_event
        purposes.append(call_purpose)
        formats.append(response_format)
        if len(purposes) == 1:
            assert tools is not None
            state.credits_exhausted = True
            state.terminal_call_allowed = True
            return _assembled("I found more.", [_call("list_sources")])
        assert tools is None
        state.terminal_call_allowed = False
        return _assembled(_answer(("Final from the paid tool result.", [])))

    async def _run(name, args, ctx):
        del args, ctx
        calls.append(name)
        return ToolResult(text_parts=["paid result"])

    monkeypatch.setattr(agent.models, "stream_agent_response", _stream)
    monkeypatch.setattr(agent.tools, "run", _run)
    try:
        events = await _collect("q", ToolContext(workspace_id="ws_1"))
    finally:
        accounting._accounting.reset(token)

    assert calls == ["list_sources"]
    assert purposes == ["agent", "terminal"]
    assert formats == [None, agent.JSON_OBJECT]
    assert events[-1]["answer"] == "Final from the paid tool result."


async def test_estimated_tokens_accumulate_across_rounds(monkeypatch):
    stream, _seen = _script_stream(
        [
            _assembled("more", [_call("list_sources")]),
            _assembled(_answer(("final", []))),
        ]
    )

    async def _run(name, args, ctx):
        del args, ctx
        return ToolResult(text_parts=[f"ran {name}"])

    monkeypatch.setattr(agent.models, "stream_agent_response", stream)
    monkeypatch.setattr(agent.tools, "run", _run)
    monkeypatch.setattr(agent.compact, "needs_compact", lambda *_a, **_k: False)
    monkeypatch.setattr(
        agent.compact,
        "request_context",
        lambda *_a, **_k: accounting.ContextComposition(conversation_tokens=10),
    )

    events = await _collect("q", ToolContext(workspace_id="ws_1"))
    assert events[-1]["telemetry"]["estimatedInputTokens"] == 20


async def test_compaction_completion_count_does_not_stop_the_turn(monkeypatch):
    stream, _seen = _script_stream([_assembled(_answer(("final", [])))])

    async def _compact(messages, _spec, *, on_compact=None, **_kwargs):
        for _ in range(20):
            if on_compact is not None:
                on_compact()
        return messages

    monkeypatch.setattr(agent.models, "stream_agent_response", stream)
    monkeypatch.setattr(agent.compact, "compact_messages", _compact)

    events = await _collect("q", ToolContext(workspace_id="ws_1"))
    assert events[-1]["answer"] == "final"
    assert events[-1]["telemetry"]["completionCalls"] == 21
    assert events[-1]["telemetry"]["compactionCalls"] == 20


async def test_empty_response_does_not_resend(monkeypatch):
    stream, seen = _script_stream([_assembled(""), _assembled("should not run")])
    monkeypatch.setattr(agent.models, "stream_agent_response", stream)

    events = await _collect("q", ToolContext(workspace_id="ws_1"))
    assert len(seen) == 1
    assert events[-1]["telemetry"]["stopReason"] == "planning_cap"


async def test_internal_error_is_sanitized_and_carries_usage(monkeypatch):
    async def _boom(*_a, **_k):
        raise RuntimeError("psycopg connection to postgres.internal failed")

    monkeypatch.setattr(agent.models, "stream_agent_response", _boom)

    usage = obs.start_usage()
    usage.add_completion("deepseek", "deepseek-v4-flash", 10, 4)
    events = await _collect("q", ToolContext(workspace_id="ws_1"))
    err = next(e for e in events if e["type"] == "error")
    assert err["code"] == "agent_failed"
    assert "psycopg" not in err["message"]
    assert err["usage"]["inputTokens"] == 10


async def test_admit_checkpoint_folds_all_completed_history(monkeypatch):
    folded = {}

    async def _fold(**kwargs):
        folded.update(kwargs)
        return "all prior messages"

    monkeypatch.setattr(agent.compact, "needs_compact", lambda *_a, **_k: True)
    monkeypatch.setattr(agent.compact, "summarize_checkpoint", _fold)

    spec = _model()
    messages, replacement = await agent._admit_checkpoint(
        messages=[
            {"role": "system", "content": "sys"},
            {"role": "user", "content": "q", "_kind": "query"},
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
    )
    assert replacement is not None
    assert replacement["throughMessageId"] == "u5"
    assert [turn["id"] for turn in folded["turns"]] == [
        "u1",
        "u2",
        "u3",
        "u4",
        "u5",
    ]
    assert [message["content"] for message in messages] == [
        "sys",
        agent.chat_prompts.memory_message("all prior messages")["content"],
        "q",
    ]


async def test_missing_provider_usage_falls_back_to_estimates(monkeypatch):
    stream, _seen = _script_stream([_assembled(_answer(("short answer", [])))])
    monkeypatch.setattr(agent.models, "stream_agent_response", stream)

    events = await _collect("q", ToolContext(workspace_id="ws_1"))
    tel = events[-1]["telemetry"]
    assert tel["reportedInputTokens"] == 0
    assert tel["estimatedInputTokens"] > 0


async def test_done_carries_usage_when_the_meter_is_set(monkeypatch):
    stream, _seen = _script_stream([_assembled(_answer(("ok", [])))])
    monkeypatch.setattr(agent.models, "stream_agent_response", stream)

    usage = obs.start_usage()
    usage.add_completion("deepseek", "deepseek-v4-flash", 10, 4)
    events = await _collect("q", ToolContext(workspace_id="ws_1"))
    done = events[-1]
    assert done["usage"]["inputTokens"] == 10
    assert done["tokenCount"] == 14


async def test_checkpoint_rewrite_does_not_duplicate_the_question(monkeypatch):
    stream, seen = _script_stream([_assembled(_answer(("ok", [])))])

    folded = {}

    async def _fold(**kwargs):
        folded.update(kwargs)
        return "prior facts"

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
        model=_model(),
        checkpoint={"summary": "older"},
    ):
        events.append(event)

    assert any(e["type"] == "checkpoint" for e in events)
    contents = [m.get("content") for m in seen[0]["messages"]]
    assert contents.count("current question") == 1
    assert len(folded["turns"]) == len(history)
    assert folded["current_user_message"] == "current question"


async def test_checkpoint_folds_trailing_user_message_from_failed_turn(monkeypatch):
    folded = {}
    monkeypatch.setattr(agent.compact, "needs_compact", lambda *_a, **_k: True)

    async def _fold(**kwargs):
        folded.update(kwargs)
        return "folded memory"

    monkeypatch.setattr(agent.compact, "summarize_checkpoint", _fold)
    query = {"role": "user", "content": "current", "_kind": "query"}
    rebuilt, replacement = await agent._admit_checkpoint(
        messages=[
            {"role": "system", "content": "system"},
            {"role": "user", "content": "old question"},
            {"role": "assistant", "content": "old answer"},
            {"role": "user", "content": "failed question"},
            query,
        ],
        history=[
            {"id": "m1", "role": "user", "content": "old question"},
            {"id": "m2", "role": "assistant", "content": "old answer"},
            {"id": "m3", "role": "user", "content": "failed question"},
        ],
        checkpoint=None,
        spec=_model(),
        schemas=[],
        budget=agent.TurnBudget(),
        query_msg=query,
    )

    assert replacement is not None
    assert replacement["throughMessageId"] == "m3"
    assert [turn["id"] for turn in folded["turns"]] == ["m1", "m2", "m3"]
    assert [message["content"] for message in rebuilt] == [
        "system",
        agent.chat_prompts.memory_message("folded memory")["content"],
        "current",
    ]


def test_operation_id_matches_the_go_fixture():
    # server/internal/store/agent_operations_test.go pins the same literal.
    assert tools.operation_id("m_1", "call_1") == "op_4bf000a1f98d2dcd046acbf1"
    assert tools.operation_id("m_1", "call_1") != tools.operation_id("m_1", "call_2")


async def test_material_confirmed_404_is_a_tool_failure(monkeypatch):
    ctx = ToolContext(
        workspace_id="ws_1",
        user_id="u1",
        operations=frozenset(contract.OPERATIONS),
        assistant_message_id="m_1",
    )
    ctx._scope_outline = {
        "chapters": [],
        "files": [{"id": "f_1", "name": "source.pdf", "chapter_id": None, "chunks": 1}],
    }
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

    def _get(url, **kwargs):
        got["params"] = kwargs.get("params")
        got["url"] = url
        return _Resp(404)

    async def _nosleep(*_a, **_k):
        return None

    monkeypatch.setattr(tools.requests, "post", _post)
    monkeypatch.setattr(tools.requests, "get", _get)
    monkeypatch.setattr(tools.asyncio, "sleep", _nosleep)

    result = await tools._create_material(
        {"kind": "note", "_tool_call_id": "call_1"}, ctx
    )
    assert result.failed and result.outcome == "failed"
    assert posts["n"] == 4
    assert got["params"] == {"workspaceId": "ws_1", "userId": "u1"}
    assert got["url"].endswith(
        "/api/internal/agent-operations/" + tools.operation_id("m_1", "call_1")
    )


async def test_material_uncertain_get_fails_the_turn(monkeypatch):
    ctx = ToolContext(
        workspace_id="ws_1",
        user_id="u1",
        operations=frozenset(contract.OPERATIONS),
        assistant_message_id="m_1",
    )
    ctx._scope_outline = {
        "chapters": [],
        "files": [{"id": "f_1", "name": "source.pdf", "chapter_id": None, "chunks": 1}],
    }
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
        await tools._create_material({"kind": "note", "_tool_call_id": "call_1"}, ctx)


async def test_repeated_material_post_returns_original(monkeypatch):
    ctx = ToolContext(
        workspace_id="ws_1",
        user_id="u1",
        operations=frozenset(contract.OPERATIONS),
        assistant_message_id="m_1",
    )
    ctx._scope_outline = {
        "chapters": [],
        "files": [{"id": "f_1", "name": "source.pdf", "chapter_id": None, "chunks": 1}],
    }
    monkeypatch.setattr(tools.cfg, "gateway_url", "http://gw")
    monkeypatch.setattr(tools.cfg, "pipeline_secret", "s")

    class _Resp:
        status_code = 200

        def json(self):
            return {
                "operationId": "op_x",
                "outcome": "succeeded",
                "effect": {
                    "operation": "created",
                    "operationId": "op_x",
                    "resource": {
                        "kind": "material",
                        "id": "mat_abc",
                        "title": "Note",
                        "materialKind": "note",
                    },
                },
            }

    monkeypatch.setattr(tools.requests, "post", lambda *_a, **_k: _Resp())
    first = await tools._create_material(
        {"kind": "note", "_tool_call_id": "call_1"}, ctx
    )
    second = await tools._create_material(
        {"kind": "note", "_tool_call_id": "call_1"}, ctx
    )
    assert first.effects == second.effects
    assert first.effects[0]["resource"]["id"] == "mat_abc"


async def test_client_drop_after_stream_skips_tools_and_next_call(monkeypatch):
    client = agent.ClientDrop()
    calls = {"n": 0}

    async def _stream(
        messages,
        *,
        model,
        tools=None,
        on_event=None,
        call_purpose="agent",
        response_format=None,
    ):
        del messages, model, call_purpose
        calls["n"] += 1
        assembled = _assembled(
            "looking",
            [_call("list_sources")],
        )
        if on_event is not None:
            on_event(StreamEvent(kind="text", text="looking"))
        client.mark()
        return assembled

    monkeypatch.setattr(agent.models, "stream_agent_response", _stream)

    events = []
    async for event in agent.run_agent(
        query="q",
        ctx=ToolContext(workspace_id="ws_1"),
        history=None,
        model=_model(),
        client=client,
    ):
        events.append(event)
    assert calls["n"] == 1
    assert not any(e.get("type") == "tool_start" for e in events)
    assert events[-1]["type"] != "error"


async def test_client_drop_before_stream_skips_provider_call(monkeypatch):
    calls = {"n": 0}

    async def _stream(
        messages,
        *,
        model,
        tools=None,
        on_event=None,
        call_purpose="agent",
        response_format=None,
    ):
        del messages, model, tools, on_event, call_purpose
        calls["n"] += 1
        return _assembled("late")

    monkeypatch.setattr(agent.models, "stream_agent_response", _stream)

    client = agent.ClientDrop()
    client.mark()
    events = []
    async for event in agent.run_agent(
        query="q",
        ctx=ToolContext(workspace_id="ws_1"),
        history=None,
        model=_model(),
        client=client,
    ):
        events.append(event)
    assert calls["n"] == 0
    assert not any(e.get("type") == "error" for e in events)
    assert not any(e.get("type") == "phase" for e in events)


async def test_client_drop_does_not_cancel_in_flight_provider_call(monkeypatch):
    started = asyncio.Event()
    release = asyncio.Event()
    finished = {"n": 0}

    async def _stream(
        messages,
        *,
        model,
        tools=None,
        on_event=None,
        call_purpose="agent",
        response_format=None,
    ):
        del messages, model, tools, call_purpose
        if on_event is not None:
            on_event(StreamEvent(kind="text", text="partial"))
        started.set()
        await release.wait()
        finished["n"] += 1
        return _assembled("partial extra")

    monkeypatch.setattr(agent.models, "stream_agent_response", _stream)

    client = agent.ClientDrop()
    events: list[dict] = []

    async def _run() -> None:
        async for event in agent.run_agent(
            query="q",
            ctx=ToolContext(workspace_id="ws_1"),
            history=None,
            model=_model(),
            client=client,
        ):
            events.append(event)

    task = asyncio.create_task(_run())
    await started.wait()
    client.mark()
    await asyncio.sleep(0)
    assert finished["n"] == 0
    release.set()
    await task
    assert finished["n"] == 1
    assert not any(e.get("type") == "error" for e in events)


@pytest.mark.asyncio
async def test_relay_stops_sse_and_waits_for_agent():
    from pipeline.retrieve import service as retrieve_service

    released = asyncio.Event()
    finished = {"n": 0}

    async def _agen():
        yield {"type": "phase", "phase": "planning"}
        await released.wait()
        finished["n"] += 1
        yield {"type": "done"}

    class _Req:
        def __init__(self) -> None:
            self.gone = False

        async def is_disconnected(self) -> bool:
            return self.gone

    req = _Req()
    client = agent.ClientDrop()
    chunks: list[str] = []

    async def _consume() -> None:
        async for chunk in retrieve_service._relay_until_disconnect(
            req, _agen(), client
        ):
            chunks.append(chunk)
            req.gone = True

    task = asyncio.create_task(_consume())
    await asyncio.sleep(0.05)
    assert finished["n"] == 0
    assert client.dropped
    released.set()
    await task
    assert finished["n"] == 1
    assert any("planning" in c for c in chunks)
    assert not any("done" in c for c in chunks)


# ------------------------------------------------------------- trash tools


def _owner_ctx() -> ToolContext:
    ctx = ToolContext(
        workspace_id="ws_1",
        user_id="u1",
        operations=frozenset(contract.OPERATIONS),
        assistant_message_id="m_1",
    )
    ctx._scope_outline = {
        "chapters": [],
        "files": [
            {"id": "f_1", "name": "one.pdf", "chapter_id": None, "chunks": 1},
            {"id": "f_2", "name": "two.pdf", "chapter_id": None, "chunks": 1},
        ],
    }
    return ctx


def _receipt(operation: str, kind: str, rid: str) -> dict:
    return {
        "operationId": "op_x",
        "outcome": "succeeded",
        "effect": {
            "operation": operation,
            "operationId": "op_x",
            "resource": {"kind": kind, "id": rid, "title": "one.pdf"},
            "trashEpisodeId": "trash_1",
        },
    }


def test_trash_tools_follow_the_operations_table(monkeypatch):
    monkeypatch.setattr(tools.cfg, "gateway_url", "http://gw")
    monkeypatch.setattr(tools.cfg, "pipeline_secret", "s")
    editor = ToolContext(
        workspace_id="ws",
        user_id="u",
        operations=frozenset(
            {
                "source.read",
                "material.read",
                "material.create",
                "document.edit",
                "resource.trash",
            }
        ),
    )
    names = {s["function"]["name"] for s in tools.schemas_for(editor)}
    assert "trash_file" in names
    assert "list_trashed_files" not in names and "restore_file" not in names
    owner = ToolContext(
        workspace_id="ws", user_id="u", operations=frozenset(contract.OPERATIONS)
    )
    names = {s["function"]["name"] for s in tools.schemas_for(owner)}
    assert {"trash_file", "list_trashed_files", "restore_file"} <= names


async def test_trash_file_posts_the_target_and_narrows_a_restricted_scope(monkeypatch):
    ctx = _owner_ctx()
    ctx.file_ids = ["f_1", "f_2"]
    monkeypatch.setattr(tools.cfg, "gateway_url", "http://gw")
    monkeypatch.setattr(tools.cfg, "pipeline_secret", "s")
    seen: dict = {}

    class _Resp:
        status_code = 200

        def json(self):
            return _receipt("trashed", "source_file", "f_1")

    def _post(url, **kwargs):
        seen["url"] = url
        seen.update(json.loads(kwargs["data"]))
        return _Resp()

    reloaded = {"n": 0}

    async def _load(workspace_id, file_ids=None):
        reloaded["n"] += 1
        reloaded["file_ids"] = file_ids
        return pending.PendingSources()

    monkeypatch.setattr(tools.requests, "post", _post)
    monkeypatch.setattr(tools.pending, "load", _load)
    result = await tools.run(
        "trash_file",
        {"target": {"kind": "source_file", "id": "f_1"}, "_tool_call_id": "c1"},
        ctx,
    )

    assert result.outcome == "succeeded"
    assert result.effects[0]["operation"] == "trashed"
    assert seen["url"].endswith("/api/internal/trash")
    assert seen["target"] == {"kind": "source_file", "id": "f_1"}
    assert seen["assistantMessageId"] == "m_1" and seen["toolCallId"] == "c1"
    # The turn's own view is refreshed: outline dropped, scope narrowed, baseline re-read.
    assert ctx._scope_outline is None
    assert ctx.file_ids == ["f_2"]
    assert reloaded == {"n": 1, "file_ids": ["f_2"]}
    assert "no longer current evidence" in result.text()


async def test_trash_file_refuses_a_file_outside_the_scope(monkeypatch):
    ctx = _owner_ctx()
    ctx.file_ids = ["f_1"]
    monkeypatch.setattr(tools.cfg, "gateway_url", "http://gw")
    monkeypatch.setattr(tools.cfg, "pipeline_secret", "s")
    posted = {"n": 0}

    def _post(*_a, **_k):
        posted["n"] += 1
        raise AssertionError("must not reach the gateway")

    monkeypatch.setattr(tools.requests, "post", _post)
    result = await tools.run(
        "trash_file",
        {"target": {"kind": "source_file", "id": "f_2"}, "_tool_call_id": "c1"},
        ctx,
    )
    assert result.refused and posted["n"] == 0
    invalid = await tools.run(
        "trash_file",
        {"target": {"kind": "folder", "id": "x"}, "_tool_call_id": "c1"},
        ctx,
    )
    assert invalid.refused and invalid.error_code == "invalid_input"


async def test_restricted_scope_emptied_by_trash_stays_empty(monkeypatch):
    ctx = _owner_ctx()
    ctx.file_ids = ["f_1"]
    monkeypatch.setattr(tools.cfg, "gateway_url", "http://gw")
    monkeypatch.setattr(tools.cfg, "pipeline_secret", "s")

    class _Resp:
        status_code = 200

        def json(self):
            return _receipt("trashed", "source_file", "f_1")

    async def _load(workspace_id, file_ids=None):
        return pending.PendingSources()

    monkeypatch.setattr(tools.requests, "post", lambda *_a, **_k: _Resp())
    monkeypatch.setattr(tools.pending, "load", _load)
    await tools.run(
        "trash_file",
        {"target": {"kind": "source_file", "id": "f_1"}, "_tool_call_id": "c1"},
        ctx,
    )
    assert ctx.file_ids == []

    async def _outline(_workspace_id):
        return {
            "chapters": [],
            "files": [
                {"id": "f_2", "name": "two.pdf", "chapter_id": None, "chunks": 1}
            ],
        }

    monkeypatch.setattr(tools.store, "workspace_outline", _outline)
    listed = await tools._list_sources({}, ctx)
    assert "two.pdf" not in listed.text()
    resolved = await tools._resolve_scope(ctx, tools._MISSING)
    assert isinstance(resolved, tools.ResolvedScope) and resolved.file_ids == []


async def test_list_trashed_files_renders_ids_for_restore(monkeypatch):
    ctx = _owner_ctx()
    monkeypatch.setattr(tools.cfg, "gateway_url", "http://gw")
    monkeypatch.setattr(tools.cfg, "pipeline_secret", "s")

    class _Resp:
        status_code = 200

        def json(self):
            return {
                "items": [
                    {
                        "kind": "material",
                        "id": "mat_9",
                        "title": "Old quiz",
                        "materialKind": "quiz",
                        "trashedAt": "2026-09-09T00:00:00Z",
                        "purgeAfter": "2026-10-09T00:00:00Z",
                        "episodeId": "trash_1",
                    }
                ]
            }

    monkeypatch.setattr(tools.requests, "get", lambda *_a, **_k: _Resp())
    result = await tools.run("list_trashed_files", {"_tool_call_id": "c1"}, ctx)
    assert "mat_9" in result.text() and "kind=material" in result.text()


async def test_restore_file_posts_to_the_restore_route(monkeypatch):
    ctx = _owner_ctx()
    monkeypatch.setattr(tools.cfg, "gateway_url", "http://gw")
    monkeypatch.setattr(tools.cfg, "pipeline_secret", "s")
    seen: dict = {}

    class _Resp:
        status_code = 200

        def json(self):
            return _receipt("restored", "material", "mat_9")

    def _post(url, **kwargs):
        seen["url"] = url
        return _Resp()

    async def _load(workspace_id, file_ids=None):
        return pending.PendingSources()

    monkeypatch.setattr(tools.requests, "post", _post)
    monkeypatch.setattr(tools.pending, "load", _load)
    result = await tools.run(
        "restore_file",
        {"target": {"kind": "material", "id": "mat_9"}, "_tool_call_id": "c1"},
        ctx,
    )
    assert result.outcome == "succeeded"
    assert seen["url"].endswith("/api/internal/trash/restore")
    assert result.effects[0]["operation"] == "restored"


def _gateway(monkeypatch, *, get=None, post=None):
    monkeypatch.setattr(tools.cfg, "gateway_url", "http://gw")
    monkeypatch.setattr(tools.cfg, "pipeline_secret", "s")
    if get is not None:
        monkeypatch.setattr(tools.requests, "get", get)
    if post is not None:
        monkeypatch.setattr(tools.requests, "post", post)


class _JsonResp:
    def __init__(self, body, status=200):
        self._body = body
        self.status_code = status

    def json(self):
        return self._body


async def test_list_documents_hides_files_outside_a_restricted_scope(monkeypatch):
    ctx = _owner_ctx()
    ctx.file_ids = ["f_2"]
    seen: dict = {}

    def _post(url, **kwargs):
        seen["url"] = url
        seen.update(json.loads(kwargs["data"]))
        return _JsonResp(
            {
                "items": [
                    {
                        "kind": "source_file",
                        "id": "f_1",
                        "title": "one.pdf",
                        "format": "pdf",
                        "editable": False,
                        "reason": "pdf",
                    },
                    {
                        "kind": "source_file",
                        "id": "f_2",
                        "title": "two.txt",
                        "format": "text",
                        "editable": True,
                    },
                    {
                        "kind": "material",
                        "id": "mat_1",
                        "title": "Notes",
                        "format": "plate",
                        "materialKind": "note",
                        "editable": True,
                    },
                ]
            }
        )

    _gateway(monkeypatch, post=_post)
    result = await tools.run("list_documents", {"_tool_call_id": "c1"}, ctx)
    text = result.text()
    assert seen["url"].endswith("/api/internal/documents/list")
    assert seen["userId"] == "u1" and seen["workspaceId"] == "ws_1"
    assert "f_1" not in text and "one.pdf" not in text
    assert "id=f_2" in text and "editable" in text
    assert "id=mat_1" in text and "note" in text


async def test_inspect_document_renders_blocks_lines_and_office_entries(monkeypatch):
    ctx = _owner_ctx()
    bodies = iter(
        [
            {
                "format": "plate",
                "title": "Notes",
                "revision": 3,
                "supportedOperations": ["replace_text"],
                "blocks": [
                    {"id": "b1", "type": "p", "text": "hello", "properties": {}},
                    {
                        "id": "q1",
                        "type": "quiz",
                        "text": "",
                        "children": [
                            {"id": "qq1", "type": "quiz_question", "text": "Why?"}
                        ],
                    },
                    {
                        "id": "m1",
                        "type": "mermaid",
                        "text": "",
                        "properties": {"source": "graph TD"},
                    },
                ],
            },
            {
                "format": "xlsx",
                "title": "book.xlsx",
                "revision": 1,
                "supportedOperations": ["set_cell"],
                "entries": [{"id": "s1:[1,1]", "label": "Sheet1!A1", "value": "42"}],
                "total": 80,
                "nextStart": 60,
            },
        ]
    )

    def _post(url, **kwargs):
        return _JsonResp(next(bodies))

    _gateway(monkeypatch, post=_post)
    material = await tools.run(
        "inspect_document",
        {"target": {"kind": "material", "id": "mat_1"}, "_tool_call_id": "c1"},
        ctx,
    )
    text = material.text()
    assert "[b1] (p) hello" in text
    assert "    [qq1] (quiz_question) Why?" in text
    assert "source: graph TD" in text
    office = await tools.run(
        "inspect_document",
        {"target": {"kind": "source_file", "id": "f_1"}, "_tool_call_id": "c2"},
        ctx,
    )
    text = office.text()
    assert "supported: set_cell" in text
    assert "[s1:[1,1]] Sheet1!A1: 42" in text
    assert "(next start = 60 of 80)" in text


async def test_edit_document_posts_commands_and_refreshes_the_turn_view(monkeypatch):
    ctx = _owner_ctx()
    ctx.file_ids = ["f_1", "f_2"]
    seen: dict = {}

    def _post(url, **kwargs):
        seen["url"] = url
        seen.update(json.loads(kwargs["data"]))
        body = _receipt("edited", "source_file", "f_1")
        body["effect"]["undo"] = {"operationId": "op_x", "status": "available"}
        return _JsonResp(body)

    reloaded = {"n": 0}

    async def _load(workspace_id, file_ids=None):
        reloaded["n"] += 1
        return pending.PendingSources()

    _gateway(monkeypatch, post=_post)
    monkeypatch.setattr(tools.pending, "load", _load)
    commands = [
        {
            "type": "replace_text",
            "target_id": "body:paragraph:p1",
            "expected_text": "old",
            "text": "new",
        }
    ]
    result = await tools.run(
        "edit_document",
        {
            "target": {"kind": "source_file", "id": "f_1"},
            "commands": commands,
            "_tool_call_id": "c1",
        },
        ctx,
    )
    assert result.outcome == "succeeded"
    assert seen["url"].endswith("/api/internal/documents/edit")
    assert seen["commands"] == commands and "expectedRevision" not in seen
    assert seen["assistantMessageId"] == "m_1" and seen["toolCallId"] == "c1"
    assert result.effects[0]["operation"] == "edited"
    assert ctx._scope_outline is None and reloaded["n"] == 1


async def test_edit_document_refuses_a_file_outside_the_scope_and_invalid_commands(
    monkeypatch,
):
    ctx = _owner_ctx()
    ctx.file_ids = ["f_2"]
    calls = {"n": 0}

    def _post(url, **kwargs):
        calls["n"] += 1
        return _JsonResp({})

    _gateway(monkeypatch, post=_post)
    result = await tools.run(
        "edit_document",
        {
            "target": {"kind": "source_file", "id": "f_1"},
            "commands": [{"type": "replace_text", "expected_text": "a", "text": "b"}],
            "_tool_call_id": "c1",
        },
        ctx,
    )
    assert result.refused and calls["n"] == 0
    invalid = await tools.run(
        "edit_document",
        {
            "target": {"kind": "material", "id": "mat_1"},
            "commands": [{"type": "explode"}],
            "_tool_call_id": "c2",
        },
        ctx,
    )
    assert invalid.error_code == "invalid_input" and calls["n"] == 0


# ---------------------------------------------------------- structured answers


def _stream_chunks(
    chunks_per_response: list[list[str]], finals: list[AssembledResponse]
):
    """Like ``_script_stream`` but with explicit text deltas per response."""
    seen: list[dict] = []

    async def _stream(
        messages,
        *,
        model,
        tools=None,
        on_event=None,
        call_purpose="agent",
        response_format=None,
    ):
        del model, call_purpose
        seen.append(
            {
                "tools": tools,
                "messages": list(messages),
                "response_format": response_format,
            }
        )
        chunks = chunks_per_response.pop(0)
        if on_event is not None:
            for part in chunks:
                on_event(StreamEvent(kind="text", text=part))
        return finals.pop(0)

    return _stream, seen


async def _two_passage_turn(
    monkeypatch, chunks: list[str], final: str, extra_finals=()
):
    """One read_document step showing [1] and [2], then the answer stream."""
    chunk_lists = [[], chunks] + [[] for _ in extra_finals]
    finals = [
        _assembled("", [_call("read_document", '{"file_id":"f_1"}')]),
        _assembled(final),
        *extra_finals,
    ]
    stream, seen = _stream_chunks(chunk_lists, finals)

    async def _run(name, args, ctx):
        del name, args, ctx
        return ToolResult(
            passages=[
                _passage(chunk_id="c1", page_start=1, page_end=1),
                _passage(
                    chunk_id="c2",
                    text="Calvin cycle fixes carbon.",
                    page_start=2,
                    page_end=2,
                ),
            ]
        )

    monkeypatch.setattr(agent.models, "stream_agent_response", stream)
    monkeypatch.setattr(agent.tools, "run", _run)
    events = await _collect("q", ToolContext(workspace_id="ws_1"))
    return events, seen


async def test_json_answer_streams_as_prose_with_renumbered_citations(monkeypatch):
    raw = '{"answer":[{"text":"Carbon is fixed.","passages":[2]},{"text":"Light is absorbed.","passages":[1,2]}]}'
    chunks = [raw[i : i + 9] for i in range(0, len(raw), 9)]
    events, _seen = await _two_passage_turn(monkeypatch, chunks, raw)

    deltas = [e["text"] for e in events if e["type"] == "block_delta"]
    answer = "Carbon is fixed. [1]\n\nLight is absorbed. [2][1]"
    assert "".join(deltas) == answer
    # No raw JSON ever reached the stream.
    assert not any("{" in d or '"passages"' in d for d in deltas)
    assert events[-1]["answer"] == answer
    cites = [e for e in events if e["type"] == "citations"]
    # Only the used list, growing as the markers appear: [1] = c2 first. The
    # retrieved-but-unused passages never reach the browser.
    assert [[c["chunkId"] for c in e["citations"]] for e in cites] == [
        ["c2"],
        ["c2", "c1"],
    ]
    assert [e["version"] for e in cites] == [1, 2]
    assert all(e.get("final") for e in cites)
    assert events[-1]["telemetry"]["completionCalls"] == 2


async def test_unfinished_json_answer_keeps_the_streamed_prose(monkeypatch):
    raw = '{"answer":[{"text":"Carbon is fixed.","passages":[2]},{"text":"Cut off'
    events, _seen = await _two_passage_turn(monkeypatch, [raw], raw)

    assert events[-1]["answer"] == "Carbon is fixed. [1]\n\nCut off"
    final = [e for e in events if e["type"] == "citations"][-1]
    assert [c["chunkId"] for c in final["citations"]] == ["c2"]
    assert events[-1]["telemetry"]["completionCalls"] == 2


async def test_plain_prose_answer_is_repaired_once_in_json_mode(monkeypatch):
    prose = "Carbon is fixed [2]. Light is absorbed [1]."
    repaired = _assembled(
        '{"answer":[{"text":"Carbon is fixed.","passages":[2]},{"text":"Light is absorbed.","passages":[1]}]}'
    )
    events, seen = await _two_passage_turn(
        monkeypatch, [prose[:10], prose[10:]], prose, [repaired]
    )

    # The prose was held back; the repaired rendering is the only text sent.
    assert sum(e["type"] == "block_start" for e in events) == 1
    deltas = [e["text"] for e in events if e["type"] == "block_delta"]
    assert deltas == ["Carbon is fixed. [1]\n\nLight is absorbed. [2]"]
    assert events[-1]["answer"] == deltas[0]
    repair_call = seen[2]
    assert repair_call["tools"] is None
    assert repair_call["response_format"] == agent.JSON_OBJECT
    assert repair_call["messages"][-2:] == [
        {"role": "assistant", "content": prose},
        {"role": "user", "content": agent.REPAIR_PROMPT},
    ]
    final = [e for e in events if e["type"] == "citations"][-1]
    assert [c["chunkId"] for c in final["citations"]] == ["c2", "c1"]
    assert events[-1]["telemetry"]["completionCalls"] == 3


async def test_failed_repair_keeps_the_raw_prose_without_citations(monkeypatch):
    prose = "Carbon is fixed [2]."
    events, _seen = await _two_passage_turn(
        monkeypatch, [prose], prose, [_assembled("still prose")]
    )

    assert events[-1]["answer"] == prose
    final = [e for e in events if e["type"] == "citations"][-1]
    assert final["citations"] == [] and final["final"] is True


async def test_answer_call_without_tools_requests_json_mode(monkeypatch):
    stream, seen = _script_stream([_assembled(_answer(("ok", [])))])
    monkeypatch.setattr(agent.models, "stream_agent_response", stream)
    monkeypatch.setattr(agent.cfg, "agent_max_steps", 1)

    await _collect("q", ToolContext(workspace_id="ws_1"))
    assert seen[0]["tools"] is None
    assert seen[0]["response_format"] == agent.JSON_OBJECT


async def test_captured_images_ride_into_the_next_request_only(monkeypatch):
    buffer = io.BytesIO()
    Image.new("RGB", (56, 28), "white").save(buffer, "JPEG")
    jpeg = buffer.getvalue()
    stream, seen = _script_stream(
        [
            _assembled("", [_call("read_document", '{"file_id":"f_1"}', "r1")]),
            _assembled("", [_call("capture_page", '{"file_id":"f_1","page":1}', "k1")]),
            _assembled(_answer(("Seen.", [1]))),
        ]
    )

    async def _run(name, args, ctx):
        if name == "read_document":
            return ToolResult(
                passages=[_passage(chunk_id="c1", page_start=1, page_end=1)]
            )
        assert name == "capture_page"
        ctx.captures.append(
            agent.capture.record(
                call_id=args["_tool_call_id"],
                file_id="f_1",
                page=1,
                box=[0, 0, 1000, 1000],
                jpeg=jpeg,
                size=(56, 28),
                started=0.0,
            )
        )
        ctx.pending_images[args["_tool_call_id"]] = (
            "capture_page result 1",
            agent.capture.data_url(jpeg),
        )
        return ToolResult(text_parts=["Captured page 1."])

    monkeypatch.setattr(agent.models, "stream_agent_response", stream)
    monkeypatch.setattr(agent.tools, "run", _run)

    events = await _collect("q", ToolContext(workspace_id="ws_1"))

    roles = [m["role"] for m in seen[2]["messages"]]
    assert roles[-3:] == ["assistant", "tool", "user"]
    image_message = seen[2]["messages"][-1]
    assert image_message["content"][-1]["type"] == "image_url"
    assert seen[1]["messages"][-1]["role"] == "tool"
    activity = events[-1]["activity"]
    capture_block = next(b for b in activity if b.get("name") == "capture_page")
    assert capture_block["capture"] == {
        "page": 1,
        "bbox": [0, 0, 1000, 1000],
        "bytes": len(jpeg),
    }
    assert capture_block["detail"] == "page 1"
    assert events[-1]["answer"] == "Seen. [1]"
    # Telemetry counts the image by its 28 px patches (2 x 1), not its base64.
    with_image = agent.models.measure_request_context(
        seen[2]["messages"], model=_model()
    )
    stripped, _ = agent.capture.split_images(seen[2]["messages"])
    without = agent.models.measure_request_context(stripped, model=_model())
    assert with_image.total_tokens - without.total_tokens == 2


@pytest.mark.parametrize(
    "raw",
    [
        '{"answer": "Carbon is fixed [2]."}',
        '{"answer": {"text": "Carbon is fixed.", "passages": [2]}}',
        '{"answer": []}',
        # Non-numeric passage entries: the claim text already streamed is
        # reset by a repeated block_start and replaced by the repaired answer.
        '{"answer": [{"text": "Carbon is fixed.", "passages": [2.0]}]}',
        '{"answer": [{"text": "Carbon is fixed.", "passages": [true]}]}',
        '{"answer": [{"text": "Carbon is fixed.", "passages": null}]}',
        '{"answer": [{"text": "Carbon is fixed.", "passages": "2"}]}',
        '{"answer": [{"text": "Carbon is fixed.", "passages": 2}]}',
        '{"answer": [{"text": "Carbon is fixed.", "passages": {}}]}',
    ],
)
async def test_complete_json_of_the_wrong_shape_is_repaired(monkeypatch, raw):
    repaired = _assembled('{"answer":[{"text":"Carbon is fixed.","passages":[2]}]}')
    events, seen = await _two_passage_turn(
        monkeypatch, [raw[:7], raw[7:]], raw, [repaired]
    )

    assert len(seen) == 3 and seen[2]["response_format"] == agent.JSON_OBJECT
    # Whatever streamed before the shape was known, the last block_start
    # resets it and the only text after it is the repaired answer.
    starts = [i for i, e in enumerate(events) if e["type"] == "block_start"]
    after = [e["text"] for e in events[starts[-1] :] if e["type"] == "block_delta"]
    assert after == ["Carbon is fixed. [1]"]
    assert events[-1]["answer"] == "Carbon is fixed. [1]"
    final = [e for e in events if e["type"] == "citations"][-1]
    assert [c["chunkId"] for c in final["citations"]] == ["c2"]


async def test_attached_captures_count_against_the_compaction_budget(monkeypatch):
    """Images ride outside ``messages``; their patch estimate is passed as
    ``extra`` so a turn compacted to the edge of the window still fits them."""
    extras: list[int] = []
    original = agent.compact.compact_messages

    async def _compact(messages, spec, *, extra=0, **kwargs):
        extras.append(extra)
        return await original(messages, spec, extra=extra, **kwargs)

    monkeypatch.setattr(agent.compact, "compact_messages", _compact)
    stream, _seen = _script_stream(
        [
            _assembled("", [_call("capture_page", '{"file_id":"f_1","page":1}', "k1")]),
            _assembled(_answer(("Seen.", []))),
        ]
    )

    async def _run(name, args, ctx):
        ctx.captures.append(
            {
                "callId": args["_tool_call_id"],
                "page": 1,
                "bbox": [0, 0, 1000, 1000],
                "bytes": 1,
                "estimatedImageTokens": 2240,
            }
        )
        return ToolResult(text_parts=["Captured page 1."])

    monkeypatch.setattr(agent.models, "stream_agent_response", stream)
    monkeypatch.setattr(agent.tools, "run", _run)

    await _collect("q", ToolContext(workspace_id="ws_1"))
    assert extras == [0, 2240]


async def test_quoted_passage_numbers_stream_like_integers(monkeypatch):
    raw = '{"answer":[{"text":"Carbon is fixed.","passages":["2"]}]}'
    events, seen = await _two_passage_turn(monkeypatch, [raw[:20], raw[20:]], raw)
    assert len(seen) == 2
    assert events[-1]["answer"] == "Carbon is fixed. [1]"
    final = [e for e in events if e["type"] == "citations"][-1]
    assert [c["chunkId"] for c in final["citations"]] == ["c2"]
