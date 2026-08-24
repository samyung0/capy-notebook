from __future__ import annotations

import pytest

from pipeline.registry import AUTH_PLATFORM_OR_USER, ModelConfig
from pipeline.retrieval import accounting, compact


def _spec(**overrides) -> ModelConfig:
    base = {
        "model_key": "deepseek-flash",
        "version": 1,
        "display_name": "Flash",
        "provider_slug": "deepseek",
        "base_url": "https://api.deepseek.com",
        "provider_model_id": "deepseek-v4-flash",
        "auth_mode": AUTH_PLATFORM_OR_USER,
        "context_window_tokens": 200,
    }
    base.update(overrides)
    return ModelConfig(**base)


def test_needs_compact_ignores_short_history():
    spec = _spec(context_window_tokens=10_000)
    assert not compact.needs_compact(
        [{"role": "system", "content": "s"}, {"role": "user", "content": "hi"}],
        spec,
    )


def test_tail_start_keeps_tool_call_with_result():
    messages = [
        {"role": "system", "content": "s"},
        {"role": "user", "content": "q"},
        {
            "role": "assistant",
            "content": "",
            "tool_calls": [{"function": {"name": "search_workspace"}}],
        },
        {"role": "tool", "content": "hits"},
        {"role": "user", "content": "1"},
        {"role": "user", "content": "2"},
        {"role": "user", "content": "3"},
        {"role": "user", "content": "4"},
        {"role": "user", "content": "5"},
    ]
    assert compact._tail_start(messages, 1) == 2


@pytest.mark.asyncio
async def test_compact_summarizes_middle(monkeypatch):
    pad = "word " * 2000
    messages = [
        {"role": "system", "content": "sys"},
        *[
            {
                "role": "user" if i % 2 == 0 else "assistant",
                "content": pad,
            }
            for i in range(8)
        ],
        {"role": "user", "content": "latest question"},
    ]

    async def fake_complete(*_args, **_kwargs):
        return "kept facts"

    monkeypatch.setattr(compact.models, "complete_text", fake_complete)
    out = await compact.compact_messages(messages, _spec())
    assert out[0]["content"] == "sys"
    assert out[1]["content"].startswith("Earlier conversation:")
    assert "kept facts" in out[1]["content"]
    assert out[-1]["content"] == "latest question"


@pytest.mark.asyncio
async def test_compact_does_not_swallow_accounting_failure(monkeypatch):
    messages = [
        {"role": "system", "content": "sys"},
        *[
            {
                "role": "user" if i % 2 == 0 else "assistant",
                "content": "old " * 20_000,
            }
            for i in range(8)
        ],
        {"role": "user", "content": "latest question"},
    ]

    async def fail_settlement(*_args, **_kwargs):
        raise accounting.AccountingError("settlement outcome unknown")

    monkeypatch.setattr(compact.models, "complete_text", fail_settlement)
    with pytest.raises(accounting.AccountingError):
        await compact.compact_messages(messages, _spec())


def test_needs_compact_uses_input_budget_not_full_window():
    spec = _spec(context_window_tokens=20_000)
    # input_budget is max(4000, 20000-8192)=11808; 90% is about 10627.
    pad = "word " * 10_000
    assert compact.needs_compact([{"role": "user", "content": pad}], spec)


def test_openai_live_chain_start_protects_after_last_user():
    messages = [
        {"role": "system", "content": "s"},
        {"role": "user", "content": "q"},
        {"role": "assistant", "content": "", "tool_calls": [{"id": "c1"}]},
        {"role": "tool", "tool_call_id": "c1", "content": "hits"},
    ]
    assert compact.openai_live_chain_start(messages) == 1
    done = [*messages, {"role": "assistant", "content": "answer"}]
    assert compact.openai_live_chain_start(done) == 1
    idle = [
        {"role": "system", "content": "s"},
        {"role": "user", "content": "q"},
        {"role": "assistant", "content": "done"},
    ]
    assert compact.openai_live_chain_start(idle) == len(idle)


@pytest.mark.asyncio
async def test_summarize_checkpoint_keeps_structured_refs(monkeypatch):
    seen = {}

    async def fake_complete(messages, **_kwargs):
        seen["user"] = messages[1]["content"]
        return (
            '{"summary":"kept","source_refs":['
            '{"fileId":"f1","chunkId":"c1","fileName":"a.pdf","snippet":"hi"}]}'
        )

    monkeypatch.setattr(compact.models, "complete_text", fake_complete)
    out = await compact.summarize_checkpoint(
        prior_summary="old",
        prior_refs=[{"fileId": "f1", "chunkId": "c1", "fileName": "a.pdf"}],
        turns=[
            {
                "role": "assistant",
                "content": "a",
                "citations": [{"fileId": "f1", "chunkId": "c1", "fileName": "a.pdf"}],
            }
        ],
        spec=_spec(),
    )
    assert out["summary"] == "kept"
    assert out["source_refs"][0]["chunkId"] == "c1"
    assert "f1" in seen["user"]
    assert "c1" in seen["user"]
    assert "Known sources" in seen["user"]


