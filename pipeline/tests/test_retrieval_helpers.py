"""Offline unit tests for pure retrieval logic (no network, no database).

Covers the parts that decide what the agent is *allowed* to see and how a
passage becomes a citation — the places where a silent regression would look
like a quality problem rather than a bug.
"""

from __future__ import annotations

import pytest

from pipeline.prompts import curate as curate_prompts
from pipeline.registry import ModelConfig
from pipeline.retrieval import contract, library, models, tools, workflows
from pipeline.retrieval.search import Passage, _cap_per_file, _mark_tier_only, search
from pipeline.retrieval.tools import ToolContext


def _passage(chunk_id: str, file_id: str = "f_1", **kwargs) -> Passage:
    return Passage(
        chunk_id=chunk_id,
        file_id=file_id,
        file_name=kwargs.pop("file_name", "bio.pdf"),
        chunk_idx=kwargs.pop("chunk_idx", 0),
        section_path=kwargs.pop("section_path", ""),
        text=kwargs.pop("text", "body"),
        hit_text=kwargs.pop("hit_text", "body"),
        **kwargs,
    )


# ------------------------------------------------------------------- scoping


async def test_unscoped_context_resolves_to_every_workspace_file():
    ctx = ToolContext(workspace_id="ws_1")
    ctx._scope_outline = {
        "chapters": [],
        "files": [
            {"id": "f_1", "name": "one", "chapter_id": None, "chunks": 1},
            {"id": "f_2", "name": "two", "chapter_id": None, "chunks": 1},
        ],
    }

    resolved = await tools._resolve_scope(ctx, tools._MISSING)

    assert isinstance(resolved, tools.ResolvedScope)
    assert resolved.file_ids == ["f_1", "f_2"]


async def test_agent_cannot_widen_a_scope_the_user_narrowed():
    ctx = ToolContext(workspace_id="ws_1", file_ids=["f_1", "f_2"])
    ctx._scope_outline = {
        "chapters": [],
        "files": [
            {"id": "f_1", "name": "one", "chapter_id": None, "chunks": 1},
            {"id": "f_2", "name": "two", "chapter_id": None, "chunks": 1},
            {"id": "f_99", "name": "other", "chapter_id": None, "chunks": 1},
        ],
    }

    resolved = await tools._resolve_scope(ctx, {"file_ids": ["f_2", "f_99"]})

    assert isinstance(resolved, tools.ToolResult)
    assert resolved.refused


async def test_fully_out_of_scope_request_is_rejected_not_widened():
    ctx = ToolContext(workspace_id="ws_1", file_ids=["f_1"])
    ctx._scope_outline = {
        "chapters": [],
        "files": [
            {"id": "f_1", "name": "one", "chapter_id": None, "chunks": 1},
            {"id": "f_99", "name": "other", "chapter_id": None, "chunks": 1},
        ],
    }

    resolved = await tools._resolve_scope(ctx, {"file_ids": ["f_99"]})

    assert isinstance(resolved, tools.ToolResult)
    assert resolved.refused


_READ = frozenset({"source.read", "material.read"})
_EDITOR = _READ | {"material.create", "document.edit", "resource.trash"}


def test_material_tool_is_hidden_without_a_gateway(monkeypatch):
    monkeypatch.setattr(tools.cfg, "gateway_url", "")
    monkeypatch.setattr(tools.cfg, "pipeline_secret", "")
    names = [
        s["function"]["name"]
        for s in tools.schemas_for(ToolContext(workspace_id="ws", operations=_EDITOR))
    ]

    assert "create_material" not in names
    assert "search_workspace" in names


def test_material_tool_needs_the_create_operation(monkeypatch):
    monkeypatch.setattr(tools.cfg, "gateway_url", "http://gateway")
    monkeypatch.setattr(tools.cfg, "pipeline_secret", "secret")
    ctx = ToolContext(workspace_id="ws", user_id="u_1", operations=_READ)

    assert "create_material" not in [
        s["function"]["name"] for s in tools.schemas_for(ctx)
    ]
    ctx.operations = _EDITOR
    assert "create_material" in [s["function"]["name"] for s in tools.schemas_for(ctx)]
    ctx.user_id = ""
    assert "create_material" not in [
        s["function"]["name"] for s in tools.schemas_for(ctx)
    ]


def test_read_tools_need_the_read_operation():
    assert tools.schemas_for(ToolContext(workspace_id="ws")) == []


async def test_dispatch_rechecks_operations_and_validates_arguments(monkeypatch):
    monkeypatch.setattr(tools.cfg, "gateway_url", "http://gateway")
    monkeypatch.setattr(tools.cfg, "pipeline_secret", "secret")
    viewer = ToolContext(workspace_id="ws", user_id="u_1", operations=_READ)

    refused = await tools.run("create_material", {"kind": "note"}, viewer)
    assert refused.refused and refused.error_code == "lifecycle_rejected"

    editor = ToolContext(workspace_id="ws", user_id="u_1", operations=_EDITOR)
    invalid = await tools.run("create_material", {"kind": "poem"}, editor)
    assert invalid.refused and invalid.error_code == "invalid_input"
    extra = await tools.run("search_workspace", {"query": "x", "bogus": 1}, editor)
    assert extra.refused and "bogus" in extra.text()
    unknown = await tools.run("teleport", {}, editor)
    assert unknown.refused and unknown.error_code == "unsupported_operation"


def test_restricted_empty_scope_stays_empty():
    ctx = ToolContext(workspace_id="ws_1", file_ids=[])
    ctx._scope_outline = {
        "chapters": [],
        "files": [{"id": "f_1", "name": "one", "chapter_id": None, "chunks": 1}],
    }
    import asyncio

    resolved = asyncio.get_event_loop().run_until_complete(
        tools._resolve_scope(ctx, tools._MISSING)
    )
    assert isinstance(resolved, tools.ResolvedScope)
    assert resolved.file_ids == []


# ------------------------------------------------------- knowledge library

_CURATE = _READ | {"library.read"}


def _names(ctx: ToolContext) -> list[str]:
    return [s["function"]["name"] for s in tools.schemas_for(ctx)]


def _excerpt(**kwargs) -> library.Excerpt:
    return library.Excerpt(
        id=kwargs.pop("id", "e_1"),
        book_id="ahss",
        book_title="Advanced High School Statistics",
        section_path="8.1 Line fitting",
        roles=kwargs.pop("roles", ["introduction"]),
        topic_ids=["linear-regression"],
        confidence=0.9,
        synopsis="Fitting a line by least squares.",
        pages=[338, 339],
        figure_ids=kwargs.pop("figure_ids", ["fig_8_1"]),
        chunk_ids=["c_1", "c_2"],
        **kwargs,
    )


