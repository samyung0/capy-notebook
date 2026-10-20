"""Offline unit tests for pure retrieval logic (no network, no database).

Covers the parts that decide what the agent is *allowed* to see and how a
passage becomes a citation — the places where a silent regression would look
like a quality problem rather than a bug.
"""

from __future__ import annotations

import json

import pytest

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

_LIBRARY = _READ | {"library.read"}


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


def test_knowledge_tools_need_the_library_switch_a_library_and_the_operation(
    monkeypatch,
):
    monkeypatch.setattr(tools.library, "enabled", lambda: True)
    ctx = ToolContext(workspace_id="ws", user_id="u_1", operations=_LIBRARY)

    assert "search_knowledge" not in _names(ctx), "Library off: never offered"
    ctx.library = True
    assert set(tools.KNOWLEDGE_TOOLS) <= set(_names(ctx))
    # Workspace reads stay available with Library on.
    assert "search_workspace" in _names(ctx)

    monkeypatch.setattr(tools.library, "enabled", lambda: False)
    assert "search_knowledge" not in _names(ctx), "no library configured"
    monkeypatch.setattr(tools.library, "enabled", lambda: True)
    ctx.operations = _READ
    assert "search_knowledge" not in _names(ctx), "library.read was not granted"


def test_knowledge_capture_also_needs_the_knowledge_base_bucket(monkeypatch):
    monkeypatch.setattr(tools.library, "enabled", lambda: True)
    monkeypatch.setattr(tools.cfg, "knowledge_base_b2_bucket", "")
    ctx = ToolContext(
        workspace_id="ws", user_id="u_1", operations=_LIBRARY, library=True
    )

    assert tools.KNOWLEDGE_CAPTURE not in _names(ctx), "no bucket, nothing to render"
    monkeypatch.setattr(tools.cfg, "knowledge_base_b2_bucket", "capy-knowledge-base")
    assert tools.KNOWLEDGE_CAPTURE in _names(ctx)
    ctx.library = False
    assert tools.KNOWLEDGE_CAPTURE not in _names(ctx)


_STATISTICS = {
    "id": "statistics",
    "label": "Statistics",
    "aliases": ["stats"],
    "area": "mathematics",
    "excerpts": 12,
}


def test_subject_list_rides_on_search_knowledge_only(monkeypatch):
    monkeypatch.setattr(tools.library, "enabled", lambda: True)
    ctx = ToolContext(
        workspace_id="ws",
        user_id="u_1",
        operations=_LIBRARY,
        library=True,
        library_catalog=[_STATISTICS],
    )

    described = {
        s["function"]["name"]: s["function"]["description"]
        for s in tools.schemas_for(ctx)
    }

    assert '- "statistics" (12 excerpts)' in described["search_knowledge"]
    assert "Statistics" not in described["search_knowledge"]
    assert "also: stats" not in described["search_knowledge"]
    assert "statistics" not in described["read_knowledge"], (
        "the list is long; it is listed once"
    )
    assert "browse_knowledge" not in described
    assert "statistics" not in contract.DEFINITIONS["search_knowledge"]["description"]


async def test_search_knowledge_renders_excerpts_and_refuses_unknown_subjects(
    monkeypatch,
):
    """A subject is checked against the turn's catalog, which the description
    lists; cards name the book and roles, not topic ids."""
    ctx = ToolContext(
        workspace_id="ws",
        user_id="u_1",
        operations=_LIBRARY,
        library=True,
        library_catalog=[_STATISTICS],
    )
    excerpt = _excerpt()
    excerpt.retrieval = {
        "summary": "Fitting a line",
        "scope": "One predictor; no software is required for the explanation.",
        "context_excerpt_ids": ["e_2"],
    }
    excerpt.links = [{"id": "e_2", "section_path": "8.2 Residuals", "pages": [340]}]
    excerpt.synopsis = "Complete reviewed notes " * 1000
    excerpt.hit_text = "The least squares line minimises the sum of squared residuals."
    searched: list[str] = []

    async def _search(query, *, subject=None, roles=None, **_kwargs):
        searched.append(query)
        assert (query, subject, roles) == (
            "least squares",
            "statistics",
            ["introduction"],
        )
        return library.SearchResult([excerpt], subject, roles)

    monkeypatch.setattr(tools.library, "search", _search)
    result = await tools._search_knowledge(
        {"query": "least squares", "subject": "statistics", "roles": ["introduction"]},
        ctx,
    )
    text = result.text()

    assert (
        "[e_1] Advanced High School Statistics (book ahss) — 8.1 Line fitting "
        "(pages 338, 339)" in text
    )
    assert "roles: introduction" in text and "figures: fig_8_1" in text
    assert "topics:" not in text
    assert "least squares line" in text and "Fitting a line" in text
    assert "One predictor" in text and "- [e_2] 8.2 Residuals (pages 340)" in text
    assert "Complete reviewed notes" not in text

    refused = await tools._search_knowledge({"query": "x", "subject": "algebra"}, ctx)
    assert refused.refused and "Unknown subject id 'algebra'" in refused.text()
    assert "listed in this tool's description" in refused.text()
    assert searched == ["least squares"], "an unknown subject never searches"


