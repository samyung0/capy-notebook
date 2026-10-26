"""Offline tests for the chat agent loop."""

from __future__ import annotations

import asyncio
import base64
import io
import itertools
import json
import re
from dataclasses import asdict, replace
from datetime import datetime

import pytest
from PIL import Image

from pipeline import config, obs
from pipeline.prompts.sources import source_block
from pipeline.registry import ModelConfig
from pipeline.retrieval import (
    accounting,
    agent,
    contract,
    deck,
    pending,
    scripted,
    search,
    skills,
    tools,
)
from pipeline.retrieval.chunking import estimate_tokens
from pipeline.retrieval.limits import TOOLS_PER_RESPONSE
from pipeline.retrieval.search import Passage
from pipeline.retrieval.stream import AssembledResponse, StreamEvent, ToolCall
from pipeline.retrieval.tools import ToolContext, ToolResult, TurnFailed
from pipeline.retrieval.usage_extract import NormalizedUsage


@pytest.fixture(autouse=True)
def no_pending_sources(monkeypatch):
    async def load(*_args, **_kwargs):
        return pending.PendingSources()

    async def chapters(*_args, **_kwargs):
        return [], None

    async def titles(*_args, **_kwargs):
        return {}

    monkeypatch.setattr(pending, "load", load)
    monkeypatch.setattr(agent.store, "workspace_chapters", chapters)
    monkeypatch.setattr(agent.store, "resource_titles", titles)


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


