"""The Workspace only switch, search_web, web citations, the Q221 send-back
and GLM's AskUser slips (decisions 2026-10-24)."""

from __future__ import annotations

import asyncio
import json

import pytest
import requests

from pipeline.prompts import chat as chat_prompts
from pipeline.registry import ModelConfig
from pipeline.retrieval import (
    accounting,
    agent,
    contract,
    evidence,
    openui,
    pending,
    tools,
    websearch,
)
from pipeline.retrieval.response_guard import (
    contains_arg_markup,
    contains_tool_protocol,
)
from pipeline.retrieval.search import Passage
from pipeline.retrieval.stream import AssembledResponse, StreamEvent, ToolCall
from pipeline.retrieval.tools import ToolContext

CATALOG = [{"id": "history", "label": "History", "aliases": [], "excerpts": 3}]


@pytest.fixture(autouse=True)
def quiet_stores(monkeypatch):
    async def load(*_args, **_kwargs):
        return pending.PendingSources()

    async def chapters(*_args, **_kwargs):
        return [], None

    async def titles(*_args, **_kwargs):
        return {}

    monkeypatch.setattr(pending, "load", load)
    monkeypatch.setattr(agent.store, "workspace_chapters", chapters)
    monkeypatch.setattr(agent.store, "resource_titles", titles)


def _model(provider: str = "deepseek") -> ModelConfig:
    glm = provider == "zai"
    return ModelConfig(
        version=1,
        provider_name=provider,
        model_name="m",
        provider_slug=provider,
        model_slug="glm-5.3-flash" if glm else "deepseek-v4-flash",
        thinking_levels=("low", "high", "max") if glm else ("low", "mid", "high"),
        default_thinking="high",
        context_window_tokens=100_000,
        slots=("chat",),
    )


def _ctx(**kwargs) -> ToolContext:
    return ToolContext(
        workspace_id="ws_1",
        user_id="u1",
        operations=frozenset(contract.OPERATIONS),
        assistant_message_id="m_1",
        **kwargs,
    )


def _writer(monkeypatch, **kwargs) -> ToolContext:
    """A learner who can write: the send-back keeps the note offer."""
    monkeypatch.setattr(tools, "_gateway_ready", lambda: True)
    return _ctx(**kwargs)


def _script(responses: list[AssembledResponse]):
    seen: list[dict] = []

    async def _stream(messages, *, model, tools=None, on_event=None, **_kwargs):
        del model
        seen.append({"messages": list(messages), "tools": tools})
        assembled = responses.pop(0)
        if on_event is not None and assembled.text:
            middle = len(assembled.text) // 2
            for part in (assembled.text[:middle], assembled.text[middle:]):
                on_event(StreamEvent(kind="text", text=part))
        return assembled

    return _stream, seen


async def _collect(query: str, ctx: ToolContext, model: ModelConfig, **kwargs):
    return [
        event
        async for event in agent.run_agent(
            query=query,
            ctx=ctx,
            history=kwargs.pop("history", None),
            model=model,
            **kwargs,
        )
    ]


def _program(*parts: str) -> str:
    names = [f"p{i}" for i in range(len(parts))]
    lines = [f"{n} = {part}" for n, part in zip(names, parts, strict=True)]
    return f"root = Answer([{', '.join(names)}])\n" + "\n".join(lines) + "\n"


OFFER = 'AskUser("Shall I make a note of this?", ["Make a note", "No thanks"])'


# ------------------------------------------------------------- the switch