async def test_empty_result_reports_role_counts_only_under_a_subject(monkeypatch):
    ctx = ToolContext(
        workspace_id="ws",
        operations=_LIBRARY,
        library=True,
        library_catalog=[_STATISTICS],
    )
    available: dict[str, int] | None = {"introduction": 3, "exercise": 1}

    async def _search(_query, *, subject=None, roles=None, **_kwargs):
        return library.SearchResult(
            [], subject, roles or [], available if subject else None
        )

    monkeypatch.setattr(tools.library, "search", _search)
    filtered = await tools._search_knowledge(
        {"query": "proofs", "subject": "statistics", "roles": ["formal"]}, ctx
    )

    assert "No verified excerpt matches roles formal in subject statistics." in (
        filtered.text()
    )
    assert "That subject holds: introduction 3, exercise 1" in filtered.text()

    # Without a subject the same counts would be the whole library's.
    unfiltered = await tools._search_knowledge(
        {"query": "proofs", "roles": ["formal"]}, ctx
    )
    assert "no subject filter" in unfiltered.text()
    assert "introduction 3" not in unfiltered.text()


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
    ctx = ToolContext(workspace_id="ws", operations=_LIBRARY, library=True)

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
    assert [(r.excerpt_id, r.start) for r in ctx.library_reads.reads] == [("e_1", 42)]
    assert ctx.library_reads.reads[0].section == "8.1 Line fitting"

    # A repeat of the same position returns the text and adds nothing.
    again = await tools._read_knowledge({"excerpt_id": "e_1", "start": 42}, ctx)
    assert "(chunk 42) Residuals" in again.text()
    assert len(ctx.library_reads.reads) == 1


async def test_a_page_the_output_limit_cuts_continues_at_the_first_unshown_chunk(
    monkeypatch,
):
    """The page stops before the clip would, so next start skips nothing."""
    monkeypatch.setattr(tools, "TOOL_RESULT_MAX_TOKENS", 450)
    ctx = ToolContext(workspace_id="ws", operations=_LIBRARY, library=True)

    async def _read(excerpt_id, *, start=0, count=12):
        assert count == 3
        return _read_result(
            start=start,
            chunks=[{"chunk_idx": 40 + i, "text": f"w{i}xyz " * 100} for i in range(3)],
            next_start=43,
        )

    monkeypatch.setattr(tools.library, "read_excerpt", _read)
    text = (
        await tools._read_knowledge({"excerpt_id": "e_1", "start": 40, "count": 3}, ctx)
    ).text()

    assert "(chunk 41)" in text and "(chunk 42)" not in text
    assert text.endswith("(page cut at the tool output limit; next start = 42)")
    assert tools.limit_tool_result(text) == text, "nothing left for the clip to drop"

    # One chunk over the limit by itself: the next start goes ahead of the clip.
    monkeypatch.setattr(tools, "TOOL_RESULT_MAX_TOKENS", 200)
    shown = tools.limit_tool_result(
        (await tools._read_knowledge({"excerpt_id": "e_1", "count": 3}, ctx)).text()
    )
    assert shown.startswith("(page cut at the tool output limit; next start = 41)")
    assert shown.endswith(
        "[Tool output truncated. Narrow the request or continue reading.]"
    )