def test_knowledge_tools_need_curate_a_library_and_the_operation(monkeypatch):
    monkeypatch.setattr(tools.library, "enabled", lambda: True)
    ctx = ToolContext(workspace_id="ws", user_id="u_1", operations=_CURATE)

    assert "search_knowledge" not in _names(ctx), "ordinary chat never sees them"
    ctx.curate = True
    assert set(tools.KNOWLEDGE_TOOLS) <= set(_names(ctx))
    # Workspace reads stay available to a learner in curate mode.
    assert "search_workspace" in _names(ctx)

    monkeypatch.setattr(tools.library, "enabled", lambda: False)
    assert "search_knowledge" not in _names(ctx), "no library configured"
    monkeypatch.setattr(tools.library, "enabled", lambda: True)
    ctx.operations = _READ
    assert "search_knowledge" not in _names(ctx), "library.read was not granted"


def test_knowledge_capture_also_needs_the_knowledge_base_bucket(monkeypatch):
    monkeypatch.setattr(tools.library, "enabled", lambda: True)
    monkeypatch.setattr(tools.cfg, "knowledge_base_b2_bucket", "")
    ctx = ToolContext(workspace_id="ws", user_id="u_1", operations=_CURATE, curate=True)

    assert tools.KNOWLEDGE_CAPTURE not in _names(ctx), "no bucket, nothing to render"
    monkeypatch.setattr(tools.cfg, "knowledge_base_b2_bucket", "capy-knowledge-base")
    assert tools.KNOWLEDGE_CAPTURE in _names(ctx)
    ctx.curate = False
    assert tools.KNOWLEDGE_CAPTURE not in _names(ctx)


_STATISTICS = {
    "id": "statistics",
    "label": "Statistics",
    "aliases": ["stats"],
    "area": "mathematics",
    "excerpts": 12,
}


def test_subject_list_rides_on_browse_knowledge_only(monkeypatch):
    monkeypatch.setattr(tools.library, "enabled", lambda: True)
    ctx = ToolContext(
        workspace_id="ws",
        user_id="u_1",
        operations=_CURATE,
        curate=True,
        library_catalog=[_STATISTICS],
    )

    described = {
        s["function"]["name"]: s["function"]["description"]
        for s in tools.schemas_for(ctx)
    }

    assert (
        '- browse_knowledge({"subject": "statistics"}) (12 excerpts)'
        in described["browse_knowledge"]
    )
    assert "Statistics" not in described["browse_knowledge"]
    assert "also: stats" not in described["browse_knowledge"]
    assert "Subject IDs are only for `subject`" in described["browse_knowledge"]
    assert "statistics" not in described["search_knowledge"], (
        "the list is long; it is listed once"
    )
    assert "omit it for a direct or cross-topic search" in described["search_knowledge"]
    assert "statistics" not in described["read_knowledge"]
    assert "statistics" not in contract.DEFINITIONS["browse_knowledge"]["description"]


def test_curate_replaces_the_write_tool_descriptions(monkeypatch):
    """create_material means something else here, so the prompt package owns it."""
    monkeypatch.setattr(tools.library, "enabled", lambda: True)
    monkeypatch.setattr(tools.cfg, "gateway_url", "http://gateway")
    monkeypatch.setattr(tools.cfg, "pipeline_secret", "secret")
    ctx = ToolContext(
        workspace_id="ws", user_id="u_1", operations=_CURATE | _EDITOR, curate=True
    )

    described = {
        s["function"]["name"]: s["function"]["description"]
        for s in tools.schemas_for(ctx)
    }

    assert (
        described["create_material"]
        == curate_prompts.TOOL_DESCRIPTIONS["create_material"]
    )
    assert "Materials are the output of this mode" in described["create_material"]
    assert "section by section" in described["edit_document"]
    ctx.curate = False
    plain = {
        s["function"]["name"]: s["function"]["description"]
        for s in tools.schemas_for(ctx)
    }
    assert (
        plain["create_material"]
        == contract.DEFINITIONS["create_material"]["description"]
    )


async def test_search_knowledge_renders_excerpts_and_refuses_unknown_topics(
    monkeypatch,
):
    """Topic ids seen in a subject browse this turn need no lookup; the rest
    are checked against the library in one query."""
    ctx = ToolContext(
        workspace_id="ws",
        user_id="u_1",
        operations=_CURATE,
        curate=True,
        library_catalog=[_STATISTICS],
        subject_topics={"statistics": [{"id": "linear-regression", "excerpts": 3}]},
    )
    excerpt = _excerpt()
    excerpt.retrieval = {
        "summary": "Fitting a line",
        "scope": "One predictor; no software is required for the explanation.",
        "context_excerpt_ids": ["e_2"],
    }
    excerpt.synopsis = "Complete reviewed notes " * 1000
    excerpt.hit_text = "The least squares line minimises the sum of squared residuals."
    looked_up: list[list[str]] = []

    async def _known(ids):
        looked_up.append(ids)
        return set()

    async def _search(query, *, topics=None, roles=None, **_kwargs):
        assert (query, topics, roles) == (
            "least squares",
            ["linear-regression"],
            ["introduction"],
        )
        return library.SearchResult([excerpt], topics, roles)

    monkeypatch.setattr(tools.library, "search", _search)
    monkeypatch.setattr(tools.library, "known_topics", _known)
    result = await tools._search_knowledge(
        {
            "query": "least squares",
            "topics": ["linear-regression"],
            "roles": ["introduction"],
        },
        ctx,
    )
    text = result.text()

    assert (
        "[e_1] Advanced High School Statistics — 8.1 Line fitting (pages 338, 339)"
        in text
    )
    assert "roles: introduction" in text and "figures: fig_8_1" in text
    assert "least squares line" in text and "Fitting a line" in text
    assert "One predictor" in text and "e_2" in text
    assert "Complete reviewed notes" not in text
    assert looked_up == [], "a browsed topic id is known without a query"

    refused = await tools._search_knowledge({"query": "x", "topics": ["algebra"]}, ctx)
    assert refused.refused and "algebra" in refused.text()
    assert "subject browse call" in refused.text()
    assert "returned topic_id values" in refused.text()
    assert looked_up == [["algebra"]], "an unbrowsed id is checked once"


async def test_empty_result_reports_role_counts_only_under_a_topic_filter(monkeypatch):
    ctx = ToolContext(
        workspace_id="ws",
        operations=_CURATE,
        curate=True,
        library_catalog=[_STATISTICS],
    )
    available: dict[str, int] | None = {"introduction": 3, "exercise": 1}

    async def _known(ids):
        return set(ids)

    async def _search(_query, *, topics=None, roles=None, **_kwargs):
        return library.SearchResult(
            [], topics or [], roles or [], available if topics else None
        )

    monkeypatch.setattr(tools.library, "search", _search)
    monkeypatch.setattr(tools.library, "known_topics", _known)
    filtered = await tools._search_knowledge(
        {"query": "proofs", "topics": ["linear-regression"], "roles": ["formal"]}, ctx
    )

    assert "No verified excerpt matches roles formal" in filtered.text()
    assert "Those topics hold: introduction 3, exercise 1" in filtered.text()

    # Without topics the same counts would be the whole library's.
    unfiltered = await tools._search_knowledge(
        {"query": "proofs", "roles": ["formal"]}, ctx
    )
    assert "no topic filter" in unfiltered.text()
    assert "introduction 3" not in unfiltered.text()


