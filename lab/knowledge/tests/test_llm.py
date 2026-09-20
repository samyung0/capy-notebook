import json

import httpx
import llm
import pytest
import store

SCHEMA = {
    "type": "object",
    "properties": {"n": {"type": "integer"}},
    "required": ["n"],
    "additionalProperties": False,
}


def reply(content, request_id="req-1"):
    return httpx.Response(
        200,
        json={
            "choices": [{"message": {"content": content, "reasoning": "ignored"}}],
            "usage": {
                "prompt_tokens": 5,
                "completion_tokens": 2,
                "completion_tokens_details": {"reasoning_tokens": 1},
            },
        },
        headers={"x-request-id": request_id},
    )


@pytest.fixture(autouse=True)
def no_sleep(monkeypatch):
    waited = []
    monkeypatch.setattr(llm.time, "sleep", waited.append)
    return waited


def test_ollama_waits_and_retries_on_connection_error_429_and_5xx(no_sleep):
    seen = []

    def handler(request):
        seen.append(json.loads(request.content)["model"])
        if len(seen) == 1:
            raise httpx.ConnectError("refused", request=request)
        if len(seen) == 2:
            return httpx.Response(429, headers={"retry-after": "7"})
        if len(seen) == 3:
            return httpx.Response(
                502, headers={"retry-after": "Wed, 21 Oct 2026 07:28:00 GMT"}
            )
        return reply('```json\n{"n": 3}\n```')

    result = llm.complete(
        [{"role": "user", "content": "count"}],
        SCHEMA,
        stage="topics",
        sha256="s",
        transport=httpx.MockTransport(handler),
    )
    assert result.value == {"n": 3} and result.endpoint == llm.OLLAMA
    assert seen == ["glm-5.3-flash:cloud"] * 4 and no_sleep == [5, 7.0, 60]
    assert result.usage == {
        "prompt_tokens": 5,
        "completion_tokens": 2,
        "reasoning_tokens": 1,
    }
    calls = store.llm_usage(0)[llm.OLLAMA]
    assert calls["calls"] == 4 and calls["ok"] == 1 and calls["input_tokens"] == 5


def test_the_fourth_transport_failure_raises_without_another_endpoint(no_sleep):
    with pytest.raises(llm.LLMError, match="after 3 retries"):
        llm.complete(
            [{"role": "user", "content": "c"}],
            SCHEMA,
            stage="t",
            transport=httpx.MockTransport(lambda request: httpx.Response(503)),
        )
    assert no_sleep == [5, 20, 60]
    assert store.llm_usage(0)[llm.OLLAMA]["calls"] == 4


def test_schema_failure_retries_once_then_raises_and_4xx_raises_at_once(no_sleep):
    seen = []

    def handler(request):
        seen.append(str(request.url))
        body = json.loads(request.content)
        assert (
            body["reasoning_effort"] == "low"
            and body["response_format"]["type"] == "json_schema"
        )
        assert "JSON schema" in body["messages"][-1]["content"]
        return reply('{"n": "three"}')

    with pytest.raises(llm.SchemaError):
        llm.complete(
            [{"role": "user", "content": "count"}],
            SCHEMA,
            stage="topics",
            transport=httpx.MockTransport(handler),
        )
    assert seen == [llm.OLLAMA, llm.OLLAMA] and no_sleep == []
    with pytest.raises(llm.LLMError, match="400"):
        llm.complete(
            [{"role": "user", "content": "c"}],
            SCHEMA,
            stage="t",
            transport=httpx.MockTransport(
                lambda request: httpx.Response(400, text="bad")
            ),
        )


def test_alibaba_live_call_is_strict_json_schema_with_thinking_off(monkeypatch):
    monkeypatch.setenv("ALIBABA_API_KEY", "key")
    monkeypatch.setenv("ALIBABA_BASE_URL", "https://alibaba.test/compatible-mode/v1/")
    captured = {}

    def handler(request):
        captured["url"] = str(request.url)
        captured["auth"] = request.headers.get("authorization")
        captured["body"] = json.loads(request.content)
        return reply('{"n": 1}')

    result = llm.alibaba(
        [{"role": "user", "content": "review"}],
        SCHEMA,
        stage="review",
        sha256="s",
        transport=httpx.MockTransport(handler),
    )
    assert captured["url"] == "https://alibaba.test/compatible-mode/v1/chat/completions"
    assert captured["auth"] == "Bearer key"
    body = captured["body"]
    assert body["model"] == "qwen3.8-flash" and body["enable_thinking"] is False
    assert "thinking_budget" not in body and body["temperature"] == 0
    assert body["response_format"]["json_schema"] == {
        "name": "review",
        "strict": True,
        "schema": SCHEMA,
    }
    assert body["messages"] == [{"role": "user", "content": "review"}]
    assert result.model == "qwen3.8-flash" and result.request_id == "req-1"
    # the batch body is the same request with the thinking budget
    batch = llm.alibaba_body(body["messages"], SCHEMA, thinking=True)
    assert batch["enable_thinking"] is True and batch["thinking_budget"] == 4096


def test_alibaba_needs_both_env_values(monkeypatch):
    monkeypatch.delenv("ALIBABA_API_KEY", raising=False)
    monkeypatch.setenv("ALIBABA_BASE_URL", "https://alibaba.test/v1")
    with pytest.raises(llm.LLMError, match="ALIBABA_BASE_URL and ALIBABA_API_KEY"):
        llm.alibaba([], SCHEMA, stage="review")


def test_images_ride_on_the_last_user_message_as_data_urls():
    captured = {}

    def handler(request):
        captured.update(json.loads(request.content))
        return reply('{"n": 1}')

    llm.complete(
        [{"role": "system", "content": "rules"}, {"role": "user", "content": "text"}],
        SCHEMA,
        stage="scrape",
        images=[b"a", b"b"],
        transport=httpx.MockTransport(handler),
    )
    user = captured["messages"][1]["content"]
    assert user[0] == {"type": "text", "text": "text"}
    assert [p["type"] for p in user[1:]] == ["image_url", "image_url"]
    assert user[1]["image_url"]["url"].startswith("data:image/jpeg;base64,")
    assert captured["messages"][-1]["role"] == "system"