def _library_ctx() -> ToolContext:
    return ToolContext(
        workspace_id="ws",
        user_id="u_1",
        operations=_LIBRARY | _EDITOR,
        assistant_message_id="m_1",
        library=True,
    )


async def test_a_write_credits_named_excerpts_or_the_reads_since_the_last_write(
    monkeypatch,
):
    """Named excerpts are credited as named. A write naming none credits what
    was read since the last write that landed, or everything read when nothing
    is new, of the books its text matches (all of them when it matches none);
    with no reads it credits nothing and asks for nothing."""

    async def provenance(ids):
        return [{"id": "book", "excerptIds": list(ids)}]

    monkeypatch.setattr(tools.library, "provenance", provenance)
    ctx = _library_ctx()
    reads = ctx.library_reads
    write = {"content": "The slope was 2.45."}

    assert await tools.write_sources(ctx, "create_material", {}) == ([], [])

    for n in (1, 2):
        reads.note(f"e_{n}", 0, f"8.{n}", text="(chunk 3) A slope of 2.45.")
    named = await tools.write_sources(ctx, "create_material", {"excerpt_ids": ["e_2"]})
    assert named == ([{"id": "book", "excerptIds": ["e_2"]}], ["e_2"])
    _, credited = await tools.write_sources(ctx, "create_material", write)
    assert credited == ["e_1", "e_2"]
    tools.landed(ctx, credited)

    reads.note("e_3", 0, "8.3", text="(chunk 9) A slope of 2.45 again.")
    _, credited = await tools.write_sources(ctx, "add_questions", write)
    assert credited == ["e_3"], "only what was read since the last write"
    tools.landed(ctx, credited)

    _, credited = await tools.write_sources(ctx, "add_questions", write)
    assert credited == ["e_1", "e_2", "e_3"], "nothing new: everything read"
    _, credited = await tools.write_sources(ctx, "add_questions", {"content": "x"})
    assert credited == ["e_1", "e_2", "e_3"], "matching no book: every candidate"
    # Reading an excerpt again makes it new for the next write.
    reads.note("e_1", 0, "8.1")
    assert (await tools.write_sources(ctx, "create_material", write))[1] == ["e_1"]
    # What a write credited is retained for later turns, named or not.
    assert ctx.library_evidence.used == {"e_1", "e_2", "e_3"}


async def test_without_the_library_writes_offer_and_take_no_excerpt_ids(monkeypatch):
    """Offered anyway, the model fills excerpt_ids with workspace passage ids."""
    monkeypatch.setattr(tools, "_gateway_ready", lambda: True)
    ctx = ToolContext(workspace_id="ws", user_id="u_1", operations=_EDITOR)
    for schema in tools.schemas_for(ctx):
        assert "excerpt_ids" not in schema["function"]["parameters"]["properties"]
    refused = await tools.write_sources(
        ctx, "create_material", {"excerpt_ids": ["attention#1"]}
    )
    assert isinstance(refused, tools.ToolResult)
    assert "library is not a source this turn" in refused.text()


async def test_an_edit_of_a_source_file_carries_no_provenance():
    """The user's own file is not written from the library, so it credits no
    excerpts and takes none."""
    ctx = _library_ctx()
    ctx.library_reads.note("e_1", 0, "8.1")

    assert await tools.write_sources(ctx, "edit_document", {}, material=False) == (
        [],
        [],
    )
    refused = await tools.write_sources(
        ctx, "edit_document", {"excerpt_ids": ["e_1"]}, material=False
    )
    assert isinstance(refused, tools.ToolResult)
    assert "carries no provenance" in refused.text()