@pytest.mark.asyncio
async def test_checkpoint_summary_request_fits_pinned_input_budget(monkeypatch):
    spec = _spec(context_window_tokens=5_000)

    async def fake_complete(messages, **_kwargs):
        assert compact.estimate_messages(messages) <= compact.registry.input_budget(
            spec
        )
        return '{"summary":"kept","source_refs":[]}'

    monkeypatch.setattr(compact.models, "complete_text", fake_complete)
    await compact.summarize_checkpoint(
        prior_summary="old " * 10_000,
        prior_refs=[
            {
                "fileId": f"f{i}",
                "chunkId": f"c{i}",
                "fileName": "source.pdf",
                "snippet": "evidence " * 500,
            }
            for i in range(100)
        ],
        turns=[],
        spec=spec,
    )


@pytest.mark.asyncio
async def test_openai_compacts_prefix_keeps_live_chain(monkeypatch):
    pad = "word " * 2000
    messages = [
        {"role": "system", "content": "sys"},
        *[
            {"role": "user" if i % 2 == 0 else "assistant", "content": pad}
            for i in range(8)
        ],
        {"role": "user", "content": "1"},
        {"role": "user", "content": "2"},
        {"role": "user", "content": "3"},
        {"role": "user", "content": "4"},
        {"role": "user", "content": "5"},
        {"role": "user", "content": "current q"},
        {
            "role": "assistant",
            "content": "n",
            "output_items": [
                {"type": "reasoning", "id": "rs1", "encrypted_content": "enc"}
            ],
        },
        {"role": "tool", "tool_call_id": "c1", "content": "hits"},
    ]

    async def fake_complete(*_a, **_k):
        return "folded"

    monkeypatch.setattr(compact.models, "complete_text", fake_complete)
    out = await compact.compact_messages(messages, _spec(), protect_openai_chain=True)
    assert any(
        item.get("encrypted_content") == "enc"
        for message in out
        for item in message.get("output_items") or []
    )
    assert any(m.get("content") == "hits" for m in out)


@pytest.mark.asyncio
async def test_openai_strips_output_items_when_live_chain_overflows(monkeypatch):
    messages = [
        {"role": "system", "content": "sys"},
        {"role": "user", "content": "q"},
        {
            "role": "assistant",
            "content": "n",
            "output_items": [
                {"type": "reasoning", "id": "rs1", "encrypted_content": "enc"}
            ],
        },
        {"role": "tool", "tool_call_id": "c1", "content": "x" * 20_000},
    ]

    async def fake_complete(*_a, **_k):
        return "folded"

    monkeypatch.setattr(compact.models, "complete_text", fake_complete)
    out = await compact.compact_messages(messages, _spec(), protect_openai_chain=True)
    assert not any(m.get("output_items") for m in out)
    assert compact.estimate_messages(out) < compact.estimate_messages(messages)


@pytest.mark.asyncio
async def test_terminal_compaction_clips_without_another_model_call(monkeypatch):
    messages = [
        {"role": "system", "content": "sys"},
        {"role": "user", "content": "old " * 20_000},
        {"role": "assistant", "content": "working"},
        {"role": "tool", "tool_call_id": "c1", "content": "result " * 20_000},
    ]

    async def fail_complete(*_args, **_kwargs):
        raise AssertionError("terminal preparation must not spend a compaction call")

    monkeypatch.setattr(compact.models, "complete_text", fail_complete)
    spec = _spec()
    out = await compact.compact_messages(
        messages,
        spec,
        extra=500,
        allow_summary=False,
    )

    assert compact.fits_request(out, spec, extra=500)
    assert out[0]["role"] == "system"
    assert out[-1]["role"] == "tool"


def test_clip_messages_reserves_tool_schema_budget():
    spec = _spec()
    messages = [
        {"role": "system", "content": "sys"},
        {"role": "user", "content": "question " * 10_000},
    ]
    out = compact.clip_messages(messages, spec, extra=1_000)
    assert compact.fits_request(out, spec, extra=1_000)