async def _collect(
    query: str, ctx: ToolContext, *, model: ModelConfig | None = None, **kwargs
) -> list[dict]:
    events = []
    async for event in agent.run_agent(
        query=query, ctx=ctx, history=None, model=model or _model(), **kwargs
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
    """The final answer the prompt asks for: a program, one Md per claim."""
    names = [f"c{i}" for i in range(len(claims))]
    lines = ["root = Answer([" + ", ".join(names) + "])"]
    for name, (text, passages) in zip(names, claims, strict=True):
        marks = f", {json.dumps(passages)}" if passages else ""
        lines.append(f"{name} = Md({json.dumps(text)}{marks})")
    return "\n".join(lines) + "\n"


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
        stopped=None,
    ):
        del model, call_purpose
        seen.append(
            {
                "tools": tools,
                # Tools off: the turn context says so, or no tools to send.
                "tools_off": agent.turn_context.tools_off(messages) or not tools,
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
    passage = _passage()
    stream, seen = _script_stream(
        [
            _assembled(
                "",
                [
                    _call("read_document", '{"file_id":"f_1"}'),
                    _call("list_sources", "{}", "listing"),
                ],
            ),
            _assembled(_answer(("First answer.", [1]))),
            _assembled(_answer(("Follow-up from the same passage.", [1]))),
        ]
    )

    async def run(name, *_):
        if name == "list_sources":
            return ToolResult(text_parts=["Full source listing"])
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
    assert passage.text in replay and "Full source listing" in replay
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
    assert 'No workspace item has the id "f_missing"' in result.text()


async def test_read_rejects_a_file_outside_the_scope(monkeypatch):
    ctx = ToolContext(workspace_id="ws_1", file_ids=["f_1"])
    ctx._scope_outline = {
        "chapters": [],
        "files": [
            {"id": "f_1", "name": "one.pdf", "chapter_id": None, "chunks": 1},
            {"id": "f_2", "name": "two.pdf", "chapter_id": None, "chunks": 1},
        ],
    }
    read = await tools._read_document({"file_id": "f_2"}, ctx)

    assert read.refused
    assert '"f_2" is outside the sources chosen for this chat' in read.text()


async def test_read_document_refuses_a_quiz_in_words(monkeypatch):
    # A quiz is a scope item (Epo 2026-10-21) but holds no passages.
    async def no_rows(**_kwargs):
        return []

    # Without the guard the read reaches this stub, not a database.
    monkeypatch.setattr(tools.store, "read_file_range", no_rows)
    ctx = ToolContext(workspace_id="ws_1")
    ctx._scope_outline = {
        "chapters": [],
        "files": [
            {
                "id": "mat_quiz",
                "name": "Cells quiz",
                "chapter_id": None,
                "chunks": 0,
                "kind": "material",
                "material_kind": "quiz",
            },
        ],
    }
    read = await tools._read_document({"file_id": "mat_quiz"}, ctx)
    assert read.refused
    assert read.text() == (
        "mat_quiz is a quiz, which has no passages to read; inspect_document reads it."
    )


async def test_create_material_sends_its_sources_as_written(monkeypatch):
    # Sources are a made-from line Go resolves to names (Epo 2026-10-21): sent
    # as written, with nothing indexed in the workspace and no library books.
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
    sources = ["f_1", "Cells quiz", "Lecture 3, 14 Oct"]
    result = await tools._create_material(
        {
            "kind": "note",
            "content": "body",
            "sources": sources,
            "_tool_call_id": "call_1",
        },
        ctx,
    )

    assert not result.refused
    assert seen["sources"] == sources
    assert "fileIds" not in seen and "chapterIds" not in seen
    assert seen["assistantMessageId"] == "m_1"
    assert seen["toolCallId"] == "call_1"


@pytest.mark.parametrize(
    "status, code, told",
    [
        (403, "permission_denied", True),
        (403, "account_suspended", True),
        (404, "", False),
    ],
)
async def test_a_write_refused_for_permission_tells_the_model_to_stop(
    monkeypatch, status, code, told
):
    ctx = ToolContext(
        workspace_id="ws_1",
        user_id="u1",
        operations=frozenset(contract.OPERATIONS),
        assistant_message_id="m_1",
    )
    monkeypatch.setattr(tools.cfg, "gateway_url", "http://gw")
    monkeypatch.setattr(tools.cfg, "pipeline_secret", "s")

    class _Resp:
        status_code = status

        def __init__(self) -> None:
            self.headers: dict[str, str] = {}

        def json(self):
            return (
                {"code": code, "message": "refused"}
                if code
                else {"message": "not found"}
            )

    monkeypatch.setattr(tools.requests, "post", lambda *_a, **_k: _Resp())
    result = await tools._create_material(
        {"kind": "note", "content": "body", "_tool_call_id": "call_1"}, ctx
    )

    assert result.refused
    assert (tools.NO_PERMISSION in agent._result_text(result, [])) is told
    assert tools.NO_PERMISSION not in result.error_payload()["message"]


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


async def test_create_material_refuses_an_unknown_chapter_before_sending(monkeypatch):
    ctx = ToolContext(
        workspace_id="ws_1",
        user_id="u1",
        operations=frozenset(contract.OPERATIONS),
        assistant_message_id="m_1",
    )
    ctx.chapters = [{"id": "ch_1", "name": "Cells"}]
    monkeypatch.setattr(tools.cfg, "gateway_url", "http://gw")
    monkeypatch.setattr(tools.cfg, "pipeline_secret", "s")

    def _post(*_args, **_kwargs):
        raise AssertionError("an unknown chapter reached the gateway")

    monkeypatch.setattr(tools.requests, "post", _post)
    result = await tools._create_material(
        {"kind": "note", "content": "body", "chapter_id": "ch_9", "_tool_call_id": "c"},
        ctx,
    )
    assert result.refused and "not a chapter of this workspace" in result.text()


def _library_ctx(monkeypatch) -> ToolContext:
    """A Library-on context whose gateway is stubbed, with an empty workspace index."""
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
    return ctx


def _book(*excerpt_ids: str) -> dict:
    return {
        "id": "ahss",
        "title": "Advanced High School Statistics",
        "authors": ["Diez"],
        "edition": "4e",
        "license": "CC BY-SA 4.0",
        "licenseUrl": "https://x",
        "sourceUrl": "https://y",
        "version": 2,
        "excerptIds": list(excerpt_ids),
    }


def _gateway_receipt(monkeypatch, effect: dict) -> list[dict]:
    """Record every gateway POST body and answer with one succeeded receipt."""
    sent: list[dict] = []

    class _Resp:
        status_code = 200

        def json(self):
            return {"operationId": "op_x", "outcome": "succeeded", "effect": effect}

    def _post(*_args, **kwargs):
        sent.append(json.loads(kwargs["data"]))
        return _Resp()

    monkeypatch.setattr(tools.requests, "post", _post)
    return sent


def _created(rid: str, title: str, kind: str = "note") -> dict:
    return {
        "operation": "created",
        "operationId": "op_x",
        "resource": {
            "kind": "material",
            "id": rid,
            "title": title,
            "materialKind": kind,
        },
    }


async def test_a_library_material_sends_provenance_and_needs_no_indexed_scope(
    monkeypatch,
):
    """A material written from the library is grounded in the library: the
    workspace may hold nothing indexed, and the excerpt ids become its
    attribution record."""
    ctx = _library_ctx(monkeypatch)
    books = [_book("e_1")]

    async def _provenance(excerpt_ids):
        assert excerpt_ids == ["e_1"]
        return books

    monkeypatch.setattr(tools.library, "provenance", _provenance)
    sent = _gateway_receipt(monkeypatch, _created("mat_abc", "Regression"))
    ctx.library_reads.note("e_1", 0, "8.1")

    result = await tools._create_material(
        {
            "kind": "note",
            "title": "Regression",
            "content": "body",
            "excerpt_ids": ["e_1"],
            "_tool_call_id": "call_1",
        },
        ctx,
    )

    assert not result.refused
    assert sent[0]["provenance"] == {"books": books}
    assert ctx.library_reads.reads[0].credited


async def test_two_materials_may_share_the_same_excerpts(monkeypatch):
    """A note and the quiz drilling it are written from the same reads; the
    second write is neither refused nor stripped of its attribution."""
    ctx = _library_ctx(monkeypatch)
    asked: list[list[str]] = []

    async def _provenance(excerpt_ids):
        asked.append(list(excerpt_ids))
        return [_book(*excerpt_ids)]

    monkeypatch.setattr(tools.library, "provenance", _provenance)
    sent = _gateway_receipt(monkeypatch, _created("mat_note", "Regression"))
    ctx.library_reads.note("e_1", 0, "8.1")
    ctx.library_reads.note("e_2", 0, "8.2")

    note = await tools._create_material(
        {
            "kind": "note",
            "title": "Regression",
            "content": "body",
            "excerpt_ids": ["e_1", "e_2"],
            "_tool_call_id": "call_1",
        },
        ctx,
    )
    _gateway_receipt(monkeypatch, _created("mat_quiz", "Practice", "quiz"))
    quiz = await tools._add_questions(
        {
            "title": "Practice",
            "questions": [{"question": "Slope?", "accepted": ["2"]}],
            "excerpt_ids": ["e_1", "e_2"],
            "_tool_call_id": "call_2",
        },
        ctx,
    )

    assert not note.refused and not quiz.refused
    assert asked == [["e_1", "e_2"], ["e_1", "e_2"]]
    assert sent[0]["provenance"]["books"][0]["excerptIds"] == ["e_1", "e_2"]


async def test_a_library_edit_sends_provenance(monkeypatch):
    """Growing a note section by section: the appended section's excerpts join
    the material's attribution, and Go merges them by book id."""
    ctx = _library_ctx(monkeypatch)

    async def _provenance(excerpt_ids):
        return [_book(*excerpt_ids)]

    monkeypatch.setattr(tools.library, "provenance", _provenance)
    sent = _gateway_receipt(
        monkeypatch,
        {
            "operation": "edited",
            "operationId": "op_x",
            "resource": {"kind": "material", "id": "mat_note", "title": "Regression"},
        },
    )
    ctx.library_reads.note("e_2", 0, "8.2", text="Residuals are observed minus fitted.")

    result = await tools._edit_document(
        {
            "target": {"kind": "material", "id": "mat_note"},
            "commands": [
                {
                    "type": "insert_markdown",
                    "after_block_id": None,
                    "markdown": "Residuals are observed minus fitted values.",
                }
            ],
            "_tool_call_id": "call_9",
        },
        ctx,
    )

    assert not result.refused
    assert sent[0]["provenance"]["books"][0]["excerptIds"] == ["e_2"], (
        "naming none credits the reads since the last write"
    )


async def test_a_write_naming_no_excerpts_credits_the_books_its_text_matches(
    monkeypatch,
):
    """Of the excerpts read since the last write, a book is credited when its
    read text shares with the write a word 4-gram, or a number with a decimal
    point or two digits, that no other read book holds (Epo 2026-10-13); what
    the read tools add (head lines, chunk prefixes, links) and a slide's SVG
    markup do not count, and a write matching no book credits every candidate,
    as before. Named excerpts are credited as before; provenance is read once
    per write."""
    ctx = _library_ctx(monkeypatch)
    book_of = {"e_stats": "ahss", "e_seeds": "botany"}
    asked: list[list[str]] = []

    async def _provenance(excerpt_ids):
        asked.append(list(excerpt_ids))
        books: dict[str, list[str]] = {}
        for excerpt_id in excerpt_ids:
            books.setdefault(book_of[excerpt_id], []).append(excerpt_id)
        return [{"id": book, "excerptIds": ids} for book, ids in books.items()]

    monkeypatch.setattr(tools.library, "provenance", _provenance)
    ctx.library_reads.note(
        "e_stats",
        0,
        "8.1",
        text="[exc_stats] Statistics — 8.1\nchunks 3-4 of this excerpt, from 3\n"
        "(chunk 3) A sample of 40 seeds had a mean mass of 2.45 g, and the line "
        "of best fit passes the means.\nNext in this book: [exc_more] 8.2 "
        "(pages 12, 13)",
    )
    ctx.library_reads.note(
        "e_seeds",
        0,
        "3.2",
        text="[exc_seeds] Botany — 3.2\nscope: germination at 75.5 percent\n"
        "(chunk 7) Seeds need water and warmth; the line of best fit passes "
        "the means. Plant 80 seeds per tray.",
    )

    async def credited(tool: str, args: dict) -> list[str]:
        out = await tools.write_sources(ctx, tool, args)
        assert isinstance(out, tuple)
        assert [e for book in out[0] for e in book["excerptIds"]] == out[1]
        return out[1]

    def note(content: str) -> dict:
        return {"kind": "note", "content": content}

    # 40 and 2.45 are the statistics read's alone; 75.5 is only in the other
    # read's scope line, and the shared 4-grams belong to both.
    assert await credited(
        "create_material",
        note(
            "Of 40 seeds, 75.5 percent germinated; the mean mass was 2.45 g, and "
            "the line of best fit passes the means."
        ),
    ) == ["e_stats"]
    # 12 and 13 are only in the statistics read's link line.
    assert await credited(
        "create_material", note("Seeds need water and warmth, see pages 12 and 13.")
    ) == ["e_seeds"]
    # The slide's 80 is an attribute, not its text.
    slide = '<svg width="1280"><text x="80" y="40">Mean mass 2.45 g</text></svg>'
    assert await credited(
        "write_slide", {"deck_id": "d", "slide": 1, "svg": slide}
    ) == ["e_stats"]
    assert await credited("create_material", note("Photosynthesis needs light.")) == [
        "e_stats",
        "e_seeds",
    ], "no book matches: every candidate, as before"
    assert len(asked) == 4, "one provenance read per write"
    named = await tools.write_sources(
        ctx, "create_material", {"kind": "note", "excerpt_ids": ["e_seeds"]}
    )
    assert isinstance(named, tuple) and named[1] == ["e_seeds"]


async def test_an_edit_of_a_source_file_carries_no_provenance(monkeypatch):
    """The learner's own file is not written from the library: the edit takes
    no excerpt ids, credits no reads, and Go is sent no provenance for it."""
    ctx = _library_ctx(monkeypatch)
    sent = _gateway_receipt(
        monkeypatch,
        {
            "operation": "edited",
            "operationId": "op_x",
            "resource": {"kind": "source_file", "id": "f_1", "title": "one.pdf"},
        },
    )

    async def _load(_workspace_id, _file_ids):
        return tools.pending.PendingSources()

    monkeypatch.setattr(tools.pending, "load", _load)
    ctx.library_reads.note("e_1", 0, "8.1")

    result = await tools._edit_document(
        {
            "target": {"kind": "source_file", "id": "f_1"},
            "commands": [{"type": "replace_text", "expected": "teh", "text": "the"}],
            "_tool_call_id": "call_9",
        },
        ctx,
    )

    assert not result.refused, result.text()
    assert "provenance" not in sent[0]
    assert not ctx.library_reads.reads[0].credited, "a source edit credits no read"


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
        stopped=None,
    ):
        del messages, model, tools, call_purpose
        if on_event is not None:
            program = _answer(("Hello", []))
            cut = program.index("Hel") + 3
            on_event(StreamEvent(kind="text", text=program[:cut]))
            on_event(StreamEvent(kind="text", text=program[cut:]))
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
    deltas = [e["text"] for e in events if e["type"] == "block_delta"]
    # The first delta reached the consumer while the provider stream was open.
    assert len(deltas) >= 2 and "".join(deltas) == _answer(("Hello", []))


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
    assert events[-1]["answer"] == _answer(("Chlorophyll absorbs red.", []))
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


async def test_the_last_planning_round_turns_tools_off(monkeypatch):
    stream, seen = _script_stream([_assembled(_answer(("ok", [])))])
    monkeypatch.setattr(agent.models, "stream_agent_response", stream)
    monkeypatch.setattr(agent.cfg, "agent_max_steps", 1)

    await _collect("What does chlorophyll absorb?", ToolContext(workspace_id="ws_1"))
    assert seen[0]["tools_off"]


async def test_a_turn_before_its_first_write_counts_its_responses_down(monkeypatch):
    stream, seen = _script_stream(
        [
            _assembled("", [_call("list_sources")]),
            _assembled(_answer(("ok", []))),
        ]
    )
    monkeypatch.setattr(agent.models, "stream_agent_response", stream)
    monkeypatch.setattr(agent.cfg, "agent_max_steps", 2)

    async def _run(_name, _args, _ctx):
        return ToolResult(text_parts=["sources"])

    monkeypatch.setattr(agent.tools, "run", _run)
    await _collect("q", ToolContext(workspace_id="ws_1"))
    contexts = [
        [m["content"] for m in call["messages"] if m.get("_kind") == "turn_context"][-1]
        for call in seen
    ]
    assert "Responses remaining this turn, this one included: 2;" in contexts[0]
    assert "Responses remaining" not in contexts[1]
    # A turn without the writing skill is asked for an answer, not a material.
    assert "Write before then" not in contexts[0]
    assert agent.turn_context.FINAL_ANSWER_NOTICE in contexts[1]


async def test_a_tools_off_response_that_calls_tools_is_asked_once_more(monkeypatch):
    """Tools stay in a tools-off request, so the model may still call one. The
    calls do not run; each result says so, and the next response answers."""
    stream, seen = _script_stream(
        [
            _assembled("", [_call("list_sources")]),
            _assembled(_answer(("ok", []))),
        ]
    )
    monkeypatch.setattr(agent.models, "stream_agent_response", stream)
    monkeypatch.setattr(agent.cfg, "agent_max_steps", 1)

    async def _run(_name, _args, _ctx):
        raise AssertionError("a tools-off call ran")

    monkeypatch.setattr(agent.tools, "run", _run)
    events = await _collect("q", ToolContext(workspace_id="ws_1"))

    assert [call["tools_off"] for call in seen] == [True, True]
    assert seen[1]["tools"] == seen[0]["tools"]
    results = [m for m in seen[1]["messages"] if m.get("role") == "tool"]
    assert [m["content"] for m in results] == [agent.TOOLS_OFF_RESULT]
    assert events[-1]["telemetry"]["stopReason"] == "answer"


async def test_a_second_tools_off_response_with_calls_ends_the_turn(monkeypatch):
    calling = _assembled("", [_call("list_sources")])
    stream, seen = _script_stream([calling, calling])
    monkeypatch.setattr(agent.models, "stream_agent_response", stream)
    monkeypatch.setattr(agent.cfg, "agent_max_steps", 1)

    async def _run(_name, _args, _ctx):
        raise AssertionError("a tools-off call ran")

    monkeypatch.setattr(agent.tools, "run", _run)
    events = await _collect("q", ToolContext(workspace_id="ws_1"))

    # The calls are dropped; with no text left the turn ends as any empty one.
    assert len(seen) == 2
    assert events[-1]["code"] == "invalid_answer"


async def test_a_tool_call_written_as_text_with_tools_off_ends_at_the_cap(monkeypatch):
    """GLM writes its own tool-call syntax as text when tools are off. That is
    the cap, not a flagged answer: the turn ends and keeps what it made."""
    leaked = "Here is the note.<tool_call>create_material<arg_key>kind</arg_key>"
    stream, seen = _script_stream([_assembled(leaked)])
    monkeypatch.setattr(agent.models, "stream_agent_response", stream)
    monkeypatch.setattr(agent.cfg, "agent_max_steps", 1)

    events = await _collect("q", ToolContext(workspace_id="ws_1"))
    assert seen[0]["tools_off"]
    assert not any(e["type"] == "error" for e in events)
    assert events[-1]["type"] == "done"
    assert events[-1]["telemetry"]["stopReason"] == "planning_cap"
    assert not events[-1]["answer"]
    assert "tool_call" not in "".join(e.get("text", "") for e in events)


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
    assert events[-1]["answer"] == _answer(("Chlorophyll absorbs red.", []))
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
    assert events[-1]["answer"] == _answer(("See both.", [1, 2]))
    assert [c["n"] for c in cite_events[0]["citations"]] == [1, 2]


async def test_read_batch_runs_concurrently_in_call_order(monkeypatch):
    overlap = {"active": 0, "peak": 0}

    stream, _seen = _script_stream(
        [
            _assembled(
                "",
                [
                    _call("list_sources", "{}", "c1"),
                    _call("read_document", '{"file_id":"f_1"}', "c2"),
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
    assert len(ran) == TOOLS_PER_RESPONSE == 4
    tool_msgs = [m for m in seen[1]["messages"] if m.get("role") == "tool"]
    assert [m["tool_call_id"] for m in tool_msgs] == [f"c{i}" for i in range(5)]
    assert "4 tool-call limit" in tool_msgs[-1]["content"]


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
        stopped=None,
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
    assert formats == [None, None]
    assert events[-1]["answer"] == _answer(("Final from the paid tool result.", []))


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
    assert events[-1]["answer"] == _answer(("final", []))
    assert events[-1]["telemetry"]["completionCalls"] == 21
    assert events[-1]["telemetry"]["compactionCalls"] == 20


async def test_empty_response_does_not_resend(monkeypatch):
    stream, seen = _script_stream([_assembled(""), _assembled("should not run")])
    monkeypatch.setattr(agent.models, "stream_agent_response", stream)

    events = await _collect("q", ToolContext(workspace_id="ws_1"))
    assert len(seen) == 1
    assert events[-1]["type"] == "error"
    assert events[-1]["code"] == "invalid_answer"
    assert not any(e["type"] == "done" for e in events)


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
    asked = agent.chat_prompts.with_mode_line("current question", False)
    assert contents.count(asked) == 1
    assert len(folded["turns"]) == len(history)
    assert folded["current_user_message"] == asked


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
    assert posts["n"] == 3
    assert "on 3 tries; nothing was saved" in result.error
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
        stopped=None,
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
        stopped=None,
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
        stopped=None,
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


async def test_a_go_hang_up_marks_the_client_and_lets_the_running_call_finish():
    from pipeline.retrieve import service as retrieve_service

    released = asyncio.Event()
    finished = {"n": 0}

    async def _agen():
        yield {"type": "phase", "phase": "planning"}
        await released.wait()
        finished["n"] += 1
        yield {"type": "done"}

    client = agent.ClientDrop()
    first = asyncio.Event()

    async def _consume() -> None:
        async for _chunk in retrieve_service._relay_until_disconnect(_agen(), client):
            first.set()

    task = asyncio.create_task(_consume())
    await first.wait()
    task.cancel()  # Starlette cancels the response when Go hangs up
    for _ in range(5):
        await asyncio.sleep(0)
    assert client.dropped and finished["n"] == 0
    released.set()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert finished["n"] == 1


# ------------------------------------- turn saves, however it ends (Epo 2026-10-21)

_LEAKED_TOOL_CALL = (
    _answer(("Safe prefix", []))
    + '<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="create_material">'
)


def _listing_then(monkeypatch, second) -> None:
    """A turn whose first response lists sources (call c1) and whose second is
    ``second``: a response, or an exception the provider call raises."""
    responses = [_assembled("", [_call("list_sources", "{}", "c1")]), second]

    async def _stream(_messages, *, on_event=None, **_kwargs):
        reply = responses.pop(0)
        if isinstance(reply, BaseException):
            raise reply
        if on_event is not None and reply.text:
            on_event(StreamEvent(kind="text", text=reply.text))
        return reply

    async def _run(name, args, ctx):
        del args, ctx
        return ToolResult(text_parts=[f"ran {name}"])

    monkeypatch.setattr(agent.models, "stream_agent_response", _stream)
    monkeypatch.setattr(agent.tools, "run", _run)


def _saved_listing(event: dict) -> None:
    assert [b["callId"] for b in event["activity"] if b["kind"] == "tool"] == ["c1"]
    assert [n["text"] for n in event["toolEvidence"]["tools"]] == ["ran list_sources"]


async def test_a_client_drop_after_a_tool_leaves_a_checkpoint_with_it(monkeypatch):
    client = agent.ClientDrop()
    _listing_then(monkeypatch, _assembled(_answer(("late", []))))
    real = agent.models.stream_agent_response

    async def _stream(*args, **kwargs):
        reply = await real(*args, **kwargs)
        if reply.text:  # the user stops while the second response streams
            client.mark()
        return reply

    monkeypatch.setattr(agent.models, "stream_agent_response", _stream)
    events = await _collect("q", ToolContext(workspace_id="ws_1"), client=client)

    assert not any(e["type"] in ("done", "error") for e in events)
    _saved_listing([e for e in events if e["type"] == "turn_checkpoint"][-1])


@pytest.mark.parametrize(
    "code, second, compaction",
    [
        ("agent_failed", RuntimeError("provider disconnected"), None),
        ("provider_busy", agent.elitellm.ProviderBusy("busy", retry_after=1), None),
        ("invalid_key", agent.models.UserKeyError("invalid_key", "rejected"), None),
        ("source_changed", pending.SourceChanged(), None),
        ("invalid_answer", _assembled(""), None),
        ("response_flagged", _assembled(_LEAKED_TOOL_CALL), None),
        ("context_too_large", None, agent.compact.ContextTooLarge("full")),
        ("compaction_failed", None, agent.compact.InvalidSummary("empty")),
    ],
)
async def test_an_error_after_a_tool_carries_the_turn_so_far(
    monkeypatch, code, second, compaction
):
    _listing_then(monkeypatch, second)
    if compaction is not None:
        real = agent.compact.compact_messages
        steps = itertools.count()

        async def _compact(*args, **kwargs):
            if next(steps):  # the second step's compaction fails
                raise compaction
            return await real(*args, **kwargs)

        monkeypatch.setattr(agent.compact, "compact_messages", _compact)
    events = await _collect("q", ToolContext(workspace_id="ws_1"))

    assert events[-1]["type"] == "error" and events[-1]["code"] == code
    _saved_listing(events[-1])


async def test_a_turn_without_an_answer_still_records_its_searches(monkeypatch):
    _listing_then(monkeypatch, RuntimeError("provider disconnected"))
    recorded: list[dict] = []

    async def _record(events):
        recorded.extend(events)

    monkeypatch.setattr(agent.store, "record_search_events", _record)
    ctx = ToolContext(workspace_id="ws_1")
    ctx.search_events.append({"chunk_ids": ["c_1"]})  # a search the turn ran
    await _collect("q", ctx)

    assert [event["cited"] for event in recorded] == [[False]]


# ------------------------------------------------------- Stop (Epo 2026-10-21)


def _stop_turn(monkeypatch, responses: list[AssembledResponse], run) -> None:
    """A turn that answers from ``responses`` and runs tools with ``run``; a
    model call past them, or an error report, fails the test."""

    async def _stream(_messages, *, on_event=None, **_kwargs):
        assert responses, "a model call after the stop"
        return responses.pop(0)

    def _report(*_args, **_kwargs):
        raise AssertionError("a stop reported an error")

    monkeypatch.setattr(agent.models, "stream_agent_response", _stream)
    monkeypatch.setattr(agent.tools, "run", run)
    monkeypatch.setattr(agent.obs, "reported_event", _report)


def _stopped_calls(event: dict) -> list[tuple[str, str]]:
    assert event["type"] == "turn_checkpoint" and event["stopped"]
    return [
        (b["callId"], b["outcome"]) for b in event["activity"] if b["kind"] == "tool"
    ]


async def test_a_stop_during_a_slow_tool_lets_it_finish_and_starts_nothing_more(
    monkeypatch,
):
    client = agent.ClientDrop()
    running, release = asyncio.Event(), asyncio.Event()

    async def _run(name, args, ctx):
        del name, args, ctx
        running.set()
        await release.wait()
        return ToolResult(text_parts=["slow listing"])

    _stop_turn(monkeypatch, [_assembled("", [_call("list_sources", "{}", "c1")])], _run)
    task = asyncio.create_task(
        _collect("q", ToolContext(workspace_id="ws_1"), client=client)
    )
    await running.wait()
    client.stop()
    release.set()
    events = await task

    assert _stopped_calls(events[-1]) == [("c1", "succeeded")]
    assert [n["text"] for n in events[-1]["toolEvidence"]["tools"]] == ["slow listing"]
    assert not any(e["type"] in ("done", "error") for e in events)


async def test_a_stop_during_a_write_starts_no_further_call_of_its_batch(monkeypatch):
    client = agent.ClientDrop()
    ran: list[str] = []

    async def _run(name, args, ctx):
        del name, ctx
        ran.append(args["_tool_call_id"])
        client.stop()  # the user stops while the first write runs
        return ToolResult(text_parts=["created"])

    writes = [
        _call("create_material", '{"kind":"note","title":"A"}', "c1"),
        _call("create_material", '{"kind":"note","title":"B"}', "c2"),
    ]
    _stop_turn(monkeypatch, [_assembled("", writes)], _run)
    events = await _collect("q", ToolContext(workspace_id="ws_1"), client=client)

    assert ran == ["c1"]
    assert _stopped_calls(events[-1]) == [("c1", "succeeded")]


async def test_a_stop_during_a_search_lets_its_rerank_finish_and_settle(monkeypatch):
    """A provider call running inside a tool at Stop is billed with the turn."""
    client = agent.ClientDrop()
    running, answer = asyncio.Event(), asyncio.Event()
    opened: list[str] = []
    settled: list[str] = []

    async def _open(call_id, **_kwargs):
        opened.append(call_id)

    async def _no_lease(_call_id):
        return None

    async def _post(payload, **_kwargs):
        settled.append(payload["callId"])
        return {}

    async def _rerank(_spec, _query, documents):
        running.set()
        await answer.wait()
        return {"scores": [1.0] * len(documents), "input_tokens": 30}

    async def _run(name, args, ctx):
        del name, args, ctx
        rows = [{"id": "a", "indexed_text": "a"}, {"id": "b", "indexed_text": "b"}]
        _, reranked = await search.rerank("q", rows)
        return ToolResult(text_parts=[f"reranked={reranked}"])

    monkeypatch.setattr(accounting.cfg, "gateway_url", "http://gateway")
    monkeypatch.setattr(accounting.cfg, "pipeline_secret", "secret")
    monkeypatch.setattr(accounting, "open_call", _open)
    monkeypatch.setattr(accounting, "release_call", _no_lease)
    monkeypatch.setattr(accounting, "_post_settlement", _post)
    monkeypatch.setattr(agent.models.elitellm, "rerank", _rerank)
    monkeypatch.setattr(search, "_rerank_spec", lambda: _model())
    search_call = _call("search_knowledge", '{"query":"q"}', "c1")
    _stop_turn(monkeypatch, [_assembled("", [search_call])], _run)
    token = accounting.bind("cr_stop")
    try:
        turn = asyncio.create_task(
            _collect("q", ToolContext(workspace_id="ws_1"), client=client)
        )
        await running.wait()
        client.stop()
        answer.set()
        events = await turn
        await asyncio.gather(*list(accounting._background))
    finally:
        accounting.reset(token)

    assert _stopped_calls(events[-1]) == [("c1", "succeeded")]
    assert len(opened) == 1 and settled == opened


async def test_a_model_call_failing_after_a_stop_is_not_reported(monkeypatch):
    client = agent.ClientDrop()

    async def _stream(_messages, **_kwargs):
        client.stop()
        raise RuntimeError("provider session is closed")

    def _report(*_args, **_kwargs):
        raise AssertionError("a stop reported an error")

    monkeypatch.setattr(agent.models, "stream_agent_response", _stream)
    monkeypatch.setattr(agent.obs, "reported_event", _report)
    events = await _collect("q", ToolContext(workspace_id="ws_1"), client=client)

    assert _stopped_calls(events[-1]) == []
    assert not any(e["type"] == "error" for e in events)


async def test_chat_stop_marks_only_the_running_turn():
    from pipeline.retrieve import service as retrieve_service

    client = agent.ClientDrop()
    retrieve_service._running["m_run"] = client
    try:
        stopped = await retrieve_service.chat_stop(
            retrieve_service.ChatStopReq(assistantMessageId="m_run")
        )
        missing = await retrieve_service.chat_stop(
            retrieve_service.ChatStopReq(assistantMessageId="m_other")
        )
    finally:
        retrieve_service._running.pop("m_run", None)
    assert stopped == {"stopped": True} and client.stopped and not client.dropped
    assert missing.status_code == 404


async def test_stopped_and_failed_turns_replay_marked_unfinished():
    def _turn(id_: str, status: str, content: str, note: str) -> dict:
        evidence = {"tools": [{"name": "list_sources", "text": note}], "passages": []}
        return {
            "id": id_,
            "role": "assistant",
            "content": content,
            "status": status,
            "toolEvidence": evidence,
        }

    history = [
        {"id": "u1", "role": "user", "content": "make a note", "status": "complete"},
        _turn("a1", "aborted", "Working on it", "stopped listing"),
        {"id": "u2", "role": "user", "content": "try again", "status": "complete"},
        _turn("a2", "error", "", "failed listing"),
    ]
    out = await agent.evidence.history_turns(history, ToolContext(workspace_id="ws_1"))
    texts = [message["content"] for message in out]

    assert texts[1] == "Working on it\n\n" + agent.evidence.UNFINISHED["aborted"]
    assert agent.evidence.UNFINISHED["error"] in texts
    assert sum("stopped listing" in t or "failed listing" in t for t in texts) == 2


# ---------------------------- result retention between messages (Epo 2026-10-21)


async def _ran(name, args, ctx):
    del args, ctx
    return ToolResult(text_parts=[f"ran {name}"])


async def test_an_answered_turn_replays_its_edit_receipt_not_its_inspection(
    monkeypatch,
):
    stream, _seen = _script_stream(
        [
            _assembled("", [_call("inspect_document", '{"material_id":"m"}', "c1")]),
            _assembled("", [_call("edit_document", '{"material_id":"m"}', "c2")]),
            _assembled(_answer(("Edited.", []))),
        ]
    )
    monkeypatch.setattr(agent.models, "stream_agent_response", stream)
    monkeypatch.setattr(agent.tools, "run", _ran)
    done = (await _collect("Fix my note", ToolContext(workspace_id="ws_1")))[-1]

    assert done["type"] == "done"
    assert [n["name"] for n in done["toolEvidence"]["tools"]] == ["edit_document"]
    history = [
        {"id": "u1", "role": "user", "content": "Fix my note", "status": "complete"},
        {
            "id": "a1",
            "role": "assistant",
            "content": "Edited.",
            "status": "complete",
            "toolEvidence": done["toolEvidence"],
        },
    ]
    out = await agent.evidence.history_turns(history, ToolContext(workspace_id="ws_1"))
    replayed = "\n".join(m["content"] for m in out)
    assert "ran edit_document" in replayed and "ran inspect_document" not in replayed


_SEARCHED = _passage(chunk_id="s1", text="Mitosis has four phases.")
_JPEG = "data:image/jpeg;base64,AA=="


def _after_stop(evidence: dict) -> list[dict]:
    return [
        {
            "id": "u1",
            "role": "user",
            "content": "Explain mitosis",
            "status": "complete",
        },
        {
            "id": "a1",
            "role": "assistant",
            "content": "",
            "status": "aborted",
            "toolEvidence": evidence,
        },
    ]


async def test_a_stopped_turn_keeps_its_edit_receipt_not_its_reads_or_captures(
    monkeypatch,
):
    """A stopped turn counts as finished (Epo 2026-10-22): its search, read and
    capture results never reach the next prompt, its edit receipt does."""
    client = agent.ClientDrop()

    async def _run(name, args, ctx):
        if name == "capture_page":
            call_id = args["_tool_call_id"]
            ctx.captures.append(
                {"callId": call_id, "page": 1, "bbox": [0, 0, 1000, 1000], "bytes": 3}
                | {"estimatedImageTokens": 4}
            )
            ctx.pending_images[call_id] = ("capture_page result 1", _JPEG)
            return ToolResult(text_parts=["Captured page 1."])
        if name == "edit_document":
            client.stop()  # the user stops while the edit runs
            return ToolResult(text_parts=["edit receipt: 1 block replaced"])
        return ToolResult(passages=[_SEARCHED], text_parts=[f"ran {name}"])

    calls = [
        _call("search_workspace", '{"query":"mitosis"}', "c1"),
        _call("read_document", '{"file_id":"f_1"}', "c2"),
        _call("capture_page", '{"file_id":"f_1","page":1}', "c3"),
        _call("edit_document", '{"material_id":"m"}', "c4"),
    ]
    _stop_turn(monkeypatch, [_assembled("", calls)], _run)
    events = await _collect("q", ToolContext(workspace_id="ws_1"), client=client)
    evidence = events[-1]["toolEvidence"]
    assert [n["name"] for n in evidence["tools"]] == ["edit_document"]

    stream, seen = _script_stream([_assembled(_answer(("Done.", [])))])
    monkeypatch.setattr(agent.models, "stream_agent_response", stream)
    async for _event in agent.run_agent(
        query="go on",
        ctx=ToolContext(workspace_id="ws_1"),
        history=_after_stop(evidence),
        model=_model(),
    ):
        pass
    prompt = json.dumps(seen[0]["messages"])
    assert "edit receipt: 1 block replaced" in prompt
    assert _SEARCHED.text not in prompt and "ran read_document" not in prompt
    assert "Captured page 1." not in prompt and _JPEG not in prompt


@pytest.mark.parametrize("ending", ["stop", "failure"])
async def test_a_partial_answer_keeps_the_passages_it_cited(monkeypatch, ending):
    """A turn stopped or failed mid-answer keeps the passages the user saw
    cited, like an answered turn (Epo 2026-10-22)."""
    client = agent.ClientDrop()
    ctx = ToolContext(workspace_id="ws_1")
    program = _answer(("Mitosis has four phases.", [1]), ("More.", []))
    shown, rest = program.split('"More', 1)

    async def _stream(_messages, *, on_event=None, **_kwargs):
        if not ctx.citations:
            return _assembled("", [_call("read_document", '{"file_id":"f_1"}', "r1")])
        on_event(StreamEvent(kind="text", text=shown))
        for _ in range(20):  # the user sees the first claim with its citation
            if ctx.cited_shown:
                break
            await asyncio.sleep(0)
        if ending == "failure":
            raise RuntimeError("provider disconnected")
        client.stop()
        on_event(StreamEvent(kind="text", text='"More' + rest))
        return _assembled(program)

    async def _run(name, args, ctx):
        return ToolResult(passages=[_SEARCHED], paged=True, text_parts=["(end)"])

    monkeypatch.setattr(agent.models, "stream_agent_response", _stream)
    monkeypatch.setattr(agent.tools, "run", _run)
    events = await _collect("q", ctx, client=client)

    if ending == "stop":
        assert events[-1]["type"] == "turn_checkpoint" and events[-1]["stopped"]
    else:
        assert events[-1]["type"] == "error"
    passages = events[-1]["toolEvidence"]["passages"]
    assert [p["chunk_id"] for p in passages] == ["s1"]


async def test_a_call_the_stop_kept_from_starting_replays_as_cancelled(monkeypatch):
    client = agent.ClientDrop()

    async def _run(name, args, ctx):
        client.stop()  # the user stops while the first write runs
        return ToolResult(text_parts=["created A"])

    writes = [
        _call("create_material", '{"kind":"note","title":"A"}', "c1"),
        _call("create_material", '{"kind":"note","title":"B"}', "c2"),
    ]
    _stop_turn(monkeypatch, [_assembled("", writes)], _run)
    events = await _collect("q", ToolContext(workspace_id="ws_1"), client=client)
    evidence = events[-1]["toolEvidence"]

    assert [(n["outcome"], n["text"]) for n in evidence["tools"]] == [
        ("succeeded", "created A"),
        ("cancelled", agent.CANCELLED),
    ]
    out = await agent.evidence.history_turns(
        _after_stop(evidence), ToolContext(workspace_id="ws_1")
    )
    replayed = [m["content"] for m in out if agent.CANCELLED in m["content"]]
    assert len(replayed) == 1
    assert '"name":"create_material"' in replayed[0]
    assert evidence["tools"][1]["detail"] in replayed[0]


async def test_a_stop_with_a_malformed_office_create_still_saves_its_record(
    monkeypatch,
):
    """Review r2 L4: commands sent as an object instead of a list name nothing
    in the call's detail instead of failing the stop checkpoint."""
    client = agent.ClientDrop()
    create = '{"commands": {"type": "create", "title": "Budget"}}'

    async def _stream(_messages, **_kwargs):
        client.stop()  # the response was still streaming at the stop
        return _assembled("", [_call("edit_office_document", create, "c1")])

    monkeypatch.setattr(agent.models, "stream_agent_response", _stream)
    events = await _collect("q", ToolContext(workspace_id="ws_1"), client=client)

    assert events[-1]["type"] == "turn_checkpoint" and events[-1]["stopped"]
    assert events[-1]["toolEvidence"]["tools"] == [
        {
            "name": "edit_office_document",
            "detail": "",
            "outcome": "cancelled",
            "text": agent.CANCELLED,
        }
    ]


async def test_a_note_its_tool_no_longer_keeps_is_not_replayed():
    """Review r2 L5: a row saved while inspections were kept whole follows the
    current retention; the record of a cancelled call still replays."""
    saved = {
        "tools": [
            {
                "name": "inspect_document",
                "outcome": "succeeded",
                "text": "quiz answers",
            },
            {"name": "list_sources", "outcome": "succeeded", "text": "a listing"},
            {
                "name": "search_workspace",
                "outcome": "cancelled",
                "text": agent.CANCELLED,
            },
        ]
    }
    out = await agent.evidence.history_turns(
        [
            {"id": "u1", "role": "user", "content": "q", "status": "complete"},
            {
                "id": "a1",
                "role": "assistant",
                "content": "Done.",
                "status": "complete",
                "toolEvidence": saved,
            },
        ],
        ToolContext(workspace_id="ws_1"),
    )
    replayed = "\n".join(m["content"] for m in out)
    assert "a listing" in replayed and agent.CANCELLED in replayed
    assert "quiz answers" not in replayed


async def test_the_calls_of_a_response_ending_after_the_stop_are_cancelled(
    monkeypatch,
):
    client = agent.ClientDrop()

    async def _stream(_messages, **_kwargs):
        client.stop()  # the response was still streaming at the stop
        return _assembled("", [_call("search_workspace", '{"query":"q"}', "c1")])

    monkeypatch.setattr(agent.models, "stream_agent_response", _stream)
    events = await _collect("q", ToolContext(workspace_id="ws_1"), client=client)

    assert [(n["name"], n["outcome"]) for n in events[-1]["toolEvidence"]["tools"]] == [
        ("search_workspace", "cancelled")
    ]


async def test_the_office_tools_stay_offered_after_a_dropped_office_inspection(
    monkeypatch,
):
    _gateway(monkeypatch)
    run = agent.tools.run

    async def _run(name, args, ctx):
        if name == "inspect_office_document":
            return ToolResult(text_parts=["Sheet1!A1 = 3"])
        return await run(name, args, ctx)

    stream, seen = _script_stream(
        [
            _assembled("", [_call("read_skill", '{"name": "office_building"}', "c1")]),
            _assembled(
                "", [_call("inspect_office_document", '{"file_id":"f_1"}', "c2")]
            ),
            _assembled(_answer(("A1 is 3.", []))),
            _assembled(_answer(("Still 3.", []))),
        ]
    )
    monkeypatch.setattr(agent.models, "stream_agent_response", stream)
    monkeypatch.setattr(agent.tools, "run", _run)
    done = (await _collect("What is in A1?", _owner_ctx()))[-1]
    evidence = done["toolEvidence"]
    assert evidence["officeTools"] is True and evidence["tools"] == []

    # The next message, as the gateway sends it (store.ConversationPrompt).
    later = _owner_ctx()
    later.office_tools = evidence["officeTools"]
    history = [
        {"id": "u1", "role": "user", "content": "What is in A1?", "status": "complete"},
        {
            "id": "a1",
            "role": "assistant",
            "content": "A1 is 3.",
            "status": "complete",
            "toolEvidence": evidence,
        },
    ]
    async for _event in agent.run_agent(
        query="And now?", ctx=later, history=history, model=_model()
    ):
        pass
    offered = [t["function"]["name"] for t in seen[3]["tools"]]
    assert offered[-2:] == list(tools.OFFICE_TOOLS)
    assert not any("Sheet1!A1" in str(m["content"]) for m in seen[3]["messages"])


async def test_an_answer_that_fails_after_recording_does_not_record_again(
    monkeypatch,
):
    stream, _seen = _script_stream([_assembled(_answer(("ok", [])))])
    monkeypatch.setattr(agent.models, "stream_agent_response", stream)
    calls: list[list[dict]] = []

    async def _record(events):
        calls.append(events)

    def _pack(_ctx, _order, **_kwargs):
        raise RuntimeError("pack failed")

    monkeypatch.setattr(agent.store, "record_search_events", _record)
    monkeypatch.setattr(agent.evidence, "pack", _pack)
    ctx = ToolContext(workspace_id="ws_1")
    ctx.search_events.append({"chunk_ids": ["c_1"]})
    with pytest.raises(RuntimeError, match="pack failed"):
        await _collect("q", ctx)

    assert len(calls) == 1


async def test_a_cancelled_search_record_still_removes_the_deck_dir(
    monkeypatch, tmp_path
):
    _listing_then(monkeypatch, RuntimeError("provider disconnected"))

    async def _cancelled(_events):
        raise asyncio.CancelledError

    monkeypatch.setattr(agent.store, "record_search_events", _cancelled)
    ctx = ToolContext(workspace_id="ws_1", deck_dir=str(tmp_path / "deck"))
    (tmp_path / "deck").mkdir()
    ctx.search_events.append({"chunk_ids": ["c_1"]})
    with pytest.raises(asyncio.CancelledError):
        await _collect("q", ctx)

    assert not (tmp_path / "deck").exists()


async def test_a_turn_failed_mid_batch_keeps_the_calls_that_finished(monkeypatch):
    stream, _seen = _script_stream(
        [
            _assembled(
                "",
                [
                    _call("list_sources", "{}", "c1"),
                    _call("create_material", '{"kind":"note"}', "c2"),
                ],
            )
        ]
    )

    async def _run(name, args, ctx):
        del args, ctx
        if name == "create_material":
            raise TurnFailed("the receipt read timed out")
        return ToolResult(text_parts=[f"ran {name}"])

    monkeypatch.setattr(agent.models, "stream_agent_response", stream)
    monkeypatch.setattr(agent.tools, "run", _run)
    events = await _collect("q", ToolContext(workspace_id="ws_1", user_id="u1"))

    assert events[-1]["type"] == "error" and events[-1]["code"] == "agent_failed"
    assert not any(e["type"] == "turn_checkpoint" for e in events)
    _saved_listing(events[-1])


async def test_a_finished_turn_sends_done_as_before_with_notes_in_call_order(
    monkeypatch,
):
    stream, _seen = _script_stream(
        [
            _assembled(
                "",
                [
                    _call("list_sources", "{}", "c1"),
                    _call("list_sources", "{}", "c2"),
                ],
            ),
            _assembled(_answer(("done", []))),
        ]
    )
    second_done = asyncio.Event()

    async def _run(name, args, ctx):
        del name, ctx
        if args["_tool_call_id"] == "c1":
            await second_done.wait()  # the first call finishes last
        else:
            second_done.set()
        return ToolResult(text_parts=[f"listed for {args['_tool_call_id']}"])

    monkeypatch.setattr(agent.models, "stream_agent_response", stream)
    monkeypatch.setattr(agent.tools, "run", _run)
    events = await _collect("q", ToolContext(workspace_id="ws_1"))

    done = events[-1]
    assert set(done) == {
        "type",
        "tokenCount",
        "telemetry",
        "activity",
        "answer",
        "toolEvidence",
    }
    assert done["telemetry"]["stopReason"] == "answer"
    assert {b["callId"] for b in done["activity"] if b["kind"] == "tool"} == {
        "c1",
        "c2",
    }
    assert done["toolEvidence"] == {
        "tools": [
            {
                "name": "list_sources",
                "detail": "listing sources",
                "outcome": "succeeded",
                "text": f"listed for {call_id}",
            }
            for call_id in ("c1", "c2")
        ],
        "passages": [],
        "skills": [],
    }
    checkpoint = next(e for e in events if e["type"] == "turn_checkpoint")
    assert checkpoint["toolEvidence"] == done["toolEvidence"]


async def test_an_exception_past_the_agent_still_sends_the_turn_so_far(monkeypatch):
    from pipeline.retrieve import service

    async def _agent(*, ctx, **_kwargs):
        ctx.activity.append({"id": "c1", "kind": "tool", "callId": "c1"})
        ctx.evidence_notes.append({"name": "list_sources", "text": "ran list_sources"})
        yield {"type": "phase", "phase": "planning"}
        raise RuntimeError("citation regions unavailable")

    monkeypatch.setattr(service, "run_agent", _agent)
    monkeypatch.setattr(service.accounting, "bind", lambda _session: None)
    monkeypatch.setattr(service.models, "resolve_query_model", lambda *_a: _model())
    req = service.ChatStreamReq(
        providerSlug="deepseek",
        modelSlug="deepseek-v4-flash",
        configVersion=1,
        userId="u_1",
        paidBy="platform",
        thinking="high",
        query="q",
        workspaceId="ws_1",
        contractVersion=contract.VERSION,
        operations=[],
        spendSessionId="cr_1",
        role="editor",
    )
    chunks = [chunk async for chunk in service._chat_events(req)]

    last = json.loads(chunks[-1].removeprefix("data: "))
    assert last["code"] == "agent_failed"
    _saved_listing(last)


async def test_a_chat_stream_is_stoppable_until_it_ends(monkeypatch):
    from pipeline.retrieve import service

    registered = []

    async def _agent(*, client, **_kwargs):
        registered.append(service._running.get("m_turn") is client)
        yield {"type": "done"}

    monkeypatch.setattr(service, "run_agent", _agent)
    monkeypatch.setattr(service.accounting, "bind", lambda _session: None)
    monkeypatch.setattr(service.models, "resolve_query_model", lambda *_a: _model())
    req = service.ChatStreamReq(
        providerSlug="deepseek",
        modelSlug="deepseek-v4-flash",
        configVersion=1,
        userId="u_1",
        paidBy="platform",
        thinking="high",
        query="q",
        workspaceId="ws_1",
        contractVersion=contract.VERSION,
        operations=[],
        assistantMessageId="m_turn",
        spendSessionId="cr_1",
        role="editor",
    )
    _chunks = [chunk async for chunk in service._chat_events(req)]

    assert registered == [True] and "m_turn" not in service._running


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

    async def _documents(*_args):
        return {"items": [{"kind": "source_file", "id": "f_2", "editable": False}]}

    monkeypatch.setattr(tools, "_gateway_read", _documents)
    listed = await tools._list_sources({}, ctx)
    assert "two.pdf" not in listed.text()
    resolved = await tools._resolve_scope(ctx, [])
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
        self.headers: dict[str, str] = {}

    def json(self):
        return self._body


@pytest.mark.parametrize("file_ids", [None, ["f_2"], []])
async def test_list_sources_includes_materials_and_scoped_file_editability(
    monkeypatch, file_ids
):
    ctx = _owner_ctx()
    ctx.file_ids = file_ids
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
                    {
                        "kind": "material",
                        "id": "mat_2",
                        "title": "Cells quiz",
                        "format": "plate",
                        "materialKind": "quiz",
                        "chapterId": "ch_1",
                        "editable": True,
                    },
                ]
            }
        )

    _gateway(monkeypatch, post=_post)

    async def _outline(_workspace_id):
        return {
            "chapters": [{"id": "ch_1", "name": "Biology"}],
            "files": [
                {
                    "id": "f_1",
                    "name": "one.pdf",
                    "chapter_id": "ch_1",
                    "chunks": 4,
                    "status": "ready",
                    "descriptor": "Cell structure",
                },
                {
                    "id": "f_2",
                    "name": "two.txt",
                    "chapter_id": None,
                    "chunks": 0,
                    "status": "pending",
                },
                {
                    "id": "mat_1",
                    "name": "Notes",
                    "chapter_id": None,
                    "chunks": 2,
                    "status": "ready",
                    "kind": "material",
                    "descriptor": "Mitosis phases",
                },
            ],
        }

    monkeypatch.setattr(tools.store, "workspace_outline", _outline)
    result = await tools.run("list_sources", {"_tool_call_id": "c1"}, ctx)
    text = result.text()
    assert seen["url"].endswith("/api/internal/documents/list")
    assert seen["userId"] == "u1" and seen["workspaceId"] == "ws_1"
    if file_ids is None:
        assert "## Biology" in text and "Cell structure" in text
        assert "file_id=f_1, kind=source_file, editable=false, 4 passages" in text
    else:
        assert "f_1" not in text and "one.pdf" not in text
    if file_ids != []:
        assert "file_id=f_2, kind=source_file, editable=true, 0 passages" in text
        assert "[pending]" in text
    else:
        assert "f_2" not in text and "two.txt" not in text
    # A note's summary sits under its line, as a file's descriptor does.
    assert (
        "Notes (id=mat_1, kind=material, material_kind=note, editable=true)"
        "\n  Mitosis phases"
    ) in text
    # A material sits under the chapter it is filed in; the rest are unfiled.
    biology = text.split("## Biology (chapter_id=ch_1)")[1].split("\n## ")[0]
    assert "Cells quiz (id=mat_2" in biology
    assert "Notes (id=mat_1" in text.split("## Unfiled study materials")[1]
    # Only notes are outlined and indexed; the other kinds name their tools.
    assert (
        "Cells quiz (id=mat_2, kind=material, material_kind=quiz, editable=true); "
        "inspect_document and edit_document take its id"
    ) in text


async def test_inspect_document_renders_a_materials_blocks(monkeypatch):
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
                        "text": "graph TD",
                        "properties": {"caption": "Tide flow"},
                    },
                    {
                        "id": "r1",
                        "type": "material_ref",
                        "text": "",
                        "properties": {"materialId": "mat_q", "refKind": "quiz"},
                    },
                    {
                        "id": "r2",
                        "type": "material_ref",
                        "text": "",
                        "properties": {"materialId": "", "refKind": "flashcards"},
                    },
                ],
            },
        ]
    )

    def _post(url, **kwargs):
        return _JsonResp(next(bodies))

    _gateway(monkeypatch, post=_post)
    ctx.pending_sources = pending.PendingSources(
        notes=[
            {
                "materialId": "mat_1",
                "title": "Notes",
                "revision": 3,
                "changes": [
                    {
                        "id": "n_1",
                        "kind": "text",
                        "operation": "replace",
                        "blockId": "b1",
                        "label": "",
                        "before": "cells",
                        "after": "nuclei",
                    }
                ],
            }
        ],
        read_ids=set(),
    )
    material = await tools.run(
        "inspect_document",
        {"target": {"kind": "material", "id": "mat_1"}, "_tool_call_id": "c1"},
        ctx,
    )
    # An inspect is a read: it passes the note's changes on (r3 M16).
    assert '"after":"nuclei"' in material.pending
    text = material.text()
    assert "[b1] (p) hello" in text
    assert "    [qq1] (quiz_question) Why?" in text
    # A Mermaid block reads as its source, its caption apart (Epo 2026-10-22).
    assert "[m1] (mermaid) graph TD\n    caption: Tide flow" in text
    assert "embedded quiz material id=mat_q: inspect it as kind material" in text
    assert "embedded flashcards reference, not yet created" in text


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
    ctx.skills_read = {"editing"}
    commands = [{"type": "replace_text", "expected_text": "old", "text": "new"}]
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
    assert "The user can undo this" in result.text()


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