def test_the_mode_note_comes_where_the_switch_is_first_known_or_changes():
    on = chat_prompts.chat_messages(
        locale="en", checkpoint=None, history=[], query="q", workspace_only=True
    )
    off = chat_prompts.chat_messages(
        locale="en", checkpoint=None, history=[], query="q", workspace_only=False
    )
    assert on[-1]["content"] == chat_prompts.MODE_LINES[True] + "\n\nq"
    assert off[-1]["content"] == chat_prompts.MODE_LINES[False] + "\n\nq"
    # The cache rule: only the message differs.
    assert on[:-1] == off[:-1]

    # Epo 2026-10-25: a note only at the first known switch and at each change.
    history = [
        {"id": "u0", "role": "user", "content": "saved before the switch"},
        {"id": "a0", "role": "assistant", "content": "answer"},
        {"id": "u1", "role": "user", "content": "first", "workspaceOnly": True},
        {"id": "a1", "role": "assistant", "content": "answer"},
        {"id": "u2", "role": "user", "content": "same mode", "workspaceOnly": True},
        {"id": "a2", "role": "assistant", "content": "answer"},
        {"id": "u3", "role": "user", "content": "flipped", "workspaceOnly": False},
        {"id": "a3", "role": "assistant", "content": "answer"},
    ]
    replayed = asyncio.run(
        evidence.history_turns(history, ToolContext(workspace_id="ws"))
    )
    users = [m["content"] for m in replayed if m["role"] == "user"]
    assert users == [
        "saved before the switch",
        chat_prompts.with_mode_line("first", True),
        "same mode",
        chat_prompts.with_mode_line("flipped", False),
    ]
    shown = evidence.mode_shown(history)
    assert shown is False
    same = chat_prompts.chat_messages(
        locale="en",
        checkpoint=None,
        history=replayed,
        query="q",
        workspace_only=False,
        mode_shown=shown,
    )
    assert same[-1]["content"] == "q"
    changed = chat_prompts.chat_messages(
        locale="en",
        checkpoint=None,
        history=replayed,
        query="q",
        workspace_only=True,
        mode_shown=shown,
    )
    assert changed[-1]["content"] == chat_prompts.with_mode_line("q", True)
    # Compaction that folds the noted history puts the note on the query once.
    noted = chat_prompts.with_mode_note(same[-1])
    assert noted["content"] == chat_prompts.with_mode_line("q", False)
    assert chat_prompts.with_mode_note(noted) == noted


def test_the_tool_list_is_the_same_in_both_modes(monkeypatch):
    monkeypatch.setattr(tools, "_gateway_ready", lambda: True)
    monkeypatch.setattr(tools.library, "enabled", lambda: True)
    off = tools.schemas_for(_ctx(library_catalog=CATALOG))
    on = tools.schemas_for(_ctx(library_catalog=CATALOG, workspace_only=True))
    assert on == off
    names = {s["function"]["name"] for s in on}
    assert {"search_web", "search_knowledge", "read_knowledge"} <= names


async def test_workspace_only_answers_the_outside_tools_as_not_available(monkeypatch):
    monkeypatch.setattr(tools.library, "enabled", lambda: True)

    async def _never(*_args, **_kwargs):
        raise AssertionError("an outside tool ran with Workspace only on")

    monkeypatch.setattr(websearch, "search", _never)
    monkeypatch.setattr(tools.library, "search", _never)
    ctx = _ctx(library_catalog=CATALOG, workspace_only=True)
    for name, args in (
        ("search_web", {"query": "berlin airlift"}),
        ("search_knowledge", {"query": "berlin airlift"}),
    ):
        result = await tools.run(name, args, ctx)
        assert result.refused
        assert result.text() == tools.NOT_AVAILABLE.format(tool=name)


def _excerpts_offered(ctx: ToolContext) -> bool:
    schema = next(
        s for s in tools.schemas_for(ctx) if s["function"]["name"] == "create_material"
    )
    return "excerpt_ids" in schema["function"]["parameters"]["properties"]


def test_write_tools_name_excerpts_only_with_the_library(monkeypatch):
    monkeypatch.setattr(tools, "_gateway_ready", lambda: True)
    monkeypatch.setattr(tools.library, "enabled", lambda: True)
    assert _excerpts_offered(_ctx(library_catalog=CATALOG))
    # The switch leaves the list alone (cache rule); a library that is not
    # ready drops the parameter with its tools.
    assert _excerpts_offered(_ctx(library_catalog=CATALOG, workspace_only=True))
    assert not _excerpts_offered(_ctx(library_catalog=[]))
    monkeypatch.setattr(tools.library, "enabled", lambda: False)
    assert not _excerpts_offered(_ctx(library_catalog=CATALOG))


# ------------------------------------------------------------- search_web


def _web(url: str = "https://example.org/a") -> websearch.WebResult:
    return websearch.WebResult(
        title="The airlift",
        url=url,
        snippet="Short.",
        summary="A longer summary for the model.",
        site="example.org",
        date="2025-05-12",
    )


def _searches(monkeypatch, outcomes: list):
    """search_web answers from outcomes: a list of results, or an exception."""
    settled: list[int] = []
    abandoned: list[str] = []

    async def search(_query):
        outcome = outcomes.pop(0)
        if isinstance(outcome, Exception):
            raise outcome
        return outcome

    async def settle(_call_id, *, results):
        settled.append(results)

    async def abandon(call_id, _exc=None):
        abandoned.append(call_id)

    monkeypatch.setattr(websearch, "search", search)
    monkeypatch.setattr(accounting, "settle_web_search", settle)
    monkeypatch.setattr(accounting, "abandon_call", abandon)
    return settled, abandoned


