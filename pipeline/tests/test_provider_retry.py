"""Busy-answer retry policy at the model boundary.

Every attempt is its own call id. Interactive calls get two attempts inside
three seconds and fail closed as ProviderBusy; ingest calls get three attempts
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
        "thinking_levels": ("instant", "low", "high"),
        "default_thinking": "instant",
        "context_window_tokens": 100_000,
    }
    values.update(overrides)
    return ModelConfig(**values)


@pytest.fixture(autouse=True)
def _platform_key(monkeypatch):
    registry.bind_request_llm()
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


async def test_ingest_calls_get_three_attempts_with_backoff(
    monkeypatch, sleeps, ingest_mode
):
    calls = 0

    async def complete(*_args, **_kwargs):
        nonlocal calls
        calls += 1
        if calls < 3:
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
    assert calls == models.INGEST_RETRY.attempts == 3
    assert len(sleeps) == 2 and all(0.3 < s < 3 for s in sleeps)


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


async def test_caption_raises_provider_busy(monkeypatch, sleeps, ingest_mode):
    monkeypatch.setattr(models.registry, "captioning_spec", lambda: _spec())

    async def complete(*_args, **_kwargs):
        raise _busy()

    monkeypatch.setattr(models.elitellm, "complete", complete)
    with pytest.raises(elitellm.ProviderBusy):
        await models.caption_image("data:image/png;base64,AA==", "describe")


async def test_agent_stream_retries_only_before_the_first_byte(monkeypatch, sleeps):
    attempts = 0

    async def stream(spec, messages, tools, temperature, on_event, receipt, **kw):
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise _busy(retry_after=0.25)
        if attempts == 2:
            receipt.seen = True
            raise elitellm.ProviderError("stream dropped", status_code=502)
        return _assembled()

    monkeypatch.setattr(models, "_stream_via_adapter", stream)
    with pytest.raises(elitellm.ProviderError, match="stream dropped"):
        await models.stream_agent_response(
            [{"role": "user", "content": "hi"}], model=_spec()
        )
    assert attempts == 2
    assert sleeps == [0.25]


async def test_a_stopped_turn_starts_no_retry_of_its_model_call(monkeypatch, sleeps):
    attempts = 0

    async def stream(*_args, **_kwargs):
        nonlocal attempts
        attempts += 1
        raise elitellm.ProviderError("connect failed", status_code=502)

    monkeypatch.setattr(models, "_stream_via_adapter", stream)
    with pytest.raises(elitellm.ProviderError, match="connect failed"):
        await models.stream_agent_response(
            [{"role": "user", "content": "hi"}], model=_spec(), stopped=lambda: True
        )
    assert attempts == 1 and sleeps == []


async def test_a_stop_during_the_retry_wait_starts_no_next_attempt(monkeypatch):
    attempts = 0
    stop = False

    async def stream(*_args, **_kwargs):
        nonlocal attempts
        attempts += 1
        raise _busy(retry_after=0.25)

    async def sleep(_seconds):
        nonlocal stop
        stop = True  # the user presses Stop while the call waits to retry

    monkeypatch.setattr(models, "_stream_via_adapter", stream)
    monkeypatch.setattr(models.asyncio, "sleep", sleep)
    with pytest.raises(elitellm.ProviderError, match="slow down"):
        await models.stream_agent_response(
            [{"role": "user", "content": "hi"}], model=_spec(), stopped=lambda: stop
        )
    assert attempts == 1


async def test_interactive_completion_streams_and_assembles(monkeypatch):
    seen = {}

    async def stream(spec, messages, tools, temperature, on_event, receipt, **kwargs):
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


async def test_caption_retries_transient_failures_and_empty_answers(
    monkeypatch, sleeps, ingest_mode
):
    monkeypatch.setattr(models.registry, "captioning_spec", lambda: _spec())
    calls = 0

    async def complete(*_args, **_kwargs):
        nonlocal calls
        calls += 1
        if calls == 1:
            raise elitellm.ProviderError("upstream reset", status_code=502)
        return elitellm.chat_response(
            {"role": "assistant", "content": "" if calls == 2 else "a chart"},
            finish_reason="stop",
            usage={"prompt_tokens": 1, "completion_tokens": 1},
        )

    monkeypatch.setattr(models.elitellm, "complete", complete)
    assert (
        await models.caption_image("data:image/png;base64,AA==", "describe")
        == "a chart"
    )
    assert calls == 3 and len(sleeps) == 2


@pytest.mark.parametrize(
    ("first_text", "first_finish"), [("page text", "length"), ("", "stop")]
)
async def test_vlm_page_retries_an_unusable_answer_and_charges_only_a_usable_read(
    monkeypatch, sleeps, ingest_mode, first_text, first_finish
):
    monkeypatch.setattr(models.registry, "captioning_spec", lambda: _spec())
    # Each attempt leases the page-read gate at CAPY_VLM_PAGE_CAPACITY.
    monkeypatch.setattr(models.cfg, "vlm_page_capacity", 64)
    answers = iter([(first_text, first_finish), ("page text", "stop")])
    opened: list = []
    charged: list = []

    async def open_call(*_args, **kwargs):
        opened.append(kwargs["capacity"])

    async def settle(**kwargs):
        charged.append(kwargs["credit_micros"])

    async def complete(_spec, _messages, **kwargs):
        assert kwargs["max_tokens"] == models.VLM_PAGE_MAX_TOKENS
        text, finish = next(answers)
        return elitellm.chat_response(
            {"role": "assistant", "content": text},
            finish_reason=finish,
            usage={"prompt_tokens": 1, "completion_tokens": 1},
        )

    monkeypatch.setattr(models.accounting, "open_call", open_call)
    monkeypatch.setattr(models.accounting, "settle", settle)
    monkeypatch.setattr(models.elitellm, "complete", complete)
    read = await models.read_page("data:image/jpeg;base64,AA==", credit_micros=1_000)
    assert read == "page text"
    assert opened == [("vlm_page", 64)] * 2
    assert charged == [0, 1_000]


@pytest.mark.parametrize("outcome", ["busy", "error", "empty", "length"])
async def test_vlm_page_read_makes_at_most_three_calls(
    monkeypatch, sleeps, ingest_mode, outcome
):
    """One read per page (decided 2026-10-15): the ingest policy's 3 calls."""
    monkeypatch.setattr(models.registry, "captioning_spec", lambda: _spec())
    calls = 0

    async def complete(*_args, **_kwargs):
        nonlocal calls
        calls += 1
        if outcome == "busy":
            raise _busy(status=503)
        if outcome == "error":
            raise elitellm.ProviderError("upstream", status_code=500)
        return elitellm.chat_response(
            {"role": "assistant", "content": "" if outcome == "empty" else "text"},
            finish_reason="length" if outcome == "length" else "stop",
            usage={"prompt_tokens": 1, "completion_tokens": 1},
        )

    monkeypatch.setattr(models.elitellm, "complete", complete)
    page = models.read_page("data:image/jpeg;base64,AA==", credit_micros=1)
    if outcome == "busy":
        # Busy past the attempts re-pends the job instead of leaving the page.
        with pytest.raises(elitellm.ProviderBusy):
            await page
    else:
        assert await page is None
    assert calls == 3


