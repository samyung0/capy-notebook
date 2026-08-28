"""Provider stream assembly: partial args, multiple calls, reasoning, usage."""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from pipeline.elitellm import client as elitellm_client
from pipeline.registry import bind_request_llm
from pipeline.retrieval import models as retrieval_models
from pipeline.retrieval.models import _stream_via_adapter, messages_to_responses_input
from pipeline.retrieval.stream import (
    ChatCompletionsAssembler,
    OpenAIResponsesAssembler,
)


def test_chat_completions_assembles_partial_tool_arguments():
    asm = ChatCompletionsAssembler("deepseek")
    asm.push(
        SimpleNamespace(
            usage=None,
            choices=[
                SimpleNamespace(
                    finish_reason=None,
                    delta=SimpleNamespace(
                        content="hi",
                        tool_calls=[
                            SimpleNamespace(
                                index=0,
                                id="call_1",
                                function=SimpleNamespace(
                                    name="list_sources", arguments=""
                                ),
                            )
                        ],
                    ),
                )
            ],
        )
    )
    asm.push(
        SimpleNamespace(
            usage=SimpleNamespace(prompt_tokens=9, completion_tokens=3),
            choices=[
                SimpleNamespace(
                    finish_reason="tool_calls",
                    delta=SimpleNamespace(
                        content=None,
                        tool_calls=[
                            SimpleNamespace(
                                index=0,
                                id=None,
                                function=SimpleNamespace(name=None, arguments='{"q":'),
                            ),
                            SimpleNamespace(
                                index=1,
                                id="call_2",
                                function=SimpleNamespace(
                                    name="search_workspace", arguments='{"query":"x"}'
                                ),
                            ),
                        ],
                    ),
                )
            ],
        )
    )
    asm.push(
        SimpleNamespace(
            usage=None,
            choices=[
                SimpleNamespace(
                    finish_reason="tool_calls",
                    delta=SimpleNamespace(
                        content=None,
                        tool_calls=[
                            SimpleNamespace(
                                index=0,
                                id=None,
                                function=SimpleNamespace(name=None, arguments='"y"}'),
                            )
                        ],
                    ),
                )
            ],
        )
    )
    out = asm.finish()
    assert out.text == "hi"
    assert [c.id for c in out.tool_calls] == ["call_1", "call_2"]
    assert out.tool_calls[0].arguments == '{"q":"y"}'
    assert out.usage.input_tokens == 9


def test_chat_completions_marks_incomplete_and_ignores_reasoning_text():
    asm = ChatCompletionsAssembler("anthropic")
    asm.push(
        SimpleNamespace(
            usage=None,
            choices=[
                SimpleNamespace(
                    finish_reason="length",
                    delta=SimpleNamespace(
                        content="cut", tool_calls=None, reasoning_content="secret"
                    ),
                )
            ],
        )
    )
    out = asm.finish()
    assert out.text == "cut"
    assert out.status == "incomplete"
    assert "secret" not in out.text


