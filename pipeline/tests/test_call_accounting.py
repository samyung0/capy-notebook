from __future__ import annotations

import asyncio
import json
import math
from pathlib import Path

import pytest

from pipeline.registry import ModelConfig
from pipeline.retrieval import accounting, models
from pipeline.retrieval.usage_extract import NormalizedUsage
from pipeline.store import db


def _spec(**overrides) -> ModelConfig:
    values = {
        "version": 1,
        "provider_name": "DeepSeek",
        "model_name": "Flash",
        "provider_slug": "deepseek",
        "model_slug": "deepseek-v4-flash",
        "thinking_levels": ("instant", "low", "high"),
        "default_thinking": "instant",
        "context_window_tokens": 100_000,
    }
    values.update(overrides)
    return ModelConfig(**values)


async def test_settlement_retry_reuses_call_id_and_returns_exhaustion(monkeypatch):
    monkeypatch.setattr(accounting.cfg, "gateway_url", "http://gateway")
    monkeypatch.setattr(accounting.cfg, "pipeline_secret", "secret")
    sent = []

    class Response:
        status_code = 200
        text = ""

        @staticmethod
        def json():
            return {
                "creditsExhausted": True,
                "terminalCallAllowed": True,
                "duplicate": False,
            }

    def post(_url, **kwargs):
        sent.append(kwargs["json"])
        if len(sent) == 1:
            raise accounting.requests.Timeout("lost response")
        return Response()

    async def no_sleep(*_args):
        return None

    monkeypatch.setattr(accounting.requests, "post", post)
    monkeypatch.setattr(accounting.asyncio, "sleep", no_sleep)
    token = accounting.bind("cr_1")
    try:
        state = await accounting.settle(
            call_id="pc_1",
            kind=accounting.KIND_LLM,
            purpose=accounting.PURPOSE_AGENT,
            thinking="high",
            spec=_spec(),
            usage=NormalizedUsage(
                input_tokens=10,
                output_tokens=4,
                cached_read_tokens=3,
            ),
        )
    finally:
        accounting.reset(token)

    assert len(sent) == 2
    assert sent[0] == sent[1]
    assert sent[0]["callId"] == "pc_1"
    assert sent[0]["thinking"] == "high"
    assert sent[0]["cachedReadTokens"] == 3
    assert state is not None
    assert state.credits_exhausted
    assert state.terminal_call_allowed


async def test_settlement_is_a_noop_outside_chat():
    state = await accounting.settle(
        call_id="pc_1",
        kind=accounting.KIND_LLM,
        purpose=accounting.PURPOSE_AGENT,
        thinking="instant",
        spec=_spec(),
        usage=NormalizedUsage(input_tokens=1),
    )
    assert state is None


async def test_glm_settles_under_its_catalog_pair(monkeypatch):
    """Capacity and usage rows key on zai/glm-5.3-flash since Z.AI serves it
    (2026-10-20); the relace transport pair is gone."""
    monkeypatch.setattr(accounting.cfg, "gateway_url", "http://gateway")
    monkeypatch.setattr(accounting.cfg, "pipeline_secret", "secret")
    sent = {}

    async def post_settlement(payload):
        sent.update(payload)
        return {}

    monkeypatch.setattr(accounting, "_post_settlement", post_settlement)
    token = accounting.bind("cr_glm")
    try:
        await accounting.settle(
            call_id="pc_glm",
            kind=accounting.KIND_LLM,
            purpose=accounting.PURPOSE_AGENT,
            thinking="max",
            spec=_spec(
                provider_slug="zai",
                model_slug="glm-5.3-flash",
                thinking_levels=("low", "high", "max"),
                default_thinking="max",
            ),
            usage=NormalizedUsage(input_tokens=10, output_tokens=4),
        )
    finally:
        accounting.reset(token)

    assert sent["provider"] == "zai"
    assert sent["model"] == "glm-5.3-flash"
    assert sent["thinking"] == "max"
    assert "modelVersion" not in sent