@pytest.mark.parametrize("call", ["vlm", "caption"])
async def test_captioning_on_openrouter_keeps_reasoning_off(
    monkeypatch, ingest_mode, call
):
    """The captioning pin (decision 2026-10-19): no reasoning on page reads or
    image captions, and page reads keep their 2,000-token cap."""
    spec = _spec(
        provider_slug="openrouter",
        model_slug="deepseek/deepseek-v4.1-flash-1017",
        thinking_levels=("instant",),
    )
    monkeypatch.setattr(models.registry, "captioning_spec", lambda: spec)
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-or")
    bodies: list[dict] = []

    async def post_json(_url, _headers, body):
        bodies.append(body)
        return {
            "choices": [
                {
                    "message": {"role": "assistant", "content": "text"},
                    "finish_reason": "stop",
                }
            ],
            "usage": {"prompt_tokens": 1, "completion_tokens": 1},
        }

    monkeypatch.setattr("pipeline.elitellm.client._post_json", post_json)
    if call == "vlm":
        read = await models.read_page("data:image/jpeg;base64,AA==", credit_micros=1)
        assert read == "text"
    else:
        caption = await models.caption_image("data:image/png;base64,AA==", "describe")
        assert caption == "text"
    [body] = bodies
    assert body["model"] == "deepseek/deepseek-v4.1-flash-1017"
    assert body["provider"] == {
        "order": ["InferenceNet", "Cloudflare"],
        "allow_fallbacks": False,
    }
    assert body["reasoning"] == {"enabled": False}
    if call == "vlm":
        assert body["max_tokens"] == models.VLM_PAGE_MAX_TOKENS == 2_000


def _answer(text="text", finish="stop"):
    return elitellm.chat_response(
        {"role": "assistant", "content": text},
        finish_reason=finish,
        usage={"prompt_tokens": 1, "completion_tokens": 1},
    )


