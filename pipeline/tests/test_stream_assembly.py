"""Provider stream assembly: partial args, multiple calls, reasoning, usage."""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from pipeline.retrieval import models as retrieval_models
from pipeline.retrieval.models import messages_to_responses_input
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


@pytest.mark.asyncio
async def test_openai_responses_requests_encrypted_content(monkeypatch):
    captured = {}

    class _API:
        class responses:
            @staticmethod
            async def create(**kwargs):
                captured.update(kwargs)

                async def gen():
                    yield SimpleNamespace(
                        type="response.completed",
                        response=SimpleNamespace(usage=None, output=[]),
                    )

                return gen()

    monkeypatch.setattr(
        retrieval_models,
        "_openai_responses_reasoning",
        lambda *_a, **_k: {"effort": "low"},
    )
    spec = retrieval_models.ModelConfig(
        model_key="gpt",
        version=1,
        display_name="GPT",
        provider_slug="openai",
        base_url="https://api.openai.com/v1",
        provider_model_id="gpt-5",
    )
    await retrieval_models._stream_openai_responses(
        _API(), spec, [{"role": "user", "content": "q", "_kind": "query"}], None, None
    )
    assert captured.get("include") == ["reasoning.encrypted_content"]
    assert captured.get("store") is False
    assert captured["input"] == [{"role": "user", "content": "q"}]


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
