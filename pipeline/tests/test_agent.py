"""Offline tests for the chat agent loop.

The loop is mocked: a cassette of ``run_agent`` would bind replay to whatever
tool-call JSON the model emitted that day. What we need locked is the sequence
the SSE relay depends on — prime, tool rounds, citations before tokens, done.
"""

from __future__ import annotations

from types import SimpleNamespace

from pipeline import obs
from pipeline.retrieval import agent
from pipeline.retrieval.search import Passage
from pipeline.retrieval.tools import ToolContext


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


def _tool_call(name: str, arguments: str = "{}", call_id: str = "call_1"):
    return SimpleNamespace(
        id=call_id,
        function=SimpleNamespace(name=name, arguments=arguments),
    )


async def _collect(query: str, ctx: ToolContext, **kwargs) -> list[dict]:
    events = []
    async for event in agent.run_agent(
        query=query, ctx=ctx, history=None, model="deepseek-v4-flash", **kwargs
    ):
        events.append(event)
    return events


def test_priming_message_with_no_hits_points_at_list_sources():
    assert "list_sources" in agent._priming_message([])


def test_priming_message_numbers_passages():
    message = agent._priming_message([(1, _passage())])

    assert message.startswith("Passages retrieved for this question:")
    assert "[1]" in message
    assert "Chlorophyll absorbs" in message


async def test_run_agent_primes_then_emits_citations_before_tokens(monkeypatch):
    complete_tools: list = []

    async def _search(**_k):
        return [_passage()]

    async def _complete(messages, *, model, tools=None, **_k):
        del messages, model
        complete_tools.append(tools)
        return SimpleNamespace(content="Chlorophyll absorbs red [1].", tool_calls=None)

    async def _stream(messages, *, model, temperature=None, **_k):
        del messages, model, temperature
        yield "Chlorophyll "
        yield "absorbs red [1]."

    monkeypatch.setattr(agent, "search", _search)
    monkeypatch.setattr(agent.models, "complete", _complete)
    monkeypatch.setattr(agent.models, "stream_text", _stream)
    monkeypatch.setattr(agent.tools.cfg, "gateway_url", "")

    ctx = ToolContext(workspace_id="ws_1")
    events = await _collect("What does chlorophyll absorb?", ctx)

    kinds = [e["type"] for e in events]
    assert kinds == ["tool", "citations", "token", "token", "done"]
    assert events[0]["tool"] == "search_workspace"
    assert complete_tools[0] is not None
    assert "generate_material" not in [s["function"]["name"] for s in complete_tools[0]]


async def test_the_last_tool_round_drops_tools(monkeypatch):
    seen: list = []

    async def _search(**_k):
        return [_passage()]

    async def _complete(messages, *, model, tools=None, **_k):
        del messages, model
        seen.append(tools)
        return SimpleNamespace(content="ok", tool_calls=None)

    async def _stream(messages, *, model, temperature=None, **_k):
        del messages, model, temperature
        yield "ok"

    monkeypatch.setattr(agent, "search", _search)
    monkeypatch.setattr(agent.models, "complete", _complete)
    monkeypatch.setattr(agent.models, "stream_text", _stream)
    monkeypatch.setattr(agent.cfg, "agent_max_steps", 1)

    await _collect("What does chlorophyll absorb?", ToolContext(workspace_id="ws_1"))

    assert seen == [None]


async def test_a_tool_call_runs_before_the_streamed_answer(monkeypatch):
    rounds = 0

    async def _search(**_k):
        return [_passage()]

    async def _complete(messages, *, model, tools=None, **_k):
        del messages, model, tools
        nonlocal rounds
        rounds += 1
        if rounds == 1:
            return SimpleNamespace(
                content="",
                tool_calls=[_tool_call("list_sources")],
            )
        return SimpleNamespace(content="ok", tool_calls=None)

    async def _stream(messages, *, model, temperature=None, **_k):
        del messages, model, temperature
        yield "Chlorophyll absorbs red [1]."

    async def _run(name, args, ctx):
        del args, ctx
        return f"ran {name}"

    monkeypatch.setattr(agent, "search", _search)
    monkeypatch.setattr(agent.models, "complete", _complete)
    monkeypatch.setattr(agent.models, "stream_text", _stream)
    monkeypatch.setattr(agent.tools, "run", _run)

    events = await _collect(
        "What does chlorophyll absorb?", ToolContext(workspace_id="ws_1")
    )
    tools_used = [e["tool"] for e in events if e["type"] == "tool"]

    assert tools_used == ["search_workspace", "list_sources"]
    assert [e["type"] for e in events].count("token") == 1
    assert events[-1]["type"] == "done"


async def test_done_carries_usage_when_the_meter_is_set(monkeypatch):
    async def _search(**_k):
        return [_passage()]

    async def _complete(messages, *, model, tools=None, **_k):
        del messages, model, tools
        return SimpleNamespace(content="ok", tool_calls=None)

    async def _stream(messages, *, model, temperature=None, **_k):
        del messages, model, temperature
        yield "ok"

    monkeypatch.setattr(agent, "search", _search)
    monkeypatch.setattr(agent.models, "complete", _complete)
    monkeypatch.setattr(agent.models, "stream_text", _stream)

    usage = obs.start_usage()
    usage.add_completion("deepseek", "deepseek-v4-flash", 10, 4)
    events = await _collect(
        "What does chlorophyll absorb?", ToolContext(workspace_id="ws_1")
    )

    done = events[-1]
    assert done["type"] == "done"
    assert done["usage"]["inputTokens"] == 10
    assert done["tokenCount"] == 14
