"""Offline unit tests for pure retrieval logic (no network, no database).

Covers the parts that decide what the agent is *allowed* to see and how a
passage becomes a citation — the places where a silent regression would look
like a quality problem rather than a bug.
"""

from __future__ import annotations

from pipeline.registry import ModelConfig
from pipeline.retrieval import models, tools, workflows
from pipeline.retrieval.search import Passage, _cap_per_file, search
from pipeline.retrieval.store import normalize_concept
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


def test_unscoped_context_lets_the_tool_choose():
    ctx = ToolContext(workspace_id="ws_1")

    assert tools._scoped(ctx, None) is None
    assert tools._scoped(ctx, ["f_9"]) == ["f_9"]


def test_agent_cannot_widen_a_scope_the_user_narrowed():
    ctx = ToolContext(workspace_id="ws_1", file_ids=["f_1", "f_2"])

    assert tools._scoped(ctx, ["f_2", "f_99"]) == ["f_2"]
    assert tools._scoped(ctx, None) == ["f_1", "f_2"]


def test_a_fully_out_of_scope_request_falls_back_to_the_scope():
    """An empty file filter would search the whole workspace, so it must not be
    the result of asking for files outside the scope."""
    ctx = ToolContext(workspace_id="ws_1", file_ids=["f_1"])

    assert tools._scoped(ctx, ["f_99"]) == ["f_1"]


def test_material_tool_is_hidden_without_a_gateway(monkeypatch):
    monkeypatch.setattr(tools.cfg, "gateway_url", "")
    monkeypatch.setattr(tools.cfg, "pipeline_secret", "")
    names = [
        s["function"]["name"] for s in tools.schemas_for(ToolContext(workspace_id="ws"))
    ]

    assert "generate_material" not in names
    assert "search_workspace" in names


def test_material_tool_is_hidden_without_a_user(monkeypatch):
    monkeypatch.setattr(tools.cfg, "gateway_url", "http://gateway")
    monkeypatch.setattr(tools.cfg, "pipeline_secret", "secret")
    ctx = ToolContext(workspace_id="ws")

    assert "generate_material" not in [
        s["function"]["name"] for s in tools.schemas_for(ctx)
    ]
    ctx.user_id = "u_1"
    assert "generate_material" in [
        s["function"]["name"] for s in tools.schemas_for(ctx)
    ]


# --------------------------------------------------------------- citations


def test_citation_numbers_are_stable_across_tool_calls():
    ctx = ToolContext(workspace_id="ws_1")
    first = tools.remember(ctx, [_passage("c1"), _passage("c2")])
    # A later tool re-retrieves c2 and finds something new.
    second = tools.remember(ctx, [_passage("c2"), _passage("c3")])

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


# ------------------------------------------------------------------ concepts


def test_concept_normalization_is_case_and_space_insensitive():
    assert normalize_concept("  Calvin   Cycle ") == normalize_concept("calvin cycle")


# ----------------------------------------------------------------- workflows


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


def test_overflow_only_triggers_with_more_than_one_document():
    from pipeline.config import cfg

    big = "x" * (cfg.llm_input_budget_tokens * 4)
    one_file = [_passage("c1", file_id="f_1")]
    two_files = one_file + [_passage("c2", file_id="f_2")]

    assert workflows.overflows(big, one_file) is False
    assert workflows.overflows(big, two_files) is True
    assert workflows.overflows("short", two_files) is False


# ------------------------------------------------------- query embed prefix


def _embed_spec(provider_model_id: str) -> ModelConfig:
    return ModelConfig(
        model_key="qwen-embed",
        version=1,
        display_name="embed",
        provider_slug="openrouter",
        base_url="https://example.test",
        provider_model_id=provider_model_id,
        params={"dimensions": 2560},
        surfaces=("embedding",),
    )


def test_qwen3_query_gets_instruct_prefix():
    spec = _embed_spec("qwen/qwen3-embedding-4b")
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
    spec = _embed_spec("qwen/qwen3-embedding-4b")
    seen: dict[str, object] = {}

    async def pin(_ws: str) -> dict[str, object]:
        return {
            "embedding_model_key": "qwen-embed",
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
    assert seen["terms"] == "chlorophyll"


async def test_search_skips_prefix_when_workspace_pin_is_not_qwen3(monkeypatch):
    spec = _embed_spec("text-embedding-3-large")
    seen: dict[str, object] = {}

    async def pin(_ws: str) -> dict[str, object]:
        return {
            "embedding_model_key": "openai-embed",
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


async def test_a_failed_file_summary_retries_instead_of_storing_a_blank(monkeypatch):
    """A blank summary is permanent: nothing refills it and donors copy it."""
    import pytest

    from pipeline.jobs import RetryableError
    from pipeline.retrieval import indexing
    from pipeline.retrieval.chunking import Chunk

    async def _explode(*_a, **_k):
        raise RuntimeError("provider is down")

    monkeypatch.setattr(indexing, "ingest_spec", lambda: object())
    monkeypatch.setattr(indexing.models, "complete_text", _explode)

    with pytest.raises(RetryableError):
        await indexing.summarize_file("bio.pdf", [Chunk(text="Chlorophyll absorbs")])


async def test_the_summary_prompt_excludes_the_uploaders_file_name(monkeypatch):
    """Summaries are copied verbatim to every workspace with the same bytes."""
    from pipeline.retrieval import indexing
    from pipeline.retrieval.chunking import Chunk

    seen: list[str] = []

    async def _capture(messages, **_k):
        seen.append(messages[-1]["content"])
        return '{"descriptor": "Chlorophyll absorbs light.", "summary": "A summary"}'

    monkeypatch.setattr(indexing, "ingest_spec", lambda: object())
    monkeypatch.setattr(indexing.models, "complete_text", _capture)

    descriptor, summary = await indexing.summarize_file(
        "Divorce settlement draft.pdf", [Chunk(text="Chlorophyll absorbs")]
    )

    assert "Divorce settlement draft.pdf" not in seen[0]
    assert "Chlorophyll absorbs" in seen[0]
    assert "Chlorophyll" in descriptor
    assert summary


async def test_the_concept_prompt_excludes_the_uploaders_file_name(monkeypatch):
    """Concepts are copied to every workspace that uploads the same bytes."""
    from pipeline.retrieval import indexing
    from pipeline.retrieval.chunking import Chunk

    seen: list[str] = []

    async def _capture(messages, **_k):
        seen.extend(m["content"] for m in messages)
        return '["chlorophyll"]'

    monkeypatch.setattr(indexing, "ingest_spec", lambda: object())
    monkeypatch.setattr(indexing.models, "complete_text", _capture)

    concepts = await indexing.extract_concepts(
        "Divorce settlement draft.pdf",
        [Chunk(text="Chlorophyll absorbs red and blue light.")],
        [{"id": "chk_1"}],
    )

    blob = "\n".join(seen)
    assert "Divorce settlement draft.pdf" not in blob
    assert "Chlorophyll absorbs red and blue light." in blob
    assert concepts and concepts[0]["name"] == "chlorophyll"
