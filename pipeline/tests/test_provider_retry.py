"""Busy-answer retry policy at the model boundary.

Every attempt is its own call id. Interactive calls get two attempts inside
three seconds and fail closed as ProviderBusy; ingest calls get four attempts
inside two minutes. A Retry-After longer than what is left of the budget ends
the call at once instead of sleeping for nothing.
"""

from __future__ import annotations

import pytest

from pipeline import elitellm, registry
from pipeline.registry import ModelConfig
from pipeline.retrieval import accounting, models
from pipeline.retrieval.stream import AssembledResponse
from pipeline.retrieval.usage_extract import NormalizedUsage


def _spec(**overrides) -> ModelConfig:
    values = {
        "version": 1,
        "provider_name": "DeepSeek",
        "model_name": "Flash",
        "provider_slug": "deepseek",
        "model_slug": "deepseek-v4-flash",
        "platform_enabled": True,
        "byok_enabled": True,
        "thinking_levels": ("instant", "low", "high"),
        "default_thinking": "instant",
        "context_window_tokens": 100_000,
    }
    values.update(overrides)
    return ModelConfig(**values)


@pytest.fixture(autouse=True)
def _platform_key(monkeypatch):
    registry.bind_request_llm(paid_by="platform")
    monkeypatch.setattr(models.obs, "record_normalized", lambda *a, **k: None)
    monkeypatch.setattr(models.obs, "record_completion", lambda *a, **k: None)
    monkeypatch.setattr(models.obs, "record_embedding", lambda *a, **k: None)


@pytest.fixture
def sleeps(monkeypatch):
    slept: list[float] = []

    async def fake_sleep(seconds):
        slept.append(seconds)

    monkeypatch.setattr(models.asyncio, "sleep", fake_sleep)
    return slept


@pytest.fixture
def ingest_mode(monkeypatch):
    """Bind an ingest session while keeping every accounting write in memory."""
    monkeypatch.setattr(accounting.cfg, "dsn", "postgres://unused")

    async def _noop(*_args, **_kwargs):
        return None

    monkeypatch.setattr(models.accounting, "open_call", _noop)
    monkeypatch.setattr(models.accounting, "settle", _noop)
    monkeypatch.setattr(models.accounting, "abandon_call", _noop)
    monkeypatch.setattr(models.accounting, "release_call", _noop)
    token = accounting.bind_ingest("cr_ingest", {})
    yield
    accounting.reset(token)


def _busy(retry_after=None, status=429):
    return elitellm.ProviderError(
        "slow down", status_code=status, retry_after=retry_after
    )


def _assembled(text="ok"):
    return AssembledResponse(
        text=text, usage=NormalizedUsage(input_tokens=3, output_tokens=2)
    )


async def test_interactive_busy_answer_waits_for_retry_after_then_retries(
    monkeypatch, sleeps
):
    attempts = []

    async def stream(spec, messages, tools, temperature, on_event, **kwargs):
        attempts.append(kwargs)
        if len(attempts) == 1:
            raise _busy(retry_after=1)
        return _assembled("second time")

    monkeypatch.setattr(models, "_stream_via_adapter", stream)
    assert await models.complete_text(
        [{"role": "user", "content": "hi"}], model=_spec()
    )
    assert len(attempts) == 2
    assert sleeps == [1]


async def test_interactive_gives_up_when_retry_after_outlives_the_budget(
    monkeypatch, sleeps
):
    calls = 0

    async def stream(*_args, **_kwargs):
        nonlocal calls
        calls += 1
        raise _busy(retry_after=10)

    monkeypatch.setattr(models, "_stream_via_adapter", stream)
    with pytest.raises(elitellm.ProviderBusy) as caught:
        await models.complete_text([{"role": "user", "content": "hi"}], model=_spec())
    assert calls == 1
    assert sleeps == []
    assert caught.value.retry_after == 10
    assert caught.value.busy


async def test_interactive_fails_closed_after_two_attempts(monkeypatch, sleeps):
    calls = 0

    async def stream(*_args, **_kwargs):
        nonlocal calls
        calls += 1
        raise _busy(retry_after=0.5, status=529)

    monkeypatch.setattr(models, "_stream_via_adapter", stream)
    with pytest.raises(elitellm.ProviderBusy):
        await models.complete_text([{"role": "user", "content": "hi"}], model=_spec())
    assert calls == models.INTERACTIVE_RETRY.attempts == 2
    assert sleeps == [0.5]


async def test_a_bad_request_is_never_retried(monkeypatch, sleeps):
    calls = 0

    async def stream(*_args, **_kwargs):
        nonlocal calls
        calls += 1
        raise elitellm.ProviderError("bad request", status_code=400)

    monkeypatch.setattr(models, "_stream_via_adapter", stream)
    with pytest.raises(elitellm.ProviderError, match="bad request"):
        await models.complete_text([{"role": "user", "content": "hi"}], model=_spec())
    assert calls == 1 and sleeps == []