async def test_a_message_gets_three_searches_and_an_empty_one_counts(monkeypatch):
    settled, _ = _searches(monkeypatch, [[_web()], [], [_web("https://b.org")]])
    ctx = _ctx()
    first = await tools.run("search_web", {"query": "a"}, ctx)
    assert [p.kind for p in first.passages] == ["web"]
    assert first.text().endswith("Searches left for this message: 2.")
    empty = await tools.run("search_web", {"query": "b"}, ctx)
    assert (
        empty.text()
        == "No web results for this query. Searches left for this message: 1."
    )
    await tools.run("search_web", {"query": "c"}, ctx)
    capped = await tools.run("search_web", {"query": "d"}, ctx)
    assert capped.refused and "limit reached" in capped.text()
    # Only a search with results is charged; the empty one settles at zero.
    assert settled == [1, 0, 1]


async def test_two_failures_are_free_and_a_message_runs_at_most_five(monkeypatch):
    failed = websearch.SearchFailed("HTTP 500")
    settled, abandoned = _searches(
        monkeypatch, [failed, failed, failed, [_web()], [_web("https://b.org")]]
    )
    ctx = _ctx()
    outcomes = [await tools.run("search_web", {"query": str(n)}, ctx) for n in range(6)]
    assert [r.failed for r in outcomes[:3]] == [True, True, True]
    assert outcomes[0].text() == (
        "search_web failed: the search service did not answer. Answer from what "
        "you have, and say the web could not be searched."
    )
    assert not outcomes[3].failed and not outcomes[4].failed
    assert outcomes[5].refused, "the third failure counted toward the 3"
    assert len(abandoned) == 3 and settled == [1, 1]


async def test_the_same_query_again_reuses_its_results_uncounted(monkeypatch):
    settled, _ = _searches(monkeypatch, [[_web()], [], []])
    ctx = _ctx()
    first = await tools.run("search_web", {"query": "Berlin airlift"}, ctx)
    again = await tools.run("search_web", {"query": " berlin  AIRLIFT "}, ctx)
    assert again.passages == first.passages
    assert again.text() == first.text()
    assert settled == [1] and ctx.web_searches == 1
    # An empty answer is reused too; neither repeat took a place.
    await tools.run("search_web", {"query": "nothing"}, ctx)
    await tools.run("search_web", {"query": "nothing"}, ctx)
    assert settled == [1, 0] and ctx.web_searches == 2


async def test_an_unsettled_search_keeps_its_results_uncounted(monkeypatch):
    _searches(monkeypatch, [[_web()]])

    async def settle(_call_id, *, results):
        del results
        raise accounting.SettlementError("gateway refused")

    monkeypatch.setattr(accounting, "settle_web_search", settle)
    ctx = _ctx()
    result = await tools.run("search_web", {"query": "a"}, ctx)
    assert not result.failed and [p.kind for p in result.passages] == ["web"]
    assert "gateway refused" not in result.text()
    assert ctx.web_searches == 0


async def test_searches_running_together_hold_their_places(monkeypatch):
    release = asyncio.Event()

    async def slow(_query):
        await release.wait()
        return [_web()]

    async def settle(_call_id, *, results):
        del results

    monkeypatch.setattr(websearch, "search", slow)
    monkeypatch.setattr(accounting, "settle_web_search", settle)
    ctx = _ctx()
    running = [
        asyncio.create_task(tools.run("search_web", {"query": str(n)}, ctx))
        for n in range(4)
    ]
    await asyncio.sleep(0)
    release.set()
    results = await asyncio.gather(*running)
    assert sum(r.refused for r in results) == 1


async def test_a_web_search_settles_one_unit_only_with_results(monkeypatch):
    posted: list[dict] = []

    async def post(payload, *, deadline=None):
        del deadline
        posted.append(payload)
        return {"creditsExhausted": False, "terminalCallAllowed": False}

    monkeypatch.setattr(accounting, "_post_settlement", post)
    token = accounting._accounting.set(accounting.RequestAccounting(session_id="s_1"))
    try:
        await accounting.settle_web_search("pc_1", results=5)
        await accounting.settle_web_search("pc_2", results=0)
    finally:
        accounting.reset(token)
    assert [(p["kind"], p["units"]) for p in posted] == [
        ("web_search", 1),
        ("web_search", 0),
    ]
    assert all(p["inputTokens"] == 0 and p["thinking"] == "" for p in posted)