async def test_rerank_settles_under_its_own_catalog_version(monkeypatch):
    """A rerank names its catalog version, and its late background reply
    never rolls back the exhaustion flags a newer LLM settlement set."""
    monkeypatch.setattr(accounting.cfg, "gateway_url", "http://gateway")
    monkeypatch.setattr(accounting.cfg, "pipeline_secret", "secret")
    sent = {}

    async def post_settlement(payload):
        sent.update(payload)
        return {"creditsExhausted": False, "terminalCallAllowed": False}

    monkeypatch.setattr(accounting, "_post_settlement", post_settlement)
    token = accounting.bind("cr_rerank")
    state = accounting.current()
    state.credits_exhausted = state.terminal_call_allowed = True
    try:
        await accounting.settle(
            call_id="pc_rerank",
            kind=accounting.KIND_RERANK,
            purpose=accounting.KIND_RERANK,
            thinking="",
            spec=_spec(
                version=3,
                provider_slug="deepinfra",
                model_slug="Qwen/Qwen3-Reranker-4B",
                thinking_levels=(),
                default_thinking="",
            ),
            usage=NormalizedUsage(input_tokens=268),
        )
    finally:
        accounting.reset(token)

    assert (sent["kind"], sent["purpose"], sent["provider"], sent["model"]) == (
        "rerank",
        "rerank",
        "deepinfra",
        "Qwen/Qwen3-Reranker-4B",
    )
    assert sent["modelVersion"] == 3 and sent["inputTokens"] == 268
    assert state.credits_exhausted and state.terminal_call_allowed


async def test_open_and_abandon_are_noop_when_unbound():
    await accounting.open_call("pc_1", kind=accounting.KIND_LLM, purpose="agent")
    await accounting.abandon_call("pc_1")


async def test_cancelled_tracked_call_waits_for_receipt_deadline(monkeypatch):
    events: list[str] = []

    async def open_call(*_args, **_kwargs):
        events.append("open")

    async def abandon_call(*_args, **_kwargs):
        events.append("abandon")

    monkeypatch.setattr(accounting, "open_call", open_call)
    monkeypatch.setattr(accounting, "abandon_call", abandon_call)

    with pytest.raises(asyncio.CancelledError):
        async with models._tracked_call(kind=accounting.KIND_LLM, purpose="agent"):
            raise asyncio.CancelledError

    assert events == ["open"]


async def test_settlement_failure_does_not_abandon_successful_provider_call(
    monkeypatch,
):
    events: list[str] = []

    async def open_call(*_args, **_kwargs):
        events.append("open")

    async def abandon_call(*_args, **_kwargs):
        events.append("abandon")

    monkeypatch.setattr(accounting, "open_call", open_call)
    monkeypatch.setattr(accounting, "abandon_call", abandon_call)

    with pytest.raises(accounting.SettlementError):
        async with models._tracked_call(kind=accounting.KIND_LLM, purpose="agent"):
            raise accounting.SettlementError("database unavailable")

    assert events == ["open"]


async def test_local_receipt_settlement_retries_the_same_call(monkeypatch):
    attempts: list[str] = []

    class TransientDatabaseError(RuntimeError):
        sqlstate = "40001"

    def settle(call_id: str) -> None:
        attempts.append(call_id)
        if len(attempts) < 3:
            raise TransientDatabaseError("serialization retry")

    async def no_sleep(_delay: float) -> None:
        return None

    monkeypatch.setattr(accounting.asyncio, "sleep", no_sleep)
    await accounting._retry_local_settlement(
        settle,
        "pc_same",
        deadline=accounting.time.monotonic() + 60,
    )

    assert attempts == ["pc_same", "pc_same", "pc_same"]


async def test_local_receipt_settlement_rejects_deterministic_error_once():
    attempts = 0

    def settle() -> None:
        nonlocal attempts
        attempts += 1
        raise RuntimeError("call identity mismatch")

    with pytest.raises(accounting.SettlementError, match="rejected"):
        await accounting._retry_local_settlement(
            settle,
            deadline=accounting.time.monotonic() + 12 * 60 * 60,
        )

    assert attempts == 1