async def test_browse_labels_the_role_numbers_as_assignments(monkeypatch):
    """They do not sum to the total: an excerpt counts once per role it carries."""
    ctx = ToolContext(
        workspace_id="ws",
        operations=_CURATE,
        curate=True,
        library_catalog=[_STATISTICS],
    )

    async def _browse(topic, *, page=1, **_kwargs):
        return library.BrowseResult(
            topic={"id": topic, "label": "Linear regression", "scope": "Fitting lines"},
            by_role={"introduction": 2, "formal": 2},
            by_book={"ahss": 3},
            total=3,
            page=page,
            page_size=20,
            items=[_excerpt()],
        )

    monkeypatch.setattr(tools.library, "browse", _browse)
    result = await tools._browse_knowledge({"topic": "linear-regression"}, ctx)
    text = result.text()

    assert "3 verified excerpts. By book: ahss 3." in text
    assert "Role assignments (an excerpt counts once per role it carries)" in text
    assert "introduction 2, formal 2" in text
    assert "[e_1] Advanced High School Statistics" in text


async def test_browse_of_a_subject_lists_its_topics_and_remembers_them(monkeypatch):
    ctx = ToolContext(
        workspace_id="ws",
        operations=_CURATE,
        curate=True,
        library_catalog=[_STATISTICS],
    )
    topics = [
        {
            "id": "linear-regression",
            "label": "Linear regression",
            "scope": "Fitting lines",
            "excerpts": 3,
        },
        {"id": "sampling", "label": "Sampling", "scope": "", "excerpts": 0},
    ]

    async def _browse_subject(key):
        assert key == "statistics"
        return {"subject": _STATISTICS, "topics": topics}

    monkeypatch.setattr(tools.library, "browse_subject", _browse_subject)
    result = await tools._browse_knowledge({"subject": "statistics"}, ctx)
    text = result.text()

    assert text.startswith("Subject 'statistics': 2 topics\n")
    assert (
        '- topic_id="linear-regression": Linear regression — Fitting lines (3 excerpts)'
        in text
    )
    assert '- topic_id="sampling": Sampling (0 excerpts)' in text
    assert "Use these topic_id values in search_knowledge.topics" in text
    assert ctx.subject_topics == {"statistics": topics}

    both = await tools._browse_knowledge({"subject": "statistics", "topic": "x"}, ctx)
    neither = await tools._browse_knowledge({}, ctx)
    assert both.refused and neither.refused
    assert "exactly one of subject" in neither.text()


async def test_browse_dispatches_on_the_argument_not_the_id(monkeypatch):
    """`probability` is both a subject and (until renamed) a topic id: the
    argument given picks the catalog, and a miss names that catalog."""
    ctx = ToolContext(
        workspace_id="ws",
        operations=_CURATE,
        curate=True,
        library_catalog=[_STATISTICS],
    )
    calls = []

    async def _browse_subject(key):
        calls.append(("subject", key))
        raise ValueError(f"unknown subject id {key!r}")

    async def _browse(key, *, page=1):
        calls.append(("topic", key))
        raise ValueError(f"unknown topic id {key!r}")

    monkeypatch.setattr(tools.library, "browse_subject", _browse_subject)
    monkeypatch.setattr(tools.library, "browse", _browse)

    as_topic = await tools._browse_knowledge({"topic": "probability"}, ctx)
    as_subject = await tools._browse_knowledge({"subject": "probability"}, ctx)

    assert calls == [("topic", "probability"), ("subject", "probability")]
    assert as_topic.refused and "unknown topic id 'probability'" in as_topic.text()
    assert (
        as_subject.refused and "unknown subject id 'probability'" in as_subject.text()
    )
    assert ctx.subject_topics == {}


def _read_result(**kwargs) -> library.ExcerptRead:
    return library.ExcerptRead(
        excerpt=_excerpt(),
        start=kwargs.pop("start", 0),
        chunks=kwargs.pop("chunks", []),
        next_start=kwargs.pop("next_start", None),
        first=kwargs.pop("first", 40),
        last=kwargs.pop("last", 44),
    )


async def test_read_knowledge_pages_in_chunk_units_and_records_the_read(monkeypatch):
    ctx = ToolContext(workspace_id="ws", operations=_CURATE, curate=True)

    async def _read(excerpt_id, *, start=0, **_kwargs):
        assert (excerpt_id, start) == ("e_1", 42)
        return _read_result(
            start=start,
            chunks=[{"chunk_idx": 42, "text": "Residuals are the vertical distances."}],
            next_start=43,
        )

    monkeypatch.setattr(tools.library, "read_excerpt", _read)
    result = await tools._read_knowledge({"excerpt_id": "e_1", "start": 42}, ctx)

    assert "(chunk 42) Residuals" in result.text()
    assert "chunks 40-44 of this excerpt, from 42" in result.text()
    assert "(next start = 43)" in result.text(), "next start is the last chunk plus one"
    assert [(r.excerpt_id, r.start) for r in ctx.ledger.reads] == [("e_1", 42)]
    assert ctx.ledger.reads[0].section == "8.1 Line fitting"

    # A repeat of the same position returns the text and adds nothing.
    again = await tools._read_knowledge({"excerpt_id": "e_1", "start": 42}, ctx)
    assert "(chunk 42) Residuals" in again.text()
    assert len(ctx.ledger.reads) == 1
    assert ctx.ledger.progress == 0, "reading is never progress"


# --------------------------------------------------------------- the ledger


def _curate_ctx() -> ToolContext:
    return ToolContext(
        workspace_id="ws",
        user_id="u_1",
        operations=_CURATE | _EDITOR,
        assistant_message_id="m_1",
        curate=True,
    )