async def _summary():
    return await models.complete_text(
        [{"role": "user", "content": "hi"}], model=_spec(), max_tokens=400
    )


@pytest.mark.parametrize("call", ["summary", "vlm", "caption"])
@pytest.mark.parametrize(("status", "expected_calls"), [(500, 2), (401, 1)])
async def test_ingest_summary_and_vlm_retry_transient_errors_not_client_errors(
    monkeypatch, sleeps, ingest_mode, call, status, expected_calls
):
    """Parts design Q7, for the summary, the VLM page read and the standalone
    image caption: a 5xx takes the next attempt; a 401 ends the call."""
    monkeypatch.setattr(models.registry, "captioning_spec", lambda: _spec())
    calls = 0

    async def complete(*_args, **_kwargs):
        nonlocal calls
        calls += 1
        if calls == 1:
            raise elitellm.ProviderError("failed", status_code=status)
        return _answer()

    monkeypatch.setattr(models.elitellm, "complete", complete)
    if call == "vlm":
        read = await models.read_page("data:image/jpeg;base64,AA==", credit_micros=1)
        assert read == ("text" if status == 500 else None)
    elif call == "caption":
        caption = await models.caption_image("data:image/png;base64,AA==", "describe")
        assert caption == ("text" if status == 500 else "")
    elif status == 500:
        assert await _summary() == "text"
    else:
        with pytest.raises(elitellm.ProviderError):
            await _summary()
    assert calls == expected_calls


async def test_ingest_summary_counts_an_unusable_answer_as_an_attempt(
    monkeypatch, sleeps, ingest_mode
):
    answers = iter([_answer(""), _answer("cut", "length"), _answer("A descriptor.")])
    calls = 0

    async def complete(*_args, **_kwargs):
        nonlocal calls
        calls += 1
        return next(answers)

    monkeypatch.setattr(models.elitellm, "complete", complete)
    assert await _summary() == "A descriptor."
    assert calls == 3

    answers = iter([_answer("")] * 3)
    with pytest.raises(models.UnusableAnswer):
        await _summary()
    assert calls == 6


# Chat's model queue (Epo 2026-10-29): over the cap a chat call waits its turn;
# a busy provider puts it back once, unseen, and the second busy answer shows.


@pytest.fixture
def chat_turn():
    """Bind a chat turn's slot policy and record its waiting status."""
    from pipeline.retrieval import limits

    seen: list[str] = []
    limits.MODEL_QUEUES.clear()
    token = limits.bind_call_slots(
        limits.CallSlotPolicy(
            limits.CHAT_SLOT_WAIT_S,
            on_wait=lambda: seen.append("waiting"),
            on_granted=lambda: seen.append("granted"),
        )
    )
    yield seen
    limits.reset_call_slots(token)
    limits.MODEL_QUEUES.clear()


async def test_chat_calls_over_the_cap_go_in_arrival_order(monkeypatch, chat_turn):
    import asyncio

    admitted: list[str] = []
    used = 0

    async def open_call(call_id, *, deadline, pause=None, **_kwargs):
        nonlocal used
        while used >= 1:
            if deadline is None:
                raise accounting.GateFull("full")
            # A long poll: only the end of the call holding the slot wakes it.
            await pause(30)
        used += 1
        admitted.append(asyncio.current_task().get_name())

    async def release_call(_call_id):
        nonlocal used
        used -= 1

    held = asyncio.Event()

    async def stream(*_args, **_kwargs):
        if asyncio.current_task().get_name() == "first":
            await held.wait()
        return _assembled()

    monkeypatch.setattr(models.accounting, "open_call", open_call)
    monkeypatch.setattr(models.accounting, "release_call", release_call)
    monkeypatch.setattr(models, "_stream_via_adapter", stream)

    def call(name):
        return asyncio.create_task(
            models.stream_agent_response(
                [{"role": "user", "content": name}], model=_spec()
            ),
            name=name,
        )

    first = call("first")
    await asyncio.sleep(0)
    second = call("second")
    await asyncio.sleep(0)
    third = call("third")
    await asyncio.sleep(0.05)
    assert admitted == ["first"]
    held.set()
    await asyncio.wait_for(asyncio.gather(first, second, third), timeout=2)
    assert admitted == ["first", "second", "third"]
    assert chat_turn == ["waiting", "waiting", "granted", "granted"]


