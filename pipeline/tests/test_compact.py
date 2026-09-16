from __future__ import annotations

import json
import re

import pytest

from pipeline import elitellm, registry
from pipeline.elitellm.client import anthropic_request
from pipeline.prompts import chat as chat_prompts
from pipeline.registry import ModelConfig
from pipeline.retrieval import accounting, compact


def _spec(**overrides) -> ModelConfig:
    base = {
        "version": 1,
        "provider_name": "DeepSeek",
        "model_name": "Flash",
        "provider_slug": "deepseek",
        "model_slug": "deepseek-v4-flash",
        "platform_enabled": True,
        "byok_enabled": True,
        "thinking_levels": ("instant", "low"),
        "default_thinking": "instant",
        "context_window_tokens": 20_000,
    }
    base.update(overrides)
    return ModelConfig(**base)


def test_compaction_uses_full_usable_budget_not_a_ratio(monkeypatch):
    spec = _spec()
    usable = compact.usable_input_limit(spec)
    measured = {"tokens": usable}

    def _measure(*_args, **_kwargs):
        return accounting.ContextComposition(conversation_tokens=measured["tokens"])

    monkeypatch.setattr(compact, "request_context", _measure)
    assert not compact.needs_compact([{"role": "user", "content": "q"}], spec)
    measured["tokens"] += 1
    assert compact.needs_compact([{"role": "user", "content": "q"}], spec)


def test_compaction_caps_large_model_input_at_250k():
    usable = compact.usable_input_limit(_spec(context_window_tokens=1_000_000))

    assert usable == (
        compact.EFFECTIVE_INPUT_LIMIT_TOKENS - compact.PROTOCOL_SAFETY_MARGIN_TOKENS
    )


def test_checkpoint_summary_has_12000_token_budget():
    assert chat_prompts.SUMMARY_TARGET_MIN == 4000
    assert chat_prompts.SUMMARY_TARGET_MAX == 10000
    assert chat_prompts.SUMMARY_MAX_TOKENS == 12000
    assert "Target 4,000 to 10,000 tokens" in chat_prompts.CHECKPOINT_SYSTEM_PROMPT
    assert "Never exceed 12,000 tokens" in chat_prompts.CHECKPOINT_SYSTEM_PROMPT


def test_catalog_margin_can_apply_calibrated_estimation_error():
    plain = compact.usable_input_limit(_spec())
    calibrated = compact.usable_input_limit(
        _spec(params={"context_safety_margin_tokens": 2048})
    )
    assert plain - calibrated == 2048 - compact.PROTOCOL_SAFETY_MARGIN_TOKENS


@pytest.mark.parametrize(
    "thinking,output",
    [("instant", 8192), ("low", 8192), ("mid", 12288), ("high", 20480), ("max", 8192)],
)
def test_admission_reserves_the_same_anthropic_output_as_the_request(thinking, output):
    spec = _spec(
        provider_slug="anthropic",
        context_window_tokens=200_000,
        thinking_levels=("instant", "low", "mid", "high", "max"),
        default_thinking=thinking,
    )
    registry.bind_request_llm(thinking=thinking)
    try:
        body = anthropic_request(
            spec, [], temperature=None, tools=None, max_tokens=None, thinking=thinking
        )
        assert body["max_tokens"] == elitellm.output_budget(spec) == output
        assert (
            compact.usable_input_limit(spec)
            + body["max_tokens"]
            + compact.PROTOCOL_SAFETY_MARGIN_TOKENS
            == 200_000
        )
        assert (
            compact.usable_input_limit(spec, max_tokens=8000, reasoning=False)
            == 200_000 - 8000 - compact.PROTOCOL_SAFETY_MARGIN_TOKENS
        )
        assert (
            compact.usable_input_limit(spec, max_tokens=65_536)
            == 200_000 - 65_536 - compact.PROTOCOL_SAFETY_MARGIN_TOKENS
        )
    finally:
        registry.bind_request_llm()