def test_create_ledger_upserts_atomically_and_preserves_progress(monkeypatch):
    import asyncio
    from dataclasses import asdict

    monkeypatch.setattr(tools.library, "enabled", lambda: True)

    def apply(args, target):
        return asyncio.run(tools.run("create_ledger", args, target))

    ctx = _curate_ctx()

    def update(**args):
        return asyncio.run(tools.run("create_ledger", args, ctx))

    assert (
        update(body="Cells", todos=["Plan cell biology", "Quiz"]).outcome == "succeeded"
    )
    ctx.ledger.note_read("exc_1", 0, "Cells")
    ctx.ledger.note_material(
        tools.LedgerMaterial(
            id="mat_1", kind="quiz", title="Quiz", size="2 questions", todo=1
        )
    )
    assert ctx.ledger.progress == 2
    assert (
        update(
            body="Advanced cell biology",
            todos=[{"id": 0, "todo": "Write an advanced guide"}],
        ).outcome
        == "succeeded"
    )
    assert ctx.ledger.requests == ["Advanced cell biology"]
    assert ctx.ledger.todo(0).text == "Write an advanced guide"
    assert ctx.ledger.next_todo_id == 2 and len(ctx.ledger.todos) == 2
    assert ctx.ledger.todo(1).done and ctx.ledger.todo(1).material_id == "mat_1"
    assert ctx.ledger.read_ids() == {"exc_1"} and len(ctx.ledger.materials) == 1
    assert ctx.ledger.progress == 2  # Replanning does not buy extra stall responses.

    assert (
        update(
            body=None,
            todos=[
                {"id": 0, "todo": "First revision"},
                {"id": 0, "todo": "Last revision"},
            ],
        ).outcome
        == "succeeded"
    )
    assert ctx.ledger.todo(0).text == "Last revision"
    assert ctx.ledger.requests == ["Advanced cell biology"]
    assert update(todos=[{"id": 0, "todo": "Guide"}]).outcome == "succeeded"
    assert ctx.ledger.requests == ["Advanced cell biology"]
    assert update(body="").outcome == "succeeded"
    assert ctx.ledger.requests == [""]  # Empty is non-null and replaces the body.
    assert update(body="Current plan").outcome == "succeeded"

    assert update(todos=[f"Section {i}" for i in range(9)]).outcome == "succeeded"
    assert len(ctx.ledger.open_todos()) == 10
    assert update(todos=[{"id": 0, "todo": "Corrected guide"}]).outcome == "succeeded"
    before = asdict(ctx.ledger)
    for args in (
        {"body": "Should not land", "todos": ["Eleventh todo"]},
        {"body": "Should not land", "todos": [{"id": 999, "todo": "Eleventh ID"}]},
        {"body": "Should not land", "todos": [{"id": 0, "todo": " "}]},
        {"todos": [{"id": "0", "todo": "Invalid ID"}]},
    ):
        assert update(**args).refused
        assert asdict(ctx.ledger) == before
    assert update(body=None, todos=[]).outcome == "succeeded"
    assert asdict(ctx.ledger) == before
    restored = tools.Ledger.from_stored(ctx.ledger.stored())
    assert restored.stored() == ctx.ledger.stored()
    assert not restored.written and restored.requests == ["Current plan"]
    restored_ctx = _curate_ctx()
    restored_ctx.ledger = restored
    assert apply(
        {"todos": [{"id": 1, "todo": "Reuse completed ID"}]}, restored_ctx
    ).refused
    # The reported failing shape included explicit IDs for both old and new todos.
    fresh = _curate_ctx()
    assert apply({"body": "Plan", "todos": ["Planning"]}, fresh).outcome == "succeeded"
    assert (
        apply(
            {
                "body": "Advanced cells",
                "todos": [{"id": 0, "todo": "Guide"}, {"id": 1, "todo": "Quiz"}],
            },
            fresh,
        ).outcome
        == "succeeded"
    )
    assert fresh.ledger.next_todo_id == 2 and fresh.ledger.open_todos() == [0, 1]


async def test_a_later_turn_continues_the_stored_ledger():
    """The ledger is the conversation's: a new turn sees what is still open and
    its own create_ledger adds to it rather than replacing it. The done todo of
    the earlier turn is gone, and the open one keeps the id it always had."""
    first = tools.Ledger()
    first.add("Teach linear regression", ["note", "quiz"])
    first.note_material(
        tools.LedgerMaterial(
            id="mat_1", kind="note", title="T", size="9 tokens", todo=0
        )
    )
    ctx = _curate_ctx()
    ctx.ledger = tools.Ledger.from_stored(first.stored())

    assert ctx.ledger.open_todos() == [1]
    added = await tools._create_ledger(
        {"body": "Now flashcards too", "todos": ["flashcards"]}, ctx
    )

    assert "[ ] 2. flashcards" in added.text(), "ids continue the conversation"
    assert await tools.curate_write(ctx, "create_material", {"todo": 1}) == ([], 1)
    ctx.ledger.note_material(
        tools.LedgerMaterial(
            id="mat_2", kind="quiz", title="Q", size="9 questions", todo=1
        )
    )

    out = ctx.ledger.stored()
    assert out["requests"] == ["Now flashcards too"]
    assert out["todos"] == [{"id": 2, "text": "flashcards"}]
    assert [m["id"] for m in out["materials"]] == ["mat_1", "mat_2"]
    assert [m["todo"] for m in out["materials"]] == [0, 1], "the ids they closed"
    assert out["next_todo_id"] == 3
    assert "reads" not in out, "reads are this turn's only"


async def test_ledger_caps_unfinished_todos_across_turns_at_ten():
    schema = contract.DEFINITIONS["create_ledger"]["inputSchema"]
    assert schema["properties"]["todos"]["maxItems"] == tools.STORED_TODOS == 10
    assert contract.validate_args(
        "create_ledger", {"body": "Too much", "todos": ["note"] * 11}
    )
    previous = tools.Ledger()
    previous.add("First plan", [f"note {i}" for i in range(9)])
    ctx = _curate_ctx()
    ctx.ledger = tools.Ledger.from_stored(previous.stored())
    before = ctx.ledger.stored()

    refused = await tools._create_ledger(
        {"body": "More work", "todos": ["quiz", "flashcards"]}, ctx
    )
    assert refused.refused and "at most 10" in refused.text()
    assert ctx.ledger.stored() == before
    assert not ctx.ledger.written and ctx.ledger.progress == 0

    added = await tools._create_ledger({"body": "More work", "todos": ["quiz"]}, ctx)
    assert not added.refused and len(ctx.ledger.open_todos()) == 10
    ctx.ledger = tools.Ledger.from_stored(ctx.ledger.stored())
    full = await tools._create_ledger({"body": "More work", "todos": ["cards"]}, ctx)
    assert full.refused
    ctx.ledger.note_material(
        tools.LedgerMaterial(
            id="mat_1", kind="note", title="Done", size="1 token", todo=0
        )
    )
    added = await tools._create_ledger({"body": "More work", "todos": ["cards"]}, ctx)
    assert not added.refused and len(ctx.ledger.open_todos()) == 10
    assert ctx.ledger.next_todo_id == 11, "completed todo ids are never reused"


def test_the_stored_ledger_keeps_only_what_the_next_turn_needs():
    """The gateway refuses a ledger over 64 KiB and the model pays for every
    rendered line, so storing it drops the done todos and keeps the tail."""
    ledger = tools.Ledger(
        requests=[f"request {i}" for i in range(8)],
        todos=[
            tools.LedgerTodo(id=0, text="first done", done=True, material_id="mat_0"),
            tools.LedgerTodo(id=1, text="first open"),
            tools.LedgerTodo(id=2, text="second done", done=True, material_id="mat_1"),
            tools.LedgerTodo(id=3, text="second open"),
        ],
        next_todo_id=4,
        materials=[
            tools.LedgerMaterial(
                id=f"mat_{i}", kind="note", title="T", size="9 tokens", todo=0
            )
            for i in range(60)
        ],
    )

    out = ledger.stored()

    assert out["requests"] == [f"request {i}" for i in range(3, 8)]
    assert [m["id"] for m in out["materials"]] == [f"mat_{i}" for i in range(10, 60)]
    assert out["todos"] == [
        {"id": 1, "text": "first open"},
        {"id": 3, "text": "second open"},
    ]
    assert tools.Ledger.from_stored(out).open_todos() == [1, 3], "ids never move"
    assert {m["todo"] for m in out["materials"]} == {0}, "the todo each one closed"