async def test_cancellation_waits_for_known_receipt_to_finish():
    started = asyncio.Event()
    release = asyncio.Event()
    finished = asyncio.Event()

    async def receipt() -> None:
        started.set()
        await release.wait()
        finished.set()

    settlement = asyncio.create_task(accounting._finish_known_receipt(receipt()))
    await started.wait()
    settlement.cancel()
    await asyncio.sleep(0)
    assert not settlement.done()

    release.set()
    with pytest.raises(asyncio.CancelledError):
        await settlement
    assert finished.is_set()


def _counting_estimates(monkeypatch) -> list:
    """The values the context estimator walks, in order."""
    walked: list = []
    real = accounting.estimate_context_value

    def counting(value):
        walked.append(value)
        return real(value)

    monkeypatch.setattr(accounting, "estimate_context_value", counting)
    return walked


def test_a_model_call_estimates_only_messages_it_has_not_measured(monkeypatch):
    """(security regression: rate-limit audit Q238) A request's estimate sums
    each message's kept estimate: the next call's request walks only the
    message added since, never the whole context again."""
    walked = _counting_estimates(monkeypatch)
    messages = [
        {"role": "system", "content": "rules " * 200},
        {"role": "user", "content": "question " * 300},
        {"role": "assistant", "content": "answer " * 300},
    ]
    first = models.measure_request_context(messages, model=_spec())
    assert len(walked) == len(messages)
    walked.clear()
    added = {"role": "tool", "tool_call_id": "c1", "content": "result " * 100}
    messages.append(added)

    second = models.measure_request_context(messages, model=_spec())

    assert walked == [
        {"role": "tool", "tool_call_id": "c1", "content": "result " * 100}
    ]
    assert second.system_tokens == first.system_tokens
    assert second.conversation_tokens == (
        first.conversation_tokens + models.message_tokens(added)
    )


def test_a_message_estimate_is_kept_until_the_message_changes(monkeypatch):
    """(security regression: rate-limit audit Q238) One walk per message; a
    message edited in place (a notice appended to a tool result) is counted
    again."""
    walked = _counting_estimates(monkeypatch)
    message = {"role": "tool", "tool_call_id": "c1", "content": "result " * 50}

    def measure() -> int:
        return models.measure_request_context([message], model=_spec()).total_tokens

    first = measure()
    assert measure() == measure() == first
    assert len(walked) == 1

    message["content"] += " Answer from the evidence you have now."
    assert measure() > first
    assert len(walked) == 2


def test_the_estimates_count_like_the_character_walk():
    """The CJK runs counted in C give the per-character count: kana, hangul
    and ideographs one token each, other characters four (prose) or three
    (provider JSON) to a token."""
    from pipeline.retrieval.chunking import estimate_tokens
    from pipeline.retrieval.lang import is_cjk

    text = "Plain words, café, 中文字符, かなカナ, 한국어, emoji 🙂, 豈 and 中" * 7
    cjk = sum(1 for ch in text if is_cjk(ch))
    assert cjk > 0
    assert estimate_tokens(text) == cjk + (len(text) - cjk + 3) // 4
    assert accounting.estimate_context_value(text) == cjk + (len(text) - cjk + 2) // 3


def test_measure_context_separates_system_tools_and_conversation():
    measured = accounting.measure_context(
        [
            {"role": "system", "content": "Follow the workspace rules."},
            {"role": "user", "content": "Summarize my notes."},
            {
                "role": "assistant",
                "content": "Earlier compacted conversation summary",
                "_kind": "summary",
            },
        ],
        tools=[
            {
                "type": "function",
                "function": {"name": "search_notes", "parameters": {}},
            }
        ],
        window_tokens=100_000,
    )

    assert measured.system_tokens > 0
    assert measured.tool_tokens > 0
    assert measured.conversation_tokens > 0
    assert measured.total_tokens == (
        measured.system_tokens + measured.tool_tokens + measured.conversation_tokens
    )
    assert measured.window_tokens == 100_000
    assert measured.counting_method == accounting.CONTEXT_COUNTING_METHOD
    assert measured.counting_version == accounting.CONTEXT_COUNTING_VERSION