@pytest.mark.asyncio
async def test_anthropic_stream_preserves_tool_call_thinking_and_usage(
    monkeypatch: pytest.MonkeyPatch,
):
    events = [
        {
            "type": "message_start",
            "message": {"usage": {"input_tokens": 11}},
        },
        {
            "type": "content_block_start",
            "index": 0,
            "content_block": {"type": "thinking", "thinking": ""},
        },
        {
            "type": "content_block_delta",
            "index": 0,
            "delta": {"type": "thinking_delta", "thinking": "Search first."},
        },
        {
            "type": "content_block_delta",
            "index": 0,
            "delta": {"type": "signature_delta", "signature": "sig_123"},
        },
        {"type": "content_block_stop", "index": 0},
        {
            "type": "content_block_start",
            "index": 1,
            "content_block": {
                "type": "tool_use",
                "id": "toolu_123",
                "name": "search_workspace",
                "input": {},
            },
        },
        {
            "type": "content_block_delta",
            "index": 1,
            "delta": {"type": "input_json_delta", "partial_json": '{"query":'},
        },
        {
            "type": "content_block_delta",
            "index": 1,
            "delta": {"type": "input_json_delta", "partial_json": '"notes"}'},
        },
        {"type": "content_block_stop", "index": 1},
        {
            "type": "message_delta",
            "delta": {"stop_reason": "tool_use"},
            "usage": {"output_tokens": 4},
        },
        {"type": "message_stop"},
    ]

    async def fake_stream_sse(*_args, **_kwargs):
        for event in events:
            yield event

    monkeypatch.setattr(elitellm_client, "_stream_sse", fake_stream_sse)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    bind_request_llm(paid_by="platform", thinking="high")
    spec = retrieval_models.ModelConfig(
        version=1,
        provider_name="Anthropic",
        model_name="Claude",
        provider_slug="anthropic",
        model_slug="claude-opus-5",
        platform_enabled=True,
        byok_enabled=True,
        thinking_levels=("low", "mid", "high", "max"),
        default_thinking="high",
        surfaces=("chat",),
    )

    out = await _stream_via_adapter(
        spec,
        [{"role": "user", "content": "Search my notes."}],
        [{"type": "function", "function": {"name": "search_workspace"}}],
        None,
        None,
    )

    assert [(call.id, call.name, call.arguments) for call in out.tool_calls] == [
        ("toolu_123", "search_workspace", '{"query":"notes"}')
    ]
    assert out.provider_message["thinking_blocks"] == [
        {
            "type": "thinking",
            "thinking": "Search first.",
            "signature": "sig_123",
        }
    ]
    assert out.usage.input_tokens == 11
    assert out.usage.output_tokens == 4


def test_openai_responses_replays_encrypted_reasoning_and_usage():
    asm = OpenAIResponsesAssembler()
    asm.push(SimpleNamespace(type="response.output_text.delta", delta="Hello"))
    asm.push(
        SimpleNamespace(
            type="response.output_item.done",
            item={
                "type": "reasoning",
                "id": "rs_1",
                "encrypted_content": "enc-secret",
            },
        )
    )
    asm.push(
        SimpleNamespace(
            type="response.function_call_arguments.delta",
            item_id="fc_1",
            delta='{"query":',
        )
    )
    asm.push(
        SimpleNamespace(
            type="response.output_item.added",
            item={
                "type": "function_call",
                "id": "fc_1",
                "call_id": "call_9",
                "name": "search_workspace",
            },
        )
    )
    asm.push(
        SimpleNamespace(
            type="response.function_call_arguments.delta",
            item_id="fc_1",
            delta='"x"}',
        )
    )
    asm.push(SimpleNamespace(type="response.reasoning_text.delta", delta="hidden"))
    asm.push(
        SimpleNamespace(
            type="response.completed",
            response=SimpleNamespace(
                usage=SimpleNamespace(
                    input_tokens=20,
                    output_tokens=5,
                    input_tokens_details=SimpleNamespace(cached_tokens=4),
                ),
                output=[],
            ),
        )
    )
    out = asm.finish()
    assert out.text == "Hello"
    assert "hidden" not in out.text
    assert out.tool_calls[0].id == "call_9"
    assert out.tool_calls[0].arguments == '{"query":"x"}'
    assert any(
        item.get("encrypted_content") == "enc-secret" for item in out.output_items
    )
    assert out.usage.cached_read_tokens == 4


def test_openai_incomplete_and_failed():
    asm = OpenAIResponsesAssembler()
    asm.push(SimpleNamespace(type="response.incomplete", response=None))
    assert asm.finish().status == "incomplete"
    asm = OpenAIResponsesAssembler()
    asm.push(
        SimpleNamespace(
            type="response.failed",
            response=SimpleNamespace(error=SimpleNamespace(message="boom")),
        )
    )
    out = asm.finish()
    assert out.status == "error"
    assert out.error == "boom"