def test_high_reasoning_pending_overflow_is_explicit_before_the_provider_call():
    from pipeline.retrieval import pending

    spec = _spec(
        provider_slug="anthropic",
        context_window_tokens=200_000,
        thinking_levels=("high",),
        default_thinking="high",
    )
    messages = [
        {"role": "system", "content": "system"},
        {"role": "user", "content": "question", "_kind": "query"},
    ]
    sources = pending.PendingSources(
        [{"fileId": "f", "changes": [{"after": "x" * 561_000}]}]
    )
    block, _, omitted = pending.reserve(messages, sources, spec, None)
    assert omitted
    assert "omitted" in block["content"]
    assert compact.fits_request(pending.inject(messages, block), spec)


@pytest.mark.asyncio
async def test_checkpoint_prompt_uses_current_message_only_to_resolve_references(
    monkeypatch,
):
    seen = {}

    async def fake_complete(messages, **kwargs):
        seen["system"] = messages[0]["content"]
        seen["payload"] = json.loads(messages[1]["content"])
        seen["max_tokens"] = kwargs["max_tokens"]
        return "The third bullet was to reject every invalid id."

    monkeypatch.setattr(compact.models, "complete_text", fake_complete)
    summary = await compact.summarize_checkpoint(
        prior_summary="Earlier plan",
        turns=[
            {
                "role": "assistant",
                "content": "1. Keep it. 2. Rename it. 3. Reject every invalid id.",
            }
        ],
        current_user_message="What did you mean by the third bullet?",
        spec=_spec(context_window_tokens=100_000),
    )

    assert summary.startswith("The third bullet")
    assert seen["payload"]["current_user_message"] == (
        "What did you mean by the third bullet?"
    )
    assert seen["payload"]["new_completed_messages"] == []
    assert seen["payload"]["recent_messages"] == [
        {
            "role": "assistant",
            "content": "1. Keep it. 2. Rename it. 3. Reject every invalid id.",
        }
    ]
    assert "third bullet" in seen["system"]
    assert "let its topic narrow" in seen["system"]
    assert seen["max_tokens"] == chat_prompts.SUMMARY_MAX_TOKENS


@pytest.mark.asyncio
async def test_checkpoint_separates_six_recent_messages(monkeypatch):
    seen = {}

    async def fake_complete(messages, **_kwargs):
        seen.update(json.loads(messages[1]["content"]))
        return "memory"

    monkeypatch.setattr(compact.models, "complete_text", fake_complete)
    turns = [
        {
            "role": "user" if index % 2 == 0 else "assistant",
            "content": f"turn-{index}",
        }
        for index in range(8)
    ]

    await compact.summarize_checkpoint(
        prior_summary="prior",
        turns=turns,
        current_user_message="current",
        spec=_spec(context_window_tokens=100_000),
    )

    assert [turn["content"] for turn in seen["new_completed_messages"]] == [
        "turn-0",
        "turn-1",
    ]
    assert [turn["content"] for turn in seen["recent_messages"]] == [
        f"turn-{index}" for index in range(2, 8)
    ]


@pytest.mark.asyncio
async def test_checkpoint_folds_every_turn_in_chronological_batches(monkeypatch):
    payloads = []

    async def fake_complete(messages, **_kwargs):
        payload = json.loads(messages[1]["content"])
        payloads.append(payload)
        labels = [
            turn["content"].split()[0]
            for turn in [
                *payload["new_completed_messages"],
                *payload["recent_messages"],
            ]
        ]
        return (payload["previous_memory"] + " " + " ".join(labels)).strip()

    monkeypatch.setattr(compact.models, "complete_text", fake_complete)
    turns = [
        {
            "role": "user" if index % 2 == 0 else "assistant",
            "content": f"turn-{index} " + ("detail " * 700),
        }
        for index in range(8)
    ]
    summary = await compact.summarize_checkpoint(
        prior_summary="prior",
        turns=turns,
        current_user_message="current",
        # 16k window less the 12k summary reserve leaves the same small usable
        # input this test needs to force more than one chronological batch.
        spec=_spec(context_window_tokens=16_000),
    )

    assert len(payloads) > 1
    assert summary.split() == ["prior", *[f"turn-{index}" for index in range(8)]]
    assert all(payload["current_user_message"] == "current" for payload in payloads)