def test_provider_shaped_measurement_keeps_reasoning_and_full_tool_payloads():
    spec = _spec()
    short = models.measure_request_context(
        [
            {"role": "system", "content": "system"},
            {"role": "user", "content": "question"},
            {
                "role": "assistant",
                "content": "",
                "reasoning_content": "reasoning " * 100,
                "tool_calls": [
                    {
                        "id": "call_1",
                        "type": "function",
                        "function": {
                            "name": "search_workspace",
                            "arguments": "x" * 100,
                        },
                    }
                ],
            },
            {"role": "tool", "tool_call_id": "call_1", "content": "result"},
        ],
        model=spec,
        tools=[
            {
                "type": "function",
                "function": {"name": "search_workspace", "parameters": {}},
            }
        ],
    )
    long = models.measure_request_context(
        [
            {"role": "system", "content": "system"},
            {"role": "user", "content": "question"},
            {
                "role": "assistant",
                "content": "",
                "reasoning_content": "reasoning " * 100,
                "tool_calls": [
                    {
                        "id": "call_1",
                        "type": "function",
                        "function": {
                            "name": "search_workspace",
                            "arguments": "x" * 10_000,
                        },
                    }
                ],
            },
            {"role": "tool", "tool_call_id": "call_1", "content": "result"},
        ],
        model=spec,
        tools=[
            {
                "type": "function",
                "function": {"name": "search_workspace", "parameters": {}},
            }
        ],
    )

    assert long.conversation_tokens > short.conversation_tokens + 3000
    assert long.system_tokens == short.system_tokens
    assert long.tool_tokens == short.tool_tokens


def test_openai_responses_and_anthropic_thinking_blocks_are_counted():
    tools = [
        {
            "type": "function",
            "function": {"name": "search_workspace", "parameters": {}},
        }
    ]
    openai = _spec(
        provider_slug="openai",
        model_slug="gpt-5",
        default_thinking="low",
    )
    openai_messages = [
        {"role": "system", "content": "system"},
        {"role": "user", "content": "question"},
        {
            "role": "assistant",
            "content": "",
            "output_items": [
                {
                    "type": "reasoning",
                    "id": "rs_1",
                    "encrypted_content": "encrypted " * 1000,
                }
            ],
        },
    ]
    anthropic = _spec(provider_slug="anthropic", model_slug="claude-sonnet")
    anthropic_messages = [
        {"role": "system", "content": "system"},
        {"role": "user", "content": "question"},
        {
            "role": "assistant",
            "content": "",
            "thinking_blocks": [{"type": "thinking", "thinking": "private " * 1000}],
            "tool_calls": [
                {
                    "id": "call_1",
                    "type": "function",
                    "function": {"name": "search_workspace", "arguments": "{}"},
                }
            ],
        },
    ]

    openai_count = models.measure_request_context(
        openai_messages, model=openai, tools=tools
    )
    anthropic_count = models.measure_request_context(
        anthropic_messages, model=anthropic, tools=tools
    )

    assert openai_count.conversation_tokens > 3000
    assert anthropic_count.conversation_tokens > 2000


async def test_open_call_forwards_numeric_context_before_provider_call(monkeypatch):
    monkeypatch.setattr(accounting.cfg, "gateway_url", "http://gateway")
    monkeypatch.setattr(accounting.cfg, "pipeline_secret", "secret")
    monkeypatch.setattr(accounting.cfg, "dsn", "postgres://unused")
    forwarded = []

    async def capture_to_thread(function, *args):
        forwarded.append((function, args))
        return True

    monkeypatch.setattr(accounting.asyncio, "to_thread", capture_to_thread)
    context = accounting.ContextComposition(
        system_tokens=11,
        tool_tokens=7,
        conversation_tokens=23,
        window_tokens=128_000,
    )
    token = accounting.bind("cr_1")
    try:
        await accounting.open_call(
            "pc_1",
            kind=accounting.KIND_LLM,
            purpose=accounting.PURPOSE_AGENT,
            thinking="high",
            context=context,
        )
    finally:
        accounting.reset(token)

    # The interactive receipt window derives from the stream backstop, not
    # the idle timeout: a stream may legitimately run far past one idle gap.
    assert forwarded == [
        (
            accounting._open_call_sync,
            (
                "cr_1",
                "pc_1",
                accounting.KIND_LLM,
                accounting.PURPOSE_AGENT,
                "high",
                context,
                max(1, math.ceil(accounting.cfg.interactive_stream_max_s)) + 300,
                "",
                "",
                None,
                None,
                "",
                None,
            ),
        )
    ]