async def test_a_busy_provider_puts_a_chat_call_back_once_unseen(
    monkeypatch, sleeps, chat_turn
):
    attempts = 0

    async def stream(*_args, **_kwargs):
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            # Past the 3 s interactive budget, within the chat's wait.
            raise _busy(retry_after=10)
        return _assembled("second time")

    monkeypatch.setattr(models, "_stream_via_adapter", stream)
    assembled = await models.stream_agent_response(
        [{"role": "user", "content": "hi"}], model=_spec()
    )
    assert assembled.text == "second time"
    assert sleeps == [10]
    assert chat_turn == ["waiting", "granted"]


async def test_a_second_busy_answer_reaches_the_chat(monkeypatch, sleeps, chat_turn):
    attempts = 0

    async def stream(*_args, **_kwargs):
        nonlocal attempts
        attempts += 1
        raise _busy(retry_after=10)

    monkeypatch.setattr(models, "_stream_via_adapter", stream)
    with pytest.raises(elitellm.ProviderBusy):
        await models.stream_agent_response(
            [{"role": "user", "content": "hi"}], model=_spec()
        )
    assert attempts == 2
    assert sleeps == [10]


async def test_generate_and_editor_keep_failing_fast(monkeypatch, sleeps):
    from pipeline.retrieval import limits

    token = limits.bind_call_slots(limits.CallSlotPolicy(wait_s=0))

    async def stream(*_args, **_kwargs):
        raise _busy(retry_after=10)

    monkeypatch.setattr(models, "_stream_via_adapter", stream)
    try:
        with pytest.raises(elitellm.ProviderBusy):
            await models.complete_text(
                [{"role": "user", "content": "hi"}], model=_spec()
            )
    finally:
        limits.reset_call_slots(token)
    assert sleeps == []


def _bind_chat(**overrides):
    from pipeline.retrieval import limits

    values = {"wait_s": limits.CHAT_SLOT_WAIT_S}
    values.update(overrides)
    return limits.bind_call_slots(limits.CallSlotPolicy(**values))


def _gate(monkeypatch, caps: dict[str, int]):
    """A fake shared gate: ``caps`` per model slug, the rest unlimited."""
    used: dict[str, int] = {}
    calls: dict[str, str] = {}

    async def open_call(call_id, *, spec, deadline, pause=None, **_kwargs):
        slug = spec.model_slug
        while used.get(slug, 0) >= caps.get(slug, 1 << 30):
            if deadline is None or models.time.monotonic() > deadline:
                raise accounting.GateFull("full", retry_after=5)
            await (pause or models.asyncio.sleep)(0.01)
        used[slug] = used.get(slug, 0) + 1
        calls[call_id] = slug

    async def release_call(call_id):
        used[calls.pop(call_id)] -= 1

    monkeypatch.setattr(models.accounting, "open_call", open_call)
    monkeypatch.setattr(models.accounting, "release_call", release_call)
    return used


async def test_a_busy_answer_late_in_the_wait_still_goes_back_in_line(
    monkeypatch, sleeps, chat_turn
):
    """Review M1: the busy retry gets a window of its own."""
    import types

    clock = [1000.0]
    monkeypatch.setattr(
        models, "time", types.SimpleNamespace(monotonic=lambda: clock[0])
    )
    attempts = 0

    async def stream(*_args, **_kwargs):
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            clock[0] += 55  # most of the wait spent in line already
            raise _busy(retry_after=15)
        return _assembled("second time")

    monkeypatch.setattr(models, "_stream_via_adapter", stream)
    assembled = await models.stream_agent_response(
        [{"role": "user", "content": "hi"}], model=_spec()
    )
    assert assembled.text == "second time"
    assert sleeps == [15]


async def test_a_stop_ends_the_busy_wait_at_once(monkeypatch):
    """Review L1."""
    import asyncio

    left = asyncio.Event()
    token = _bind_chat(left=left)

    async def stream(*_args, **_kwargs):
        asyncio.get_running_loop().call_later(0.05, left.set)
        raise _busy(retry_after=30)

    monkeypatch.setattr(models, "_stream_via_adapter", stream)
    try:
        with pytest.raises(models.CallNotStarted):
            await asyncio.wait_for(
                models.stream_agent_response(
                    [{"role": "user", "content": "hi"}], model=_spec()
                ),
                timeout=2,
            )
    finally:
        from pipeline.retrieval import limits

        limits.reset_call_slots(token)