def test_search_keeps_only_http_results_and_sends_the_query_alone(monkeypatch):
    sent: list[dict] = []

    class Response:
        status_code = 200

        @staticmethod
        def json():
            return {
                "results": [
                    {
                        "title": "T",
                        "url": "https://ok.org/p",
                        "summary": "S",
                        "date": "2025-05-12T10:00",
                    },
                    {
                        "title": "U",
                        "url": "https://ok.org/q",
                        "summary": "S",
                        "date": "May 12, 2025",
                    },
                    {"title": "Bad", "url": "javascript:alert(1)", "summary": "S"},
                    {"title": "", "url": "https://no-title.org", "summary": "S"},
                ]
            }

    def post(url, *, headers, json, timeout):
        del headers, timeout
        sent.append({"url": url, **json})
        return Response()

    monkeypatch.setattr(websearch, "platform_api_key", lambda _slug: "sk-test")
    monkeypatch.setattr(requests, "post", post)
    results = asyncio.run(websearch.search("q" * 200))
    assert [r.url for r in results] == ["https://ok.org/p", "https://ok.org/q"]
    assert results[0].site == "ok.org" and results[0].date == "2025-05-12"
    assert results[1].date == ""
    assert sent == [{"url": websearch.SEARCH_URL, "query": "q" * 128, "count": 5}]

    Response.status_code = 500
    with pytest.raises(websearch.SearchFailed):
        asyncio.run(websearch.search("q"))


def test_a_date_is_parsed_or_left_out():
    assert websearch._date("2025-05-12T23:30:00+02:00") == "2025-05-12"
    assert websearch._date("2025-05-12T10:00:00Z") == "2025-05-12"
    assert websearch._date("2025-05-12") == "2025-05-12"
    for unreadable in ("May 12, 2025", "2025-13-40", "", None, 20250512):
        assert websearch._date(unreadable) == ""


def _web_passage() -> Passage:
    return Passage(
        chunk_id="web:https://example.org/a",
        file_id="https://example.org/a",
        file_name="The airlift",
        chunk_idx=0,
        section_path="example.org",
        text="A longer summary for the model.",
        hit_text="Short.",
        published="2025-05-12",
        kind="web",
    )


def test_a_web_result_reads_as_source_data_and_cites_its_link():
    passage = _web_passage()
    assert passage.as_context(3).count("https://example.org/a") == 1
    assert "[3] Web: The airlift (example.org, 2025-05-12)" in passage.as_context(3)
    assert passage.as_citation() == {
        "kind": "web",
        "fileId": "",
        "chunkId": "web:https://example.org/a",
        "fileName": "The airlift",
        "url": "https://example.org/a",
        "siteName": "example.org",
        "published": "2025-05-12",
        "snippet": "Short.",
    }
    shown = tools.render_result(tools._result("x", passages=[passage]), [(1, passage)])
    assert "Locations for read_document" not in shown


async def test_a_cited_web_result_stays_for_the_next_message():
    ctx = ToolContext(workspace_id="ws")
    passage = _web_passage()
    ctx.citations.append(passage)
    ctx.evidence_passage_ids.add(passage.chunk_id)
    packed = evidence.pack(ctx, [1])
    assert packed["passages"][0]["kind"] == "web"

    later = ToolContext(workspace_id="ws")
    history = [
        {"id": "u1", "role": "user", "content": "q"},
        {"id": "a1", "role": "assistant", "content": "a", "toolEvidence": packed},
    ]
    replayed = await evidence.history_turns(history, later)
    assert any("https://example.org/a" in m["content"] for m in replayed)
    assert later.citations[0].as_citation()["url"] == "https://example.org/a"


# ------------------------------------------------------------- Q221


async def test_an_offer_only_first_reply_goes_back_once_unshown(monkeypatch):
    stream, seen = _script(
        [
            AssembledResponse(text=_program(OFFER)),
            AssembledResponse(text=_program('Md("The answer.")', OFFER)),
        ]
    )
    monkeypatch.setattr(agent.models, "stream_agent_response", stream)
    events = await _collect("Explain the airlift", _writer(monkeypatch), _model())

    assert len(seen) == 2
    assert seen[1]["messages"][-2]["content"] == chat_prompts.SEND_BACK
    deltas = "".join(e["text"] for e in events if e["type"] == "block_delta")
    assert "The answer." in deltas and deltas.count("Shall I make a note") == 1
    assert "The answer." in events[-1]["answer"]