def test_turn_context_renders_open_file_preferences_and_reads():
    from pipeline.retrieval import turn_context

    ctx = _library_ctx()
    ctx.open_resource = {"id": "f_1", "kind": "file", "title": "Cells.pdf"}
    ctx.study_preferences = {
        "writingStyle": "brief",
        "quiz": "less",
        "flashcards": "more",
        "mainFormat": "deck",
    }
    ctx.library_reads.note("e_1", 0, "Ch 8 > 8.1 Line fitting")
    ctx.library_reads.note("e_1", 12, "Ch 8 > 8.1 Line fitting")

    rendered = turn_context.message(ctx)
    body = rendered["content"]

    assert rendered["_kind"] == "turn_context"
    assert "Open: Cells.pdf (file f_1). The learner owns this workspace." in body
    assert "key points first" in body, "brief writing"
    assert "a deck explains each chapter" in body
    assert "a quiz of 5 questions and a set of 10 flashcards" in body
    # Knowledge checks are notes only: a deck's turn gets no check line.
    assert "knowledge check" not in body, "deck main format"
    ctx.study_preferences["mainFormat"] = "note"
    noted = turn_context.message(ctx)["content"]
    assert "knowledge check of at most 3 flashcards" in noted, "cards set higher"
    assert "make no standalone" not in noted, "both practice items are on"
    assert body.count("- e_1 ") == 1, "one line per excerpt, not per read"
    assert turn_context.FINAL_NOTICE in turn_context.message(ctx, final=True)["content"]

    viewer = _library_ctx()
    viewer.role = "viewer"
    empty = turn_context.message(viewer)["content"]
    assert "Open: nothing. The learner can only view this workspace." in empty
    assert "Library excerpts" not in empty
    assert (
        "a quiz of 5 questions; make no standalone flashcards unless asked." in empty
    ), "default preferences: quiz less, flashcards off said off"
    assert "a note explains each chapter" in empty
    assert "knowledge check of at most 2 questions" in empty


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


def test_normalize_questions_canonical_ids_and_optional_level():
    from uuid import UUID

    from pipeline.prompts.generate import quiz_instruction

    source = [
        {
            "stem": [],
            "parts": [
                {
                    "blocks": [{"type": "text", "text": "Explain"}],
                    "answer": {"type": "open", "accepted": ["Because"], "hints": []},
                    "marks": 3,
                    "markscheme": [
                        {"text": "States the cause", "marks": 1},
                        {"text": "Links it to the effect", "marks": 2},
                    ],
                    "solution": [],
                },
                {
                    "blocks": [{"type": "text", "text": "True?"}],
                    "answer": {"type": "boolean", "correct": True},
                    "marks": 2,
                    "solution": [],
                },
            ],
            "layout": "paper",
            "labels": "letters",
        }
    ]
    questions = workflows.normalize_questions(source)
    assert UUID(questions[0]["id"]).version == 4
    assert UUID(questions[0]["parts"][0]["id"]).version == 4
    assert "id" not in source[0] and "level" not in questions[0]
    assert questions[0]["parts"][0]["answer"]["accepted"] == ["Because"]
    assert 'Omit the optional "level"' in quiz_instruction(count=1, types=["open"])
    assert "NON-COMPUTATIONAL" in quiz_instruction(count=1, types=["open"])


def test_normalize_questions_rejects_legacy_or_partial_output():
    import pytest

    for data in ([{"type": "short", "prompt": "?"}], ["nope", None], []):
        with pytest.raises(workflows.GenerateEmpty):
            workflows.normalize_questions(data)
    open_answer = {"type": "open", "accepted": ["Because"], "hints": []}
    closed_answer = {"type": "boolean", "correct": True}
    item = {"text": "States the cause", "marks": 1}
    # Old string items, boolean marks, mismatched sums and closed schemes.
    for answer, extra in (
        (open_answer, {"marks": 1, "markscheme": ["States the cause"]}),
        (open_answer, {"marks": 1, "markscheme": [{"text": "States", "marks": True}]}),
        (open_answer, {"marks": 2, "markscheme": [item]}),
        (open_answer, {"marks": 1}),
        (closed_answer, {"marks": 1, "markscheme": [item]}),
        (closed_answer, {}),
        (closed_answer, {"marks": True}),
    ):
        part = {"blocks": [{"type": "text", "text": "Explain"}], "answer": answer}
        part |= extra | {"solution": []}
        question = {"stem": [], "parts": [part], "layout": "paper", "labels": "letters"}
        with pytest.raises(workflows.GenerateEmpty):
            workflows.normalize_questions([question])


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
    without_levels = service.GenerateReq.model_validate(
        req.model_dump(exclude={"levels"})
    )
    assert service._cognitive_levels(without_levels) == []

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