async def test_calls_in_line_give_back_their_call_slot(monkeypatch, chat_turn):
    """Review M2: of a model's line only the head holds a process call slot."""
    import asyncio

    from pipeline.retrieval import limits

    monkeypatch.setattr(limits, "CALL_SLOTS", limits.Slots(3))
    _gate(monkeypatch, {"full": 1})
    held = asyncio.Event()

    async def stream(spec, *_args, **_kwargs):
        if asyncio.current_task().get_name() == "holder":
            await held.wait()
        return _assembled(spec.model_slug)

    monkeypatch.setattr(models, "_stream_via_adapter", stream)

    def call(name, slug):
        return asyncio.create_task(
            models.stream_agent_response(
                [{"role": "user", "content": name}], model=_spec(model_slug=slug)
            ),
            name=name,
        )

    holder = call("holder", "full")
    await asyncio.sleep(0.01)
    first = call("first", "full")
    second = call("second", "full")

    async def settled():
        queue = limits.MODEL_QUEUES.get("deepseek:full")
        while not (queue and queue.waiting == 2 and limits.CALL_SLOTS.used == 2):
            await asyncio.sleep(0.005)
            queue = limits.MODEL_QUEUES.get("deepseek:full")

    # The holder and the head of the line hold slots; the call behind does not.
    await asyncio.wait_for(settled(), timeout=1)
    other = await asyncio.wait_for(call("other", "idle"), timeout=1)
    assert other.text == "idle"
    held.set()
    await asyncio.wait_for(asyncio.gather(holder, first, second), timeout=1)
    assert limits.CALL_SLOTS.used == 0


async def test_the_line_wait_ends_in_busy_and_leaves_the_line_clean(monkeypatch):
    import asyncio

    from pipeline.retrieval import limits

    limits.MODEL_QUEUES.clear()
    token = _bind_chat(wait_s=0.2)
    _gate(monkeypatch, {"full": 1})
    held = asyncio.Event()

    async def stream(*_args, **_kwargs):
        if asyncio.current_task().get_name() == "holder":
            await held.wait()
        return _assembled()

    monkeypatch.setattr(models, "_stream_via_adapter", stream)
    try:
        holder = asyncio.create_task(
            models.stream_agent_response(
                [{"role": "user", "content": "a"}], model=_spec(model_slug="full")
            ),
            name="holder",
        )
        await asyncio.sleep(0.01)
        with pytest.raises(elitellm.ProviderBusy):
            await asyncio.wait_for(
                models.stream_agent_response(
                    [{"role": "user", "content": "b"}], model=_spec(model_slug="full")
                ),
                timeout=2,
            )
        held.set()
        await holder
    finally:
        limits.reset_call_slots(token)
    queue = limits.MODEL_QUEUES["deepseek:full"]
    assert queue.waiting == 0 and not queue._turn.locked()
    assert limits.CALL_SLOTS.used == 0
    limits.MODEL_QUEUES.clear()


async def test_a_stop_in_line_starts_nothing_and_leaves_it_clean(monkeypatch):
    import asyncio

    from pipeline.retrieval import limits

    limits.MODEL_QUEUES.clear()
    left = asyncio.Event()
    token = _bind_chat(left=left)
    _gate(monkeypatch, {"full": 1})
    held = asyncio.Event()
    started = []

    async def stream(*_args, **_kwargs):
        started.append(asyncio.current_task().get_name())
        if asyncio.current_task().get_name() == "holder":
            await held.wait()
        return _assembled()

    monkeypatch.setattr(models, "_stream_via_adapter", stream)
    try:
        holder = asyncio.create_task(
            models.stream_agent_response(
                [{"role": "user", "content": "a"}], model=_spec(model_slug="full")
            ),
            name="holder",
        )
        await asyncio.sleep(0.01)
        asyncio.get_running_loop().call_later(0.05, left.set)
        with pytest.raises(models.CallNotStarted):
            await asyncio.wait_for(
                models.stream_agent_response(
                    [{"role": "user", "content": "b"}], model=_spec(model_slug="full")
                ),
                timeout=2,
            )
        held.set()
        await holder
    finally:
        limits.reset_call_slots(token)
    assert started == ["holder"]
    queue = limits.MODEL_QUEUES["deepseek:full"]
    assert queue.waiting == 0 and not queue._turn.locked()
    limits.MODEL_QUEUES.clear()


async def test_an_embedding_under_a_chat_never_waits_in_line(
    monkeypatch, sleeps, chat_turn
):
    """Review L2: embeddings and reranks keep the interactive budget."""
    assert models.retry_policy(llm=False) == models.INTERACTIVE_RETRY
    chat = models.retry_policy()
    assert chat.wait is not None and chat.budget_s == 60