async def test_the_send_back_runs_once_and_past_the_planning_cap(monkeypatch):
    monkeypatch.setattr(agent, "PLANNING_RESPONSES", 1)
    stream, seen = _script(
        [
            AssembledResponse(text=_program(OFFER)),
            AssembledResponse(text=_program(OFFER)),
        ]
    )
    monkeypatch.setattr(agent.models, "stream_agent_response", stream)
    events = await _collect("Explain the airlift", _writer(monkeypatch), _model())
    # One response was the cap; the send-back took one more, then the turn
    # ended on the second offer.
    assert len(seen) == 2
    assert (
        events[-1]["type"] == "done" and "Shall I make a note" in events[-1]["answer"]
    )


async def test_a_later_turn_is_not_sent_back(monkeypatch):
    stream, seen = _script([AssembledResponse(text=_program(OFFER))])
    monkeypatch.setattr(agent.models, "stream_agent_response", stream)
    history = [
        {"id": "u1", "role": "user", "content": "earlier"},
        {"id": "a1", "role": "assistant", "content": "earlier answer"},
    ]
    await _collect("Explain", _writer(monkeypatch), _model(), history=history)
    assert len(seen) == 1


async def test_a_read_only_first_reply_goes_back_for_the_answer_alone(monkeypatch):
    clarify = 'AskUser("Which chapter do you mean?", ["Chapter 1", "Chapter 2"])'
    stream, seen = _script(
        [
            AssembledResponse(text=_program(clarify)),
            AssembledResponse(text=_program('Md("The answer.")')),
        ]
    )
    monkeypatch.setattr(agent.models, "stream_agent_response", stream)
    viewer = _ctx()
    assert not any(
        s["function"]["name"] in agent.WRITE_TOOLS for s in tools.schemas_for(viewer)
    )
    events = await _collect("Explain the airlift", viewer, _model())
    assert len(seen) == 2
    assert seen[1]["messages"][-2]["content"] == chat_prompts.SEND_BACK_READ_ONLY
    assert "The answer." in events[-1]["answer"]

    ask = ToolCall(
        id="ask_1",
        name="AskUser",
        arguments=json.dumps({"question": "Which chapter?", "choices": ["1"]}),
    )
    stream, seen = _script(
        [AssembledResponse(tool_calls=[ask]), AssembledResponse(text="The answer.")]
    )
    monkeypatch.setattr(agent.models, "stream_agent_response", stream)
    await _collect("Explain the airlift", _ctx(), _model("zai"))
    tool_result = next(m for m in seen[1]["messages"] if m.get("role") == "tool")
    assert tool_result["content"] == chat_prompts.SEND_BACK_TOOL_READ_ONLY


async def test_glm_gets_the_tool_form_send_back(monkeypatch):
    ask = ToolCall(
        id="ask_1",
        name="AskUser",
        arguments=json.dumps({"question": "Shall I make a note?", "choices": ["Yes"]}),
    )
    stream, seen = _script(
        [
            AssembledResponse(tool_calls=[ask]),
            AssembledResponse(text="The answer [1].", tool_calls=[ask]),
        ]
    )
    monkeypatch.setattr(agent.models, "stream_agent_response", stream)
    events = await _collect("Explain the airlift", _writer(monkeypatch), _model("zai"))
    sent = seen[1]["messages"]
    tool_result = next(m for m in sent if m.get("role") == "tool")
    # Measuring keeps each message's estimate on it under "_tokens".
    assert {k: v for k, v in tool_result.items() if k != "_tokens"} == {
        "role": "tool",
        "tool_call_id": "ask_1",
        "content": chat_prompts.SEND_BACK_TOOL,
    }
    assert "The answer" in events[-1]["answer"]


# ------------------------------------------------------------- GLM slips


def test_glm_argument_markup_is_recognized():
    # Checked on a prose answer once it ends (the next two tests show both
    # outcomes); an answer program streams, so the streaming guard passes it.
    assert contains_arg_markup("Done.AskUser<arg_key>question</arg_key>")
    assert contains_arg_markup("x</arg_value><arg_key>plain")
    assert not contains_tool_protocol("Done.AskUser<arg_key>question</arg_key>")


