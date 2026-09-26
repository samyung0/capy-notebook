"""Bounded evidence survives history/compaction and reuses only current chunks."""

import json
from dataclasses import asdict

from pipeline.prompts import chat
from pipeline.registry import ModelConfig
from pipeline.retrieval import accounting, compact, evidence, tools
from pipeline.retrieval.search import Passage


def passage(chunk_id, text="Source fact."):
    return Passage(
        chunk_id=chunk_id,
        file_id="f",
        file_name="source.pdf",
        chunk_idx=0,
        section_path="",
        text=text,
    )


async def test_history_reuses_current_passages_and_preserves_tool_notes(monkeypatch):
    first, gone, changed = passage("current"), passage("gone"), passage("changed")

    async def current(workspace, ids):
        assert workspace == "ws" and set(ids) == {"current", "gone", "changed"}
        return [
            {**asdict(first), "id": first.chunk_id},
            {**asdict(changed), "id": changed.chunk_id, "text": "Changed source fact."},
        ]

    monkeypatch.setattr(evidence.store, "history_passages", current)
    ctx = tools.ToolContext(workspace_id="ws")
    tools.assign_citations(ctx, [passage("other")])
    saved = {
        "tools": [{"name": "list_sources", "text": "full source listing"}],
        "passages": [asdict(first), asdict(gone), asdict(changed)],
    }
    history = await evidence.history_turns(
        [
            {"id": "u", "role": "user", "content": "About my source"},
            {
                "id": "a",
                "role": "assistant",
                "content": "Earlier answer [1]",
                "toolEvidence": saved,
            },
        ],
        ctx,
    )
    assert len(history) == 6 and history[-1]["id"] == "a"
    assert history[1]["role"] == "assistant"
    assert all(
        t["role"] == "user" and t["_kind"] == "source_evidence" for t in history[2:]
    )
    content = "\n".join(turn["content"] for turn in history)
    assert (
        "[2] source.pdf\nSource fact." in content and "full source listing" in content
    )
    assert "gone in file f is no longer available" in content
    assert "changed in file f is no longer available" in content
    assert "Changed source fact." not in content
    assert [p.chunk_id for p in ctx.citations] == ["other", "current"]
    messages = chat.chat_messages(
        locale="en", checkpoint=None, history=history, query="Explain it"
    )
    assert messages[-1]["_kind"] == "query"
    summary = chat.checkpoint_messages(
        prior_memory="", turns=history, current_user_message="Explain it"
    )
    assert "untrusted_source_data" in summary[-1]["content"]
    assert "historical, not verified current contents" in summary[0]["content"]
    assert (
        "Source fact." in summary[-1]["content"]
        and "full source listing" in summary[-1]["content"]
    )
    restricted = await evidence.history_turns(
        history=[{"role": "assistant", "toolEvidence": saved}],
        ctx=tools.ToolContext(workspace_id="ws", file_ids=[]),
    )
    assert all("Source fact." not in turn["content"] for turn in restricted)


def test_pack_keeps_only_cited_passages_and_all_selected_results():
    first = passage("cited")
    ctx = tools.ToolContext(
        workspace_id="ws",
        citations=[first, passage("unused")],
        evidence_passage_ids={"cited", "unused"},
    )
    ctx.evidence_notes = [
        {"name": "list_sources", "text": "日" * 8192} for _ in range(6)
    ]
    packed = evidence.pack(ctx, [1, 1])
    assert [p["chunk_id"] for p in packed["passages"]] == ["cited"]
    assert packed["tools"] == ctx.evidence_notes
    assert evidence.pack(ctx, [])["passages"] == []


async def test_full_results_batch_as_conversation_context_on_a_small_window(
    monkeypatch,
):
    results = [
        {"name": "list_sources", "text": f"result-{i}:" + "日" * 8192}
        for i in range(14)
    ]
    turns = await evidence.history_turns(
        [
            {
                "id": "a",
                "role": "assistant",
                "content": "Answer",
                "toolEvidence": {"tools": results},
            }
        ],
        tools.ToolContext(workspace_id="ws"),
    )
    assert len(turns) == 15
    measured = accounting.measure_context(turns)
    assert measured.conversation_tokens > 14 * 8192 and measured.tool_tokens == 0
    received = []

    async def summarize(messages, **_):
        payload = json.loads(messages[-1]["content"])
        received.extend(payload["new_completed_messages"] + payload["recent_messages"])
        return "Durable source memory"

    monkeypatch.setattr(compact.models, "complete_text", summarize)
    spec = ModelConfig(
        version=1,
        provider_name="DeepSeek",
        model_name="Flash",
        provider_slug="deepseek",
        model_slug="deepseek-v4-flash",
        thinking_levels=("high",),
        default_thinking="high",
        context_window_tokens=32_768,
    )
    summary = await compact.summarize_checkpoint(
        prior_summary="", turns=turns, current_user_message="Follow up", spec=spec
    )
    assert summary == "Durable source memory"
    assert [t["content"] for t in received] == [t["content"] for t in turns]
    assert all(t["provenance"] == "untrusted_source_data" for t in received[1:])
