from __future__ import annotations

import asyncio
import json
import os

import httpx
import pytest

from pipeline.config import cfg
from pipeline.elitellm.client import (
    ANTHROPIC_URL,
    DEEPINFRA_CHAT_URL,
    DEEPINFRA_EMBED_URL,
    DEEPINFRA_GLM_FLASH_MODEL,
    _as_obj,
    _thinking_for_call,
    anthropic_endpoint,
    anthropic_request,
    anthropic_thinking_body,
    assistant_message_from_obj,
    deepseek_request,
    deepseek_thinking_body,
    embed_batch,
    jsonable,
    message_from_response,
    openai_chat_request,
    openai_reasoning_effort,
    openai_responses_request,
    transport_model_slug,
    transport_provider_slug,
    uses_responses,
    zai_request,
    zai_thinking_body,
)
from pipeline.elitellm.client import (
    complete as elitellm_complete,
)
from pipeline.elitellm.client import stream as elitellm_stream
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
        "slots": ("chat",),
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


def test_no_reasoning_uses_provider_off_or_lowest_setting():
    vision = _spec(
        provider_slug="openai",
        model_slug="gpt-5.6-luna",
        thinking_levels=(),
        default_thinking="",
        slots=("captioning",),
    )

    assert _thinking_for_call(vision, False) == ""
    assert _thinking_for_call(_spec(thinking_levels=("low", "high")), False) == ""
    zai_vision = _spec(
        provider_slug="zai",
        model_slug="glm-5.3-flash",
        thinking_levels=("low", "high", "max"),
        default_thinking="max",
        slots=("chat", "captioning"),
    )
    assert _thinking_for_call(zai_vision, False) == "low"
    assert _thinking_for_call(zai_vision, None) == "max"


def test_zai_caption_request_uses_deepinfra_low_reasoning():
    spec = _spec(
        provider_slug="zai",
        model_slug="glm-5.3-flash",
        thinking_levels=("low", "high", "max"),
        default_thinking="max",
        slots=("chat", "captioning"),
    )
    messages = [
        {
            "role": "user",
            "content": [
                {"type": "text", "text": "Describe this image."},
                {
                    "type": "image_url",
                    "image_url": {"url": "data:image/png;base64,eA=="},
                },
            ],
        }
    ]
    body = zai_request(
        spec,
        messages,
        temperature=0.2,
        tools=None,
        response_format=None,
        max_tokens=None,
        thinking="low",
        stream=False,
        tool_choice=None,
    )

    assert body["model"] == DEEPINFRA_GLM_FLASH_MODEL
    assert body["messages"] == messages
    assert "thinking" not in body
    assert body["reasoning_effort"] == "low"
    with pytest.raises(RegistryError, match="supports only low"):
        zai_thinking_body("")


@pytest.mark.asyncio
async def test_zai_complete_uses_exact_deepinfra_exception(
    monkeypatch: pytest.MonkeyPatch,
):
    spec = _spec(
        provider_slug="zai",
        model_slug="glm-5.3-flash",
        thinking_levels=("low", "high", "max"),
        default_thinking="max",
        slots=("chat", "captioning"),
    )
    seen: dict[str, object] = {}

    async def post_json(url, headers, body):
        seen.update(url=url, headers=headers, body=body)
        return {
            "choices": [{"message": {"role": "assistant", "content": "caption"}}],
            "usage": {"prompt_tokens": 1, "completion_tokens": 1},
        }

    bind_request_llm(paid_by="platform")
    monkeypatch.setenv("DEEPINFRA_API_KEY", "sk-deepinfra")
    monkeypatch.setattr("pipeline.elitellm.client._post_json", post_json)

    response = await elitellm_complete(
        spec,
        [{"role": "user", "content": "caption"}],
        reasoning=False,
    )

    assert seen["url"] == DEEPINFRA_CHAT_URL
    assert seen["headers"] == {
        "authorization": "Bearer sk-deepinfra",
        "content-type": "application/json",
    }
    assert seen["body"]["model"] == DEEPINFRA_GLM_FLASH_MODEL
    assert seen["body"]["reasoning_effort"] == "low"
    assert transport_provider_slug(spec) == "deepinfra"
    assert transport_model_slug(spec) == DEEPINFRA_GLM_FLASH_MODEL
    assert response.choices[0].message.content == "caption"