def test_messages_to_responses_input_keeps_encrypted_items():
    items = messages_to_responses_input(
        [
            {"role": "system", "content": "sys"},
            {"role": "user", "content": "q"},
            {
                "role": "assistant",
                "content": "narrating",
                "output_items": [
                    {"type": "reasoning", "encrypted_content": "enc"},
                    {
                        "type": "function_call",
                        "call_id": "c1",
                        "name": "list_sources",
                        "arguments": "{}",
                    },
                ],
            },
            {"role": "tool", "tool_call_id": "c1", "content": "sources"},
        ]
    )
    assert items[0] == {"role": "system", "content": "sys"}
    assert any(i.get("encrypted_content") == "enc" for i in items)
    assert items[-1] == {
        "type": "function_call_output",
        "call_id": "c1",
        "output": "sources",
    }


def test_openai_dedupes_replayed_items_by_id():
    asm = OpenAIResponsesAssembler()
    asm.push(
        SimpleNamespace(
            type="response.output_item.done",
            item={
                "type": "function_call",
                "id": "fc_1",
                "call_id": "call_9",
                "name": "list_sources",
                "arguments": "{}",
            },
        )
    )
    asm.push(
        SimpleNamespace(
            type="response.completed",
            response=SimpleNamespace(
                usage=None,
                output=[
                    {
                        "type": "function_call",
                        "id": "fc_1",
                        "call_id": "call_9",
                        "name": "list_sources",
                        "arguments": "{}",
                        "status": "completed",
                    }
                ],
            ),
        )
    )
    out = asm.finish()
    assert [item.get("id") for item in out.output_items] == ["fc_1"]
    assert not any(
        item.get("type") == "message" and item.get("content") == out.text
        for item in out.output_items
    )


def test_openai_responses_requests_encrypted_content():
    from pipeline.elitellm.client import openai_responses_request

    spec = retrieval_models.ModelConfig(
        version=1,
        provider_name="OpenAI",
        model_name="GPT",
        provider_slug="openai",
        model_slug="gpt-5.6-sol",
        thinking_levels=("instant", "low", "mid", "high", "max"),
        default_thinking="low",
    )
    body = openai_responses_request(
        spec,
        [{"role": "user", "content": "q"}],
        tools=None,
        max_tokens=None,
        thinking="low",
        stream=True,
        response_format=None,
        tool_choice=None,
    )
    assert body.get("include") == ["reasoning.encrypted_content"]
    assert body.get("store") is False
    assert body["input"] == [{"role": "user", "content": "q"}]


def test_messages_to_responses_input_keeps_narration_when_items_lack_text():
    items = messages_to_responses_input(
        [
            {
                "role": "assistant",
                "content": "Looking that up.",
                "output_items": [
                    {"type": "reasoning", "encrypted_content": "enc"},
                    {
                        "type": "function_call",
                        "call_id": "c1",
                        "name": "list_sources",
                        "arguments": "{}",
                    },
                ],
            }
        ]
    )
    assert any(i.get("content") == "Looking that up." for i in items)


def _chat_spec() -> retrieval_models.ModelConfig:
    return retrieval_models.ModelConfig(
        version=1,
        provider_name="DeepSeek",
        model_name="Flash",
        provider_slug="deepseek",
        model_slug="deepseek-v4-flash",
        thinking_levels=("instant", "low", "mid", "high", "max"),
        default_thinking="instant",
    )


class _ChatAPI:
    def __init__(self, streams, errors=None):
        self.streams = list(streams)
        self.errors = list(errors or [])
        self.creates = 0

    class completions:
        def __init__(self, outer):
            self.outer = outer

        async def create(self, **_kwargs):
            self.outer.creates += 1
            if self.outer.errors:
                raise self.outer.errors.pop(0)
            return self.outer.streams.pop(0)

    @property
    def chat(self):
        return SimpleNamespace(completions=self.completions(self))