async def test_a_missed_edit_target_comes_back_as_it_reads_now(monkeypatch):
    """The refusal carries the target's current text (or the block list for a
    gone id) for the model only, and says when the block changed since this
    turn last saw it, counting the turn's own edits as seen."""
    ctx = _owner_ctx()
    ctx.skills_read = {"editing"}

    def refused(code, message, details):
        return _JsonResp(
            {"code": code, "message": message, "details": details}, status=409
        )

    def block(bid, text):
        return {"block": {"id": bid, "type": "p", "text": text}}

    answers = iter(
        [
            _JsonResp(
                {
                    "format": "plate",
                    "title": "Notes",
                    "blocks": [
                        {"id": "b1", "type": "p", "text": "alpha beta"},
                        {"id": "b2", "type": "p", "text": "gamma"},
                    ],
                }
            ),
            _JsonResp(_receipt("edited", "material", "mat_1")),
            refused(
                "stale_target",
                "expected text was not found in the target",
                block("b1", "alpha delta"),
            ),
            refused(
                "stale_target",
                "expected text was not found in the target",
                block("b2", "gamma, said Ann"),
            ),
            refused(
                "unavailable_target",
                "block b9 no longer exists",
                {
                    "blocks": [{"id": "b1", "type": "p", "text": "alpha delta"}],
                    "total": 3,
                },
            ),
            refused(
                "invalid_input",
                "expected text occurs 2 times; include more context",
                block("b1", "alpha delta"),
            ),
        ]
    )
    _gateway(monkeypatch, post=lambda url, **kwargs: next(answers))
    target = {"kind": "material", "id": "mat_1"}
    await tools.run("inspect_document", {"target": target, "_tool_call_id": "c0"}, ctx)

    def edit(n, bid, expected, text):
        command = {
            "type": "replace_text",
            "target_id": bid,
            "expected_text": expected,
            "text": text,
        }
        return tools.run(
            "edit_document",
            {"target": target, "commands": [command], "_tool_call_id": f"c{n}"},
            ctx,
        )

    assert (await edit(1, "b1", "beta", "delta")).outcome == "succeeded"
    own = await edit(2, "b1", "beta", "x")
    assert own.text().endswith("Block b1 (p) now reads:\nalpha delta")
    other = await edit(3, "b2", "gamma.", "g")
    assert other.text().endswith(
        "Block b2 (p) changed since you last saw it. It now reads:\ngamma, said Ann"
    )
    assert other.error_payload() == {
        "code": "stale_target",
        "message": "Could not edit the document: expected text was not found in the target",
    }
    gone = await edit(4, "b9", "x", "y")
    assert gone.text().endswith(
        "The material's blocks now, with the start of each:\n[b1] (p) alpha delta\n"
        "… 2 more; inspect_document pages through them"
    )
    # An ambiguous expected text comes back with its block too.
    twice = await edit(5, "b1", "a", "b")
    assert twice.text().endswith("Block b1 (p) now reads:\nalpha delta")


async def test_a_mermaid_expectation_is_its_stored_source(monkeypatch):
    """A Mermaid source's edge whitespace does not show where inspect or a
    stale refusal prints it, so an edit expecting the source as shown expects
    the stored one (review r2 L3: the model looped on stale_target)."""
    ctx = _owner_ctx()
    ctx.skills_read = {"editing"}
    stored, typed = "flowchart LR\n  A --> B\n", "flowchart LR\n  A --> C \n"
    sent: list[dict] = []
    answers = iter(
        [
            _JsonResp(
                {
                    "format": "plate",
                    "title": "Notes",
                    "blocks": [{"id": "m1", "type": "mermaid", "text": stored}],
                }
            ),
            _JsonResp(
                {
                    "code": "stale_target",
                    "message": "block m1 changed",
                    "details": {
                        "block": {"id": "m1", "type": "mermaid", "text": typed}
                    },
                },
                status=409,
            ),
            _JsonResp(_receipt("edited", "material", "mat_1")),
        ]
    )

    def _post(url, **kwargs):
        if "data" in kwargs:
            sent.append(json.loads(kwargs["data"]))
        return next(answers)

    _gateway(monkeypatch, post=_post)
    target = {"kind": "material", "id": "mat_1"}
    await tools.run("inspect_document", {"target": target, "_tool_call_id": "c0"}, ctx)

    def remove(n, expected):
        command = {"type": "remove_block", "block_id": "m1", "expected_text": expected}
        return tools.run(
            "edit_document",
            {"target": target, "commands": [command], "_tool_call_id": f"c{n}"},
            ctx,
        )

    assert (await remove(1, stored.strip())).outcome != "succeeded"
    assert (await remove(2, typed.strip())).outcome == "succeeded"
    expected = [body["commands"][0]["expected_text"] for body in sent[-2:]]
    assert expected == [stored, typed]


async def test_a_write_naming_unread_excerpts_credits_them(monkeypatch):
    """Named excerpts are credited whether this turn read them or not (Epo
    2026-10-14): no refusal sends the model back to read them."""
    ctx = ToolContext(workspace_id="ws")

    async def _provenance(excerpt_ids):
        return [_book(*excerpt_ids)]

    monkeypatch.setattr(tools.library, "provenance", _provenance)
    args = {"kind": "note", "content": "x", "excerpt_ids": ["e_1", "e_2"]}
    assert await tools.write_sources(ctx, "create_material", args) == (
        [_book("e_1", "e_2")],
        ["e_1", "e_2"],
    )


def test_receipts_name_the_blocks_written_and_end_is_no_relocation():
    body = _receipt("edited", "material", "mat_1")
    body["effect"]["relocated"] = [{"anchor": "end", "after": "b9", "end": True}]
    body["effect"]["blockIds"] = ["b10", "b11", "b12", "b13"]
    text = tools._receipt_result(body).text()
    assert "Block end" not in text and "It wrote 4 blocks, b10 to b13." in text
    created = _receipt("created", "material", "mat_2")
    created["effect"]["blockIds"] = ["b1", "b2"]
    assert "It wrote blocks b1, b2." in tools._receipt_result(created).text()


def test_an_office_edit_receipt_says_which_characters_it_removed():
    """Go passes the engine's note on characters an Office file cannot store
    on to the tool result (Epo 2026-10-15)."""
    body = _receipt("edited", "source_file", "f_1")
    body["notice"] = "Removed 1 character Office files cannot store (U+0001)."
    assert (
        "(id f_1). Removed 1 character Office files cannot store (U+0001)."
        in tools._receipt_result(body).text()
    )


def test_an_edit_receipt_offers_undo_only_when_it_has_one():
    """An edit no loaded room took has no Undo ref, so its result does not
    promise one (Epo 2026-10-20)."""
    undo = " The user can undo this from the chat result."
    body = _receipt("edited", "source_file", "f_1")
    assert undo not in tools._receipt_result(body).text()
    body["effect"]["undo"] = {"operationId": "op_x", "status": "available"}
    assert tools._receipt_result(body).text().endswith(undo)


def test_an_edit_receipt_says_where_a_relocated_insert_landed():
    body = _receipt("edited", "material", "mat_1")
    body["effect"]["relocated"] = [
        {"anchor": "b2", "after": "b9", "end": True},
        {"anchor": "b4", "after": None, "end": False},
    ]
    text = tools._receipt_result(body).text()
    assert (
        "Block b2 no longer existed, so the blocks meant to follow it were added "
        "at the end of the material, after block b9. Block b4 was removed earlier "
        "in this edit, so the blocks meant to follow it took its place, at the start."
    ) in text


def test_argument_errors_name_the_fields_without_echoing_the_command():
    section = "A long section. " * 200
    target = {"kind": "material", "id": "mat_1"}

    def problem(*commands):
        return contract.validate_args(
            "edit_document", {"target": target, "commands": list(commands)}
        )

    note = {"type": "insert_markdown", "after_block_id": None, "markdown": section}
    misnamed = {"type": "remove_block", "target_id": "b1", "expected_text": section}
    assert problem(note, misnamed) == (
        "edit_document arguments invalid at commands/1: remove_block takes "
        "block_id, expected_text; missing block_id; unknown target_id"
    )
    untyped = problem({"expected_text": section, "text": "b"})
    assert untyped.startswith(
        'edit_document arguments invalid at commands/0: "type" must be one of '
        "replace_text, replace_block, insert_markdown,"
    )
    assert section not in untyped
    assert problem({**note, "after_block_id": 3}).endswith(
        "invalid after_block_id (must be string or null)"
    )