async def test_a_busy_answer_on_a_user_key_is_not_a_key_failure(monkeypatch, sleeps):
    registry.bind_request_llm(paid_by="user", user_api_key="sk-user")
    calls = 0

    async def stream(*_args, **_kwargs):
        nonlocal calls
        calls += 1
        raise _busy(retry_after=30)

    monkeypatch.setattr(models, "_stream_via_adapter", stream)
    try:
        with pytest.raises(elitellm.ProviderBusy) as caught:
            await models.complete_text(
                [{"role": "user", "content": "hi"}], model=_spec()
            )
    finally:
        registry.bind_request_llm(paid_by="platform")
    # One attempt, no key mapping, and the provider's own wait carried through.
    assert calls == 1 and sleeps == []
    assert not isinstance(caught.value, models.UserKeyError)
    assert caught.value.provider_retry_after == 30


async def test_ingest_calls_get_four_attempts_with_backoff(
    monkeypatch, sleeps, ingest_mode
):
    calls = 0

    async def complete(*_args, **_kwargs):
        nonlocal calls
        calls += 1
        if calls < 4:
            raise _busy()
        return elitellm.chat_response(
            {"role": "assistant", "content": "done"},
            finish_reason="stop",
            usage={"prompt_tokens": 1, "completion_tokens": 1},
        )

    monkeypatch.setattr(models.elitellm, "complete", complete)
    assert (
        await models.complete_text([{"role": "user", "content": "hi"}], model=_spec())
        == "done"
    )
    assert calls == models.INGEST_RETRY.attempts == 4
    assert len(sleeps) == 3 and all(0.3 < s < 3 for s in sleeps)


async def test_ingest_exhaustion_raises_provider_busy(monkeypatch, sleeps, ingest_mode):
    async def complete(*_args, **_kwargs):
        raise _busy(status=503)

    monkeypatch.setattr(models.elitellm, "complete", complete)
    with pytest.raises(elitellm.ProviderBusy) as caught:
        await models.complete_text([{"role": "user", "content": "hi"}], model=_spec())
    assert caught.value.status_code == 503
    # No Retry-After from the provider: the client hint is synthesized, but the
    # job backoff must see None so the 30 s doubling ladder applies.
    assert caught.value.retry_after is not None
    assert caught.value.provider_retry_after is None


async def test_caption_is_best_effort_unless_the_caption_is_the_content(
    monkeypatch, sleeps, ingest_mode
):
    monkeypatch.setattr(models.registry, "captioning_spec", lambda: _spec())

    async def complete(*_args, **_kwargs):
        raise _busy()

    monkeypatch.setattr(models.elitellm, "complete", complete)
    assert await models.caption_image("data:image/png;base64,AA==", "describe") == ""
    with pytest.raises(elitellm.ProviderBusy):
        await models.caption_image(
            "data:image/png;base64,AA==", "describe", best_effort=False
        )


async def test_agent_stream_retries_only_before_the_first_byte(monkeypatch, sleeps):
    attempts = 0

    async def stream(
        spec, messages, tools, temperature, on_event, on_provider_byte=None, **kw
    ):
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise _busy(retry_after=0.25)
        if attempts == 2:
            on_provider_byte()
            raise elitellm.ProviderError("stream dropped", status_code=502)
        return _assembled()

    monkeypatch.setattr(models, "_stream_via_adapter", stream)
    with pytest.raises(elitellm.ProviderError, match="stream dropped"):
        await models.stream_agent_response(
            [{"role": "user", "content": "hi"}], model=_spec()
        )
    assert attempts == 2
    assert sleeps == [0.25]


async def test_interactive_completion_streams_and_assembles(monkeypatch):
    seen = {}

    async def stream(spec, messages, tools, temperature, on_event, **kwargs):
        seen.update(kwargs)
        return _assembled("assembled text")

    monkeypatch.setattr(models, "_stream_via_adapter", stream)
    response = await models.complete_response(
        [{"role": "user", "content": "hi"}],
        model=_spec(),
        max_tokens=64,
        reasoning=False,
        response_format={"type": "json_object"},
    )
    assert response.choices[0].message.content == "assembled text"
    assert response.choices[0].finish_reason == "stop"
    assert seen == {
        "max_tokens": 64,
        "reasoning": False,
        "response_format": {"type": "json_object"},
    }


def test_busy_retry_after_rounds_up_and_never_says_now():
    assert models.busy_retry_after_s(elitellm.ProviderBusy("x", retry_after=2.2)) == 3
    assert models.busy_retry_after_s(elitellm.ProviderBusy("x")) == int(
        accounting.BUSY_RETRY_AFTER_S
    )


async def test_caption_retries_transient_failures_too(monkeypatch, sleeps, ingest_mode):
    monkeypatch.setattr(models.registry, "captioning_spec", lambda: _spec())
    calls = 0

    async def complete(*_args, **_kwargs):
        nonlocal calls
        calls += 1
        if calls < 3:
            raise elitellm.ProviderError("upstream reset", status_code=502)
        return elitellm.chat_response(
            {"role": "assistant", "content": "a chart"},
            finish_reason="stop",
            usage={"prompt_tokens": 1, "completion_tokens": 1},
        )

    monkeypatch.setattr(models.elitellm, "complete", complete)
    assert (
        await models.caption_image("data:image/png;base64,AA==", "describe")
        == "a chart"
    )
    assert calls == 3 and len(sleeps) == 2