@pytest.mark.asyncio
async def test_empty_summary_fails_instead_of_advancing_checkpoint(monkeypatch):
    async def fake_complete(*_args, **_kwargs):
        return ""

    monkeypatch.setattr(compact.models, "complete_text", fake_complete)
    with pytest.raises(compact.InvalidSummary):
        await compact.summarize_checkpoint(
            prior_summary="",
            turns=[{"role": "assistant", "content": "answer"}],
            current_user_message="next question",
            spec=_spec(context_window_tokens=100_000),
        )


@pytest.mark.asyncio
async def test_live_compaction_preserves_current_query_and_active_chain(monkeypatch):
    messages = [
        {"role": "system", "content": "system"},
        {"role": "user", "content": "old " * 15_000},
        {"role": "assistant", "content": "old answer"},
        {"role": "user", "content": "current exact question", "_kind": "query"},
        {"role": "tool", "tool_call_id": "c0", "content": "search passages"},
        {
            "role": "assistant",
            "content": "working",
            "output_items": [
                {"type": "reasoning", "id": "rs1", "encrypted_content": "enc"}
            ],
        },
        {"role": "tool", "tool_call_id": "c1", "content": "result"},
    ]

    async def fake_complete(*_args, **_kwargs):
        return "old memory"

    monkeypatch.setattr(compact.models, "complete_text", fake_complete)
    out = await compact.compact_messages(messages, _spec(context_window_tokens=30_000))

    assert any(message.get("content") == "current exact question" for message in out)
    assert any(message.get("content") == "search passages" for message in out)
    assert any(
        item.get("encrypted_content") == "enc"
        for message in out
        for item in message.get("output_items") or []
    )


@pytest.mark.asyncio
async def test_protected_context_is_refused_not_clipped():
    messages = [
        {"role": "system", "content": "system"},
        {"role": "user", "content": "current " * 20_000, "_kind": "query"},
    ]
    with pytest.raises(compact.ContextTooLarge):
        await compact.compact_messages(
            messages,
            _spec(context_window_tokens=10_000),
            allow_summary=False,
        )


@pytest.mark.asyncio
async def test_live_compaction_reuses_existing_memory_without_resummarizing(
    monkeypatch,
):
    async def should_not_run(*_args, **_kwargs):
        raise AssertionError("existing memory must not be summarized again")

    monkeypatch.setattr(compact.models, "complete_text", should_not_run)
    messages = [
        {"role": "system", "content": "system"},
        {
            "role": "user",
            "content": "Earlier conversation:\nprior memory",
            "_kind": "memory",
            "_memory": "prior memory",
        },
        {"role": "user", "content": "current " * 20_000, "_kind": "query"},
    ]

    with pytest.raises(compact.ContextTooLarge):
        await compact.compact_messages(
            messages,
            _spec(context_window_tokens=10_000),
        )