def test_the_stored_ledger_keeps_the_newest_open_todos_only():
    """Open todos are the array a term-long conversation grows without end, so
    stored snapshots retain at most the newest 10."""
    ledger = tools.Ledger()
    ledger.add("Teach me everything", [f"todo {i}" for i in range(30)])

    out = ledger.stored()

    assert len(out["todos"]) == tools.STORED_TODOS
    assert [t["id"] for t in out["todos"]] == list(range(20, 30))
    assert out["next_todo_id"] == 30, "the counter does not follow the drop"


def test_a_malformed_stored_ledger_is_logged_and_the_turn_starts_empty(caplog):
    """The row is read again on every turn, so a shape this code cannot parse
    has to start the turn from nothing instead of breaking the conversation.
    A shape that could be coerced into something (a dict read as its keys, a
    todo id the counter has already handed out) is malformed too."""
    plain_todos = {"requests": ["r"], "todos": ["note"], "materials": []}
    material_todo_is_text = {
        "requests": ["r"],
        "materials": [
            {"id": "m", "kind": "note", "title": "T", "size": "9", "todo": "first"}
        ],
    }
    requests_is_a_dict = {"requests": {"a": 1}}
    materials_is_a_string = {"requests": ["r"], "materials": "mat_1"}
    todo_without_an_id = {"requests": ["r"], "todos": [{"text": "note"}]}
    id_the_counter_already_passed = {
        "requests": ["r"],
        "next_todo_id": 1,
        "todos": [{"id": 1, "text": "note"}],
    }
    malformed = (
        plain_todos,
        material_todo_is_text,
        requests_is_a_dict,
        materials_is_a_string,
        todo_without_an_id,
        id_the_counter_already_passed,
    )

    for stored in malformed:
        ledger = tools.Ledger.from_stored(stored, "conv_1")
        assert not ledger.exists and not ledger.todos and not ledger.materials

    assert caplog.text.count("stored curate ledger is malformed") == len(malformed)
    assert "conversation=conv_1" in caplog.text
    assert tools.Ledger.from_stored(None).requests == [], "no ledger is not an error"
    assert tools.Ledger.from_stored("a ledger").requests == [], "nor is a string"


async def test_curate_writes_need_a_ledger_an_open_todo_and_excerpts_that_were_read():
    ctx = _curate_ctx()

    no_ledger = await tools.curate_write(ctx, "create_material", {})
    assert isinstance(no_ledger, tools.ToolResult) and "create_ledger" in (
        no_ledger.text()
    )

    await tools._create_ledger({"body": "b", "todos": ["one", "two"]}, ctx)
    no_todo = await tools.curate_write(ctx, "create_material", {})
    assert isinstance(no_todo, tools.ToolResult)
    assert "needs todo" in no_todo.text() and "Open todos: 0, 1" in no_todo.text()

    unknown_id = await tools.curate_write(ctx, "create_material", {"todo": 2})
    assert isinstance(unknown_id, tools.ToolResult)
    assert "not on the ledger" in unknown_id.text()
    assert "Open todos: 0, 1" in unknown_id.text()

    ctx.ledger.todos[0].done = True
    done = await tools.curate_write(ctx, "create_material", {"todo": 0})
    assert isinstance(done, tools.ToolResult)
    assert "already done" in done.text() and "Open todos: 1" in done.text()

    # No library read yet: a material from workspace files alone is allowed.
    assert await tools.curate_write(ctx, "create_material", {"todo": 1}) == ([], 1)

    ctx.ledger.note_read("e_1", 0, "8.1")
    missing = await tools.curate_write(ctx, "create_material", {"todo": 1})
    assert isinstance(missing, tools.ToolResult) and "needs excerpt_ids" in (
        missing.text()
    )

    unread = await tools.curate_write(
        ctx, "edit_document", {"todo": 1, "excerpt_ids": ["e_1", "e_9"]}
    )
    assert isinstance(unread, tools.ToolResult)
    assert "'e_9'" in unread.text() and "read_knowledge" in unread.text()


async def test_a_curate_edit_of_a_source_file_carries_no_ledger_rules():
    """The ledger governs library work. The user's own file is not written from
    the library, so it needs no todo, no excerpts and no provenance."""
    ctx = _curate_ctx()
    ctx.ledger.note_read("e_1", 0, "8.1")

    assert await tools.curate_write(ctx, "edit_document", {}, material=False) == (
        [],
        None,
    )

    refused = await tools.curate_write(
        ctx, "edit_document", {"excerpt_ids": ["e_1"]}, material=False
    )
    assert isinstance(refused, tools.ToolResult)
    assert "carries no provenance" in refused.text()

    # Ignoring the todo would leave the model believing it closed one.
    with_todo = await tools.curate_write(
        ctx, "edit_document", {"todo": 0}, material=False
    )
    assert isinstance(with_todo, tools.ToolResult)
    assert "completes no ledger todo" in with_todo.text()


async def test_a_write_with_every_todo_done_is_told_to_finish_the_turn():
    """Finished todos stay finished; the learner can extend the plan."""
    ctx = _curate_ctx()
    await tools._create_ledger({"body": "b", "todos": ["one"]}, ctx)
    ctx.ledger.todos[0].done = True

    refused = await tools.curate_write(ctx, "create_material", {"todo": 0})

    assert isinstance(refused, tools.ToolResult) and refused.refused
    assert "Every todo on the ledger is done" in refused.text()
    assert "list of materials you created" in refused.text()
    assert "add a todo" in refused.text()


def test_ledger_renders_the_requests_todos_materials_and_inputs():
    ctx = _curate_ctx()
    ctx.ledger.add("Teach linear regression to a beginner", ["note", "quiz"])
    ctx.ledger.note_read("e_1", 0, "Ch 8 > 8.1 Line fitting")
    ctx.ledger.note_read("e_1", 12, "Ch 8 > 8.1 Line fitting")
    ctx.ledger.note_read("e_2", 0, "Ch 8 > 8.2 Residuals")
    ctx.ledger.note_material(
        tools.LedgerMaterial(
            id="mat_1", kind="note", title="Regression", size="900 tokens", todo=0
        )
    )

    rendered = curate_prompts.ledger_message("teach me regression", ctx.ledger)
    body = rendered["content"]

    assert rendered["_kind"] == "ledger"
    assert "request: teach me regression" in body
    assert "- Teach linear regression to a beginner" in body
    assert "[x] 0. note → mat_1" in body
    assert "[ ] 1. quiz" in body
    # Done todos leave the ledger at the end of the message, but the id of one
    # that stays open is the same id next message.
    assert "ids never change" in body
    assert "created note 'Regression' (id mat_1, 900 tokens) (todo 0)" in body
    assert body.count("- e_1 ") == 1, "one line per excerpt, not per read"
    assert "- e_2 Ch 8 > 8.2 Residuals" in body

    empty = curate_prompts.ledger_message("teach me regression", tools.Ledger())
    assert curate_prompts.NO_LEDGER in empty["content"]