async def test_generate_takes_the_panels_count(monkeypatch):
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

    def req(kind: str, **extra) -> service.GenerateReq:
        return service.GenerateReq(
            providerSlug=spec.provider_slug,
            modelSlug=spec.model_slug,
            configVersion=spec.version,
            userId="u_1",
            paidBy="platform",
            thinking="instant",
            workspaceId="ws_1",
            kind=kind,
            types=["mcq"],
            detail="standard",
            diagramType="auto",
            **extra,
        )

    # The panel's More or Less is the count; the study preferences never set it.
    assert service._count(req("quiz", count=10)) == 10
    with pytest.raises(ValueError, match="needs a count"):
        service._count(req("flashcards"))

    asked: list[str] = []

    async def _context(**_kwargs):
        return "context", [], None

    async def _produce(*, instruction, **_kwargs):
        asked.append(instruction)
        return '[{"front": "f", "back": "b"}]'

    monkeypatch.setattr(service, "_bind_llm", lambda _req: None)
    monkeypatch.setattr(service.models, "resolve_query_model", lambda *_a, **_k: spec)
    monkeypatch.setattr(service.workflows, "generation_context", _context)
    monkeypatch.setattr(service.workflows, "produce", _produce)
    await service._generate(req("flashcards", count=5))
    assert asked[0].startswith("Create 5 study flashcards")


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
        role="editor",
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

    raised: list[Exception] = []

    async def _reject_receipt(*_a, **_k):
        raise raised[0]

    monkeypatch.setattr(indexing, "ingest_spec", _ingest_spec)
    monkeypatch.setattr(indexing.models, "complete_text", _reject_receipt)

    # Any accounting error, a capacity row missing as much as a rejected receipt.
    for error in (
        accounting.SettlementError("receipt rejected"),
        accounting.AccountingError("model capacity is not configured"),
    ):
        raised[:] = [error]
        with pytest.raises(type(error), match=str(error)):
            await indexing.summarize_file(
                "bio.pdf", [Chunk(text="Chlorophyll absorbs")]
            )


async def test_the_summary_prompt_excludes_the_uploaders_file_name(monkeypatch):
    """Descriptors are copied verbatim to every workspace with the same bytes."""
    from pipeline.retrieval import indexing
    from pipeline.retrieval.chunking import Chunk

    seen: list[str] = []

    async def _capture(messages, **_k):
        seen.append(messages[-1]["content"])
        return "Chlorophyll absorbs light."

    monkeypatch.setattr(indexing, "ingest_spec", _ingest_spec)
    monkeypatch.setattr(indexing.models, "complete_text", _capture)

    descriptor = await indexing.summarize_file(
        "Divorce settlement draft.pdf", [Chunk(text="Chlorophyll absorbs")]
    )

    assert "Divorce settlement draft.pdf" not in seen[0]
    assert "Chlorophyll absorbs" in seen[0]
    assert descriptor == "Chlorophyll absorbs light."


async def test_the_descriptor_token_bound_is_its_only_cut(monkeypatch):
    from pipeline.retrieval import indexing
    from pipeline.retrieval.chunking import Chunk

    long = " ".join(f"w{i}." for i in range(300))
    bounds: list[int | None] = []

    async def _reply(_messages, *, max_tokens=None, **_k):
        bounds.append(max_tokens)
        return long

    monkeypatch.setattr(indexing, "ingest_spec", _ingest_spec)
    monkeypatch.setattr(indexing.models, "complete_text", _reply)

    assert await indexing.summarize_file("a.pdf", [Chunk(text="x")]) == long
    assert bounds == [400]