@pytest.mark.asyncio
async def test_live_compaction_folds_older_turn_exchanges_into_a_note(monkeypatch):
    def exchange(n: int) -> list[dict]:
        return [
            {
                "role": "assistant",
                "content": "",
                "tool_calls": [
                    {
                        "id": f"c{n}",
                        "type": "function",
                        "function": {"name": "read_document", "arguments": "{}"},
                    }
                ],
                "output_items": [
                    {"type": "reasoning", "id": f"rs{n}", "encrypted_content": "enc"}
                ],
            },
            {
                "role": "tool",
                "tool_call_id": f"c{n}",
                "content": f"[{n}] passage {n} " * 1_500,
            },
        ]

    messages = [
        {"role": "system", "content": "system"},
        {"role": "user", "content": "current exact question", "_kind": "query"},
        *exchange(1),
        *exchange(2),
        *exchange(3),
        *exchange(4),
    ]
    seen: list[dict] = []

    async def fake_complete(request, **_kwargs):
        seen.append(json.loads(request[-1]["content"]))
        return "turn note"

    monkeypatch.setattr(compact.models, "complete_text", fake_complete)
    out = await compact.compact_messages(messages, _spec(context_window_tokens=30_000))

    assert out[1]["content"] == "current exact question"
    assert out[2]["_kind"] == "turn_note" and out[2]["_note"] == "turn note"
    kept = {m.get("tool_call_id") for m in out if m.get("role") == "tool"}
    assert kept == {"c3", "c4"}
    assert [
        m["output_items"][0]["id"] for m in out if m.get("role") == "assistant"
    ] == [
        "rs3",
        "rs4",
    ]
    # Only the folded exchanges reach the summarizer, without provider protocol state.
    assert [
        step["tool_call_id"] for step in seen[0]["steps"] if "tool_call_id" in step
    ] == [
        "c1",
        "c2",
    ]
    assert "output_items" not in json.dumps(seen[0])
    assert seen[0]["current_user_message"] == "current exact question"


_EXCERPT = re.compile(r"ex_f\d+s\d+")


def _curate_exchange(call_id: str, name: str, result: str) -> list[dict]:
    return [
        {
            "role": "assistant",
            "content": "",
            "tool_calls": [
                {
                    "id": call_id,
                    "type": "function",
                    "function": {"name": name, "arguments": json.dumps({"n": call_id})},
                }
            ],
        },
        {"role": "tool", "tool_call_id": call_id, "content": result},
    ]


def _curate_turn(files: int = 8, sections: int = 4) -> list[list[dict]]:
    """One search, one full read and one material receipt per library section."""
    turn: list[list[dict]] = []
    for index in range(files * sections):
        sid = f"f{index // sections:02d}s{index % sections}"
        hits = "\n".join(
            f"[{n}] ex_{sid} | section {n} | score 0.8 " + "hit snippet text " * 18
            for n in range(12)
        )
        body = f"ex_{sid}\n" + "section prose sentence " * 220
        turn.append(_curate_exchange(f"s{index}", "search_knowledge", hits))
        turn.append(_curate_exchange(f"r{index}", "read_knowledge", body))
        turn.append(
            _curate_exchange(f"w{index}", "create_material", f"Created ex_{sid} note.")
        )
    return turn


@pytest.mark.asyncio
async def test_curate_turn_folds_every_section_without_losing_an_excerpt_id(
    monkeypatch,
):
    """A 32-section curate turn on a 64k window: repeated folds, nothing dropped."""
    folds = {"count": 0}

    async def fake_complete(request, **_kwargs):
        folds["count"] += 1
        payload = json.loads(request[-1]["content"])
        ids = sorted(set(_EXCERPT.findall(json.dumps(payload["steps"]))))
        return " ".join([payload["previous_note"], *ids]).strip()

    monkeypatch.setattr(compact.models, "complete_text", fake_complete)
    spec = _spec(context_window_tokens=64_000)
    messages: list[dict] = [
        {"role": "system", "content": "system"},
        {"role": "user", "content": "Note every section.", "_kind": "query"},
    ]
    kept_after_fold: list[int] = []

    for exchange in _curate_turn():
        before = folds["count"]
        messages = await compact.compact_messages(
            messages, spec, protect_live_chain=True, allow_summary=True
        )
        if folds["count"] > before:
            kept_after_fold.append(
                sum(1 for m in messages if m.get("role") == "assistant")
            )
        messages.extend(exchange)

    assert folds["count"] >= 2
    assert kept_after_fold and all(kept <= 2 for kept in kept_after_fold)
    note = " ".join(
        str(m.get("_note") or "") for m in messages if m.get("_kind") == "turn_note"
    )
    verbatim = json.dumps([m for m in messages if m.get("_kind") != "turn_note"])
    retained = set(_EXCERPT.findall(note)) | set(_EXCERPT.findall(verbatim))
    assert {f"ex_f{i // 4:02d}s{i % 4}" for i in range(32)} <= retained