# --------------------------------------------------------------- citations


def test_citation_numbers_are_stable_across_tool_calls():
    ctx = ToolContext(workspace_id="ws_1")
    first = tools.assign_citations(ctx, [_passage("c1"), _passage("c2")])
    # A later tool re-retrieves c2 and finds something new.
    second = tools.assign_citations(ctx, [_passage("c2"), _passage("c3")])

    assert [n for n, _ in first] == [1, 2]
    assert [n for n, _ in second] == [2, 3]
    assert len(ctx.citations) == 3


def test_citation_carries_pages_only_when_the_source_has_them():
    plain = _passage("c1").as_citation()
    paged = _passage("c2", page_start=4, page_end=5).as_citation()

    assert "pageStart" not in plain
    assert (paged["pageStart"], paged["pageEnd"]) == (4, 5)


def test_citation_snippet_is_the_hit_not_the_expanded_context():
    passage = _passage("c1", text="neighbour before\n\nthe hit", hit_text="the hit")

    assert passage.as_citation()["snippet"] == "the hit"


def test_location_reads_as_a_breadcrumb():
    passage = _passage("c1", section_path="Ch 4 › Light", page_start=7, page_end=7)

    assert passage.location() == "bio.pdf › Ch 4 › Light › p.7"


# ------------------------------------------------------------ diversity cap


def test_per_file_cap_promotes_other_sources():
    passages = [_passage(f"c{i}", file_id="f_1") for i in range(5)]
    passages.append(_passage("c9", file_id="f_2"))

    capped = _cap_per_file(passages, 2)

    assert [p.file_id for p in capped[:3]] == ["f_1", "f_1", "f_2"]


def test_per_file_cap_never_drops_results_in_a_single_file_workspace():
    passages = [_passage(f"c{i}") for i in range(5)]

    assert len(_cap_per_file(passages, 2)) == 5


def _row(chunk_id: str, score: float, flat: float) -> dict:
    return {
        "id": chunk_id,
        "file_id": "f_1",
        "file_name": "bio.pdf",
        "chunk_idx": 0,
        "text": "body",
        "score": score,
        "flat_score": flat,
    }


def test_tier_only_marks_the_hits_the_exact_tier_added():
    """The counterfactual for telemetry: rank the same candidates with every
    lexical row at half weight, and whatever is in the real top-k but not in
    that one owes its place to the tier."""
    rows = [
        _row("exact", 0.030, 0.010),
        _row("v1", 0.020, 0.020),
        _row("v2", 0.019, 0.019),
        _row("v3", 0.012, 0.012),
    ]
    top = [Passage.from_row(row) for row in rows[:3]]

    _mark_tier_only(top, rows, top_k=3, reranked=False)

    assert [p.tier_only for p in top] == [True, False, False]


def test_after_a_rerank_tier_only_marks_hits_the_tier_put_among_the_candidates():
    """The tier's lever is which rows the reranker scores: the exact row is in
    the fused first 20 only because of the tier, while a row the reranker
    lifted from inside both heads, or from the unreranked tail, owes nothing
    to it."""
    rows = [_row("exact", 0.030, 0.0001)] + [
        _row(f"v{i}", 0.020 - i * 0.0001, 0.020 - i * 0.0001) for i in range(25)
    ]
    ranked = [rows[20], rows[0], rows[15]]  # v19, exact, v14
    top = [Passage.from_row(row) for row in ranked]

    _mark_tier_only(top, rows, top_k=3, reranked=True)

    assert [p.tier_only for p in top] == [False, True, False]


def test_tier_only_is_untouched_when_no_tier_fired():
    rows = [_row("a", 0.02, 0.02), _row("b", 0.01, 0.01)]
    top = [Passage.from_row(row) for row in rows]

    _mark_tier_only(top, rows, top_k=1, reranked=False)

    assert not any(p.tier_only for p in top)


# ----------------------------------------------------------------- workflows


async def test_gather_context_rejects_one_invalid_file_atomically(monkeypatch):
    async def _outline(_workspace_id):
        return {
            "chapters": [],
            "files": [
                {
                    "id": "f_valid",
                    "name": "valid.md",
                    "chapter_id": None,
                    "chunks": 1,
                }
            ],
        }

    monkeypatch.setattr(workflows.store, "workspace_outline", _outline)
    try:
        await workflows.gather_context(
            workspace_id="ws_1",
            file_ids=["f_valid", "f_missing"],
        )
    except workflows.InvalidGenerateScope:
        pass
    else:
        raise AssertionError("one invalid file id must reject the whole scope")


def test_extract_json_handles_plain_fenced_and_embedded():
    assert workflows.extract_json('[{"a": 1}]') == [{"a": 1}]
    assert workflows.extract_json('sure:\n```json\n{"x": 2}\n```') == {"x": 2}
    assert workflows.extract_json("prefix [1, 2, 3] suffix") == [1, 2, 3]


def test_extract_json_returns_none_for_prose():
    assert workflows.extract_json("no json here") is None
    assert workflows.extract_json("") is None


def test_strip_fence_unwraps_mermaid():
    assert workflows.strip_fence("```mermaid\nflowchart LR\n A-->B\n```") == (
        "flowchart LR\n A-->B"
    )
    assert workflows.strip_fence("flowchart LR") == "flowchart LR"


def test_require_helpers_reject_empty_model_output():
    assert workflows.require_mermaid("```mermaid\nmindmap\n  root((X))\n```", "mindmap")
    assert workflows.require_json_list('[{"front": "a"}]', "flashcards") == [
        {"front": "a"}
    ]
    assert workflows.require_text("  bullets  ", "summary") == "bullets"

    for fn, args in (
        (workflows.require_mermaid, ("", "mindmap")),
        (workflows.require_mermaid, ("   ", "diagram")),
        (workflows.require_json_list, ("", "flashcards")),
        (workflows.require_json_list, ("[]", "quiz")),
        (workflows.require_json_list, ("not json", "quiz")),
        (workflows.require_json_list, ('{"front": "a"}', "flashcards")),
        (workflows.require_text, ("", "summary")),
        (workflows.require_text, ("  \n", "summary")),
    ):
        try:
            fn(*args)
        except workflows.GenerateEmpty as exc:
            assert exc.kind == args[-1]
        else:
            raise AssertionError(f"{fn.__name__}{args} should have failed")