def _gated_spec() -> ModelConfig:
    return _spec(
        provider_slug="deepinfra",
        model_slug="Qwen/Qwen3-Embedding-4B",
        thinking_levels=(),
        default_thinking="",
    )


async def test_open_call_takes_capacity(monkeypatch):
    monkeypatch.setattr(accounting.cfg, "gateway_url", "http://gateway")
    monkeypatch.setattr(accounting.cfg, "pipeline_secret", "secret")

    monkeypatch.setattr(accounting.cfg, "dsn", "postgres://unused")
    admissions = []

    async def to_thread(function, *args):
        assert function is accounting._open_call_sync
        admissions.append(args[9])
        return True

    monkeypatch.setattr(accounting.asyncio, "to_thread", to_thread)
    token = accounting.bind("cr_1")
    try:
        await accounting.open_call(
            "pc_1",
            kind=accounting.KIND_EMBEDDING,
            purpose=accounting.KIND_EMBEDDING,
            spec=_gated_spec(),
        )
        assert admissions == ["gateway"]
        assert accounting.current().leased_calls
    finally:
        accounting.reset(token)


async def test_open_call_polls_the_full_gate_until_its_deadline(monkeypatch):
    monkeypatch.setattr(accounting.cfg, "gateway_url", "http://gateway")
    monkeypatch.setattr(accounting.cfg, "pipeline_secret", "secret")
    monkeypatch.setattr(accounting.cfg, "dsn", "postgres://unused")
    answers = [False, False, True]
    leases = []

    async def to_thread(function, *args):
        assert function is accounting._open_call_sync
        leases.append(args[9])
        return answers.pop(0)

    sleeps = []

    async def no_sleep(seconds):
        sleeps.append(seconds)

    monkeypatch.setattr(accounting.asyncio, "to_thread", to_thread)
    monkeypatch.setattr(accounting.asyncio, "sleep", no_sleep)
    token = accounting.bind("cr_1")
    try:
        await accounting.open_call(
            "pc_1",
            kind=accounting.KIND_EMBEDDING,
            purpose=accounting.KIND_EMBEDDING,
            spec=_gated_spec(),
            deadline=accounting.time.monotonic() + 60,
        )
        state = accounting.current()
        assert state is not None and state.leased_calls == {"pc_1"}
        # Each poll passes the admission mode so the transaction reads live limits.
        assert leases == ["gateway"] * 3
        assert len(sleeps) == 2

        answers.append(False)
        with pytest.raises(accounting.elitellm.ProviderBusy) as caught:
            await accounting.open_call(
                "pc_2",
                kind=accounting.KIND_EMBEDDING,
                purpose=accounting.KIND_EMBEDDING,
                spec=_gated_spec(),
                deadline=accounting.time.monotonic(),
            )
        assert caught.value.retry_after == accounting.BUSY_RETRY_AFTER_S
        assert state.leased_calls == {"pc_1"}

        released = []

        async def release_thread(function, *args):
            released.append((function, args))

        monkeypatch.setattr(accounting.asyncio, "to_thread", release_thread)
        await accounting.release_call("pc_1")
        await accounting.release_call("pc_never_leased")
        assert released == [(accounting._release_lease_sync, ("pc_1",))]
        assert state.leased_calls == set()
    finally:
        accounting.reset(token)