def test_the_descriptor_reads_an_outline_opening_and_spaced_excerpt():
    import re

    from pipeline.retrieval import indexing
    from pipeline.retrieval.chunking import Chunk, estimate_tokens

    short = [Chunk(text="Chlorophyll absorbs light.", section_path="Light")]
    assert indexing.descriptor_excerpt(short) == short[0].indexed_text()

    chapters = [
        Chunk(
            text=f"Chapter {i} opens here. " + "filler " * 400, section_path=f"Ch {i}"
        )
        for i in range(200)
    ]
    excerpt = indexing.descriptor_excerpt(chapters)

    assert estimate_tokens(excerpt) <= indexing.DESCRIPTOR_INPUT_TOKENS
    assert excerpt.startswith("Ch 0\nCh 1\n")  # the outline comes first
    assert chapters[0].indexed_text() in excerpt  # the opening is whole
    sampled = [int(n) for n in re.findall(r"Chapter (\d+) opens here", excerpt)]
    assert max(sampled) >= 180  # the end is sampled too


async def test_an_empty_descriptor_reply_fails_explicitly(monkeypatch):
    import pytest

    from pipeline.jobs import RetryableError
    from pipeline.retrieval import indexing
    from pipeline.retrieval.chunking import Chunk

    monkeypatch.setattr(indexing, "ingest_spec", _ingest_spec)
    for reply in ("", "  \n"):

        async def _reply(*_a, reply=reply, **_k):
            return reply

        monkeypatch.setattr(indexing.models, "complete_text", _reply)
        with pytest.raises(RetryableError, match="empty"):
            await indexing.summarize_file("a.pdf", [Chunk(text="x")])


async def test_the_descriptor_regenerates_at_two_percent_or_first(
    monkeypatch,
):
    from pipeline.retrieval import indexing
    from pipeline.retrieval.chunking import Chunk

    async def _regenerate(_name, _chunks):
        return "Fresh descriptor."

    monkeypatch.setattr(indexing, "summarize_file", _regenerate)
    chunks = [Chunk(text="Chlorophyll absorbs red and blue light.")]
    published = {
        "descriptor": "Stored descriptor.",
        "change_share": 0.0199,
        "updated_at": "written",
        "chunks": chunks,
    }
    fresh = ("Fresh descriptor.", 0.0, None, None)

    # A reuse keeps when the descriptor was written.
    assert await indexing._descriptor("f", chunks, published) == (
        "Stored descriptor.",
        0.0199,
        "written",
        None,
    )
    assert (
        await indexing._descriptor("f", chunks, {**published, "change_share": 0.02})
        == fresh
    )
    assert await indexing._descriptor("f", chunks, None) == fresh


async def test_a_failed_descriptor_is_pending_or_keeps_the_published_one(
    monkeypatch,
):
    """Parts design Q4/Q10: a failed regeneration keeps a non-blank published
    descriptor with its accumulated share (the next run tries again); without
    one, or over a blank one, the descriptor is pending (no row to write),
    never blank. Accounting failures, settlement among them, still raise."""
    import pytest

    from pipeline.retrieval import accounting, indexing
    from pipeline.retrieval.chunking import Chunk

    failure = RuntimeError("503 upstream")

    async def _fail(_name, _chunks):
        raise failure

    monkeypatch.setattr(indexing, "summarize_file", _fail)
    chunks = [Chunk(text="Chlorophyll absorbs red and blue light.")]
    published = {
        "descriptor": "Stored.",
        "change_share": 0.05,
        "updated_at": "written",
        "chunks": chunks,
    }

    assert await indexing._descriptor("f", chunks, published) == (
        "Stored.",
        0.05,
        "written",
        None,
    )
    assert await indexing._descriptor("f", chunks, None) == (None, 0.0, None, failure)
    blank = {**published, "descriptor": ""}
    assert await indexing._descriptor("f", chunks, blank) == (
        None,
        0.0,
        None,
        failure,
    )
    for raised in (
        accounting.SettlementError("receipt rejected"),
        accounting.AccountingError("model capacity is not configured"),
    ):
        failure = raised
        with pytest.raises(type(raised)):
            await indexing._descriptor("f", chunks, None)


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
        "role": "editor",
    }
    for thinking in ("instant", "", "off", None):
        with pytest.raises(ValidationError):
            ChatStreamReq(**fields, thinking=thinking)
    assert ChatStreamReq(**fields, thinking="high").thinking == "high"