def test_normalize_questions_fills_ids_and_drops_legacy_difficulty():
    questions = workflows.normalize_questions(
        [
            {"type": "mcq", "prompt": "?", "options": ["a", "b"], "difficulty": "easy"},
            {"id": "q_keep", "type": "short", "prompt": "?"},
            {
                "type": "open",
                "prompt": "Explain",
                "accepted": ["cristae"],
                "hints": ["ATP"],
                "rubrics": ["Mentions folds"],
            },
        ],
    )

    assert questions[0]["level"] == "application" and "difficulty" not in questions[0]
    assert questions[0]["options"][0] == {"value": "a", "explanation": ""}
    assert questions[0]["id"].startswith("q_")
    assert questions[1]["id"] == "q_keep" and questions[1]["level"] == "application"
    assert questions[2]["accepted"] == [{"value": "cristae"}]
    assert questions[2]["hints"] == [{"value": "ATP"}]
    assert questions[2]["rubrics"] == [{"value": "Mentions folds"}]


def test_normalize_questions_skips_non_objects():
    assert workflows.normalize_questions(["nope", None]) == []


def test_scope_label_names_both_axes():
    assert workflows.scope_label(["Ch 1"], ["a.pdf"]) == (
        "chapters Ch 1; documents a.pdf"
    )
    assert workflows.scope_label([], []) == ""


async def test_generate_refuses_empty_indexed_scope_before_model(monkeypatch):
    import pytest

    from pipeline.retrieve import service

    spec = ModelConfig(
        version=1,
        provider_name="DeepSeek",
        model_name="Flash",
        provider_slug="deepseek",
        model_slug="deepseek-v4-flash",
        thinking_levels=("instant",),
        default_thinking="instant",
        context_window_tokens=100_000,
    )
    req = service.GenerateReq(
        providerSlug=spec.provider_slug,
        modelSlug=spec.model_slug,
        configVersion=spec.version,
        userId="u_1",
        paidBy="platform",
        thinking="instant",
        workspaceId="ws_1",
        kind="flashcards",
        count=5,
        levels=["recall"],
        types=["mcq"],
        detail="standard",
        diagramType="auto",
    )

    async def _gather(**_kwargs):
        return "", []

    async def _produce(**_kwargs):
        raise AssertionError("produce must not run without indexed content")

    monkeypatch.setattr(service, "_bind_llm", lambda _req: None)
    monkeypatch.setattr(service.models, "resolve_query_model", lambda *_a, **_k: spec)

    async def _pending(*_args):
        return service.workflows.pending.PendingSources()

    monkeypatch.setattr(service.workflows.pending, "load", _pending)
    monkeypatch.setattr(service.workflows, "gather_context", _gather)
    monkeypatch.setattr(service.workflows, "produce", _produce)

    with pytest.raises(workflows.GenerateNoContent):
        await service._generate(req)


@pytest.mark.parametrize("character", ["a", "光", "😀"])
async def test_pipeline_chat_defense_rejects_query_character_overflow(character):
    import json

    from pipeline.retrieve import service

    req = service.ChatStreamReq(
        providerSlug="deepseek",
        modelSlug="deepseek-v4-flash",
        configVersion=1,
        userId="u_1",
        paidBy="platform",
        thinking="high",
        query=character * (service.CHAT_CHARACTER_LIMIT + 1),
        workspaceId="ws_1",
        contractVersion=contract.VERSION,
        operations=[],
        spendSessionId="cr_1",
    )

    chunk = await anext(service._chat_events(req, None))
    payload = json.loads(chunk.removeprefix("data: "))

    assert payload["code"] == "query_too_long"


# ------------------------------------------------------- query embed prefix


def _embed_spec(litellm_model_id: str) -> ModelConfig:
    return ModelConfig(
        version=1,
        provider_name="Qwen",
        model_name="embed",
        provider_slug="deepinfra",
        model_slug=litellm_model_id,
        params={"dimensions": 2560},
        slots=("retrieval",),
    )


def test_qwen3_query_gets_instruct_prefix():
    spec = _embed_spec("Qwen/Qwen3-Embedding-4B")
    shaped = models.format_query("chlorophyll", spec)

    assert shaped.startswith("Instruct:")
    assert shaped.endswith("Query:chlorophyll")
    assert "notes and uploaded materials" in shaped


def test_qwen3_huggingface_id_also_prefixes():
    spec = _embed_spec("Qwen/Qwen3-Embedding-8B")
    assert models.format_query("gravity", spec).endswith("Query:gravity")


def test_non_qwen3_query_stays_raw():
    spec = _embed_spec("text-embedding-3-large")
    assert models.format_query("chlorophyll", spec) == "chlorophyll"


async def test_search_prefixes_qwen3_vectors_not_lexical_terms(monkeypatch):
    """The workspace pin decides the prefix. Lexical terms stay the raw query."""
    spec = _embed_spec("Qwen/Qwen3-Embedding-4B")
    seen: dict[str, object] = {}

    async def pin(_ws: str) -> dict[str, object]:
        return {
            "embedding_provider_slug": "deepinfra",
            "embedding_model_slug": "Qwen/Qwen3-Embedding-4B",
            "embedding_model_version": 1,
            "embedding_dim": 2560,
        }

    async def fake_embed(texts: list[str], *, spec: ModelConfig) -> list[list[float]]:
        seen["texts"] = texts
        return [[0.0] * spec.embedding_dim]

    async def fake_hybrid(**kwargs: object) -> list:
        seen["terms"] = kwargs["terms"]
        return []

    monkeypatch.setattr("pipeline.retrieval.search.store.workspace_embedding_pin", pin)
    monkeypatch.setattr(
        "pipeline.retrieval.search.registry.resolve_pinned", lambda *_a, **_k: spec
    )
    monkeypatch.setattr("pipeline.retrieval.search.models.embed", fake_embed)
    monkeypatch.setattr("pipeline.retrieval.search.store.hybrid_search", fake_hybrid)

    await search(workspace_id="ws", query="chlorophyll")

    assert seen["texts"] == [models.format_query("chlorophyll", spec)]
    assert seen["terms"].any_of == "chlorophyll"


async def test_search_skips_prefix_when_workspace_pin_is_not_qwen3(monkeypatch):
    spec = _embed_spec("text-embedding-3-large")
    seen: dict[str, object] = {}

    async def pin(_ws: str) -> dict[str, object]:
        return {
            "embedding_provider_slug": "openai",
            "embedding_model_slug": "text-embedding-3-large",
            "embedding_model_version": 1,
            "embedding_dim": 2560,
        }

    async def fake_embed(texts: list[str], *, spec: ModelConfig) -> list[list[float]]:
        seen["texts"] = texts
        return [[0.0] * spec.embedding_dim]

    async def fake_hybrid(**kwargs: object) -> list:
        del kwargs
        return []

    monkeypatch.setattr("pipeline.retrieval.search.store.workspace_embedding_pin", pin)
    monkeypatch.setattr(
        "pipeline.retrieval.search.registry.resolve_pinned", lambda *_a, **_k: spec
    )
    monkeypatch.setattr("pipeline.retrieval.search.models.embed", fake_embed)
    monkeypatch.setattr("pipeline.retrieval.search.store.hybrid_search", fake_hybrid)

    await search(workspace_id="ws", query="chlorophyll")

    assert seen["texts"] == ["chlorophyll"]


# ------------------------------------------------------------ file summaries