async def test_glm_text_askuser_is_read_back_as_the_call_it_meant(monkeypatch):
    text = (
        "The blockade began in June 1948 [1]."
        'AskUser<arg_key>choices</arg_key><arg_value>["Make a note", "No thanks"]'
        "</arg_value><arg_key>question</arg_key><arg_value>Shall I make a note?"
    )
    for provider, recovered in (("zai", True), ("deepseek", False)):
        stream, _ = _script([AssembledResponse(text=text)])
        monkeypatch.setattr(agent.models, "stream_agent_response", stream)
        events = await _collect("When did it begin?", _ctx(), _model(provider))
        if not recovered:
            assert events[-1]["type"] == "error"
            continue
        program = openui.parse(events[-1]["answer"], strict=True)
        asks = [c for c in openui.walk(program) if c.name == "AskUser"]
        assert [(c.prop("question"), c.prop("choices")) for c in asks] == [
            ("Shall I make a note?", ["Make a note", "No thanks"])
        ]
        assert "arg_key" not in events[-1]["answer"]


async def test_glm_markup_inside_an_answer_program_is_no_turn_error(monkeypatch):
    text = (
        _program('Md("The blockade began in June 1948.")')
        + "AskUser<arg_key>question</arg_key><arg_value>Shall I make a note?"
        "</arg_value>\n"
    )
    stream, _ = _script([AssembledResponse(text=text)])
    monkeypatch.setattr(agent.models, "stream_agent_response", stream)
    events = await _collect("When did it begin?", _ctx(), _model("zai"))
    assert not any(e["type"] == "error" for e in events)
    assert events[-1]["type"] == "done"
    assert "The blockade began in June 1948." in events[-1]["answer"]


def test_a_tool_called_askuser_keeps_its_prose_citations():
    ask = ToolCall(
        id="a", name="AskUser", arguments='{"question": "More?", "choices": []}'
    )
    program = openui.parse(
        agent.ask_user_answer(
            [ask], "It began in 1948 [1] and ended [2, 3]. See [9].", 3
        ),
        strict=True,
    )
    intro = next(c for c in openui.walk(program) if c.name == "Md")
    assert intro.prop("text") == "It began in 1948 and ended. See [9]."
    assert intro.prop("passages") == [1, 2, 3]


# ------------------------------------------------------------- the note pick


async def test_the_note_pick_builds_the_note(monkeypatch):
    """Phase 2: an explanation gets an answer, not materials; the learner's pick
    of its note offer is a new request that builds the note."""
    question = "Explain how the Truman Doctrine and the Marshall Plan worked together."
    answer = _program('Md("Containment, then recovery.")', OFFER)
    stream, seen = _script([AssembledResponse(text=answer)])
    monkeypatch.setattr(agent.models, "stream_agent_response", stream)
    first = await _collect(question, _writer(monkeypatch), _model())
    assert len(seen) == 1, "an answer with its offer is not sent back"
    system = seen[0]["messages"][0]["content"]
    assert (
        "A question, or a request to explain or summarise, gets an answer with "
        "citations, not materials." in system
    )
    assert "Shall I make a note" in first[-1]["answer"]

    ran: list[str] = []

    async def _run(name, args, ctx):
        del args, ctx
        ran.append(name)
        return tools.ToolResult(text_parts=["Created the note m_1."])

    build = ToolCall(
        id="c1",
        name="create_material",
        arguments=json.dumps({"kind": "note", "title": "Containment"}),
    )
    stream, seen = _script(
        [
            AssembledResponse(tool_calls=[build]),
            AssembledResponse(text=_program('Md("I made the note.")')),
        ]
    )
    monkeypatch.setattr(agent.models, "stream_agent_response", stream)
    monkeypatch.setattr(agent.tools, "run", _run)
    history = [
        {"id": "u1", "role": "user", "content": question, "workspaceOnly": False},
        {"id": "a1", "role": "assistant", "content": answer},
    ]
    # The question panel sends the offer and the pick (chat/questions.ts).
    pick = "Shall I make a note of this?\nMake a note"
    events = await _collect(pick, _writer(monkeypatch), _model(), history=history)
    offered = {t["function"]["name"] for t in seen[0]["tools"]}
    assert "create_material" in offered
    assert seen[0]["messages"][-2]["content"].endswith(pick)
    assert ran == ["create_material"]
    assert events[-1]["type"] == "done" and "I made the note." in events[-1]["answer"]