async def test_a_queued_chat_head_waits_through_its_pause_hook(monkeypatch):
    """A chat queue's head waits between gate tries through ``pause``, which a
    call ending wakes early (Epo 2026-10-29); with no deadline a full gate
    answers GateFull at once."""
    monkeypatch.setattr(accounting.cfg, "gateway_url", "http://gateway")
    monkeypatch.setattr(accounting.cfg, "pipeline_secret", "secret")
    monkeypatch.setattr(accounting.cfg, "dsn", "postgres://unused")
    answers = [False, True]

    async def to_thread(_function, *_args):
        return answers.pop(0)

    paused = []

    async def pause(seconds):
        paused.append(seconds)

    monkeypatch.setattr(accounting.asyncio, "to_thread", to_thread)
    token = accounting.bind("cr_1")
    try:
        await accounting.open_call(
            "pc_1",
            kind=accounting.KIND_LLM,
            purpose=accounting.PURPOSE_AGENT,
            spec=_gated_spec(),
            deadline=accounting.time.monotonic() + 60,
            pause=pause,
        )
        assert len(paused) == 1
        answers.append(False)
        with pytest.raises(accounting.GateFull):
            await accounting.open_call(
                "pc_2",
                kind=accounting.KIND_LLM,
                purpose=accounting.PURPOSE_AGENT,
                spec=_gated_spec(),
                deadline=None,
            )
        assert len(paused) == 1
    finally:
        accounting.reset(token)


def test_admission_holds_the_model_wide_lock_for_one_statement():
    """(security regression: rate-limit audit M13, Q298) Admission sweeps
    expired leases before it takes the model-wide lock, then holds the lock
    for one conditional insert."""

    class Cursor:
        rowcount = 1

        def __init__(self) -> None:
            self.statements: list[str] = []

        def execute(self, sql: str, _params=None) -> None:
            self.statements.append(sql.split()[0])
            if "pg_advisory_xact_lock" in sql:
                self.statements[-1] = "LOCK"

    cur = Cursor()
    assert db.acquire_provider_capacity(
        cur, lease_id="pc_1", provider="m", units=1, capacity=4, lease_seconds=60
    )
    assert cur.statements == ["DELETE", "LOCK", "INSERT"]


@pytest.mark.parametrize("ingest", [False, True], ids=["chat", "ingest"])
async def test_a_settled_call_frees_its_lease_in_the_settlement(monkeypatch, ingest):
    """(security regression: rate-limit audit M13, Q298) A settled call's lease
    goes with its settlement (the gateway's transaction, or the local one for
    ingest), so the call's end starts no release transaction of its own; a call
    whose settlement failed still frees its lease."""
    from pipeline import registry
    from pipeline.retrieval.stream import AssembledResponse

    monkeypatch.setattr(accounting.cfg, "dsn", "postgres://unused")
    monkeypatch.setattr(accounting.cfg, "gateway_url", "http://gateway")
    monkeypatch.setattr(accounting.cfg, "pipeline_secret", "secret")
    jobs: list[str] = []
    failing: list[bool] = []

    async def to_thread(function, *_args):
        jobs.append(function.__name__)
        if function is accounting._settle_ingest_call_sync and failing:
            raise ValueError("rejected")
        return function is accounting._open_call_sync or None

    async def post_settlement(_payload, **_kwargs):
        jobs.append("post_settlement")
        if failing:
            raise accounting.SettlementError("accounting failed")
        return {}

    async def stream(*_args, **_kwargs):  # chat streams
        return AssembledResponse(
            text="ok", usage=NormalizedUsage(input_tokens=3, output_tokens=2)
        )

    async def complete(*_args, **_kwargs):  # ingest does not
        return models.elitellm.chat_response(
            {"role": "assistant", "content": "ok"},
            finish_reason="stop",
            usage={"prompt_tokens": 3, "completion_tokens": 2},
        )

    monkeypatch.setattr(accounting.asyncio, "to_thread", to_thread)
    monkeypatch.setattr(accounting, "_post_settlement", post_settlement)
    monkeypatch.setattr(models, "_stream_via_adapter", stream)
    monkeypatch.setattr(models.elitellm, "complete", complete)
    registry.bind_request_llm()
    token = accounting.bind_ingest("cr_1", {}) if ingest else accounting.bind("cr_1")
    settled = "_settle_ingest_call_sync" if ingest else "post_settlement"
    try:
        await models.complete_text([{"role": "user", "content": "q"}], model=_spec())
        assert jobs == ["_open_call_sync", settled]

        jobs.clear()
        failing.append(True)
        with pytest.raises(accounting.SettlementError):
            await models.complete_text(
                [{"role": "user", "content": "q"}], model=_spec()
            )
        assert jobs == ["_open_call_sync", settled, "_release_lease_sync"]
    finally:
        accounting.reset(token)