async def test_blank_optional_arguments_are_left_out_before_checking(monkeypatch):
    """Blank means absent (null, "", "null", [] or {}) where the schema does
    not require the property, into an edit command's variant; a required one
    is kept as sent, so replace_text's empty text still deletes. Seen in the
    2026-10-13 runs: target_id null, create_material scope []."""
    edit = {
        "target": {"kind": "material", "id": "mat_1"},
        "commands": [
            {
                "type": "replace_text",
                "target_id": None,
                "expected_text": "a",
                "text": "",
            },
            {"type": "insert_markdown", "after_block_id": None, "markdown": "x"},
        ],
        "excerpt_ids": [],
        "_tool_call_id": "c1",
    }
    assert tools.without_blanks("edit_document", edit) == {
        "target": {"kind": "material", "id": "mat_1"},
        "commands": [
            {"type": "replace_text", "expected_text": "a", "text": ""},
            {"type": "insert_markdown", "after_block_id": None, "markdown": "x"},
        ],
        "_tool_call_id": "c1",
    }
    assert tools.without_blanks(
        "create_material", {"kind": "note", "sources": [], "title": "null", "cards": {}}
    ) == {"kind": "note"}
    # A blank expectation beside its side is one: a card's empty front
    # (Epo 2026-10-21); without the side it means nothing and goes.
    card = {"type": "replace_card", "card_id": "c1", "front": "F", "expected_front": ""}
    assert tools.without_blanks(
        "edit_document", {"target": edit["target"], "commands": [card]}
    )["commands"] == [card]
    assert tools.without_blanks(
        "edit_document",
        {
            "target": edit["target"],
            "commands": [{**card, "front": None, "back": "B", "expected_back": "b"}],
        },
    )["commands"] == [
        {"type": "replace_card", "card_id": "c1", "back": "B", "expected_back": "b"}
    ]

    # Dispatch hands the handler the cleaned arguments.
    seen = {}

    async def handler(args, _ctx):
        seen.update(args)
        return tools._result("ok")

    monkeypatch.setitem(
        tools.REGISTRY, "search_workspace", tools.ToolSpec("search_workspace", handler)
    )
    result = await tools.run(
        "search_workspace",
        {"query": "q", "file_ids": [], "_tool_call_id": "c1"},
        _owner_ctx(),
    )
    assert not result.refused and seen == {"query": "q", "_tool_call_id": "c1"}


