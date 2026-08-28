from __future__ import annotations

import json
import os

import pytest

from pipeline.elitellm.client import (
    ANTHROPIC_URL,
    _as_obj,
    _thinking_for_call,
    anthropic_endpoint,
    anthropic_request,
    anthropic_thinking_body,
    assistant_message_from_obj,
    deepseek_request,
    deepseek_thinking_body,
    jsonable,
    message_from_response,
    openai_chat_request,
    openai_reasoning_effort,
    openai_responses_request,
    uses_responses,
)
from pipeline.elitellm.providers import platform_env_name
from pipeline.registry import (
    ModelConfig,
    RegistryError,
    bind_request_llm,
    provider_api_key_for,
)


def _spec(**overrides) -> ModelConfig:
    base = {
        "version": 1,
        "provider_name": "DeepSeek",
        "model_name": "Flash",
        "provider_slug": "deepseek",
        "model_slug": "deepseek-v4-flash",
        "platform_enabled": True,
        "byok_enabled": True,
        "thinking_levels": ("instant", "low", "mid", "high", "max"),
        "default_thinking": "instant",
        "surfaces": ("chat",),
        "params": {"temperature": 0.3},
    }
    base.update(overrides)
    return ModelConfig(**base)


def test_anthropic_uses_first_party_url_and_slug():
    bind_request_llm(paid_by="platform")
    spec = _spec(provider_slug="anthropic", model_slug="claude-opus-5")
    os.environ["ANTHROPIC_API_KEY"] = "sk-ant-platform"
    try:
        url, headers = anthropic_endpoint(spec)
    finally:
        os.environ.pop("ANTHROPIC_API_KEY", None)
    assert url == ANTHROPIC_URL
    assert headers["x-api-key"] == "sk-ant-platform"
    body = anthropic_request(
        spec,
        [{"role": "user", "content": "hi"}],
        temperature=None,
        tools=None,
        max_tokens=16,
        thinking="high",
    )
    assert body["model"] == "claude-opus-5"
    assert body["thinking"] == {"type": "enabled", "budget_tokens": 16384}
    assert body["max_tokens"] > body["thinking"]["budget_tokens"]
    assert "temperature" not in body


def test_anthropic_byok_uses_user_key():
    bind_request_llm(paid_by="user", user_api_key="sk-ant")
    spec = _spec(
        provider_slug="anthropic",
        model_slug="claude-opus-5",
        platform_enabled=True,
        byok_enabled=True,
    )
    url, headers = anthropic_endpoint(spec)
    assert url == ANTHROPIC_URL
    assert headers["x-api-key"] == "sk-ant"


def test_openai_mid_maps_to_medium_and_max_to_xhigh():
    assert openai_reasoning_effort("mid") == "medium"
    assert openai_reasoning_effort("max") == "xhigh"
    assert openai_reasoning_effort("instant") == "none"


def test_openai_uses_responses_only_with_tools_and_thinking():
    spec = _spec(provider_slug="openai", model_slug="gpt-5.6-sol")
    bind_request_llm(thinking="mid")
    assert uses_responses(spec, tools=True) is True
    assert uses_responses(spec, tools=False) is False
    bind_request_llm(thinking="instant")
    assert uses_responses(spec, tools=True) is False


def test_invalid_request_thinking_is_rejected_instead_of_defaulted():
    spec = _spec(
        thinking_levels=("low", "high"),
        default_thinking="high",
    )
    bind_request_llm(thinking="instant")
    with pytest.raises(RegistryError, match="does not support thinking"):
        _thinking_for_call(spec, None)
    with pytest.raises(RegistryError, match="does not support thinking"):
        uses_responses(spec, tools=True)


def test_openai_responses_body_includes_encrypted_content():
    spec = _spec(provider_slug="openai", model_slug="gpt-5.6-sol")
    body = openai_responses_request(
        spec,
        [{"role": "user", "content": "q"}],
        tools=[{"type": "function", "name": "search_workspace", "parameters": {}}],
        max_tokens=16,
        thinking="mid",
        stream=True,
        response_format=None,
        tool_choice=None,
    )
    assert body["model"] == "gpt-5.6-sol"
    assert body["store"] is False
    assert body["include"] == ["reasoning.encrypted_content"]
    assert body["reasoning"] == {"effort": "medium"}


