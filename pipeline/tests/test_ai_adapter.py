import asyncio
from types import SimpleNamespace

import pytest

from pipeline.registry import ModelConfig, RegistryError, bind_request_llm
from pipeline.retrieve import ai_adapter
from pipeline.retrieve.ai_adapter import (
    AIAdapterError,
    GhostTextReq,
    _ensure_provider,
    ghost_suggestion,
)


class _Connected:
    async def is_disconnected(self) -> bool:
        return False


class _Disconnected:
    async def is_disconnected(self) -> bool:
        await asyncio.sleep(0)
        return True


async def test_disconnected_completion_waits_for_cancellation_cleanup(monkeypatch):
    cleanup_started = asyncio.Event()
    release_cleanup = asyncio.Event()

    async def complete_response(*_args, **_kwargs):
        try:
            await asyncio.Future()
        except asyncio.CancelledError:
            cleanup_started.set()
            await release_cleanup.wait()
            raise

    monkeypatch.setattr(ai_adapter.models, "complete_response", complete_response)
    monkeypatch.setattr(ai_adapter.registry, "input_budget", lambda _model: 100)
    waiting = asyncio.create_task(
        ai_adapter._wait_completion(
            _Disconnected(), [{"role": "user", "content": "hello"}], model=object()
        )
    )
    await cleanup_started.wait()
    assert not waiting.done()

    release_cleanup.set()
    with pytest.raises(asyncio.CancelledError):
        await waiting


def test_ghost_suggestion_keeps_one_line_and_joins_at_the_caret():
    assert ghost_suggestion("split into ", " two pyruvate.\nMore") == "two pyruvate."
    assert ghost_suggestion("split into", " two pyruvate.") == " two pyruvate."
    assert ghost_suggestion("清廷調兵入川鎮壓，", "武昌兵力空虛。") == "武昌兵力空虛。"


async def test_ghost_text_sends_the_caret_prompt_with_reasoning_off(monkeypatch):
    seen: dict[str, object] = {}

    async def fake_wait(_request, messages, **kwargs):
        seen.update(kwargs, messages=messages)
        return SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content=" two ATP."))]
        )

    monkeypatch.setattr(ai_adapter, "_editor_spec", lambda _req: object())
    monkeypatch.setattr(ai_adapter, "_ensure_provider", lambda _spec: None)
    monkeypatch.setattr(ai_adapter, "_wait_completion", fake_wait)
    req = GhostTextReq(
        workspaceId="ws_1",
        thinking="instant",
        title="Cell respiration",
        before="Glycolysis yields ",
        after=" per glucose.",
    )
    assert await ai_adapter.plate_copilot(req, _Connected()) == {"text": "two ATP."}
    assert seen["reasoning"] is False
    assert seen["max_tokens"] == 40
    assert seen["messages"][1]["content"] == (
        "Title: Cell respiration\n\nGlycolysis yields <CARET> per glucose."
    )


def test_ensure_provider_accepts_a_string_key(monkeypatch):
    spec = ModelConfig(
        version=1,
        provider_name="DeepSeek",
        model_name="Flash",
        provider_slug="deepseek",
        model_slug="deepseek-v4-flash",
        slots=("editor",),
    )
    bind_request_llm()
    monkeypatch.setattr(
        ai_adapter.registry, "provider_api_key_for", lambda _spec: "sk-test"
    )
    _ensure_provider(spec)


def test_ensure_provider_maps_missing_platform_key(monkeypatch):
    spec = ModelConfig(
        version=1,
        provider_name="DeepSeek",
        model_name="Flash",
        provider_slug="deepseek",
        model_slug="deepseek-v4-flash",
        slots=("editor",),
    )
    bind_request_llm()

    def missing(_spec):
        raise RegistryError("missing key")

    monkeypatch.setattr(ai_adapter.registry, "provider_api_key_for", missing)
    with pytest.raises(AIAdapterError, match="not configured"):
        _ensure_provider(spec)