@pytest.mark.asyncio
async def test_zai_stream_uses_deepinfra_and_max_by_default(
    monkeypatch: pytest.MonkeyPatch,
):
    spec = _spec(
        provider_slug="zai",
        model_slug="glm-5.3-flash",
        byok_enabled=False,
        thinking_levels=("low", "high", "max"),
        default_thinking="max",
        slots=("chat", "captioning"),
    )
    seen: dict[str, object] = {}

    async def stream_sse(url, headers, body):
        seen.update(url=url, headers=headers, body=body)
        yield {"choices": [{"delta": {"content": "ok"}}]}

    bind_request_llm(paid_by="platform")
    monkeypatch.setenv("DEEPINFRA_API_KEY", "sk-deepinfra")
    monkeypatch.setattr("pipeline.elitellm.client._stream_sse", stream_sse)

    chunks = [
        chunk
        async for chunk in elitellm_stream(spec, [{"role": "user", "content": "hi"}])
    ]

    assert len(chunks) == 1
    assert seen["url"] == DEEPINFRA_CHAT_URL
    assert seen["body"]["model"] == DEEPINFRA_GLM_FLASH_MODEL
    assert seen["body"]["reasoning_effort"] == "max"
    assert seen["body"]["stream"] is True


@pytest.mark.asyncio
async def test_qwen_embedding_uses_exact_deepinfra_route(
    monkeypatch: pytest.MonkeyPatch,
):
    seen: dict[str, object] = {}

    async def post_json(url, headers, body):
        seen.update(url=url, headers=headers, body=body)
        return {"data": [{"embedding": [0.0, 1.0]}], "usage": {}}

    monkeypatch.setenv("DEEPINFRA_API_KEY", "sk-deepinfra")
    monkeypatch.setattr("pipeline.elitellm.client._post_json", post_json)
    spec = _spec(
        provider_slug="deepinfra",
        model_slug="Qwen/Qwen3-Embedding-4B",
        byok_enabled=False,
        thinking_levels=(),
        default_thinking="",
        slots=("retrieval",),
    )

    await embed_batch(spec, ["one", "two"], dimensions=2560)

    assert seen["url"] == DEEPINFRA_EMBED_URL
    assert seen["body"] == {
        "model": "Qwen/Qwen3-Embedding-4B",
        "input": ["one", "two"],
        "dimensions": 2560,
        "encoding_format": "float",
    }


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
    assert platform_env_name("zai") == "DEEPINFRA_API_KEY"


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


# ---- transport: busy answers and the idle timer ---------------------------


class _Chunks(httpx.AsyncByteStream):
    """Emit SSE bytes on a schedule so the timers can be observed."""

    def __init__(self, parts: list[tuple[float, bytes]]) -> None:
        self._parts = parts

    async def __aiter__(self):
        for delay, chunk in self._parts:
            await asyncio.sleep(delay)
            yield chunk


_mock_clients: list[httpx.AsyncClient] = []


@pytest.fixture(autouse=True)
async def _close_mock_clients():
    yield
    while _mock_clients:
        await _mock_clients.pop().aclose()


def _mock_client(monkeypatch, handler):
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    _mock_clients.append(client)
    monkeypatch.setattr("pipeline.elitellm.client._client", lambda: client)
    return client


async def test_busy_answers_carry_retry_after(monkeypatch):
    from pipeline.elitellm import client as transport

    def handler(_request):
        return httpx.Response(429, headers={"retry-after": "7"}, text="slow down")

    _mock_client(monkeypatch, handler)
    with pytest.raises(transport.ProviderError) as caught:
        await transport._post_json("https://example.test/v1", {}, {"a": 1})
    assert caught.value.busy
    assert caught.value.retry_after == 7.0
    assert caught.value.status_code == 429

    def http_date(_request):
        return httpx.Response(
            503, headers={"retry-after": "Thu, 01 Jan 2099 00:00:00 GMT"}
        )

    _mock_client(monkeypatch, http_date)
    with pytest.raises(transport.ProviderError) as caught:
        await transport._post_json("https://example.test/v1", {}, {})
    assert caught.value.busy and caught.value.retry_after > 0

    def bad_request(_request):
        return httpx.Response(400, text="nope")

    _mock_client(monkeypatch, bad_request)
    with pytest.raises(transport.ProviderError) as caught:
        await transport._post_json("https://example.test/v1", {}, {})
    assert not caught.value.busy and caught.value.retry_after is None