def test_openai_chat_body_sends_reasoning_effort():
    spec = _spec(provider_slug="openai", model_slug="gpt-5.6-sol")
    body = openai_chat_request(
        spec,
        [{"role": "user", "content": "q"}],
        temperature=0.3,
        tools=None,
        response_format=None,
        max_tokens=16,
        thinking="high",
        stream=False,
        tool_choice=None,
    )
    assert body["reasoning_effort"] == "high"
    assert "messages" in body


def test_deepseek_sends_thinking_and_effort():
    spec = _spec()
    on = deepseek_thinking_body("mid")
    assert on == {"thinking": {"type": "enabled"}, "reasoning_effort": "medium"}
    off = deepseek_thinking_body("instant")
    assert off == {"thinking": {"type": "disabled"}}
    body = deepseek_request(
        spec,
        [{"role": "user", "content": "q"}],
        temperature=0.0,
        tools=None,
        response_format=None,
        max_tokens=16,
        thinking="high",
        stream=False,
        tool_choice=None,
    )
    assert body["model"] == "deepseek-v4-flash"
    assert body["thinking"] == {"type": "enabled"}
    assert body["reasoning_effort"] == "high"


def test_deepseek_vision_exp_matches_flash_request_shape():
    messages = [
        {
            "role": "user",
            "content": [
                {"type": "text", "text": "caption"},
                {"type": "image_url", "image_url": {"url": "data:image/png;base64,xx"}},
            ],
        }
    ]
    common = {
        "temperature": 0.3,
        "tools": None,
        "response_format": None,
        "max_tokens": 16,
        "thinking": "instant",
        "stream": False,
        "tool_choice": None,
    }
    flash = deepseek_request(_spec(), messages, **common)
    vision = deepseek_request(
        _spec(model_slug="deepseek-v4-flash-vision-exp"), messages, **common
    )
    assert vision["model"] == "deepseek-v4-flash-vision-exp"
    assert vision["messages"] == flash["messages"] == messages
    assert {key: value for key, value in vision.items() if key != "model"} == {
        key: value for key, value in flash.items() if key != "model"
    }


def test_anthropic_max_is_adaptive():
    assert anthropic_thinking_body("max") == {"type": "adaptive"}
    assert anthropic_thinking_body("instant") == {"type": "disabled"}


def test_anthropic_platform_env_is_first_party():
    assert platform_env_name("anthropic") == "ANTHROPIC_API_KEY"
    assert platform_env_name("openai") == "OPENAI_API_KEY"


def test_platform_key_for_anthropic_reads_anthropic_env(monkeypatch):
    bind_request_llm(paid_by="platform")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant")
    key = provider_api_key_for(
        _spec(provider_slug="anthropic", model_slug="claude-opus-5")
    )
    assert key == "sk-ant"


def test_unknown_provider_is_rejected(monkeypatch):
    bind_request_llm()
    with pytest.raises(RegistryError, match="unknown elitellm provider"):
        provider_api_key_for(_spec(provider_slug="mystery", model_slug="mystery"))


def test_assistant_message_from_complete_is_jsonable():
    raw = _as_obj(
        {
            "choices": [
                {
                    "message": {
                        "role": "assistant",
                        "content": "",
                        "tool_calls": [
                            {
                                "id": "c1",
                                "type": "function",
                                "function": {
                                    "name": "search_workspace",
                                    "arguments": "{}",
                                },
                            }
                        ],
                        "reasoning_content": "think",
                    }
                }
            ]
        }
    )
    msg = assistant_message_from_obj(message_from_response(raw))
    json.dumps(msg)
    assert jsonable(msg)["tool_calls"][0]["function"]["name"] == "search_workspace"
    assert msg["reasoning_content"] == "think"
