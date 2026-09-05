from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

import pytest

from pipeline.config import env_name_for_provider
from pipeline.elitellm import (
    CONTINUITY_KEYS,
    observed_continuity,
    uses_responses,
)
from pipeline.elitellm.client import (
    anthropic_request,
    deepseek_request,
    openai_responses_request,
    zai_request,
)
from pipeline.model_replay_cert import two_turn_cassette_ok
from pipeline.registry import ModelConfig, bind_request_llm
from pipeline.retrieval.models import stream_agent_response

REPO = Path(__file__).resolve().parents[2]
MANIFEST = Path(__file__).parent / "model_replay_certifications.json"

SEARCH_TOOL = {
    "type": "function",
    "function": {
        "name": "search_workspace",
        "description": "Search the user's notes.",
        "parameters": {
            "type": "object",
            "properties": {"query": {"type": "string"}},
            "required": ["query"],
        },
    },
}
PROMPT = (
    "Call search_workspace with query photosynthesis. "
    "Do not answer until the tool result is available."
)


def _load_manifest() -> dict:
    raw = json.loads(MANIFEST.read_text())
    assert isinstance(raw, dict)
    return raw


def _certified_refs() -> list[tuple[str, str]]:
    return sorted(
        (provider_slug, model_id)
        for provider_slug, models in _load_manifest().items()
        for model_id in models
    )


def _entry(provider_slug: str, model_id: str) -> dict:
    return _load_manifest()[provider_slug][model_id]


def _cassette_path(provider_slug: str, model_id: str) -> Path:
    return REPO / _entry(provider_slug, model_id)["cassette"]


def _spec(provider_slug: str, model_id: str) -> ModelConfig:
    if provider_slug == "anthropic":
        levels = ("low", "mid", "high", "max")
        default = "high"
    elif provider_slug == "zai":
        levels = ("low", "high", "max")
        default = "max"
    else:
        levels = ("instant", "low", "mid", "high", "max")
        default = "instant"
    return ModelConfig(
        version=1,
        provider_name="replay",
        model_name="replay",
        provider_slug=provider_slug,
        model_slug=model_id,
        platform_enabled=True,
        byok_enabled=False,
        thinking_levels=levels,
        default_thinking=default,
        params={"temperature": 0},
        slots=("chat",),
    )


def _dump(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, dict):
        return {str(key): _dump(child) for key, child in value.items()}
    if isinstance(value, list):
        return [_dump(item) for item in value]
    dump = getattr(value, "model_dump", None)
    if callable(dump):
        return _dump(dump())
    return value


def _contains_key(obj: Any, key: str) -> bool:
    if isinstance(obj, dict):
        if key in obj and obj[key] not in (None, "", [], {}):
            return True
        return any(_contains_key(item, key) for item in obj.values())
    if isinstance(obj, list):
        return any(_contains_key(item, key) for item in obj)
    return False


def _tool_call_id(message: dict[str, Any]) -> str:
    for call in message.get("tool_calls") or []:
        if isinstance(call, dict):
            ident = call.get("id") or call.get("call_id")
        else:
            ident = getattr(call, "id", None) or getattr(call, "call_id", None)
        if ident:
            return str(ident)
    for item in message.get("output_items") or []:
        if str(item.get("type") or "") == "function_call":
            ident = item.get("call_id") or item.get("id")
            if ident:
                return str(ident)
    return ""


def _cert_thinking(spec: ModelConfig) -> str:
    if spec.default_thinking not in ("", "instant"):
        return spec.default_thinking
    for level in ("low", "mid", "high"):
        if level in spec.thinking_levels:
            return level
    return spec.default_thinking


async def _turn(
    spec: ModelConfig,
    messages: list[dict[str, Any]],
) -> dict[str, Any]:
    bind_request_llm(paid_by="platform", thinking=_cert_thinking(spec))
    assembled = await stream_agent_response(
        messages,
        model=spec,
        tools=[SEARCH_TOOL],
        temperature=0.0,
    )
    echoed = _dump(assembled.provider_message)
    if assembled.output_items:
        echoed["output_items"] = _dump(assembled.output_items)
    return echoed


@pytest.mark.parametrize(
    "provider_slug,model_id",
    _certified_refs(),
    ids=[f"{provider}/{model}" for provider, model in _certified_refs()],
)
def test_certified_manifest_has_two_turn_cassette(provider_slug: str, model_id: str):
    entry = _entry(provider_slug, model_id)
    cassette = _cassette_path(provider_slug, model_id)
    assert two_turn_cassette_ok(cassette), cassette
    assert entry["test"].endswith(f"[{provider_slug}/{model_id}]")