def test_one_prompt_adds_the_library_rules_only_with_library_on():
    from pipeline.prompts import chat as chat_prompts
    from pipeline.retrieval import limits

    off = chat_prompts.system_prompt("en")
    on = chat_prompts.system_prompt("en", library=True)

    assert "Library (a source this turn)" in on and "Library (a source" not in off
    # Without a write tool (a viewer) the model is told it cannot write.
    assert chat_prompts.READ_ONLY_RULE in chat_prompts.system_prompt("en", writes=False)
    assert chat_prompts.READ_ONLY_RULE not in off
    for prompt in (off, on):
        assert "read the skills for the work with read_skill" in prompt
        assert "propose the plan" not in prompt
        assert "lacks the learning scope or the learner's level" in prompt
        assert (
            f"Until its first successful write a turn has "
            f"{limits.PLANNING_RESPONSES} responses" in prompt
        )
        assert (
            f"after it, up to {limits.BUILD_TOOLS_PER_TURN} tool calls in the whole turn"
            in prompt
        )


def test_study_progress_is_offered_only_when_progress_is_on():
    ctx = ToolContext(workspace_id="ws", user_id="u_1", operations=_READ)
    assert "read_study_progress" not in _names(ctx)
    ctx.study_progress = True
    assert "read_study_progress" in _names(ctx)


def test_study_progress_renders_states_quizzes_and_weak_chapters():
    text = tools.render_progress(
        {
            "items": [
                {"id": "f_1", "kind": "file", "title": "Cells.pdf", "state": "done"},
                {
                    "id": "m_2",
                    "kind": "material",
                    "title": "Organelles",
                    "state": "started",
                },
            ],
            "recentAttempts": [
                {
                    "quizName": "Cell quiz",
                    "pct": 62,
                    "takenAt": "2026-10-03T09:00:00Z",
                    "chapters": ["Cells"],
                }
            ],
            "weakChapters": [{"chapter": "", "retention": 0.41, "items": 7}],
        }
    )
    assert "Done:\n- Cells.pdf (file f_1)" in text
    assert "Started:\n- Organelles (material m_2)" in text
    assert "- Cell quiz: 62% on 2026-10-03 (Cells)" in text
    assert "- Unfiled: 41% retained across 7" in text
    assert (
        tools.render_progress({}) == "No study progress recorded in this workspace yet."
    )


def test_inspect_shows_a_notes_quiz_as_its_fence_and_edits_expect_it_back():
    """An embedded quiz shows as the fence an edit writes; an edit expecting that
    text expects the stored one (Epo 2026-10-14)."""
    from pipeline.retrieval import questions

    item = {"question": "Which?", "options": ["A", "B"], "correct": "B"}
    stored = (
        "```quiz\n"
        + json.dumps({"questions": [questions.expand("mcq", item, "q_1")]})
        + "\n```"
    )
    shown: dict[str, tuple[str, str]] = {}
    text = tools._render_inspection(
        {
            "title": "Note",
            "format": "plate",
            "supportedOperations": ["replace_block"],
            "blocks": [{"id": "b3", "type": "quiz", "text": stored}],
        },
        shown,
    )
    view = shown["b3"][0]
    assert view in text and "correct: B" in view and stored not in text
    command = {"type": "replace_block", "block_id": "b3", "expected_text": view}
    assert tools._stored_expectation(command, shown)["expected_text"] == stored
    quiz = tools._render_inspection(
        {
            "title": "Quiz",
            "materialKind": "quiz",
            "supportedOperations": ["remove_question"],
        }
    )
    assert (
        "supported: remove_question, (add or replace questions with add_questions)"
        in quiz
    )


def test_the_final_notice_says_an_unwritten_deck_was_not_saved():
    from pipeline.retrieval import turn_context

    ctx = ToolContext(workspace_id="ws")
    ctx.decks["deck_1"] = {"id": "deck_1"}
    body = turn_context.message(ctx, final=True)["content"]
    assert turn_context.FINAL_NOTICE + turn_context.UNSAVED_DECK in body
    ctx.decks["deck_1"]["file"] = "f_1"
    assert (
        turn_context.UNSAVED_DECK
        not in turn_context.message(ctx, final=True)["content"]
    )