async def test_ingest_settlement_stays_per_call_and_local(monkeypatch):
    monkeypatch.setattr(accounting.cfg, "dsn", "postgres://unused")
    forwarded = []

    async def capture_to_thread(function, *args):
        forwarded.append((function, args))

    monkeypatch.setattr(accounting.asyncio, "to_thread", capture_to_thread)
    usage = NormalizedUsage(input_tokens=13, output_tokens=5)
    token = accounting.bind_ingest(
        "cr_ingest",
        {"digital_parse_page": {"creditMicrosPerUnit": 2_000}},
    )
    try:
        state = await accounting.settle(
            call_id="pc_ingest",
            kind=accounting.KIND_LLM,
            purpose="ingest_summary",
            thinking="instant",
            spec=_spec(),
            usage=usage,
        )
    finally:
        accounting.reset(token)

    assert state is not None
    assert state.settled_calls == 1
    assert forwarded == [
        (
            accounting._settle_ingest_call_sync,
            (
                "cr_ingest",
                "pc_ingest",
                accounting.KIND_LLM,
                "ingest_summary",
                "instant",
                _spec(),
                usage,
                None,
            ),
        )
    ]


async def test_a_cancelled_admission_is_undone_without_delaying_the_cancel(
    monkeypatch,
):
    """The admission thread cannot be cancelled; the undo must not wait for it."""
    monkeypatch.setattr(accounting.cfg, "gateway_url", "http://gateway")
    monkeypatch.setattr(accounting.cfg, "pipeline_secret", "secret")
    monkeypatch.setattr(accounting.cfg, "dsn", "postgres://unused")
    thread_may_finish = asyncio.Event()
    undone: list[str] = []

    async def to_thread(function, *args):
        if function is accounting._open_call_sync:
            # Stands in for a thread still holding the database when the
            # request goes away; it commits the lease after the cancel.
            await thread_may_finish.wait()
            return True
        assert function is accounting._undo_admission_sync
        undone.append(args[0])
        return None

    monkeypatch.setattr(accounting.asyncio, "to_thread", to_thread)
    token = accounting.bind("cr_1")
    try:
        opening = asyncio.ensure_future(
            accounting.open_call(
                "pc_1",
                kind=accounting.KIND_EMBEDDING,
                purpose=accounting.KIND_EMBEDDING,
                spec=_gated_spec(),
                deadline=accounting.time.monotonic() + 60,
            )
        )
        await asyncio.sleep(0)
        opening.cancel()
        started = accounting.time.monotonic()
        # Bounded: an inline await of the thread would hang here, not fail.
        done, _pending = await asyncio.wait({opening}, timeout=1)
        assert done and opening.cancelled()
        assert accounting.time.monotonic() - started < 1
        assert undone == []

        thread_may_finish.set()
        registered = False
        for _ in range(20):
            await asyncio.sleep(0)
            registered = registered or bool(accounting._background)
            if undone and not accounting._background:
                break
        assert undone == ["pc_1"]
        # The undo task was held while it ran and let go when it finished.
        assert registered and accounting._background == set()
    finally:
        accounting.reset(token)