# ------------------------------------------------------------ program answers


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
        stopped=None,
    ):
        del model, call_purpose
        seen.append(
            {
                "tools": tools,
                # Tools off: the turn context says so, or no tools to send.
                "tools_off": agent.turn_context.tools_off(messages) or not tools,
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


async def _two_passage_turn(monkeypatch, chunks: list[str], final: str):
    """One read_document step showing [1] and [2], then the answer stream."""
    chunk_lists = [[], chunks]
    finals = [
        _assembled("", [_call("read_document", '{"file_id":"f_1"}')]),
        _assembled(final),
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


async def test_program_streams_through_with_citations_in_reading_order(monkeypatch):
    # `b` is defined before `a` but read after it: the live list follows the
    # stream, the final list follows the reading order, and `n` maps both.
    raw = (
        "root = Answer([a, b])\n"
        'b = Md("Light is absorbed.", [1])\n'
        'a = Md("Carbon is fixed.", [2])\n'
    )
    chunks = [raw[i : i + 9] for i in range(0, len(raw), 9)]
    events, seen = await _two_passage_turn(monkeypatch, chunks, raw)

    deltas = [e["text"] for e in events if e["type"] == "block_delta"]
    assert "".join(deltas) == raw
    assert events[-1]["answer"] == raw
    assert seen[1]["response_format"] is None
    cites = [e for e in events if e["type"] == "citations"]
    # The live list follows the stream (`b` first); the final list is the
    # reading order, sent once the whole program is parsed.
    assert [[c["chunkId"] for c in e["citations"]] for e in cites] == [
        ["c1"],
        ["c2", "c1"],
    ]
    assert [c["n"] for c in cites[-1]["citations"]] == [2, 1]
    assert [e["version"] for e in cites] == [1, 2]
    assert all(e.get("final") for e in cites)
    assert events[-1]["telemetry"]["completionCalls"] == 2


async def test_unfinished_program_keeps_local_recovery_without_an_extra_call(
    monkeypatch,
):
    raw = 'root = Answer([a, b])\na = Md("Carbon is fixed.", [2])\nb = Md("Cut off'
    events, seen = await _two_passage_turn(monkeypatch, [raw], raw)
    assert len(seen) == 2
    assert sum(e["type"] == "block_start" for e in events) == 1
    assert events[-1]["answer"] == raw
    final = [e for e in events if e["type"] == "citations"][-1]
    assert [c["chunkId"] for c in final["citations"]] == ["c2"]
    assert events[-1]["telemetry"]["completionCalls"] == 2


async def test_plain_prose_answer_uses_markdown_without_an_extra_call(monkeypatch):
    prose = "Carbon is fixed."
    events, seen = await _two_passage_turn(monkeypatch, [prose], prose)
    assert len(seen) == 2
    assert events[-1]["answer"] == prose
    assert [e["text"] for e in events if e["type"] == "block_delta"] == [prose]
    final = [e for e in events if e["type"] == "citations"][-1]
    assert final["citations"] == [] and final["final"] is True


async def test_answer_call_never_requests_json_mode(monkeypatch):
    stream, seen = _script_stream([_assembled(_answer(("ok", [])))])
    monkeypatch.setattr(agent.models, "stream_agent_response", stream)
    monkeypatch.setattr(agent.cfg, "agent_max_steps", 1)

    await _collect("q", ToolContext(workspace_id="ws_1"))
    assert seen[0]["tools_off"]
    assert seen[0]["response_format"] is None


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

    # The turn context comes last; the images follow their tool results.
    roles = [m["role"] for m in seen[2]["messages"]]
    assert roles[-4:] == ["assistant", "tool", "user", "user"]
    image_message = seen[2]["messages"][-2]
    assert image_message["content"][-2]["type"] == "image_url"
    assert seen[1]["messages"][-2]["role"] == "tool"
    activity = events[-1]["activity"]
    capture_block = next(b for b in activity if b.get("name") == "capture_page")
    assert capture_block["capture"] == {
        "page": 1,
        "bbox": [0, 0, 1000, 1000],
        "bytes": len(jpeg),
    }
    assert capture_block["detail"] == "page 1"
    assert events[-1]["answer"] == _answer(("Seen.", [1]))
    # Telemetry counts the image by its 28 px patches (2 x 1), not its base64.
    with_image = agent.models.measure_request_context(
        seen[2]["messages"], model=_model()
    )
    stripped, _ = agent.capture.split_images(seen[2]["messages"])
    without = agent.models.measure_request_context(stripped, model=_model())
    assert with_image.total_tokens - without.total_tokens == 2


# A capture at the 1568 px edge: 56 x 56 patches, 3,136 tokens.
_SIDE = 1568
_PATCHES = (_SIDE // 28) ** 2


def _image_turn(monkeypatch, steps: list[list[str]]):
    """A turn whose responses each take the named images side by side
    (``k<page>`` a page capture, ``s<n>`` a source change's image), through the
    real tools with a fake render of a full-edge square, then answer. Returns
    the requests, the context and each request's compaction extra."""
    jpeg = io.BytesIO()
    Image.new("RGB", (8, 8), "white").save(jpeg, "JPEG")
    full = (jpeg.getvalue(), [0.0, 0.0, 1000.0, 1000.0], (_SIDE, _SIDE))

    async def _render_file(*_args):
        return full

    async def _no_office(*_args):
        return False

    async def _resolve(**_kwargs):
        return jpeg.getvalue()

    def call(name: str) -> ToolCall:
        if name.startswith("s"):
            args = {"file_id": "f_1", "change_id": f"c{name[1:]}", "checkpoint": 3}
            return _call("resolve_source_change", json.dumps(args), name)
        return _call("capture_page", f'{{"file_id":"f_1","page":{name[1:]}}}', name)

    stream, seen = _script_stream(
        [_assembled("", [call(name) for name in step]) for step in steps]
        + [_assembled(_answer(("Seen.", [1])))]
    )

    async def _run(name, args, ctx):
        if name == "resolve_source_change":
            return await agent.tools._resolve_source_change(args, ctx)
        return await agent.tools._capture_page(args, ctx)

    extras: list[int] = []
    compact = agent.compact.compact_messages

    async def _compact(messages, spec, *, extra=0, **kwargs):
        extras.append(extra)
        return await compact(messages, spec, extra=extra, **kwargs)

    monkeypatch.setattr(agent.models, "stream_agent_response", stream)
    monkeypatch.setattr(agent.tools, "run", _run)
    monkeypatch.setattr(agent.capture, "render_file", _render_file)
    monkeypatch.setattr(agent.capture, "office_file", _no_office)
    monkeypatch.setattr(agent.capture, "image_jpeg", lambda *_args: full)
    monkeypatch.setattr(agent.tools.pending, "resolve", _resolve)
    monkeypatch.setattr(agent.compact, "compact_messages", _compact)
    ctx = ToolContext(workspace_id="ws_1", file_ids=["f_1"])
    ctx._scope_outline = {
        "chapters": [],
        "files": [{"id": "f_1", "name": "bio.pdf", "chapter_id": None, "chunks": 1}],
    }
    agent.tools.assign_citations(
        ctx,
        [_passage(chunk_id=f"c{n}", page_start=n, page_end=n) for n in range(1, 16)],
    )
    return seen, ctx, extras


def _request_parts(request: dict) -> list[dict]:
    return [
        part
        for message in request["messages"]
        if isinstance(message.get("content"), list)
        for part in message["content"]
    ]


def _image_labels(request: dict) -> list[str]:
    """The labels of the request's images, in request order."""
    found = _request_parts(request)
    return [
        found[i - 1]["text"].split("\n")[0]
        for i, part in enumerate(found)
        if part["type"] == "image_url"
    ]


def _extra_texts(request: dict) -> list[str]:
    """Text in the images messages besides their headers, image labels and
    closing tags: a dropped image's note would show here (Q370: none)."""
    return [
        part["text"]
        for part in _request_parts(request)
        if part["type"] == "text"
        and not part["text"].startswith("Images from ")
        and not part["text"].endswith("\n<source>")
        and part["text"] != "</source>"
    ]


def _tool_text(request: dict, call_id: str) -> str:
    (message,) = [m for m in request["messages"] if m.get("tool_call_id") == call_id]
    return message["content"]


async def test_captures_past_the_image_budget_drop_the_oldest_in_one_batch(
    monkeypatch,
):
    """(Q349, Q368, Q370) A turn's images stay within 35k patch tokens: under
    it every capture rides in the request; the capture batch that takes the
    turn past it drops the oldest captures earlier requests carried, at once,
    until at most 17.5k remains; a dropped capture's image leaves the request,
    the turn and the compaction budget with no note in its place, its tool
    result keeping its ordinary text, and the next request starts the same,
    with no further drop."""
    seen, ctx, extras = _image_turn(
        monkeypatch,
        [
            ["k1", "k2", "k3", "k4"],
            ["k5", "k6", "k7", "k8"],
            ["k9", "k10", "k11", "k12"],  # 37,632 tokens: past the budget
            ["k13"],
        ],
    )
    events = await _collect("q", ctx)
    assert events[-1]["type"] == "done"
    # Side-by-side captures are numbered as they finish: the oldest seven by
    # capture order go, the five newest (15,680 tokens) stay.
    order = [record["callId"] for record in ctx.captures]
    label = {
        c: f"capture_page result {n}: bio.pdf page {c[1:]}"
        for n, c in enumerate(order, 1)
    }
    assert [_image_labels(request) for request in seen[:3]] == [
        [],
        [label[f"k{n}"] for n in range(1, 5)],
        [label[f"k{n}"] for n in range(1, 9)],
    ]
    dropped, kept = order[:7], order[7:12]
    assert set(dropped) > {"k1", "k2", "k3", "k4"} and set(kept) > {"k9", "k12"}
    assert sorted(_image_labels(seen[3])) == sorted(label[c] for c in kept)
    assert _image_labels(seen[4]) == _image_labels(seen[3]) + [label["k13"]]
    assert set(ctx.pending_images) == {*kept, "k13"}
    # No note: a dropped capture's result is the text it always had.
    assert [_extra_texts(request) for request in seen] == [[]] * 5
    for call_id in dropped:
        text = _tool_text(seen[2], call_id)
        assert text.startswith(f"Captured bio.pdf page {call_id[1:]} as capture")
        assert _tool_text(seen[3], call_id) == _tool_text(seen[4], call_id) == text
    # The request after the drop starts as the drop's own request did.
    before = seen[3]["messages"][:-1]  # its turn context comes last
    assert seen[4]["messages"][: len(before)] == before
    # The compaction budget counts the five kept captures, not all twelve.
    assert abs(extras[3] - extras[0] - 5 * _PATCHES) < 100


async def test_source_change_images_share_the_image_budget(monkeypatch):
    """(Q369, Q370) resolve_source_change images count toward the budget with
    page captures and drop with them, oldest of either kind first: a dropped
    source change image leaves the request with no note, its tool result
    keeping its ordinary text, while one no request carried yet stays."""
    seen, ctx, _extras = _image_turn(
        monkeypatch,
        [
            ["s1", "k2", "k3", "k4"],
            ["k5", "k6", "k7", "k8"],
            ["s9", "k10", "k11", "k12"],  # 37,632 tokens: past the budget
        ],
    )
    await _collect("q", ctx)
    order = [record["callId"] for record in ctx.captures]
    dropped, kept = order[:7], order[7:]
    assert "s1" in dropped and "s9" in kept
    after = seen[3]
    labels = _image_labels(after)
    assert sorted(labels) == sorted(ctx.pending_images[c][0] for c in kept)
    assert "resolve_source_change result: change c1 of file f_1" not in labels
    assert "resolve_source_change result: change c9 of file f_1" in labels
    assert _extra_texts(after) == []
    ordinary = (
        "The pending source image is attached to the next message; read it directly."
    )
    assert _tool_text(seen[1], "s1") == _tool_text(after, "s1") == ordinary


async def test_a_dropped_image_whose_exchange_was_folded_leaves_nothing(monkeypatch):
    """(Q349, Q370) Live compaction folded the first step's exchange into the
    turn note as the budget dropped its four captures: nothing of theirs
    follows the note, image or note; of the second step's captures, the one
    kept still rides after that step's tool results, and the third step's
    four after theirs."""
    seen, ctx, _extras = _image_turn(
        monkeypatch,
        [
            ["k1", "k2", "k3", "k4"],
            ["k5", "k6", "k7", "k8"],
            ["k9", "k10", "k11", "k12"],  # past the budget, and folded
        ],
    )

    def _full(messages, *_args, **_kwargs):
        """Too large once the third step's results are in, until folded."""
        kinds = [m.get("_kind") for m in messages]
        return (
            "turn_note" not in kinds
            and sum(m["role"] == "tool" for m in messages) == 12
        )

    async def _note(**_kwargs):
        return "Captured pages 1 to 4 of bio.pdf."

    monkeypatch.setattr(agent.compact, "needs_compact", _full)
    monkeypatch.setattr(agent.compact, "summarize_checkpoint", _note)
    await _collect("q", ctx)

    request = seen[3]["messages"]
    note = next(i for i, m in enumerate(request) if m.get("_kind") == "turn_note")
    assert not any(m.get("tool_call_id") in {"k1", "k2", "k3", "k4"} for m in request)
    assert request[note + 1]["role"] == "assistant"  # no images message after it
    order = [record["callId"] for record in ctx.captures]
    images = [
        [p for p in m["content"] if p["type"] == "image_url"]
        for m in request
        if m["role"] == "user" and isinstance(m.get("content"), list)
    ]
    assert [len(found) for found in images if found] == [1, 4]
    assert {"k1", "k2", "k3", "k4"} <= set(order[:7])
    assert _extra_texts(seen[3]) == []


async def test_a_compacted_turn_still_sends_every_capture(monkeypatch):
    """Live compaction folds the capture's exchange into the turn note; its
    image still rides with every later request of the turn, and the budget
    still counts it (Epo 2026-10-21)."""
    buffer = io.BytesIO()
    Image.new("RGB", (56, 28), "white").save(buffer, "JPEG")
    jpeg = buffer.getvalue()
    stream, seen = _script_stream(
        [
            _assembled("", [_call("capture_page", '{"file_id":"f_1","page":1}', "k1")]),
            _assembled("", [_call("list_sources", "{}", "r1")]),
            _assembled("", [_call("list_sources", "{}", "r2")]),
            _assembled("", [_call("list_sources", "{}", "r3")]),
            _assembled(_answer(("Seen.", []))),
        ]
    )

    async def _run(name, args, ctx):
        if name == "capture_page":
            call_id = args["_tool_call_id"]
            ctx.captures.append(
                agent.capture.record(
                    call_id=call_id,
                    file_id="f_1",
                    page=1,
                    box=[0, 0, 1000, 1000],
                    jpeg=jpeg,
                    size=(56, 28),
                    started=0.0,
                )
                | {"estimatedImageTokens": 5000}
            )
            ctx.pending_images[call_id] = (
                "capture_page result 1",
                agent.capture.data_url(jpeg),
            )
        return ToolResult(text_parts=[f"ran {name}"])

    def _full(messages, *_args, **_kwargs):
        """The request is too large once three exchanges are in, until folded."""
        kinds = [m.get("_kind") for m in messages]
        return (
            "turn_note" not in kinds and sum(m["role"] == "tool" for m in messages) == 3
        )

    async def _note(**_kwargs):
        return "Captured page 1 of f_1; listed sources."

    extras: list[int] = []
    compact = agent.compact.compact_messages

    async def _compact(messages, spec, *, extra=0, **kwargs):
        extras.append(extra)
        return await compact(messages, spec, extra=extra, **kwargs)

    monkeypatch.setattr(agent.models, "stream_agent_response", stream)
    monkeypatch.setattr(agent.tools, "run", _run)
    monkeypatch.setattr(agent.compact, "needs_compact", _full)
    monkeypatch.setattr(agent.compact, "summarize_checkpoint", _note)
    monkeypatch.setattr(agent.compact, "compact_messages", _compact)
    await _collect("q", ToolContext(workspace_id="ws_1"))

    # The fourth request folded k1's exchange; the fifth runs on the folded turn.
    for request in seen[3:]:
        messages = request["messages"]
        assert not any(m.get("tool_call_id") == "k1" for m in messages)
        note = next(i for i, m in enumerate(messages) if m.get("_kind") == "turn_note")
        assert messages[note + 1]["content"][-2]["type"] == "image_url"
    # The budget of the request after the fold still holds the capture.
    assert 4950 < extras[4] - extras[0] < 5050


@pytest.mark.parametrize(
    "raw",
    [
        'root = Answer([a])\na = Nope("Carbon is fixed.", [2])\n',
        'a = Md("Carbon is fixed.", [2])\n',
        "root = Answer([a])\n",
        'root = Md("Carbon is fixed.", [2])\n',
    ],
)
async def test_invalid_program_stays_available_for_local_recovery(monkeypatch, raw):
    events, seen = await _two_passage_turn(monkeypatch, [raw[:7], raw[7:]], raw)
    assert len(seen) == 2
    assert events[-1]["answer"] == raw
    assert events[-1]["telemetry"]["completionCalls"] == 2


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
        ctx.pending_images[args["_tool_call_id"]] = (
            "capture_page result 1",
            agent.capture.data_url(b"jpeg"),
        )
        return ToolResult(text_parts=["Captured page 1."])

    monkeypatch.setattr(agent.models, "stream_agent_response", stream)
    monkeypatch.setattr(agent.tools, "run", _run)

    await _collect("q", ToolContext(workspace_id="ws_1"))
    # The turn context rides outside too; only the capture changes between calls.
    assert extras[1] - extras[0] == 2240


async def test_fenced_program_is_unwrapped(monkeypatch):
    program = _answer(("Carbon is fixed.", [2]))
    raw = "```openui-lang\n" + program + "```"
    events, seen = await _two_passage_turn(monkeypatch, [raw[:20], raw[20:]], raw)
    assert len(seen) == 2
    deltas = [e["text"] for e in events if e["type"] == "block_delta"]
    assert "".join(deltas) == program and events[-1]["answer"] == program
    final = [e for e in events if e["type"] == "citations"][-1]
    assert [c["chunkId"] for c in final["citations"]] == ["c2"]


# --------------------------------------------------------------- build flow


def _build_model() -> ModelConfig:
    model = _model()
    return replace(model, context_window_tokens=250_000)


def _build_ctx(**kwargs) -> ToolContext:
    # The subject list is set, so the turn does not open a library connection to read it.
    kwargs.setdefault(
        "library_catalog",
        [{"id": "statistics", "label": "Statistics", "aliases": [], "excerpts": 3}],
    )
    return ToolContext(
        workspace_id="ws_1",
        user_id="u1",
        operations=frozenset(contract.OPERATIONS),
        assistant_message_id="m_1",
        **kwargs,
    )


@pytest.fixture
def library_on(monkeypatch):
    monkeypatch.setattr(agent.tools.library, "enabled", lambda: True)


async def test_a_library_that_is_down_or_empty_leaves_the_turn_on_the_workspace(
    monkeypatch, library_on, caplog
):
    """Library is a source, not a mode: when it cannot be read the turn
    answers from the workspace without offering the library tools."""

    async def _down(_ctx):
        raise TimeoutError("pool timeout")

    for catalog, loader in ((None, _down), ([], None)):
        if loader:
            monkeypatch.setattr(agent.tools, "load_library_catalog", loader)
        stream, seen = _script_stream([_assembled(_answer(("From your notes.", [])))])
        monkeypatch.setattr(agent.models, "stream_agent_response", stream)
        ctx = _build_ctx(library_catalog=catalog)
        events = await _collect("teach me regression", ctx)

        offered = {tool["function"]["name"] for tool in seen[0]["tools"]}
        assert "search_knowledge" not in offered
        assert events[-1]["telemetry"]["stopReason"] == "answer"
    assert "pool timeout" in caplog.text


async def test_a_retained_read_replays_with_its_own_count(monkeypatch):
    """A page read with count 4 matches only when it is read again with 4."""
    from pipeline.retrieval.library_evidence import LibraryEvidence

    calls = []

    async def read(args, ctx):
        calls.append(dict(args))
        ctx.library_reads.note(args["excerpt_id"], args.get("start", 0), "8.1")
        return tools._result(f"{args.get('count')} chunks")

    monkeypatch.setattr(tools, "_read_knowledge", read)
    first = LibraryEvidence()
    reads = tools.LibraryReads()
    reads.note("e_1", 0, "8.1")
    args = {"excerpt_id": "e_1", "count": 4}
    first.observe("read_knowledge", args, tools._result("4 chunks"), "4 chunks", reads)
    first.wrote(["e_1"])
    packed = first.pack()
    assert packed == [
        {
            "excerpt_id": "e_1",
            "start": 0,
            "count": 4,
            "section": "8.1",
            "text": "4 chunks",
        }
    ]

    later = LibraryEvidence()
    parts = await later.history_parts(
        [{"role": "assistant", "toolEvidence": {"libraryExcerpts": packed}}],
        ToolContext(workspace_id="ws_1"),
    )
    assert calls == [{"excerpt_id": "e_1", "start": 0, "count": 4}]
    assert ("e_1", 0) in later.inherited and "4 chunks" in parts[0][0]


async def test_turn_context_comes_last_and_tracks_the_reads(monkeypatch, library_on):
    stream, seen = _script_stream(
        [
            _assembled("", [_call("read_knowledge", '{"excerpt_id":"e_1"}', "k1")]),
            _assembled(
                "",
                [
                    _call(
                        "create_material",
                        '{"kind":"note","title":"Regression"}',
                        "k2",
                    )
                ],
            ),
            _assembled("I built one note from Advanced High School Statistics."),
        ]
    )
    monkeypatch.setattr(agent.models, "stream_agent_response", stream)

    async def _run(name, args, ctx):
        if name == "read_knowledge":
            ctx.library_reads.note("e_1", 0, "8.1 Line fitting")
            return ToolResult(text_parts=["excerpt text"])
        return ToolResult(text_parts=["Created note."])

    monkeypatch.setattr(agent.tools, "run", _run)
    ctx = _build_ctx()
    events = await _collect("teach me regression", ctx, model=_build_model())

    def _context(messages):
        return [m for m in messages if m.get("_kind") == "turn_context"][-1]

    first = _script_messages(seen, 0)
    assert "Open: nothing." in _context(first)["content"]
    assert "Library excerpts" not in _context(first)["content"]
    # Sent last and left in place: every request extends the one before it, so
    # the provider's cache covers all but the newest step.
    for before, after in itertools.pairwise(seen):
        assert after["messages"][-1] is _context(after["messages"])
        assert [m["content"] for m in after["messages"][: len(before["messages"])]] == [
            m["content"] for m in before["messages"]
        ]

    second = _context(_script_messages(seen, 1))["content"]
    assert "- e_1 8.1 Line fitting" in second
    assert "Responses remaining this turn" in second
    # The write landed: the build budget replaces the planning countdown.
    third = _context(_script_messages(seen, 2))["content"]
    assert "Responses remaining without a successful write: 5." in third
    # The turn context never becomes conversation history.
    assert events[-1]["answer"].startswith("I built one note")


def _script_messages(seen: list[dict], index: int) -> list[dict]:
    return seen[index]["messages"]


def _writing(call_id: str = "w", title: str = "x") -> AssembledResponse:
    return _assembled(
        "",
        [
            _call(
                "create_material", json.dumps({"kind": "note", "title": title}), call_id
            )
        ],
    )


async def _land(_name, _args, _ctx) -> ToolResult:
    """Every call succeeds: a write lands, a read reads."""
    return ToolResult(text_parts=["done"])


async def test_a_building_turn_has_no_response_ceiling_while_writes_land(
    monkeypatch, library_on
):
    """Twenty responses, a write landing every third one: nothing stops it,
    though a turn with no write has 12."""
    reading = _assembled("", [_call("read_knowledge", '{"excerpt_id":"e"}', "k")])
    stream, seen = _script_stream(
        [reading, reading, _writing()] * 6 + [reading, _assembled("Done.")]
    )
    monkeypatch.setattr(agent.models, "stream_agent_response", stream)
    monkeypatch.setattr(agent.tools, "run", _land)

    events = await _collect("teach me regression", _build_ctx(), model=_build_model())

    assert len(seen) == 20, "no planning ceiling once a write lands"
    assert not any(call["tools_off"] for call in seen), "the guard never fired"
    assert events[-1]["answer"] == "Done."


async def test_the_planning_cap_holds_until_the_first_write_lands(
    monkeypatch, library_on
):
    """Reads alone never lift the planning cap: the last response has tools
    off, and a refused write does not lift it either."""
    monkeypatch.setattr(agent.cfg, "agent_max_steps", 4)
    reading = _assembled("", [_call("read_knowledge", '{"excerpt_id":"e"}', "k")])
    refused = _writing("bad", "refused")
    stream, seen = _script_stream([reading, refused, reading, _assembled("Read only.")])
    monkeypatch.setattr(agent.models, "stream_agent_response", stream)

    async def _run(_name, args, _ctx):
        if args.get("title") == "refused":
            return ToolResult(text_parts=["no"], refused=True)
        return ToolResult(text_parts=["done"])

    monkeypatch.setattr(agent.tools, "run", _run)
    events = await _collect("teach me regression", _build_ctx(), model=_build_model())

    assert [call["tools_off"] for call in seen] == [False, False, False, True]
    assert events[-1]["telemetry"]["stopReason"] == "answer"


async def test_stall_guard_turns_tools_off_after_five_barren_responses(
    monkeypatch, library_on, caplog
):
    """Once a write has landed, five responses in a row without another one
    turn the tools off."""
    reading = _assembled("", [_call("read_knowledge", '{"excerpt_id":"e_1"}', "k")])
    stream, seen = _script_stream(
        [_writing()] + [reading] * 5 + [_assembled("The library has nothing more.")]
    )
    monkeypatch.setattr(agent.models, "stream_agent_response", stream)
    monkeypatch.setattr(agent.tools, "run", _land)

    events = await _collect("teach me regression", _build_ctx(), model=_build_model())

    assert [call["tools_off"] for call in seen] == [False] * 6 + [True]
    # The tools stay in the request so its prefix still hits the cache.
    assert seen[-1]["tools"] == seen[0]["tools"]
    # The response before the last with tools warned why the tools go off.
    results = [m for m in seen[-1]["messages"] if m.get("role") == "tool"]
    assert results[-2]["content"].endswith(agent.STALL_NOTICE)
    assert events[-1]["answer"] == "The library has nothing more."
    # The guard, not a planning ceiling, is what ended this turn.
    assert events[-1]["telemetry"]["stopReason"] == "stall"
    assert "5 responses landed no write" in caplog.text
    assert "1 writes landed" in caplog.text


async def test_errored_writes_extend_the_stall_guard_twice_at_most(
    monkeypatch, library_on, caplog
):
    """A refused create_material is an attempt at progress: each of the first
    two grants two more responses, so the guard fires after nine, not five."""
    reading = _assembled("", [_call("read_knowledge", '{"excerpt_id":"e_1"}', "k")])
    refused = _writing("bad", "refused")
    # A landed write, then three refused writes plus reads: only two of the
    # refusals count, so the threshold is 5 + 2 + 2 = 9 barren responses.
    stream, seen = _script_stream(
        [_writing()]
        + [refused] * 3
        + [reading] * 6
        + [_assembled("Nothing more written.")]
    )
    monkeypatch.setattr(agent.models, "stream_agent_response", stream)

    async def _run(name, args, _ctx):
        if args.get("title") == "refused":
            return ToolResult(text_parts=["read e_1 first"], refused=True)
        return ToolResult(text_parts=["done"])

    monkeypatch.setattr(agent.tools, "run", _run)
    events = await _collect("teach me regression", _build_ctx(), model=_build_model())

    assert [call["tools_off"] for call in seen] == [False] * 10 + [True]
    assert events[-1]["telemetry"]["stopReason"] == "stall"
    assert "limit 9 after 3 errored writes" in caplog.text


async def test_an_empty_response_after_a_write_stalls_but_does_not_end_the_turn(
    monkeypatch, library_on
):
    """No text and no tool calls is one wasted response, not the end of the
    turn: once a write lands there is no planning ceiling to run into."""
    stream, seen = _script_stream(
        [_writing(), _assembled(""), _assembled("I built one note.")]
    )
    monkeypatch.setattr(agent.models, "stream_agent_response", stream)
    monkeypatch.setattr(agent.tools, "run", _land)

    events = await _collect("teach me regression", _build_ctx(), model=_build_model())

    assert len(seen) == 3, "the empty response did not end the turn"
    assert [call["tools_off"] for call in seen] == [False, False, False]
    assert events[-1]["answer"] == "I built one note."
    assert events[-1]["telemetry"]["stopReason"] == "answer"


async def test_six_empty_responses_after_a_write_end_the_turn_on_the_stall_guard(
    monkeypatch, library_on
):
    """Counting them is the whole bound on a turn whose payer has no credit
    cutoff: five empties turn the tools off, the sixth ends the turn."""
    stream, seen = _script_stream([_writing()] + [_assembled("")] * 6)
    monkeypatch.setattr(agent.models, "stream_agent_response", stream)
    monkeypatch.setattr(agent.tools, "run", _land)

    events = await _collect("teach me regression", _build_ctx(), model=_build_model())

    assert [call["tools_off"] for call in seen] == [False] * 6 + [True]
    assert not events[-1]["answer"]
    assert events[-1]["telemetry"]["stopReason"] == "stall"


async def test_a_silent_terminal_call_after_a_write_reports_the_credit_cutoff(
    monkeypatch, library_on, caplog
):
    """Credits run out mid-turn, so the terminal call runs with tools off and
    returns nothing. That is the billing cutoff, not the stall guard, so
    counting stall stops sizes STALL_RESPONSES rather than the credit guard."""
    state = accounting.RequestAccounting(session_id="cr_1")
    token = accounting._accounting.set(state)
    stream, seen = _script_stream([_writing(), _assembled("")])
    monkeypatch.setattr(agent.models, "stream_agent_response", stream)

    async def _run(_name, _args, _ctx):
        state.credits_exhausted = True
        state.terminal_call_allowed = True
        return ToolResult(text_parts=["Created note."])

    monkeypatch.setattr(agent.tools, "run", _run)
    try:
        events = await _collect(
            "teach me regression", _build_ctx(), model=_build_model()
        )
    finally:
        accounting._accounting.reset(token)

    assert [call["tools_off"] for call in seen] == [False, True]
    assert "stall guard" not in caplog.text, "the guard never fired"
    assert events[-1]["telemetry"]["stopReason"] == "planning_cap"


async def test_a_response_allows_four_tool_calls(monkeypatch, library_on):
    calls = [
        _call("read_knowledge", f'{{"excerpt_id":"e_{n}"}}', f"k{n}") for n in range(7)
    ]
    stream, _seen = _script_stream(
        [_assembled("", calls), _assembled("Read what the library holds.")]
    )
    monkeypatch.setattr(agent.models, "stream_agent_response", stream)

    async def _run(_name, args, ctx):
        ctx.library_reads.note(str(args["excerpt_id"]), 0, "8.1")
        return ToolResult(text_parts=["excerpt"])

    monkeypatch.setattr(agent.tools, "run", _run)
    events = await _collect("teach me regression", _build_ctx(), model=_build_model())

    outcomes = {e["callId"]: e["outcome"] for e in events if e["type"] == "tool_end"}
    assert [outcomes[f"k{n}"] for n in range(7)] == ["succeeded"] * 4 + ["refused"] * 3


@pytest.mark.parametrize("followup", ["reuse", "changed", "missing", "compacted"])
async def test_material_excerpt_evidence_survives_only_as_current_full_text(
    monkeypatch, library_on, followup
):
    from unittest.mock import AsyncMock

    source = {("a", 0): "First page", ("a", 4): "Second page", ("unused", 0): "Unused"}

    async def read(args, ctx):
        key = args["excerpt_id"], args.get("start", 0)
        if key not in source:
            return tools._refused("Unavailable")
        ctx.library_reads.note(*key, "Section")
        return tools._result(source[key])

    original_run = tools.run

    async def run(name, args, ctx):
        if name == "read_knowledge":
            return await read(args, ctx)
        if name in ("create_material", "edit_document"):
            checked = await tools.write_sources(ctx, name, args)
            if isinstance(checked, ToolResult):
                return checked
            _, credited = checked
            effect = {
                "operation": "created" if name == "create_material" else "edited",
                "resource": {"kind": "material", "id": "mat_1", "title": "Study"},
            }
            tools.landed(ctx, credited)
            return ToolResult(text_parts=["Saved"], effects=[effect])
        return await original_run(name, args, ctx)

    monkeypatch.setattr(tools, "run", run)
    monkeypatch.setattr(tools, "_read_knowledge", read)
    monkeypatch.setattr(tools.library, "provenance", AsyncMock(return_value=[]))
    stream, seen = _script_stream(
        [
            _assembled(
                calls=[
                    _call(
                        "read_knowledge",
                        json.dumps({"excerpt_id": eid, "start": start}),
                        str(i),
                    )
                    for i, (eid, start) in enumerate(source)
                ]
            ),
            _assembled(
                calls=[
                    _call(
                        "create_material",
                        '{"kind":"note","title":"Study","content":"First page","excerpt_ids":["a"]}',
                    )
                ]
            ),
            _assembled("Created."),
        ]
    )
    monkeypatch.setattr(agent.models, "stream_agent_response", stream)
    first = await _collect("Make a note", _build_ctx(), model=_build_model())
    packed = first[-1]["toolEvidence"]["libraryExcerpts"]
    assert [(p["excerpt_id"], p["start"], p["text"]) for p in packed] == [
        ("a", 0, "First page"),
        ("a", 4, "Second page"),
    ]
    history = [
        {
            "id": "m1",
            "role": "assistant",
            "content": "Created.",
            "toolEvidence": first[-1]["toolEvidence"],
        }
    ]
    # Repeated use moves each retained page to its newest owning turn.
    history.append({**history[0], "id": "m2"})
    if followup == "changed":
        source = {key: text + " changed" for key, text in source.items()}
    elif followup == "missing":
        source.clear()
    elif followup == "compacted":
        original_compact = agent.compact.compact_messages

        async def fold(messages, *args, **kwargs):
            messages = await original_compact(messages, *args, **kwargs)
            return [m for m in messages if m.get("_kind") != "source_evidence"] + [
                {"role": "user", "_kind": "memory", "content": "Previously read a."}
            ]

        monkeypatch.setattr(agent.compact, "compact_messages", fold)
    stream, seen = _script_stream(
        [
            _assembled(calls=[_call("edit_document", '{"excerpt_ids":["a"]}', "edit")]),
            _assembled("Finished."),
        ]
    )
    monkeypatch.setattr(agent.models, "stream_agent_response", stream)
    ctx = _build_ctx()
    second = [
        e
        async for e in agent.run_agent(
            query="Extend it", ctx=ctx, history=history, model=_build_model()
        )
    ]
    outcome = next(
        e["outcome"]
        for e in second
        if e["type"] == "tool_end" and e["callId"] == "edit"
    )
    # A named excerpt is credited whether its text is retained or not (Epo
    # 2026-10-14); only the replay depends on it.
    assert outcome == "succeeded"
    replay = [
        m
        for m in seen[0]["messages"]
        if m.get("_kind") == "source_evidence" and "full text below" in m["content"]
    ]
    assert len(replay) == (2 if followup == "reuse" else 0)
    context = next(
        m["content"] for m in seen[0]["messages"] if m.get("_kind") == "turn_context"
    )
    assert ("- a Section" in context) == (followup == "reuse")
    assert bool(second[-1]["toolEvidence"].get("libraryExcerpts")) == (
        followup == "reuse"
    )
    ordinary = await agent.evidence.history_turns(
        history, ToolContext(workspace_id="ws_1")
    )
    assert not any("First page" in m["content"] for m in ordinary)


async def test_a_retained_excerpt_is_credited_only_when_nothing_new_was_read(
    monkeypatch, library_on
):
    """An excerpt retained from an earlier turn's write was credited there: a
    write naming none credits this turn's new reads, or the retained one when
    nothing new was read."""
    from pipeline.retrieval.library_evidence import ExcerptRead

    ctx = _build_ctx()
    ctx.library_evidence.inherited[("a", 0)] = ExcerptRead("a", 0, 12, "S", "A text")
    replayed = [
        {
            "_kind": "source_evidence",
            "content": ctx.library_evidence.inherited[("a", 0)].replay(),
        }
    ]
    ctx.library_evidence.activate(replayed, ctx.library_reads)
    assert ctx.library_reads.uncredited() == ["a"], "nothing new: the retained one"
    assert ctx.library_reads.reads[0].text == "A text", "kept for automatic credit"
    ctx.library_reads.note("b", 0, "S")
    assert ctx.library_reads.uncredited() == ["b"]


@pytest.mark.parametrize("terminal_text", ["Created all requested materials.", ""])
async def test_the_build_tool_cap_runs_one_terminal_response(
    monkeypatch, library_on, terminal_text
):
    # Exercise the boundary without paying for 160 actual tool calls.
    monkeypatch.setattr(agent, "BUILD_TOOLS_PER_TURN", 4)
    stream, seen = _script_stream(
        [
            _writing(),
            _assembled(
                calls=[
                    _call("read_knowledge", '{"excerpt_id":"a"}', str(i))
                    for i in range(4)
                ]
            ),
            _assembled(terminal_text),
        ]
    )
    monkeypatch.setattr(agent.models, "stream_agent_response", stream)
    monkeypatch.setattr(tools, "run", _land)
    events = await _collect("Study", _build_ctx(), model=_build_model())
    assert [e["outcome"] for e in events if e["type"] == "tool_end"].count(
        "refused"
    ) == 1
    assert seen[-1]["tools_off"]
    assert (
        agent.turn_context.FINAL_NOTICE
        in [
            m["content"]
            for m in seen[-1]["messages"]
            if m.get("_kind") == "turn_context"
        ][-1]
    )
    assert events[-1]["telemetry"]["toolCallsTurn"] == 4
    assert events[-1]["telemetry"]["stopReason"] == "tool_cap"


async def test_calls_past_the_tool_cap_are_answered_with_the_cap(
    monkeypatch, library_on
):
    monkeypatch.setattr(agent, "BUILD_TOOLS_PER_TURN", 1)
    stream, seen = _script_stream(
        [
            _writing(),
            _assembled(calls=[_call("read_knowledge", '{"excerpt_id":"a"}', "r")]),
            _assembled("Made one note."),
        ]
    )
    monkeypatch.setattr(agent.models, "stream_agent_response", stream)
    monkeypatch.setattr(tools, "run", _land)
    events = await _collect("Study", _build_ctx(), model=_build_model())

    results = [m for m in seen[-1]["messages"] if m.get("role") == "tool"]
    assert results[-1]["content"] == agent.TOOL_CAP_RESULT
    assert events[-1]["telemetry"]["stopReason"] == "tool_cap"


@pytest.mark.parametrize("deltas, fails", [(True, False), (False, False), (True, True)])
async def test_tool_protocol_in_text_flags_response_without_tools_or_repair(
    monkeypatch, deltas, fails
):
    text = (
        _answer(("Safe prefix", []))
        + '<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="create_material">'
    )
    completed = []

    async def stream(_messages, *, on_event, **_kwargs):
        if deltas:
            for character in text:
                on_event(StreamEvent(kind="text", text=character))
        completed.append(True)
        if fails:
            raise RuntimeError("provider disconnected after leaking protocol")
        return _assembled(text, [_call("create_material")])

    async def forbidden(*_args, **_kwargs):
        pytest.fail("flagged response must neither call tools nor call a repair model")

    monkeypatch.setattr(agent.models, "stream_agent_response", stream)
    monkeypatch.setattr(agent.models, "complete_text", forbidden)
    monkeypatch.setattr(agent.tools, "run", forbidden)
    events = await _collect("help", ToolContext(workspace_id="ws", user_id="u"))
    assert completed == [True]
    assert events[-1]["code"] == "response_flagged"
    assert events[-1]["message"] == "Response flagged due to safety concern"
    assert not any(event["type"] == "tool_start" for event in events)
    assert "DSML" not in "".join(event.get("text", "") for event in events)


async def test_chat_rejects_instant_before_any_model_call(monkeypatch):
    spec = replace(
        _model(), thinking_levels=("instant", "high"), default_thinking="instant"
    )

    async def forbidden(*_args, **_kwargs):
        pytest.fail("instant chat must fail before calling a model")

    monkeypatch.setattr(agent.models, "stream_agent_response", forbidden)
    events = await _collect(
        "help", ToolContext(workspace_id="ws", user_id="u"), model=spec
    )
    assert events[-1]["code"] == "model_unavailable"


async def test_a_uat_scripted_turn_runs_its_calls_through_the_tools_not_a_model(
    monkeypatch,
):
    query = scripted.MARKER + json.dumps(
        {
            "steps": [
                [
                    {"name": "read_skill", "arguments": {"name": "editing"}},
                    {"name": "list_trashed_files", "arguments": {}},
                ],
                "Scripted.",
            ]
        }
    )
    # Without the UAT switch the marker is ordinary text for the model.
    assert scripted.parse(query) is None
    monkeypatch.setattr(scripted.cfg, "uat_scripted_tools", True)
    with pytest.raises(scripted.ScriptError):
        scripted.parse(scripted.MARKER + '{"steps": [[{"name": 1}]]}')

    async def forbidden(*_args, **_kwargs):
        pytest.fail("a scripted turn must not call a model")

    monkeypatch.setattr(agent.models, "stream_agent_response", forbidden)
    events = await _collect(
        query,
        ToolContext(workspace_id="ws", operations=frozenset({"source.read"})),
        script=scripted.parse(query),
    )
    # The calls take the model's path: list_trashed_files needs trash.read,
    # which this actor lacks.
    assert {e["callId"]: e["outcome"] for e in events if e["type"] == "tool_end"} == {
        "call_uat_1_1": "succeeded",
        "call_uat_1_2": "refused",
    }
    assert events[-1]["type"] == "done"
    assert events[-1]["answer"] == "Scripted."


def test_the_scripted_tools_switch_is_true_or_unset_and_uat_only():
    flag = config.uat_only_flag
    key = "RETRIEVAL_UAT_SCRIPTED_TOOLS"
    assert not flag(key, {"SENTRY_ENVIRONMENT": "uat"})
    assert flag(key, {key: "true", "SENTRY_ENVIRONMENT": "uat"})
    with pytest.raises(ValueError, match="only with SENTRY_ENVIRONMENT=uat"):
        flag(key, {key: "true", "SENTRY_ENVIRONMENT": "production"})
    with pytest.raises(ValueError, match="true or unset"):
        flag(key, {key: "1", "SENTRY_ENVIRONMENT": "uat"})


async def test_a_search_passage_names_its_documents_unindexed_edits(monkeypatch):
    """Epo 2026-10-20: a passage whose document has unindexed edits carries a
    line naming it and its edit count, above its source block, with no edit
    text."""

    async def search(**_kwargs):
        return [_passage(chunk_id="c1"), _passage(chunk_id="c2", file_id="f_2")]

    async def no_match(*_args, **_kwargs):
        return []

    monkeypatch.setattr(tools, "search", search)
    monkeypatch.setattr(agent.pending_hints, "match", no_match)
    monkeypatch.setattr(agent.pending_hints, "_indexed_langs", _no_langs)
    ctx = ToolContext(workspace_id="ws_1")
    ctx.pending_sources = pending.PendingSources(
        [_changed_file("f_1", "secret new wording")]
    )
    ctx.pending_sources.read_ids = set()
    ctx._scope_outline = {
        "chapters": [],
        "files": [
            {"id": f, "name": "bio.pdf", "chapter_id": None, "chunks": 1}
            for f in ("f_1", "f_2")
        ],
    }
    result = await tools._search_workspace({"query": "chlorophyll"}, ctx)
    text = tools.render_result(result, tools.assign_citations(ctx, result.passages))
    flag = (
        '[1] "bio.pdf" has 1 edit not indexed yet, so this passage may be out of '
        "date: read the document for its current text.\n<source>"
    )
    assert flag in text and text.count("not indexed yet") == 1
    assert "secret new wording" not in text
    assert ctx.passage_flags == {"c1": 1}  # saved for a replay (S4)


async def test_askuser_called_as_a_tool_ends_the_turn_on_that_question(monkeypatch):
    """GLM sometimes calls the AskUser answer component as a tool. The turn
    ends on the question it meant, its prose before it, and nothing runs."""
    from pipeline.retrieval import openui

    stream, seen = _script_stream(
        [
            _assembled(
                "One quick question before I build your chapter:",
                [
                    _call(
                        "AskUser",
                        json.dumps(
                            {
                                "question": "Where should we start?",
                                "choices": '["Beginner", "I code already"]',
                            }
                        ),
                    )
                ],
            )
        ]
    )
    monkeypatch.setattr(agent.models, "stream_agent_response", stream)
    ran: list[str] = []

    async def _run(name, _args, _ctx):
        ran.append(name)
        return ToolResult(text_parts=["no"])

    monkeypatch.setattr(agent.tools, "run", _run)
    events = await _collect("I want to learn java", ToolContext(workspace_id="ws_1"))
    done = events[-1]
    assert done["type"] == "done" and not ran and len(seen) == 1
    program = openui.parse(done["answer"], strict=True)
    asks = [c for c in openui.walk(program) if c.name == "AskUser"]
    assert [(c.prop("question"), c.prop("choices")) for c in asks] == [
        ("Where should we start?", ["Beginner", "I code already"])
    ]
    assert "One quick question" in openui.to_text(program)
    assert agent.ask_user_answer([_call("AskUser", "{}")], "x", 0) is None, (
        "no question, no answer"
    )
    # Every AskUser call is a question, up to the format's three (Epo 2026-10-14).
    many = [
        _call("AskUser", json.dumps({"question": f"Q{n}?", "choices": []}), f"a{n}")
        for n in range(1, 5)
    ]
    program = openui.parse(agent.ask_user_answer(many, "", 0), strict=True)
    asked = [c.prop("question") for c in openui.walk(program) if c.name == "AskUser"]
    assert asked == ["Q1?", "Q2?", "Q3?"]


@pytest.mark.parametrize(("provider", "offered"), [("zai", True), ("deepseek", False)])
async def test_glm_is_offered_askuser_as_a_real_tool(monkeypatch, provider, offered):
    """DigitalOcean drops calls to tools a request does not list, and GLM calls
    AskUser as one, so GLM's requests list it (decision 2026-10-21)."""
    stream, seen = _script_stream([_assembled(_answer(("Hello", [])))])
    monkeypatch.setattr(agent.models, "stream_agent_response", stream)
    model = ModelConfig(
        version=1,
        provider_name="Z.ai" if provider == "zai" else "DeepSeek",
        model_name="GLM-5.3-Flash" if provider == "zai" else "Flash",
        provider_slug=provider,
        model_slug="glm-5.3-flash" if provider == "zai" else "deepseek-v4-flash",
        thinking_levels=("low", "high", "max"),
        default_thinking="high",
        context_window_tokens=100_000,
        slots=("chat",),
    )
    await _collect("hi", ToolContext(workspace_id="ws_1"), model=model)
    names = [t["function"]["name"] for t in seen[0]["tools"]]
    assert ("AskUser" in names) is offered
    if offered:
        assert names[-1] == "AskUser", "appended, so the cached prefix is unchanged"


@pytest.mark.parametrize("writing", [True, False])
async def test_results_before_the_last_tools_response_say_write_now(
    monkeypatch, writing
):
    """With 4 responses the last has tools off, so the third is the last with
    tools: the results it reads (the second response's) carry the notice, to
    write when the writing skill is in the request, else to answer."""
    second = "read_skill" if writing else "list_sources"
    stream, seen = _script_stream(
        [
            _assembled("", [_call("list_sources", "{}", "a")]),
            _assembled("", [_call(second, '{"name": "editing"}', "b")]),
            _assembled("", [_call("list_sources", "{}", "c")]),
            _assembled(_answer(("done", []))),
        ]
    )
    monkeypatch.setattr(agent.models, "stream_agent_response", stream)
    monkeypatch.setattr(agent.cfg, "agent_max_steps", 4)

    async def _run(name, _args, _ctx):
        if name == "read_skill":
            return ToolResult(text_parts=[skills.render("editing", "instructions")])
        return ToolResult(text_parts=["sources"])

    monkeypatch.setattr(agent.tools, "run", _run)
    await _collect("q", ToolContext(workspace_id="ws_1"))

    def results(call):
        return {
            m["tool_call_id"]: m["content"]
            for m in call["messages"]
            if m.get("role") == "tool"
        }

    notice = agent.LAST_TOOLS_NOTICE if writing else agent.LAST_ANSWER_NOTICE
    assert notice not in results(seen[2])["a"]
    assert results(seen[2])["b"].endswith(notice)
    assert seen[3]["tools_off"]


async def test_tool_rows_name_their_targets_and_carry_their_run_times(monkeypatch):
    stream, _ = _script_stream(
        [
            _assembled(
                "",
                [
                    _call("read_document", '{"file_id":"f_1"}', "r1"),
                    _call("read_knowledge", '{"excerpt_id":"ex_1"}', "k1"),
                    _call(
                        "inspect_document",
                        '{"target":{"kind":"material","id":"m_1"}}',
                        "i1",
                    ),
                    _call("capture_page", '{"file_id":"f_1","page":4}', "c1"),
                ],
            ),
            _assembled("", [_call("write_slide", '{"deck_id":"d1","slide":3}', "w1")]),
            _assembled(_answer(("Done.", []))),
        ]
    )
    lookups: list[list[str]] = []

    async def titles(_workspace, ids):
        lookups.append(ids)
        return {"f_1": "Biology.pdf"}

    async def excerpts(ids):
        return {"ex_1": "Campbell Biology, Chapter 3"}

    async def _run(name, args, ctx):
        return ToolResult(text_parts=["ok"])

    monkeypatch.setattr(agent.models, "stream_agent_response", stream)
    monkeypatch.setattr(agent.tools, "run", _run)
    monkeypatch.setattr(agent.store, "resource_titles", titles)
    monkeypatch.setattr(agent.library, "excerpt_labels", excerpts)
    monkeypatch.setattr(agent.library, "enabled", lambda: True)
    ctx = ToolContext(workspace_id="ws_1", labels={"m_1": "Cell notes"})

    events = await _collect("q", ctx)

    # One lookup for the response's unknown targets; known ones need none.
    assert lookups == [["f_1"]]
    starts = {e["callId"]: e for e in events if e["type"] == "tool_start"}
    assert {k: v["detail"] for k, v in starts.items()} == {
        "r1": "Biology.pdf",
        "k1": "Campbell Biology, Chapter 3",
        "i1": "Cell notes",
        "c1": "page 4",
        "w1": "slide 3",
    }
    ends = {e["callId"]: e for e in events if e["type"] == "tool_end"}
    blocks = {b["callId"]: b for b in events[-1]["activity"] if b["kind"] == "tool"}
    for call_id, start in starts.items():
        block = blocks[call_id]
        assert block["detail"] == start["detail"]
        assert block["startedAt"] == start["startedAt"]
        assert block["endedAt"] == ends[call_id]["endedAt"]
        began = datetime.fromisoformat(block["startedAt"])
        assert began.tzinfo is not None
        assert datetime.fromisoformat(block["endedAt"]) >= began


def test_results_teach_the_rows_their_names():
    ctx = ToolContext(workspace_id="ws_1")
    tools._learn_labels(
        ctx,
        ToolResult(
            passages=[_passage(file_id="f_2", file_name="Physics.pdf")],
            effects=[{"resource": {"id": "m_9", "title": "Forces quiz"}}],
        ),
    )
    assert ctx.labels == {"f_2": "Physics.pdf", "m_9": "Forces quiz"}
    assert (
        agent._describe("trash_file", {"target": {"id": "m_9"}}, ctx) == "Forces quiz"
    )
    assert agent._describe("create_deck", {"title": "x" * 300}, ctx) == "x" * 240


async def test_pending_changes_reach_the_agent_only_for_documents_it_reads(
    monkeypatch,
):
    """Epo 2026-10-20: a file's or note's pending changes go into the request
    only after the agent reads that document, never every turn."""

    def change(after):
        return [
            {
                "id": after,
                "kind": "text",
                "operation": "replace",
                "before": "old",
                "after": after,
            }
        ]

    async def load(*_args, **_kwargs):
        return pending.PendingSources(
            [
                {
                    "fileId": "f_1",
                    "name": "bio.pdf",
                    "epoch": 1,
                    "checkpoint": 2,
                    "indexedCheckpoint": 1,
                    "changes": change("read file edit"),
                },
                {
                    "fileId": "f_2",
                    "name": "chem.pdf",
                    "epoch": 1,
                    "checkpoint": 2,
                    "indexedCheckpoint": 1,
                    "changes": change("unread file edit"),
                },
            ],
            notes=[
                {
                    "materialId": "m_1",
                    "title": "Lecture",
                    "revision": 3,
                    "changes": [
                        {**change("unread note edit")[0], "blockId": "p1", "label": ""}
                    ],
                }
            ],
        )

    async def read_range(**_kwargs):
        return [
            {
                "id": "c1",
                "file_id": "f_1",
                "file_name": "bio.pdf",
                "chunk_idx": 0,
                "text": "Chlorophyll.",
            }
        ]

    stream, seen = _script_stream(
        [
            _assembled("", [_call("read_document", '{"file_id":"f_1"}')]),
            _assembled(_answer(("done", []))),
        ]
    )

    async def no_match(*_args, **_kwargs):
        return []

    monkeypatch.setattr(pending, "load", load)
    monkeypatch.setattr(agent.pending_hints, "match", no_match)
    monkeypatch.setattr(agent.pending_hints, "_indexed_langs", _no_langs)
    monkeypatch.setattr(tools.store, "read_file_range", read_range)
    monkeypatch.setattr(agent.models, "stream_agent_response", stream)
    ctx = ToolContext(workspace_id="ws_1", operations=frozenset({"source.read"}))
    ctx._scope_outline = {
        "chapters": [],
        "files": [
            {"id": "f_1", "name": "bio.pdf", "chapter_id": None, "chunks": 3},
            {"id": "f_2", "name": "chem.pdf", "chapter_id": None, "chunks": 3},
        ],
    }
    await _collect("What changed?", ctx)
    first, second = (call["messages"] for call in seen)
    text = json.dumps(second, ensure_ascii=False)
    assert "file edit" not in json.dumps(first, ensure_ascii=False)
    assert "unread file edit" not in text and "unread note edit" not in text
    # The read's own tool result carries its changes; every earlier message
    # is byte-identical, so the first request stays a cached prefix.
    [result] = [m for m in second if m.get("role") == "tool"]
    assert "read file edit" in result["content"]
    assert second[: len(first) - 1] == first[:-1]  # all but the turn context


def _hinted_sources():
    return pending.PendingSources(
        [
            {
                "fileId": "f_1",
                "name": "bio.pdf",
                "epoch": 1,
                "checkpoint": 2,
                "indexedCheckpoint": 1,
                "changes": [
                    {
                        "id": "c1",
                        "kind": "text",
                        "operation": "replace",
                        "label": "",
                        "before": "old",
                        "after": "mitosis has four phases",
                    }
                ],
            },
        ]
    )


async def _match_all(_query, pool, limit=5):
    return [p.hint for p in pool[:limit]]


async def _no_langs(_doc_ids):
    return {}


async def test_a_user_message_carries_hints_for_matching_unindexed_edits(monkeypatch):
    """Epo 2026-10-20: matching edits follow the user message as short hints
    in a source block, saved with the answer so later turns skip them."""

    async def load(*_args, **_kwargs):
        return _hinted_sources()

    stream, seen = _script_stream([_assembled(_answer(("done", [])))])
    monkeypatch.setattr(pending, "load", load)
    monkeypatch.setattr(agent.pending_hints, "match", _match_all)
    monkeypatch.setattr(agent.pending_hints, "_indexed_langs", _no_langs)
    monkeypatch.setattr(agent.models, "stream_agent_response", stream)
    ctx = ToolContext(workspace_id="ws_1")
    events = await _collect("How many phases does mitosis have?", ctx)
    # Search skips what the message already hinted (review hints-r2 T1).
    assert ctx.hinted == {("f_1", "c1")}
    messages = seen[0]["messages"]
    query = next(i for i, m in enumerate(messages) if m.get("_kind") == "query")
    assert messages[query]["content"] == agent.chat_prompts.with_mode_line(
        "How many phases does mitosis have?", False
    )
    hint = messages[query + 1]
    assert hint["_kind"] == agent.pending_hints.KIND
    assert (
        '"bio.pdf", file_id=f_1: changed "mitosis has four phases"' in hint["content"]
    )
    assert "<source>" in hint["content"]
    # The full change is not passed on before a read.
    assert not any(m.get("_kind") == "pending_sources" for m in messages)
    done = next(e for e in events if e["type"] == "done")
    saved = done["toolEvidence"]["pendingHints"]
    assert [h["changeId"] for h in saved] == ["c1"]

    # The next turn replays the hint and does not hint the same edit again
    # (review S6: fails with the cross-turn skip reverted).
    stream, seen = _script_stream([_assembled(_answer(("done", [])))])
    monkeypatch.setattr(agent.models, "stream_agent_response", stream)
    history = [
        {"id": "u1", "role": "user", "content": "How many phases does mitosis have?"},
        {
            "id": "a1",
            "role": "assistant",
            "content": "Four.",
            "toolEvidence": done["toolEvidence"],
        },
    ]
    later = ToolContext(workspace_id="ws_1")
    events = [
        e
        async for e in agent.run_agent(
            query="And mitosis again?",
            ctx=later,
            history=history,
            model=_model(),
        )
    ]
    kinds = [m.get("_kind") for m in seen[0]["messages"]]
    assert kinds.count(agent.pending_hints.KIND) == 1  # the replayed one only
    # Search skips what earlier turns hinted too (review hints-r3 M6).
    assert later.hinted == {("f_1", "c1")}
    assert kinds.index(agent.pending_hints.KIND) < kinds.index("query")
    done = next(e for e in events if e["type"] == "done")
    assert "pendingHints" not in done["toolEvidence"]


async def test_a_turn_start_checkpoint_keeps_the_turns_hint(monkeypatch):
    """Review hints-r2 T1: the hint message after the query survives the
    checkpoint rebuild."""

    async def fold(**_kwargs):
        return "memory"

    monkeypatch.setattr(agent.compact, "needs_compact", lambda *_a, **_k: True)
    monkeypatch.setattr(agent.compact, "summarize_checkpoint", fold)
    query = {"role": "user", "content": "q", "_kind": "query"}
    hint = {"role": "user", "content": "hints", "_kind": agent.pending_hints.KIND}
    messages, _ = await agent._admit_checkpoint(
        messages=[{"role": "system", "content": "sys"}, query, hint],
        history=[{"id": "u1", "role": "user", "content": "old"}],
        checkpoint=None,
        spec=_model(),
        schemas=[],
        budget=agent.TurnBudget(),
        query_msg=query,
    )
    assert messages[-2:] == [query, hint]


async def test_a_reads_changes_too_large_to_pass_on_are_omitted(monkeypatch):
    """The read gets the notice instead, and the read file is offered Process."""

    async def load(*_args, **_kwargs):
        return pending.PendingSources(
            [
                {
                    "fileId": "f_1",
                    "name": "bio.pdf",
                    "epoch": 1,
                    "checkpoint": 2,
                    "indexedCheckpoint": 1,
                    "changes": [
                        {
                            "id": "c",
                            "kind": "text",
                            "operation": "replace",
                            "before": "old",
                            "after": "huge " * 20_000,
                        }
                    ],
                },
            ]
        )

    async def read_range(**_kwargs):
        return [
            {
                "id": "c1",
                "file_id": "f_1",
                "file_name": "bio.pdf",
                "chunk_idx": 0,
                "text": "x",
            }
        ]

    async def no_match(*_args, **_kwargs):
        return []

    stream, seen = _script_stream(
        [
            _assembled("", [_call("read_document", '{"file_id":"f_1"}')]),
            _assembled(_answer(("done", []))),
        ]
    )
    monkeypatch.setattr(pending, "load", load)
    monkeypatch.setattr(agent.pending_hints, "match", no_match)
    monkeypatch.setattr(agent.pending_hints, "_indexed_langs", _no_langs)
    monkeypatch.setattr(tools.store, "read_file_range", read_range)
    monkeypatch.setattr(agent.models, "stream_agent_response", stream)
    ctx = ToolContext(workspace_id="ws_1", operations=frozenset({"source.read"}))
    ctx._scope_outline = {
        "chapters": [],
        "files": [{"id": "f_1", "name": "bio.pdf", "chapter_id": None, "chunks": 3}],
    }
    events = await _collect("What changed?", ctx)
    [result] = [m for m in seen[1]["messages"] if m.get("role") == "tool"]
    assert pending.READ_OMITTED in result["content"]
    assert "huge" not in result["content"]
    [event] = [e for e in events if e["type"] == "pending_sources"]
    assert event["omitted"] and event["fileIds"] == ["f_1"]


def _changed_file(file_id: str, after: str) -> dict:
    return {
        "fileId": file_id,
        "name": f"{file_id}.pdf",
        "epoch": 1,
        "checkpoint": 2,
        "indexedCheckpoint": 1,
        "changes": [
            {
                "id": f"{file_id}_c",
                "kind": "text",
                "operation": "replace",
                "before": "old",
                "after": after,
            }
        ],
    }


async def test_a_reload_keeps_what_the_turn_read_passed_on_and_omitted(monkeypatch):
    """Review hints-r3 R3: a source edit reloads the pending changes, and the
    turn keeps what it already passed on and offered for Process."""

    async def load(*_args, **_kwargs):
        return pending.PendingSources(
            [
                _changed_file("f_1", "huge " * 20_000),
                _changed_file("f_2", "vast " * 20_000),
                _changed_file("f_3", "small edit to mitosis"),
            ]
        )

    async def read_range(**kwargs):
        if kwargs["file_id"] == "f_2":
            # An edit to another file landed earlier in this response.
            await tools._reload_pending(ctx, "f_9")
        return [
            {
                "id": "c1",
                "file_id": kwargs["file_id"],
                "file_name": "x.pdf",
                "chunk_idx": 0,
                "text": "x",
            }
        ]

    async def no_match(*_args, **_kwargs):
        return []

    def read(file_id: str, call_id: str):
        return _call("read_document", json.dumps({"file_id": file_id}), call_id)

    stream, seen = _script_stream(
        [
            _assembled("", [read("f_1", "r1")]),
            _assembled("", [read("f_3", "r2"), read("f_2", "r3")]),
            _assembled("", [read("f_3", "r4")]),
            _assembled(_answer(("done", []))),
        ]
    )
    monkeypatch.setattr(pending, "load", load)
    monkeypatch.setattr(agent.pending_hints, "match", no_match)
    monkeypatch.setattr(agent.pending_hints, "_indexed_langs", _no_langs)
    monkeypatch.setattr(tools.store, "read_file_range", read_range)
    monkeypatch.setattr(agent.models, "stream_agent_response", stream)
    ctx = ToolContext(workspace_id="ws_1", operations=frozenset({"source.read"}))
    ctx._scope_outline = {
        "chapters": [],
        "files": [
            {"id": f, "name": f"{f}.pdf", "chapter_id": None, "chunks": 3}
            for f in ("f_1", "f_2", "f_3")
        ],
    }
    events = await _collect("What changed?", ctx)

    # (a) No event empties the offer, and (b) the file omitted after the
    # reload is offered with the one before it.
    offers = [e["fileIds"] for e in events if e["type"] == "pending_sources"]
    assert offers == [["f_1"], ["f_1", "f_2"]]
    # (c) A second read of f_3 after the reload appends nothing again.
    results = {
        m["tool_call_id"]: m["content"]
        for m in seen[3]["messages"]
        if m.get("role") == "tool"
    }
    assert "small edit to mitosis" in results["r2"]
    assert "small edit to mitosis" not in results["r4"]
    assert pending.READ_OMITTED in results["r3"]


async def test_a_search_without_passages_lists_its_edits_as_a_hint_tail(monkeypatch):
    """Review hints-r3 R2: the edits are the tool message's _hint_tail, so a
    fold strips them (also fails with agent.py no longer tagging the tail)."""

    async def load(*_args, **_kwargs):
        return pending.PendingSources([_changed_file("f_1", "mitosis has phases")])

    async def search(**_kwargs):
        return []

    calls = 0

    async def match_after_message(_query, pool, limit=5):
        # The user message hints nothing; the search finds the edit.
        nonlocal calls
        calls += 1
        return [] if calls == 1 else [p.hint for p in pool[:limit]]

    stream, seen = _script_stream(
        [
            _assembled("", [_call("search_workspace", '{"query":"mitosis"}', "s1")]),
            _assembled(_answer(("done", []))),
        ]
    )
    monkeypatch.setattr(pending, "load", load)
    monkeypatch.setattr(tools, "search", search)
    monkeypatch.setattr(agent.pending_hints, "match", match_after_message)
    monkeypatch.setattr(agent.pending_hints, "_indexed_langs", _no_langs)
    monkeypatch.setattr(agent.models, "stream_agent_response", stream)
    ctx = ToolContext(workspace_id="ws_1", operations=frozenset({"source.read"}))
    ctx._scope_outline = {
        "chapters": [],
        "files": [{"id": "f_1", "name": "f_1.pdf", "chapter_id": None, "chunks": 3}],
    }
    await _collect("Tell me about it", ctx)
    [message] = [m for m in seen[1]["messages"] if m.get("role") == "tool"]
    tail = message["_hint_tail"]
    assert agent.pending_hints.SEARCH_HEADING in tail and "mitosis has phases" in tail
    assert message["content"].endswith(tail)
    assert agent.pending_hints.for_summary(message)["content"] == (
        "No indexed passages matched."
    )


# ------------------------------------------------------------- Office tools


def _office_ctx(monkeypatch, post=None) -> ToolContext:
    _gateway(monkeypatch, post=post)
    ctx = _owner_ctx()
    ctx.office_tools = True
    ctx.skills_read = {skills.EDITING, skills.OFFICE_BUILDING}
    outline = ctx._scope_outline

    async def _outline(*_args):
        return outline

    # A landed edit drops the turn's cached outline.
    monkeypatch.setattr(tools.store, "workspace_outline", _outline)
    return ctx


def test_the_office_tools_come_last_once_offered(monkeypatch):
    """Offered only once office_building is read, or once an earlier turn of
    the conversation was offered them (the gateway's officeTools), and then
    after every other tool (Epo 2026-10-20)."""
    _gateway(monkeypatch)
    ctx = _owner_ctx()

    def names() -> list[str]:
        return [s["function"]["name"] for s in tools.schemas_for(ctx)]

    before = names()
    assert not set(tools.OFFICE_TOOLS) & set(before)
    ctx.office_tools = True
    assert names() == before + list(tools.OFFICE_TOOLS)


def test_a_viewer_reads_skills_and_office_files_but_edits_nothing(monkeypatch):
    """Every role that can chat reads skills, so a viewer gets the Office read
    tool once office_building is read; editing still needs edit rights."""
    _gateway(monkeypatch)
    ctx = ToolContext(
        workspace_id="ws",
        user_id="u",
        operations=frozenset({"source.read", "material.read"}),
        office_tools=True,
    )
    names = {s["function"]["name"] for s in tools.schemas_for(ctx)}
    assert {"read_skill", "inspect_office_document"} <= names
    assert "edit_office_document" not in names


async def test_reading_office_building_appends_the_office_tools(monkeypatch):
    """The response after the skill read sends the same tools plus the two
    Office tools at the end, and the turn marks its evidence so later turns
    keep them."""
    _gateway(monkeypatch)
    stream, seen = _script_stream(
        [
            _assembled("", [_call("read_skill", '{"name": "office_building"}')]),
            _assembled(_answer(("Read it.", []))),
        ]
    )
    monkeypatch.setattr(agent.models, "stream_agent_response", stream)
    events = await _collect("Fix my spreadsheet", _owner_ctx())
    first, second = ([t["function"]["name"] for t in s["tools"]] for s in seen)
    assert second == first + list(tools.OFFICE_TOOLS)
    assert events[-1]["toolEvidence"]["officeTools"] is True


async def test_an_office_edit_after_office_building_alone_needs_editing(monkeypatch):
    """UAT 2026-10-22: the agent read office_building alone, inspected and
    edited; the write was refused for the editing skill, as every write is.
    office_building now says an edit needs editing too."""
    _gateway(monkeypatch)
    run = agent.tools.run

    async def _run(name, args, ctx):
        if name == "inspect_office_document":
            return ToolResult(text_parts=["[body:paragraph:body:p0] Intro"])
        return await run(name, args, ctx)

    edit = json.dumps(
        {
            "file_id": "f_1",
            "commands": [
                {
                    "type": "set_alignment",
                    "target_id": "body:paragraph:body:p0",
                    "alignment": "center",
                }
            ],
        }
    )
    stream, _seen = _script_stream(
        [
            _assembled("", [_call("read_skill", '{"name": "office_building"}', "c1")]),
            _assembled(
                "", [_call("inspect_office_document", '{"file_id":"f_1"}', "c2")]
            ),
            _assembled("", [_call("edit_office_document", edit, "c3")]),
            _assembled(_answer(("Not edited.", []))),
        ]
    )
    monkeypatch.setattr(agent.models, "stream_agent_response", stream)
    monkeypatch.setattr(agent.tools, "run", _run)
    events = await _collect("Center the intro", _owner_ctx())
    refused = next(e for e in events if e["type"] == "tool_end" and e["callId"] == "c3")
    assert refused["error"]["message"] == skills.refusal([skills.EDITING], write=True)
    assert (
        "Editing or creating one also needs the editing skill"
        in skills.SKILLS[skills.OFFICE_BUILDING].text()
    )


async def test_office_tools_need_the_office_building_skill(monkeypatch):
    ctx = _office_ctx(monkeypatch)
    ctx.skills_read = {skills.EDITING}
    read = await tools.run(
        "inspect_office_document", {"file_id": "f_1", "_tool_call_id": "c1"}, ctx
    )
    edit = await tools.run(
        "edit_office_document",
        {
            "file_id": "f_1",
            "commands": [
                {
                    "type": "replace_text",
                    "target_id": "p1",
                    "expected_text": "a",
                    "text": "b",
                }
            ],
            "_tool_call_id": "c2",
        },
        ctx,
    )
    assert read.error == skills.refusal([skills.OFFICE_BUILDING], write=False)
    assert "this read needs the office_building skill" in read.error
    assert edit.error == skills.refusal([skills.OFFICE_BUILDING], write=True)
    # Nothing counts as read: the skill text never rides on a refusal.
    assert skills.OFFICE_BUILDING not in ctx.skills_read


async def test_inspect_office_document_renders_sheets_cells_and_paragraphs(
    monkeypatch,
):
    bodies = iter(
        [
            {
                "format": "xlsx",
                "title": "grades.xlsx",
                "scoped": {
                    "sheets": [
                        {"id": "0", "name": "Grades", "usedRange": "A1:H2001"},
                        {"id": "1", "name": "Notes", "usedRange": None},
                    ]
                },
            },
            {
                "format": "xlsx",
                "title": "grades.xlsx",
                "scoped": {
                    "sheet": {"id": "0", "name": "Grades", "usedRange": "A1:H2001"},
                    "range": "A1:B2",
                    "cells": [
                        {"address": "A1", "input": "Name", "value": "Name"},
                        {"address": "B2", "input": "=SUM(B3:B9)", "value": "512"},
                    ],
                },
            },
            {
                "format": "docx",
                "title": "essay.docx",
                "scoped": {
                    "paragraphs": [
                        {
                            "id": "body:paragraph:1A",
                            "style": "Heading1",
                            "list": None,
                            "text": "Method",
                        },
                        {
                            "id": "body:paragraph:2B",
                            "style": None,
                            "list": "bullet",
                            "text": "Ruler",
                        },
                        {
                            "id": "body:t0:r0c1:paragraph:3C",
                            "list": None,
                            "table": {
                                "id": "body:t0:r0c0:paragraph:3A",
                                "row": 0,
                                "column": 1,
                            },
                            "text": "Period",
                        },
                        {
                            "id": "body:sdt0:paragraph:4D",
                            "style": None,
                            "list": None,
                            "contentControl": True,
                            "text": "Name",
                        },
                        {
                            "id": "body:paragraph:5E",
                            "style": None,
                            "list": None,
                            "locked": "holds a field",
                            "text": "Page 1",
                        },
                        {
                            "id": "hf:rIdH:paragraph:6F",
                            "style": "Header",
                            "list": None,
                            "part": "header (default)",
                            "text": "Lab 3",
                        },
                    ],
                    "total": 80,
                    "nextStart": 60,
                    "styles": [
                        {"id": "Normal", "name": "Normal"},
                        {"id": "Heading1", "name": "heading 1"},
                    ],
                    "stylesMore": 3,
                },
            },
            {
                "format": "pptx",
                "title": "deck.pptx",
                "scoped": {
                    "width": 960.0,
                    "height": 540.0,
                    "slides": [
                        {
                            "id": "slide:0:256",
                            "number": 1,
                            "layout": "Title Slide",
                            "shapes": [
                                {
                                    "id": "slide:0:256:shape:0",
                                    "kind": "text",
                                    "placeholder": "ctrTitle",
                                    "text": "Cells",
                                },
                                {"id": "slide:0:256:shape:1", "kind": "picture"},
                            ],
                            "moreShapes": 3,
                        }
                    ],
                    "total": 12,
                    "nextStart": 1,
                    "layouts": [
                        {
                            "id": "ppt/slideLayouts/slideLayout1.xml",
                            "name": "Title Slide",
                        },
                        {"id": "ppt/slideLayouts/slideLayout2.xml", "name": "Blank"},
                    ],
                },
            },
            {
                "format": "pptx",
                "title": "deck.pptx",
                "scoped": {
                    "width": 960.0,
                    "height": 540.0,
                    "slide": {
                        "id": "slide:1:257",
                        "number": 2,
                        "layout": {
                            "id": "ppt/slideLayouts/slideLayout2.xml",
                            "name": "Blank",
                        },
                        "notes": "Greet the room.\nThen the demo.",
                    },
                    "slides": 12,
                    "shapes": [
                        {
                            "id": "slide:1:257:shape:0",
                            "kind": "text",
                            "name": "Title 1",
                            "placeholder": "title",
                            "box": [36.0, 20.5, 888.0, 90.0],
                        },
                        {
                            "id": "slide:1:257:shape:1",
                            "kind": "table",
                            "name": "Table 2",
                            "box": [36.0, 120.0, 400.0, 200.0],
                        },
                        {
                            "id": "slide:1:257:shape:2",
                            "kind": "text",
                            "name": "Equation",
                            "equation": True,
                            "box": [36.0, 400.0, 100.0, 30.0],
                        },
                    ],
                    "paragraphs": [
                        {
                            "id": "para:story:slide:1:257:shape:0:0:0",
                            "shape": "slide:1:257:shape:0",
                            "text": "Cells",
                        },
                        {
                            "id": "para:story:slide:1:257:shape:1:table:0:1:0",
                            "shape": "slide:1:257:shape:1",
                            "text": "Nucleus",
                            "level": 1,
                            "row": 0,
                            "column": 1,
                        },
                    ],
                    "total": 6,
                    "nextStart": 5,
                },
            },
        ]
    )
    sent: list[dict] = []

    def _post(url, **kwargs):
        sent.append(json.loads(kwargs["data"]))
        return _JsonResp(next(bodies))

    ctx = _office_ctx(monkeypatch, post=_post)
    ctx.pending_sources.read_ids = set()

    def inspect(**args):
        return tools.run(
            "inspect_office_document",
            {"file_id": "f_1", **args, "_tool_call_id": "c"},
            ctx,
        )

    sheets = await inspect()
    assert sheets.text() == (
        "grades.xlsx format=xlsx\nsheets as [id] name used range:\n"
        + source_block("[0] Grades A1:H2001\n[1] Notes empty")
    )
    assert sent[0]["office"] == {} and sent[0]["target"] == {
        "kind": "source_file",
        "id": "f_1",
    }
    # Reading a file delivers its pending changes (Epo 2026-10-20).
    assert ctx.pending_sources.read_ids == {"f_1"}
    cells = await inspect(sheet="Grades", range="A1:B2")
    assert cells.text().endswith(source_block("A1: Name\nB2: =SUM(B3:B9) → 512"))
    assert sent[1]["office"] == {"sheet": "Grades", "range": "A1:B2"}
    # A DOCX page is the engine's scoped read, its first page listing the
    # paragraph styles, at most 50 and a count of the rest (Epo 2026-10-21).
    paragraphs = (await inspect(start=0, count=60)).text()
    assert paragraphs == "\n".join(
        [
            "essay.docx format=docx",
            (
                "paragraphs as [id] (style unless the default, list, table cell, "
                "content control, locked: why replace_text and format_text refuse "
                "it, and delete_paragraph unless it only follows a table) text; after "
                "the body, headers, footers and notes under == part == lines, which "
                "take replace_text only; a command names a paragraph by its whole "
                "[id], copied exactly:"
            ),
            source_block(
                "paragraph styles as id (name): Normal (Normal), Heading1 (heading 1)"
                " and 3 more\n"
                "[body:paragraph:1A] (Heading1) Method\n"
                "[body:paragraph:2B] (bullet) Ruler\n"
                "[body:t0:r0c1:paragraph:3C] (table "
                "body:t0:r0c0:paragraph:3A row 1 column 2) Period\n"
                "[body:sdt0:paragraph:4D] (content control) Name\n"
                "[body:paragraph:5E] (locked: holds a field) Page 1\n"
                "== header (default) ==\n"
                "[hf:rIdH:paragraph:6F] (Header) Lab 3"
            ),
            "(next start = 60 of 80)",
        ]
    )
    assert sent[2]["office"] == {"start": 0, "count": 60}
    # A PPTX read lists slides with their layouts and shapes, the first page
    # the deck's layouts; a slide read its shapes and paragraphs (Epo
    # 2026-10-20). What the file names sits inside the fence.
    deck = (await inspect(count=1)).text()
    assert deck == "\n".join(
        [
            "deck.pptx format=pptx",
            (
                "slide size 960 x 540 points; slides as N. [id] (layout), each shape as "
                "[id] kind (placeholder): its first line of text (… when longer); read "
                "one slide by its number for all its shapes and its paragraphs:"
            ),
            # A read holding a picture or chart says how they show (Q240).
            tools.OFFICE_OBJECTS_HEAD.strip() + ":",
            source_block(
                "layouts as [id] name: [ppt/slideLayouts/slideLayout1.xml] Title Slide, "
                "[ppt/slideLayouts/slideLayout2.xml] Blank\n"
                "1. [slide:0:256] (Title Slide)\n"
                "  [slide:0:256:shape:0] text (ctrTitle placeholder): Cells\n"
                "  [slide:0:256:shape:1] picture\n"
                "  … and 3 more shapes"
            ),
            "(next start = 1 of 12 slides)",
        ]
    )
    slide = (await inspect(slide=2)).text()
    assert sent[4]["office"] == {"slide": 2}
    assert slide == "\n".join(
        [
            "deck.pptx format=pptx",
            (
                'slide size 960 x 540 points; shapes as [id] kind "name" (marks) at x, y '
                "size w x h points from the top left corner (shapes in a group show no "
                "box), each followed by its paragraphs as [id] (level, table cell) text; "
                "a page counts shapes and paragraphs:"
            ),
            source_block(
                "slide 2 of 12 [slide:1:257], layout "
                "[ppt/slideLayouts/slideLayout2.xml] Blank\n"
                "speaker notes:\nGreet the room.\nThen the demo.\n"
                '[slide:1:257:shape:0] text "Title 1" (title placeholder) at 36, 20.5 '
                "size 888 x 90\n"
                "  [para:story:slide:1:257:shape:0:0:0] Cells\n"
                '[slide:1:257:shape:1] table "Table 2" at 36, 120 size 400 x 200\n'
                "  [para:story:slide:1:257:shape:1:table:0:1:0] (level 1, row 1 column 2) "
                "Nucleus\n"
                '[slide:1:257:shape:2] text "Equation" (equation, not editable) at 36, '
                "400 size 100 x 30"
            ),
            "(next start = 5 of 6 shapes and paragraphs)",
        ]
    )


_PHOTO = {
    "id": "slide:0:256:shape:1",
    "kind": "picture",
    "alt": "A red square",
    "pixels": [64, 32],
    "viewable": True,
    "crop": {"left": 0.1, "top": 0.0, "right": 0.0, "bottom": 0.0},
}
_LOGO = {
    "id": "slide:0:256:shape:2",
    "kind": "picture",
    "alt": "Company logo",
    "viewable": False,
    "reason": "an EMF or WMF drawing",
}
_CHART = {
    "id": "slide:0:256:shape:3",
    "kind": "chart",
    "chartType": "column",
    "title": "Monthly sales",
    "series": [
        {
            "name": "Revenue",
            "refs": {"values": "Sheet1!$B$2:$B$21"},
            "count": 20,
            "points": [[0, "M0", 0], [2, "M2", "#N/A"]],
            "more": 18,
        }
    ],
}


async def test_office_reads_list_pictures_charts_equations_and_drawings(monkeypatch):
    """A read shows each picture's alt text and size or why it is not
    viewable, each chart's type, title and series' first points, and an
    equation's or drawn shape's text, explaining them once in its head
    (Epo 2026-10-24, Q240, Q280, Q284)."""
    bodies = iter(
        [
            {
                "format": "docx",
                "title": "plan.docx",
                "scoped": {
                    "paragraphs": [
                        {
                            "id": "body:paragraph:1A",
                            "locked": "holds a picture",
                            "text": "",
                            "objects": [
                                {**_PHOTO, "id": "body:picture:1.4"},
                                {"kind": "equation", "text": "x=2"},
                                {"kind": "drawing", "text": "Arrow label"},
                            ],
                            "moreObjects": 2,
                        }
                    ],
                    "total": 1,
                },
            },
            {
                "format": "pptx",
                "title": "deck.pptx",
                "scoped": {
                    "width": 960.0,
                    "height": 540.0,
                    "slide": {"id": "slide:0:256", "number": 1},
                    "slides": 1,
                    "shapes": [
                        {**_PHOTO, "name": "Photo", "box": [0, 0, 100, 50]},
                        {**_LOGO, "name": "Logo", "box": [0, 60, 100, 50]},
                        {**_CHART, "name": "Chart", "box": [0, 120, 400, 300]},
                    ],
                    "paragraphs": [],
                    "total": 3,
                },
            },
            {
                "format": "pptx",
                "title": "deck.pptx",
                "scoped": {
                    "width": 960.0,
                    "height": 540.0,
                    "slides": [
                        {
                            "id": "slide:0:256",
                            "number": 1,
                            "layout": "Blank",
                            "shapes": [
                                {**_LOGO},
                                {
                                    "id": _CHART["id"],
                                    "kind": "chart",
                                    "chartType": "column",
                                    "title": "Monthly sales",
                                },
                            ],
                        }
                    ],
                    "total": 1,
                },
            },
            {
                "format": "xlsx",
                "title": "book.xlsx",
                "scoped": {
                    "sheets": [
                        {
                            "id": "0",
                            "name": "Sales",
                            "usedRange": "A1:B21",
                            "objects": [
                                {
                                    **_PHOTO,
                                    "id": "xl/drawings/drawing1.xml#0:0",
                                    "cell": "D2",
                                },
                                {"kind": "drawing", "text": "Check Q2", "cell": "I11"},
                            ],
                            "notice": "Skipped xl/drawings/drawing2.xml: it does not read.",
                        }
                    ]
                },
            },
        ]
    )
    ctx = _office_ctx(monkeypatch, post=lambda url, **_: _JsonResp(next(bodies)))

    async def read(**args):
        return (
            await tools.run(
                "inspect_office_document",
                {"file_id": "f_1", **args, "_tool_call_id": "c"},
                ctx,
            )
        ).text()

    photo = 'alt "A red square", 64 x 32 px, cropped'
    logo = 'alt "Company logo", not viewable: an EMF or WMF drawing'
    docx = await read()
    assert tools.OFFICE_OBJECTS_HEAD.strip() + ":" in docx
    assert (
        source_block(
            "[body:paragraph:1A] (locked: holds a picture) \n"
            f"  [body:picture:1.4] picture {photo}\n"
            "  equation: x=2\n"
            "  drawing: Arrow label\n"
            "  … and 2 more objects"
        )
        in docx
    )
    slide = await read(slide=1)
    assert tools.OFFICE_OBJECTS_HEAD.strip() + ":" in slide
    assert (
        f'[slide:0:256:shape:1] picture "Photo" at 0, 0 size 100 x 50; {photo}\n'
        f'[slide:0:256:shape:2] picture "Logo" at 0, 60 size 100 x 50; {logo}\n'
        '[slide:0:256:shape:3] chart "Chart" at 0, 120 size 400 x 300; column '
        '"Monthly sales"\n'
        '  series "Revenue" (values Sheet1!$B$2:$B$21), 20 points: '
        '[[0,"M0",0],[2,"M2","#N/A"]] … 18 more'
    ) in slide
    listed = await read()
    assert (
        f"  [slide:0:256:shape:2] picture {logo}\n"
        '  [slide:0:256:shape:3] chart column "Monthly sales"'
    ) in listed
    sheets = await read()
    assert "each followed by its pictures, charts and drawn shapes" in sheets
    assert (
        source_block(
            "[0] Sales A1:B21\n"
            f"  [xl/drawings/drawing1.xml#0:0] picture at D2 {photo}\n"
            "  drawing at I11: Check Q2\n"
            "  Skipped xl/drawings/drawing2.xml: it does not read."
        )
        in sheets
    )


def _png64(width: int, height: int) -> str:
    buffer = io.BytesIO()
    Image.new("RGB", (width, height), (255, 0, 0)).save(buffer, "PNG")
    return base64.b64encode(buffer.getvalue()).decode()


def _ids_ctx(monkeypatch, items, notice=None):
    sent: list[dict] = []
    scoped = {"items": items} | ({"notice": notice} if notice else {})

    def _post(url, **kwargs):
        sent.append(json.loads(kwargs["data"]))
        return _JsonResp({"format": "pptx", "title": "deck.pptx", "scoped": scoped})

    return _office_ctx(monkeypatch, post=_post), sent


async def test_office_ids_attach_each_picture_and_give_charts_every_point(
    monkeypatch,
):
    """A by-id read (Q278, Q284): each viewable picture its own image on the
    next request, counted toward the message's images, kept by the image
    budget and usable as a deck figure by the capture number its line names;
    a not-viewable one its alt text and why; a chart every point; the notice
    before the fenced items."""
    ids = [_PHOTO["id"], "slide:0:256:shape:4", _LOGO["id"], _CHART["id"]]
    items = [
        {**_PHOTO, "mimeType": "image/png", "data": _png64(64, 32)},
        {**_PHOTO, "id": ids[1], "crop": None, "data": _png64(10, 10)},
        _LOGO,
        {**_CHART, "series": [{**_CHART["series"][0], "more": None, "cut": 3}]},
    ]
    ctx, sent = _ids_ctx(monkeypatch, items, notice="Not found: slide:9 is gone.")
    result = await tools.run(
        "inspect_office_document",
        {"file_id": "f_1", "ids": ids, "_tool_call_id": "c"},
        ctx,
    )
    assert sent[0]["office"] == {"ids": ids}
    text = result.text()
    assert text.index("Not found: slide:9 is gone.") < text.index("<source>")
    assert (
        f'[{ids[0]}] picture alt "A red square", 64 x 32 px, cropped; attached as capture 1'
        in text
    )
    assert (
        f'[{ids[1]}] picture alt "A red square", 64 x 32 px; attached as capture 2'
        in text
    )
    assert (
        f'[{ids[2]}] picture alt "Company logo", not viewable: an EMF or WMF drawing\n'
        in text
    )
    assert '[[0,"M0",0],[2,"M2","#N/A"]] … 3 not sent' in text
    assert list(ctx.pending_images) == ["c#1", "c#2"]
    assert ctx.budget_images == {"c#1", "c#2"} and ctx.images_taken == 2
    first, second = ctx.captures
    assert (first["picture"], first["page"], first["bbox"]) == (
        ids[0],
        None,
        [100, 0, 1000, 1000],
    )
    assert second["pixels"] == [10, 10]
    assert (
        ctx.pending_images["c#1"][0]
        == f"inspect_office_document result 1: deck.pptx picture {ids[0]}"
    )
    problems, figures, _ = deck.turn_figures(ctx.captures, ctx.pending_images)
    assert problems == {1: "", 2: ""} and set(figures) == {1, 2}


async def test_a_picture_the_engine_calls_not_viewable_is_never_decoded(monkeypatch):
    """Security regression (Q280, Q381): the AI process decodes only what the
    engine marks viewable, so bytes on a not-viewable item never reach Pillow."""

    def decode(*_args):
        raise AssertionError("decoded a picture the engine calls not viewable")

    monkeypatch.setattr(tools.capture, "picture_jpeg", decode)
    ctx, _ = _ids_ctx(monkeypatch, [{**_LOGO, "data": _png64(4, 4)}])
    result = await tools.run(
        "inspect_office_document",
        {"file_id": "f_1", "ids": [_LOGO["id"]], "_tool_call_id": "c"},
        ctx,
    )
    assert "not viewable: an EMF or WMF drawing" in result.text()
    assert not ctx.pending_images and not ctx.captures and ctx.images_taken == 0


async def test_office_pictures_past_the_message_image_limit_are_not_attached(
    monkeypatch,
):
    """Pictures share the message's 16 images with page captures: the one
    that fills them is attached and the result says the limit is reached; the
    next is named as not attached."""
    items = [
        {**_PHOTO, "data": _png64(8, 8)},
        {**_PHOTO, "id": "slide:0:256:shape:9", "data": _png64(8, 8)},
    ]
    ctx, _ = _ids_ctx(monkeypatch, items)
    ctx.images_taken = tools.MAX_IMAGES - 1
    text = (
        await tools.run(
            "inspect_office_document",
            {"file_id": "f_1", "ids": [i["id"] for i in items], "_tool_call_id": "c"},
            ctx,
        )
    ).text()
    assert "; attached as capture 1" in text
    assert "[slide:0:256:shape:9] picture" in text
    assert "not attached: this message's image limit is reached" in text
    assert text.endswith(tools.PICTURE_LIMIT)
    assert list(ctx.pending_images) == ["c#1"]
    assert ctx.images_taken == tools.MAX_IMAGES


async def test_a_long_pptx_read_shows_the_slides_that_fit_and_where_to_go_on(
    monkeypatch,
):
    """A deck page over the tool output limit is cut between slides, its next
    start the first slide not shown."""
    slides = [
        {
            "id": f"slide:{i}:{256 + i}",
            "number": i + 1,
            "layout": "Title and Content",
            "shapes": [
                {
                    "id": f"slide:{i}:{256 + i}:shape:{j}",
                    "kind": "text",
                    "text": "word " * 16,
                }
                for j in range(12)
            ],
        }
        for i in range(60)
    ]
    body = {
        "format": "pptx",
        "title": "deck.pptx",
        "scoped": {"width": 720.0, "height": 540.0, "slides": slides, "total": 60},
    }
    ctx = _office_ctx(monkeypatch, post=lambda url, **_: _JsonResp(body))
    text = (
        await tools.run(
            "inspect_office_document",
            {"file_id": "f_1", "count": 60, "_tool_call_id": "c"},
            ctx,
        )
    ).text()
    assert estimate_tokens(text) <= tools.TOOL_RESULT_MAX_TOKENS
    shown = re.findall(r"^(\d+)\. \[slide:", text, re.MULTILINE)
    assert 0 < len(shown) < 60 and shown == [str(i + 1) for i in range(len(shown))]
    assert text.endswith(
        "</source>\n(page cut at the tool output limit; "
        f"next start = {len(shown)} of 60 slides)"
    )


async def test_a_long_slide_read_shows_the_shapes_that_fit_and_where_to_go_on(
    monkeypatch,
):
    """A slide page over the tool output limit, its notes at the cap, is cut
    between its shapes and paragraphs, its next start the first not shown; a
    page that begins inside a shape names the shape its first paragraphs
    continue (review M1)."""
    shapes = [
        {"id": f"s:{i}", "kind": "text", "name": "Box " * 10, "box": [0, 0, 72, 36]}
        for i in range(1, 100)
    ]
    paragraphs = [{"id": "p:0:0", "shape": "s:0", "text": "word " * 400}] + [
        {"id": f"p:{i}:0", "shape": f"s:{i}", "text": "word " * 400}
        for i in range(1, 100)
    ]
    body = {
        "format": "pptx",
        "title": "deck.pptx",
        "scoped": {
            "width": 720.0,
            "height": 540.0,
            # Notes at the cap and its marker (Epo 2026-10-22).
            "slide": {
                "id": "slide:0:256",
                "number": 1,
                "notes": "n" * 2_000 + "… [notes cut: 9 more characters]",
            },
            "slides": 1,
            "shapes": shapes,
            "paragraphs": paragraphs,
            "total": 1201,
            "nextStart": 600,
        },
    }
    ctx = _office_ctx(monkeypatch, post=lambda url, **_: _JsonResp(body))
    text = (
        await tools.run(
            "inspect_office_document",
            {
                "file_id": "f_1",
                "slide": 1,
                "start": 401,
                "count": 199,
                "_tool_call_id": "c",
            },
            ctx,
        )
    ).text()
    assert estimate_tokens(text) <= tools.TOOL_RESULT_MAX_TOKENS
    assert "slide 1 of 1 [slide:0:256]\nspeaker notes:\nnnn" in text
    assert "… [notes cut: 9 more characters]\n[s:0] continued:\n  [p:0:0] word" in text
    shown = len(re.findall(r"^\[s:\d+\] text|^  \[p:", text, re.MULTILINE))
    assert 0 < shown < 199
    assert text.endswith(
        "</source>\n(slide cut at the tool output limit; "
        f"next start = {401 + shown} of 1201 shapes and paragraphs)"
    )


async def test_a_long_docx_read_shows_the_paragraphs_that_fit_and_where_to_go_on(
    monkeypatch,
):
    """A page over the tool output limit keeps its styles (first, inside the
    source fence) and is cut between paragraphs, its next start the first
    paragraph not shown."""
    paragraphs = [
        {"id": f"body:paragraph:{i}", "text": f"{i} " + "word " * 400}
        for i in range(60)
    ]
    body = {
        "format": "docx",
        "title": "essay.docx",
        "scoped": {
            "paragraphs": paragraphs,
            "total": 300,
            "nextStart": 65,
            "styles": [{"id": "Normal", "name": "Normal"}],
        },
    }
    ctx = _office_ctx(monkeypatch, post=lambda url, **_: _JsonResp(body))
    text = (
        await tools.run(
            "inspect_office_document",
            {"file_id": "f_1", "start": 5, "count": 60, "_tool_call_id": "c"},
            ctx,
        )
    ).text()
    assert estimate_tokens(text) <= tools.TOOL_RESULT_MAX_TOKENS
    assert "<source>\nparagraph styles as id (name): Normal (Normal)\n" in text
    shown = re.findall(r"^\[body:paragraph:(\d+)\]", text, re.MULTILINE)
    assert 0 < len(shown) < 60 and shown == [str(i) for i in range(len(shown))]
    assert text.endswith(
        "</source>\n(page cut at the tool output limit; "
        f"next start = {5 + len(shown)} of 300)"
    )


async def test_an_office_edit_over_256_kb_is_refused_before_it_leaves(monkeypatch):
    posts: list[str] = []
    ctx = _office_ctx(monkeypatch, post=lambda url, **_: posts.append(url))
    grid = [["x" * 1000] * 10] * 30
    command = {
        "type": "set_range",
        "sheet": "Grades",
        "range": "A1:J30",
        "expected": [[""] * 10] * 30,
        "values": grid,
    }
    size = len(json.dumps([command], separators=(",", ":")))
    result = await tools.run(
        "edit_office_document",
        {"file_id": "f_1", "commands": [command], "_tool_call_id": "c1"},
        ctx,
    )
    assert result.error_code == "invalid_input" and posts == []
    assert result.error == (
        f"The commands are {-(-size // 1024)} KB, over the 256 KB one call may send; "
        "split the edit into several calls."
    )


def test_a_stale_office_band_shows_its_grid_to_copy():
    """A refused row or column delete shows the band as rows of cells, exact
    for cells holding tabs or line breaks, and says when the engine cut it
    (Epo 2026-10-20, review finding 6)."""
    block = {
        "id": "Grades!3:4",
        "type": "range",
        "text": "a\nb\tx\ty",
        "grid": [["a\nb", "x\ty"], [], ["Zoë"]],
    }
    assert tools._missed_target({"block": block}, {}, office=True) == (
        "Range Grades!3:4 now holds, as rows of cells:\n"
        + r'[["a\nb","x\ty"],[],["Zoë"]]'
    )
    cut = tools._missed_target({"block": {**block, "gridCut": True}}, {}, office=True)
    assert cut.endswith(
        " … (its first 2,000 cells; inspect_office_document reads the rest)"
    )
    # A refused table delete shows the table's cells the same way.
    table = {
        "id": "body:t0:r0c0:paragraph:3A",
        "type": "table",
        "text": "a\tb",
        "grid": [["a", "b"]],
    }
    assert tools._missed_target({"block": table}, {}, office=True) == (
        'Table body:t0:r0c0:paragraph:3A now holds, as rows of cells:\n[["a","b"]]'
    )


async def test_office_edits_and_creates_reach_their_routes(monkeypatch):
    """An edit goes to the edit route marked office, a stale range comes back as
    its TSV, and a create sends the call's other commands to the create route."""
    answers = iter(
        [
            _JsonResp(_receipt("edited", "source_file", "f_1")),
            _JsonResp(
                {
                    "code": "stale_target",
                    "message": "the range changed",
                    "details": {
                        "block": {
                            "id": "Grades!A1:B2",
                            "type": "range",
                            "text": "Ann\t91\nBo\t78",
                        }
                    },
                },
                status=409,
            ),
            _JsonResp(
                {
                    "operationId": "op_c",
                    "outcome": "succeeded",
                    "effect": {
                        "operation": "created",
                        "resource": {
                            "kind": "source_file",
                            "id": "f_new",
                            "title": "Grades.xlsx",
                        },
                    },
                }
            ),
        ]
    )
    sent: list[tuple[str, dict]] = []

    def _post(url, **kwargs):
        sent.append((url, json.loads(kwargs["data"])))
        return next(answers)

    ctx = _office_ctx(monkeypatch, post=_post)
    write = {
        "type": "set_range",
        "sheet": "Grades",
        "range": "A1:B2",
        "expected": [["Ann", "91"], ["Bo", "78"]],
        "values": [["Ann", "93"], ["Bo", "78"]],
    }

    def edit(call, **args):
        return tools.run("edit_office_document", {**args, "_tool_call_id": call}, ctx)

    assert (await edit("c1", file_id="f_1", commands=[write])).outcome == "succeeded"
    url, body = sent[0]
    assert url.endswith("/api/internal/documents/edit") and body["office"] is True
    assert body["target"] == {"kind": "source_file", "id": "f_1"} and body[
        "commands"
    ] == [write]

    stale = await edit("c2", file_id="f_1", commands=[write])
    assert stale.error_code == "stale_target"
    assert stale.text().endswith(
        source_block("Range Grades!A1:B2 now holds, as TSV:\nAnn\t91\nBo\t78")
    )

    create = {"type": "create", "format": "xlsx", "title": "Grades"}
    created = await edit("c3", commands=[create, write])
    url, body = sent[2]
    assert url.endswith("/api/internal/documents/office/create")
    assert (body["format"], body["title"], body["commands"]) == (
        "xlsx",
        "Grades",
        [write],
    )
    assert "Created file 'Grades.xlsx' (id f_new)." in created.text()


def _office_edit(rid: str) -> dict:
    return {
        "operation": "edited",
        "operationId": f"op_{rid}",
        "resource": {"kind": "source_file", "id": rid, "title": f"{rid}.xlsx"},
    }


def _office_turn(monkeypatch, results: dict[str, ToolResult], files: list[str]):
    """A turn of one edit_office_document call per response, on these files,
    each answered by its call id's result, then an answer."""
    stream, _ = _script_stream(
        [
            _assembled(
                "",
                [_call("edit_office_document", json.dumps({"file_id": f}), f"c{n}")],
            )
            for n, f in enumerate(files, 1)
        ]
        + [_assembled(_answer(("Done.", [])))]
    )

    async def _run(_name, args, _ctx):
        return results[args["_tool_call_id"]]

    monkeypatch.setattr(agent.models, "stream_agent_response", stream)
    monkeypatch.setattr(agent.tools, "run", _run)


def _frames(events: list[dict]) -> list[tuple]:
    return [
        (e["type"], e["callId"], e.get("applied"), e.get("total"))
        for e in events
        if e["type"] in ("tool_start", "tool_progress", "tool_end")
    ]


async def test_a_cut_office_edit_stays_open_until_the_next_edit_of_its_file(
    monkeypatch,
):
    """Epo 2026-10-23, Q171: the cut call's row stays in progress, applied of
    total, and closes as done after the next landed edit of the same file; an
    edit of another file in between leaves it open."""
    cut = ToolResult(
        text_parts=["Edited."], effects=[_office_edit("f_1")], progress=(30, 32)
    )
    _office_turn(
        monkeypatch,
        {
            "c1": cut,
            "c2": ToolResult(effects=[_office_edit("f_2")]),
            "c3": ToolResult(refused=True, error="stale", error_code="stale_target"),
            "c4": ToolResult(effects=[_office_edit("f_1")]),
        },
        ["f_1", "f_2", "f_1", "f_1"],
    )
    # As the SSE writer serializes them, at once.
    events = [
        json.loads(json.dumps(e))
        async for e in agent.run_agent(
            query="q", ctx=_build_ctx(), history=None, model=_model()
        )
    ]

    assert _frames(events) == [
        ("tool_start", "c1", None, None),
        ("tool_progress", "c1", 30, 32),
        ("tool_start", "c2", None, None),
        ("tool_end", "c2", None, None),
        ("tool_start", "c3", None, None),
        ("tool_end", "c3", None, None),
        ("tool_start", "c4", None, None),
        ("tool_end", "c4", None, None),
        ("tool_end", "c1", None, None),
    ]
    closed = [e for e in events if e["type"] == "tool_end" and e["callId"] == "c1"]
    assert closed[0]["outcome"] == "succeeded" and closed[0]["effects"] == [
        _office_edit("f_1")
    ]
    # A checkpoint before the follow-up keeps the counts; the turn's record
    # ends as a plain edit.
    checkpoint = next(e for e in events if e["type"] == "turn_checkpoint")
    assert (
        checkpoint["activity"][0]["applied"],
        checkpoint["activity"][0]["total"],
    ) == (
        30,
        32,
    )
    first = events[-1]["activity"][0]
    assert first["callId"] == "c1" and first["outcome"] == "succeeded"
    assert "applied" not in first and "total" not in first


async def test_a_turn_ending_with_commands_unapplied_closes_the_row_with_them(
    monkeypatch,
):
    cut = ToolResult(effects=[_office_edit("f_1")], progress=(30, 32))
    _office_turn(monkeypatch, {"c1": cut}, ["f_1"])
    events = await _collect("q", _build_ctx())

    assert _frames(events) == [
        ("tool_start", "c1", None, None),
        ("tool_progress", "c1", 30, 32),
        ("tool_end", "c1", 30, 32),
    ]
    assert events[-1]["type"] == "done"
    block = events[-1]["activity"][0]
    assert (block["outcome"], block["applied"], block["total"]) == ("succeeded", 30, 32)


async def test_an_office_edit_reads_what_the_engine_left_unapplied(monkeypatch):
    """The engine alone counts the limits (Epo 2026-10-22): its notice's first
    unapplied index is how many commands it applied, a create counting."""
    notices = iter(
        [
            (
                "Not applied: the commands at indexes 30 to 31 (counting from 0), "
                "past the limit of 30 formatted spans a call; send them in another call."
            ),
            (
                "Not applied: the command at index 50 (counting from 0), past the "
                "limit of 50 commands a call; send them in another call."
            ),
            "",
        ]
    )

    def _post(url, **_kwargs):
        body = _receipt(
            "created" if url.endswith("/create") else "edited", "source_file", "f_1"
        )
        body["notice"] = next(notices)
        return _JsonResp(body)

    ctx = _office_ctx(monkeypatch, post=_post)
    span = {"type": "format_text", "target_id": "p1", "text": "a", "bold": True}

    def edit(call, **args):
        return tools.run("edit_office_document", {**args, "_tool_call_id": call}, ctx)

    edited = await edit("c1", file_id="f_1", commands=[span] * 32)
    assert edited.progress == (30, 32)
    create = {"type": "create", "format": "docx", "title": "Notes"}
    created = await edit("c2", commands=[create] + [span] * 50)
    assert created.progress == (50, 51)
    assert (await edit("c3", file_id="f_1", commands=[span])).progress is None