def _sse(payloads: list[tuple[float, str]]) -> _Chunks:
    return _Chunks([(delay, f"data: {body}\n\n".encode()) for delay, body in payloads])


async def _collect(monkeypatch, stream: httpx.AsyncByteStream) -> list[dict]:
    from pipeline.elitellm import client as transport

    def handler(_request):
        return httpx.Response(200, stream=stream)

    _mock_client(monkeypatch, handler)
    return [
        event
        async for event in transport._stream_sse("https://example.test/v1", {}, {})
    ]


async def test_stream_idle_timer_restarts_on_every_data_event(monkeypatch):
    monkeypatch.setattr(cfg, "interactive_provider_timeout_s", 0.5)
    monkeypatch.setattr(cfg, "interactive_stream_max_s", 10.0)
    # Eight events 0.1 s apart run 0.8 s in total, past the idle bound, with a
    # five-fold margin on each gap for a slow CI scheduler.
    events = await _collect(
        monkeypatch, _sse([(0.1, f'{{"n": {n}}}') for n in range(8)])
    )
    assert [event["n"] for event in events] == list(range(8))


async def test_consumer_stalls_are_not_provider_silence(monkeypatch):
    from pipeline.elitellm import client as transport

    monkeypatch.setattr(cfg, "interactive_provider_timeout_s", 0.3)
    monkeypatch.setattr(cfg, "interactive_stream_max_s", 10.0)

    def handler(_request):
        return httpx.Response(200, stream=_sse([(0, '{"n": 0}'), (0, '{"n": 1}')]))

    _mock_client(monkeypatch, handler)
    seen = []
    async for event in transport._stream_sse("https://example.test/v1", {}, {}):
        seen.append(event["n"])
        # Longer than the idle bound: only reads from the provider are timed.
        await asyncio.sleep(0.5)
    assert seen == [0, 1]


async def test_stream_silence_past_the_idle_bound_times_out(monkeypatch):
    monkeypatch.setattr(cfg, "interactive_provider_timeout_s", 0.5)
    monkeypatch.setattr(cfg, "interactive_stream_max_s", 10.0)
    with pytest.raises(TimeoutError):
        await _collect(monkeypatch, _sse([(0.05, '{"n": 0}'), (1.5, '{"n": 1}')]))


async def test_keep_alive_comments_do_not_count_as_activity(monkeypatch):
    monkeypatch.setattr(cfg, "interactive_provider_timeout_s", 0.5)
    monkeypatch.setattr(cfg, "interactive_stream_max_s", 10.0)
    # Comment keep-alives and empty data frames both leave the clock running.
    parts = [(0.05, b'data: {"n": 0}\n\n')] + [
        (0.05, b": keep-alive\n\n"),
        (0.05, b"data:\n\n"),
    ] * 12
    with pytest.raises(TimeoutError):
        await _collect(monkeypatch, _Chunks(parts))


async def test_stream_backstop_bounds_a_trickling_stream(monkeypatch):
    monkeypatch.setattr(cfg, "interactive_provider_timeout_s", 5.0)
    monkeypatch.setattr(cfg, "interactive_stream_max_s", 0.5)
    with pytest.raises(TimeoutError):
        await _collect(monkeypatch, _sse([(0.05, f'{{"n": {n}}}') for n in range(60)]))


async def test_stream_error_status_is_a_busy_provider_error(monkeypatch):
    from pipeline.elitellm import client as transport

    def handler(_request):
        return httpx.Response(529, headers={"retry-after": "2"}, text="overloaded")

    _mock_client(monkeypatch, handler)
    with pytest.raises(transport.ProviderError) as caught:
        async for _event in transport._stream_sse("https://example.test/v1", {}, {}):
            pass
    assert caught.value.busy and caught.value.retry_after == 2.0