@pytest.mark.parametrize(
    "provider_slug,model_id",
    _certified_refs(),
    ids=[f"{provider}/{model}" for provider, model in _certified_refs()],
)
def test_certified_request_shape(provider_slug: str, model_id: str):
    spec = _spec(provider_slug, model_id)
    if spec.provider_slug == "anthropic":
        assert uses_responses(spec, tools=True) is False
        body = anthropic_request(
            spec,
            [{"role": "user", "content": "q"}],
            temperature=0.0,
            tools=[SEARCH_TOOL],
            max_tokens=4096,
            thinking=spec.default_thinking,
        )
        assert body["model"] == model_id
        assert body["thinking"]["type"] == "enabled"
        assert body["max_tokens"] > body["thinking"]["budget_tokens"]
        assert "temperature" not in body
        return
    if spec.provider_slug == "openai":
        assert uses_responses(spec, tools=True) is True
        body = openai_responses_request(
            spec,
            [{"role": "user", "content": "q"}],
            tools=[SEARCH_TOOL],
            max_tokens=4096,
            thinking=_cert_thinking(spec),
            stream=True,
            response_format=None,
            tool_choice=None,
        )
        assert body["model"] == model_id
        assert body["include"] == ["reasoning.encrypted_content"]
        assert body["stream"] is True
        return
    if spec.provider_slug == "zai":
        assert uses_responses(spec, tools=True) is False
        body = zai_request(
            spec,
            [{"role": "user", "content": "q"}],
            temperature=0.0,
            tools=[SEARCH_TOOL],
            response_format=None,
            max_tokens=4096,
            thinking="max",
            stream=True,
            tool_choice="auto",
        )
        assert body["model"] == "zai-org/GLM-5.3-Flash"
        assert body["reasoning_effort"] == "max"
        assert "thinking" not in body
        assert body["stream"] is True
        return
    assert spec.provider_slug == "deepseek"
    assert uses_responses(spec, tools=True) is False
    body = deepseek_request(
        spec,
        [{"role": "user", "content": "q"}],
        temperature=0.0,
        tools=[SEARCH_TOOL],
        response_format=None,
        max_tokens=4096,
        thinking="instant",
        stream=False,
        tool_choice="auto",
    )
    assert body["model"] == model_id
    assert body["thinking"] == {"type": "disabled"}


@pytest.mark.parametrize(
    "provider_slug,model_id",
    _certified_refs(),
    ids=[f"{provider}/{model}" for provider, model in _certified_refs()],
)
async def test_certified_two_turn_replay(
    provider_slug: str, model_id: str, replay_cassette, monkeypatch
):
    spec = _spec(provider_slug, model_id)
    captured: list[dict[str, Any]] = []
    from pipeline.elitellm import client as elitellm_client

    real_stream = elitellm_client._stream_sse

    async def spy_stream(url, headers, body):
        captured.append(body)
        async for event in real_stream(url, headers, body):
            yield event

    monkeypatch.setattr(elitellm_client, "_stream_sse", spy_stream)
    if os.environ.get("EVO_TEST_RECORD", "none") == "none":
        monkeypatch.setenv(env_name_for_provider(provider_slug), "sk-replay")

    user = [{"role": "user", "content": PROMPT}]
    first = await _turn(spec, user)
    call_id = _tool_call_id(first)
    assert call_id, f"{model_id} first turn had no tool call"
    continuity = observed_continuity(first)
    assert continuity, f"{model_id} first turn had no continuity field"

    await _turn(
        spec,
        [
            *user,
            first,
            {
                "role": "tool",
                "tool_call_id": call_id,
                "content": '{"passages":[]}',
            },
        ],
    )
    assert len(captured) == 2, (
        f"{model_id} expected two provider calls, got {len(captured)}"
    )
    payload = captured[1].get("input") or captured[1].get("messages")
    for key in continuity:
        assert _contains_key(payload, key), f"{model_id} lost {key} on the second turn"
    if os.environ.get("EVO_TEST_RECORD", "none") == "none":
        recorded = replay_cassette.read_text()
        assert recorded.count("\n    method:") >= 2 or recorded.count("method:") >= 2


def test_missing_certified_cassette_fails():
    missing = REPO / "pipeline/tests/cassettes/replay/not-a-certified-model.yaml"
    assert not missing.exists()
    assert not two_turn_cassette_ok(missing)


def test_router_slug_does_not_inherit_direct_cert():
    manifest = _load_manifest()
    assert "deepseek-v4-flash" in manifest["deepseek"]
    assert "deepinfra" not in manifest
    assert not (manifest.get("deepinfra") or {}).get("deepseek-v4-flash")


def test_continuity_keys_cover_known_providers():
    assert "reasoning_content" in CONTINUITY_KEYS
    assert "thinking_blocks" in CONTINUITY_KEYS
    assert "encrypted_content" in CONTINUITY_KEYS
