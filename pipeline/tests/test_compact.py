from __future__ import annotations

import pytest

from pipeline.registry import AUTH_PLATFORM_OR_USER, ModelConfig
from pipeline.retrieval import compact


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
    pad = "word " * 200
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