def _record_call_lifecycle(monkeypatch) -> list[tuple]:
    """Bind a chat session and record each call's open, settle, abandon and
    release in order, with no database or gateway."""
    monkeypatch.setattr(accounting.cfg, "gateway_url", "http://gateway")
    monkeypatch.setattr(accounting.cfg, "pipeline_secret", "secret")
    events: list[tuple] = []

    async def open_call(call_id, **_kwargs):
        events.append(("open", call_id))

    async def abandon_call(call_id, _exc=None):
        events.append(("abandon", call_id))

    async def release_call(call_id):
        events.append(("release", call_id))

    async def post_settlement(payload, **_kwargs):
        events.append(("settle", payload))
        return {}

    monkeypatch.setattr(accounting, "open_call", open_call)
    monkeypatch.setattr(accounting, "abandon_call", abandon_call)
    monkeypatch.setattr(accounting, "release_call", release_call)
    monkeypatch.setattr(accounting, "_post_settlement", post_settlement)
    monkeypatch.setattr(models.obs, "record_normalized", lambda *a, **k: None)
    return events


async def test_a_stream_failing_after_its_usage_bills_that_usage(monkeypatch):
    """A stream that sent its usage before failing settles that usage at once
    (abandoning would bill nothing) and frees its lease."""
    events = _record_call_lifecycle(monkeypatch)

    async def stream(*_args, **_kwargs):
        yield {
            "choices": [{"index": 0, "delta": {"content": "Hel"}}],
            "usage": {"prompt_tokens": 11, "completion_tokens": 2},
        }
        raise TimeoutError("provider stream went silent for 15 s after it started")

    monkeypatch.setattr(models.elitellm, "stream", stream)
    token = accounting.bind("cr_1")
    try:
        with pytest.raises(TimeoutError):
            await models.stream_agent_response(
                [{"role": "user", "content": "hi"}], model=_spec()
            )
    finally:
        accounting.reset(token)

    call_id = events[0][1]
    assert [event[0] for event in events] == ["open", "settle", "release"]
    payload = events[1][1]
    assert (payload["callId"], payload["inputTokens"], payload["outputTokens"]) == (
        call_id,
        11,
        2,
    )
    assert events[2] == ("release", call_id)


async def test_openrouter_serving_provider_is_recorded_as_served_by(monkeypatch):
    """OpenRouter names the provider that served the call on every response;
    it reaches usage_events.metadata as servedBy, from the gateway receipt
    (streamed chat) and from ingest's local settlement (whole responses)."""
    import httpx
    import yaml

    from pipeline import registry
    from pipeline.elitellm import client as transport
    from pipeline.retrieval.usage_extract import response_usage
    from pipeline.store import db

    cassette = Path(__file__).parent / "cassettes/replay/zai__glm_5_3_flash.yaml"
    recorded = yaml.safe_load(cassette.read_text())["interactions"][0]["response"]
    body = recorded["body"]["string"].encode()
    client = httpx.AsyncClient(
        transport=httpx.MockTransport(lambda _r: httpx.Response(200, content=body))
    )
    monkeypatch.setattr(transport, "_client", lambda: client)
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-test")
    registry.bind_request_llm(thinking="max")
    events = _record_call_lifecycle(monkeypatch)
    glm = _spec(
        provider_slug="zai",
        model_slug="glm-5.3-flash",
        thinking_levels=("low", "high", "max"),
        default_thinking="max",
    )
    token = accounting.bind("cr_glm")
    try:
        await models.stream_agent_response(
            [{"role": "user", "content": "hi"}], model=glm
        )
    finally:
        accounting.reset(token)
        await client.aclose()

    settle = next(event[1] for event in events if event[0] == "settle")
    assert settle["servedBy"] == "DigitalOcean"
    assert settle["inputTokens"] == 171

    final_chunk = next(
        line[5:]
        for line in recorded["body"]["string"].splitlines()
        if line.startswith("data:") and '"usage"' in line
    )
    usage = response_usage(json.loads(final_chunk), provider="zai")
    metadata = db._ingest_provider_metadata(
        "pc_1", "ingest_summary", "llm", usage, "user"
    )
    assert metadata["servedBy"] == "DigitalOcean"
    # Direct providers carry no such field and record nothing.
    assert response_usage(json.loads(final_chunk), provider="deepseek").served_by == ""