def _ingest_spec() -> ModelConfig:
    return ModelConfig(
        version=1,
        provider_name="DeepSeek",
        model_name="Flash",
        provider_slug="deepseek",
        model_slug="deepseek-v4-flash-vision-exp",
        slots=("ingest",),
        thinking_levels=("instant",),
        default_thinking="instant",
        context_window_tokens=100_000,
    )


async def test_a_failed_file_summary_retries_instead_of_storing_a_blank(monkeypatch):
    """A blank descriptor is permanent: nothing refills it and donors copy it."""
    import pytest

    from pipeline.jobs import RetryableError
    from pipeline.retrieval import indexing
    from pipeline.retrieval.chunking import Chunk

    async def _explode(*_a, **_k):
        raise RuntimeError("provider is down")

    monkeypatch.setattr(indexing, "ingest_spec", _ingest_spec)
    monkeypatch.setattr(indexing.models, "complete_text", _explode)

    with pytest.raises(RetryableError):
        await indexing.summarize_file("bio.pdf", [Chunk(text="Chlorophyll absorbs")])


async def test_summary_settlement_failure_is_not_rewritten_as_retryable(monkeypatch):
    import pytest

    from pipeline.retrieval import accounting, indexing
    from pipeline.retrieval.chunking import Chunk

    async def _reject_receipt(*_a, **_k):
        raise accounting.SettlementError("receipt rejected")

    monkeypatch.setattr(indexing, "ingest_spec", _ingest_spec)
    monkeypatch.setattr(indexing.models, "complete_text", _reject_receipt)

    with pytest.raises(accounting.SettlementError, match="receipt rejected"):
        await indexing.summarize_file("bio.pdf", [Chunk(text="Chlorophyll absorbs")])


async def test_the_summary_prompt_excludes_the_uploaders_file_name(monkeypatch):
    """Descriptors are copied verbatim to every workspace with the same bytes."""
    from pipeline.retrieval import indexing
    from pipeline.retrieval.chunking import Chunk

    seen: list[str] = []

    async def _capture(messages, **_k):
        seen.append(messages[-1]["content"])
        return '{"descriptor": "Chlorophyll absorbs light."}'

    monkeypatch.setattr(indexing, "ingest_spec", _ingest_spec)
    monkeypatch.setattr(indexing.models, "complete_text", _capture)

    descriptor = await indexing.summarize_file(
        "Divorce settlement draft.pdf", [Chunk(text="Chlorophyll absorbs")]
    )

    assert "Divorce settlement draft.pdf" not in seen[0]
    assert "Chlorophyll absorbs" in seen[0]
    assert descriptor == "Chlorophyll absorbs light."


async def test_the_descriptor_regenerates_at_two_percent_a_version_change_or_first(
    monkeypatch,
):
    from pipeline.prompts.ingest import SUMMARY_VERSION
    from pipeline.retrieval import indexing
    from pipeline.retrieval.chunking import Chunk

    async def _regenerate(_name, _chunks):
        return "Fresh descriptor."

    monkeypatch.setattr(indexing, "summarize_file", _regenerate)
    chunks = [Chunk(text="Chlorophyll absorbs red and blue light.")]
    published = {
        "descriptor": "Stored descriptor.",
        "change_share": 0.0199,
        "summary_version": SUMMARY_VERSION,
        "chunks": chunks,
    }
    fresh = ("Fresh descriptor.", 0.0)

    assert await indexing._descriptor("f", chunks, published) == (
        "Stored descriptor.",
        0.0199,
    )
    assert (
        await indexing._descriptor("f", chunks, {**published, "change_share": 0.02})
        == fresh
    )
    stale = {**published, "summary_version": SUMMARY_VERSION - 1}
    assert await indexing._descriptor("f", chunks, stale) == fresh
    assert await indexing._descriptor("f", chunks, None) == fresh


def test_text_change_ignores_reflow_and_counts_only_edited_words():
    from pipeline.retrieval.chunking import Chunk, estimate_tokens
    from pipeline.retrieval.indexing import text_change_tokens

    old = [
        Chunk(text="Alpha beta gamma.\nDelta epsilon zeta.", section_path="Ch 1"),
        Chunk(text="Delta epsilon zeta.\nEta theta iota.", section_path="Ch 1"),
    ]
    # Re-split without the overlap block, a retained heading line, other spacing.
    reflowed = [
        Chunk(text="Ch 1\nAlpha beta  gamma.", section_path="Ch 1"),
        Chunk(text="Delta epsilon zeta.\nEta theta iota.", section_path="Ch 1"),
    ]
    edited = [reflowed[0], Chunk(text="Delta omega zeta.\nEta theta iota.")]

    assert text_change_tokens(old, reflowed) == 0
    assert text_change_tokens(old, edited) == estimate_tokens(
        "epsilon"
    ) + estimate_tokens("omega")


def test_text_change_counts_a_renumbered_csv_whole_and_fast(tmp_path):
    """A row inserted at the top renumbers every `Row N:` line, and so does a
    block pasted above a small table. The uncapped word diff took minutes on
    both; the capped one counts the range whole."""
    import random
    import time

    from pipeline.ingest.source_text import tabular_text
    from pipeline.retrieval.chunking import Chunk, estimate_tokens
    from pipeline.retrieval.indexing import text_change_tokens

    rng = random.Random(5)
    header = "Student,Class,Term,Score,Passed"

    def rows(n: int) -> list[str]:
        return [
            f"S{rng.randint(1, 400)},{rng.choice('ABC')},T{rng.randint(1, 2)},"
            f"{rng.randint(40, 100)},{rng.choice(['Yes', 'No'])}"
            for _ in range(n)
        ]

    def chunks(body: list[str]) -> list[Chunk]:
        path = tmp_path / "grades.csv"
        path.write_text("\n".join([header, *body]), encoding="utf-8")
        lines = tabular_text(str(path), "grades.csv").splitlines()
        return [
            Chunk(text="\n".join(lines[i : i + 25]), section_path="grades.csv")
            for i in range(0, len(lines), 25)
        ]

    body, small = rows(1000), rows(180)
    for old, new in (
        (chunks(body), chunks(["S999,A,T1,88,Yes", *body])),
        (chunks(small), chunks([*rows(5000), *small])),
    ):
        started = time.perf_counter()
        changed = text_change_tokens(old, new)
        assert time.perf_counter() - started < 5
        assert changed >= estimate_tokens("\n\n".join(c.indexed_text() for c in new))


def test_chat_request_requires_enabled_thinking():
    from pydantic import ValidationError

    from pipeline.retrieve.service import ChatStreamReq

    fields = {
        "query": "hello",
        "workspaceId": "ws",
        "contractVersion": contract.VERSION,
        "operations": [],
        "spendSessionId": "cr_1",
    }
    for thinking in ("instant", "", "off", None):
        with pytest.raises(ValidationError):
            ChatStreamReq(**fields, thinking=thinking)
    assert ChatStreamReq(**fields, thinking="high").thinking == "high"