def _ok_stream(text: str = "ok"):
    async def _ok():
        yield SimpleNamespace(
            usage=SimpleNamespace(prompt_tokens=3, completion_tokens=1),
            choices=[
                SimpleNamespace(
                    finish_reason="stop",
                    delta=SimpleNamespace(content=text, tool_calls=None),
                )
            ],
        )

    return _ok()


async def _noop_async(*_a, **_k):
    return None


def _patch_stream_client(monkeypatch, api, *, abandoned=None, settled=None):
    async def _no_sleep(_delay):
        return None

    async def _abandon(*_a, **_k):
        if abandoned is not None:
            abandoned["n"] += 1

    async def _settle(*_a, **_k):
        if settled is not None:
            settled["n"] += 1

    async def fake_stream(_spec, _messages, **_kwargs):
        stream = await api.chat.completions.create()
        async for chunk in stream:
            yield chunk

    monkeypatch.setattr(retrieval_models.asyncio, "sleep", _no_sleep)
    monkeypatch.setattr(retrieval_models.elitellm, "stream", fake_stream)
    monkeypatch.setattr(
        retrieval_models.elitellm, "uses_responses", lambda _spec, **_kw: False
    )
    monkeypatch.setattr(retrieval_models.accounting, "open_call", _noop_async)
    monkeypatch.setattr(retrieval_models.accounting, "abandon_call", _abandon)
    monkeypatch.setattr(retrieval_models.accounting, "settle", _settle)


@pytest.mark.asyncio
async def test_pre_byte_failure_retries_then_succeeds(monkeypatch):
    abandoned = {"n": 0}
    settled = {"n": 0}
    api = _ChatAPI(
        [_ok_stream("ok")],
        errors=[RuntimeError("connect reset")],
    )
    _patch_stream_client(monkeypatch, api, abandoned=abandoned, settled=settled)

    out = await retrieval_models.stream_agent_response(
        [{"role": "user", "content": "q"}], model=_chat_spec()
    )
    assert out.text == "ok"
    assert api.creates == 2
    assert abandoned["n"] == 1
    assert settled["n"] == 1


@pytest.mark.asyncio
async def test_after_byte_failure_does_not_retry_even_without_client_sse(
    monkeypatch,
):
    async def _partial():
        yield SimpleNamespace(
            usage=None,
            choices=[
                SimpleNamespace(
                    finish_reason=None,
                    delta=SimpleNamespace(content="hi", tool_calls=None),
                )
            ],
        )
        raise RuntimeError("stream dropped")

    abandoned = {"n": 0}
    settled = {"n": 0}
    api = _ChatAPI([_partial(), _ok_stream("late")])
    _patch_stream_client(monkeypatch, api, abandoned=abandoned, settled=settled)

    with pytest.raises(RuntimeError, match="stream dropped"):
        await retrieval_models.stream_agent_response(
            [{"role": "user", "content": "q"}], model=_chat_spec()
        )
    assert api.creates == 1
    assert abandoned["n"] == 1
    assert settled["n"] == 0


@pytest.mark.asyncio
async def test_invalid_user_key_does_not_retry(monkeypatch):
    err = RuntimeError("unauthorized")
    err.status_code = 401
    api = _ChatAPI([], errors=[err, RuntimeError("should not run")])
    _patch_stream_client(monkeypatch, api)
    retrieval_models.registry.bind_request_llm(paid_by="user", user_api_key="sk")
    try:
        with pytest.raises(retrieval_models.UserKeyError) as caught:
            await retrieval_models.stream_agent_response(
                [{"role": "user", "content": "q"}], model=_chat_spec()
            )
        assert caught.value.code == retrieval_models.INVALID_KEY
        assert api.creates == 1
    finally:
        retrieval_models.registry.bind_request_llm()
