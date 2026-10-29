"""Model clients. Every provider call goes through elitellm.

Routing is owned by the model registry: a pinned provider/model/version resolves
to an exact provider + model slug. Nothing here resolves a slot default —
every entry point takes the pin its caller was priced for.

Every provider call in the system passes through this module. That makes it
the only place token usage has to be captured, and the only place a missing
capture can hide — if a new call site is added elsewhere, its spend is
invisible and the user is silently not charged for it.
"""

from __future__ import annotations

import asyncio
import contextvars
import functools
import logging
import math
import random
import time
from collections.abc import Awaitable, Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any

from .. import elitellm, obs, registry
from ..config import cfg
from ..prompts.captioning import VLM_PAGE_PROMPT
from ..prompts.retrieval import qwen3_query
from ..registry import ModelConfig
from . import accounting, capture, limits
from .stream import (
    AssembledResponse,
    ChatCompletionsAssembler,
    OpenAIResponsesAssembler,
)
from .usage_extract import NormalizedUsage, extract_usage, response_usage

log = logging.getLogger("capy.models")

BUSY_ERROR_CODE = "provider_busy"
BUSY_ERROR = "The model is busy right now. Try again in a moment."


def busy_retry_after_s(exc: BaseException) -> int:
    """Whole seconds a client should wait before retrying a busy call."""
    retry_after = getattr(exc, "retry_after", None)
    if retry_after is None or retry_after <= 0:
        retry_after = accounting.BUSY_RETRY_AFTER_S
    return max(1, math.ceil(retry_after))


class _StreamReceipt:
    """What one provider stream has sent so far."""

    def __init__(self) -> None:
        self.seen = False
        # The last usage block, None until the provider sends one.
        self.usage: NormalizedUsage | None = None


CALL_LIMIT_BUSY = "the AI process is at its model call limit"


class CallNotStarted(Exception):
    """A call whose client left (a Stop or a lost hop) before it started:
    nothing was sent."""


# Whether the current model call holds its CALL_SLOTS slot right now.
_held_slot: contextvars.ContextVar[list[bool] | None] = contextvars.ContextVar(
    "held_call_slot", default=None
)


@asynccontextmanager
async def call_slot():
    """One model call's process slot (Epo 2026-10-24, inner-turn slots), held
    for its request and response, retries included, and its settlement and
    lease release (``_tracked_call``), under the request's slot policy
    (``limits.bind_call_slots``). Past a full CALL_SLOTS the call waits in
    arrival order up to the policy's wait, or answers provider_busy at once;
    with no policy bound the call takes no slot. Once the client has left, no
    call starts and no waiting status is sent (Q359)."""
    policy = limits.call_slot_policy()
    if policy is None:
        yield
        return
    if policy.left is not None and policy.left.is_set():
        raise CallNotStarted("the client left before the call started")
    slots = limits.CALL_SLOTS
    granted = None
    if not slots.take():
        if policy.wait_s <= 0:
            raise elitellm.ProviderBusy(
                CALL_LIMIT_BUSY, retry_after=accounting.BUSY_RETRY_AFTER_S
            )
        waiter = slots.join()  # in the queue from its refusal on (Q359)
        if not await slots.wait_for(waiter, policy.wait_s, policy.left, policy.on_wait):
            if policy.left is not None and policy.left.is_set():
                raise CallNotStarted("the client left while the call waited")
            raise elitellm.ProviderBusy(
                CALL_LIMIT_BUSY, retry_after=accounting.BUSY_RETRY_AFTER_S
            )
        granted = policy.on_granted
    # Both callbacks run where a failure still gives the slot back. A call
    # waiting in its model's line hands the slot back meanwhile (``held``).
    held = [True]
    token = _held_slot.set(held)
    try:
        if granted is not None:
            granted()
        yield
    finally:
        _held_slot.reset(token)
        if held[0]:
            slots.release()


def _slotted(call):
    """``call`` (a coroutine function) runs holding its call slot."""

    @functools.wraps(call)
    async def slotted(*args, **kwargs):
        async with call_slot():
            return await call(*args, **kwargs)

    return slotted


def _slotted_stream(stream):
    """``stream`` (an async generator function) yields holding its call slot."""

    @functools.wraps(stream)
    async def slotted(*args, **kwargs):
        async with call_slot():
            async for item in stream(*args, **kwargs):
                yield item

    return slotted


def _chat_wait() -> limits.CallSlotPolicy | None:
    """The chat's slot policy when this call may wait (a chat turn's calls;
    generate and editor bind a zero wait, ingest none)."""
    policy = limits.call_slot_policy()
    if policy is None or policy.wait_s <= 0 or not _interactive():
        return None
    return policy


def _gate_key(spec: ModelConfig) -> str:
    return f"{spec.provider_slug}:{spec.model_slug}"


async def _open_in_line(
    open_call: Callable[..., Awaitable[None]],
    chat: limits.CallSlotPolicy,
    key: str,
    deadline: float,
) -> None:
    """Open a chat call past its model's capacity in arrival order (Epo
    2026-10-29): straight through when nobody waits and the gate has room,
    else behind the calls already waiting, the head trying the gate until
    ``deadline``. The waiting status shows while it waits."""
    queue = limits.model_queue(key)
    if not queue.waiting:
        try:
            await open_call(deadline=None)
            return
        except accounting.GateFull:
            pass

    async def pause(seconds: float) -> None:
        await queue.pause(seconds)
        if chat.left is not None and chat.left.is_set():
            raise CallNotStarted("the client left while the call waited")

    if chat.on_wait is not None:
        chat.on_wait()
    queue.waiting += 1
    # Waiting in line holds no process call slot, so one full model cannot
    # fill them for every other model and route (review M2).
    slot = _held_slot.get()
    if slot is not None and slot[0]:
        slot[0] = False
        limits.CALL_SLOTS.release()
    try:
        if not await queue.head(deadline - time.monotonic(), chat.left):
            if chat.left is not None and chat.left.is_set():
                raise CallNotStarted("the client left while the call waited")
            raise accounting.GateFull(
                f"{key} is at its concurrency cap",
                retry_after=accounting.BUSY_RETRY_AFTER_S,
            )
        try:
            if slot is not None:
                await _retake_slot(slot, deadline, chat)
            await open_call(deadline=deadline, pause=pause)
        finally:
            queue.leave()
    finally:
        queue.waiting -= 1
    if chat.on_granted is not None:
        chat.on_granted()


async def _retake_slot(
    slot: list[bool], deadline: float, chat: limits.CallSlotPolicy
) -> None:
    """The head of a model's line takes a process call slot again, in the
    slots' own arrival order, before it tries the gate."""
    slots = limits.CALL_SLOTS
    if not slots.take():
        waiter = slots.join()
        if not await slots.wait_for(waiter, deadline - time.monotonic(), chat.left):
            if chat.left is not None and chat.left.is_set():
                raise CallNotStarted("the client left while the call waited")
            raise elitellm.ProviderBusy(
                CALL_LIMIT_BUSY, retry_after=accounting.BUSY_RETRY_AFTER_S
            )
    slot[0] = True


@asynccontextmanager
async def _tracked_call(
    *,
    kind: str,
    purpose: str,
    thinking: str = "",
    context: accounting.ContextComposition | None = None,
    spec: ModelConfig | None = None,
    deadline: float | None = None,
    capacity: tuple[str, int] | None = None,
    stream: _StreamReceipt | None = None,
):
    """Open one provider call around its request; free its lease on the way out.

    ``stream`` marks a streamed call. A stream that fails at any point (no
    first event, silence, an error event, transport loss, cancellation) is
    over, and nothing can settle its call id later, so it closes at once: the
    usage it sent is billed, and with none it is abandoned unbilled.
    """
    call_id = accounting.new_call_id()
    open_call = functools.partial(
        accounting.open_call,
        call_id,
        kind=kind,
        purpose=purpose,
        thinking=thinking,
        context=context,
        spec=spec,
        capacity=capacity,
    )
    # A chat model call on its model's own gate waits in that model's line.
    chat = (
        _chat_wait()
        if kind == accounting.KIND_LLM and spec is not None and capacity is None
        else None
    )
    if chat is None or spec is None or deadline is None:
        await open_call(deadline=deadline)
    else:
        await _open_in_line(open_call, chat, _gate_key(spec), deadline)
    try:
        yield call_id
    except accounting.SettlementError:
        # The receipt exists but could not apply; the deadline sweep closes it.
        raise
    except BaseException as exc:
        if stream is not None and stream.usage is not None and spec is not None:
            try:
                await accounting.settle(
                    call_id=call_id,
                    kind=kind,
                    purpose=purpose,
                    thinking=thinking,
                    spec=spec,
                    usage=stream.usage,
                )
            except Exception:
                log.exception("failed stream %s could not settle its usage", call_id)
        elif stream is not None or (
            # Cancellation stops a request locally but does not prove that the
            # provider stopped before spending, so a non-streamed call keeps
            # its call id open for the receipt-deadline sweeper.
            not isinstance(exc, asyncio.CancelledError)
            and accounting.definitive_provider_failure(exc)
        ):
            await accounting.abandon_call(call_id, exc)
        raise
    finally:
        # The attempt is over whichever way it ended; free its slot so the
        # next waiter is not held behind an abandoned or settled call.
        await accounting.release_call(call_id)
        if spec is not None and capacity is None:
            queue = limits.MODEL_QUEUES.get(_gate_key(spec))
            if queue is not None:
                queue.freed()


@dataclass(frozen=True)
class RetryPolicy:
    """Attempts and wall budget for one logical provider call.

    Every attempt is its own call id. A busy answer (429, 503, 529) waits for
    the provider's Retry-After, else a jittered backoff; a wait that would run
    past the budget ends the call at once. Waiting at a capped model's gate
    spends the same budget.
    """

    attempts: int
    budget_s: float
    # A chat model call's slot policy: it waits in line and once behind a
    # busy provider, with the waiting status (Epo 2026-10-29).
    wait: limits.CallSlotPolicy | None = None


INTERACTIVE_RETRY = RetryPolicy(attempts=2, budget_s=3.0)
INGEST_RETRY = RetryPolicy(attempts=3, budget_s=120.0)


def _interactive() -> bool:
    state = accounting.current()
    return state is None or state.settlement_mode != "ingest"


def retry_policy(*, llm: bool = True) -> RetryPolicy:
    """A chat model call keeps its two attempts but may wait its turn's whole
    wait: in its model's line, and once behind a busy provider (Epo
    2026-10-29). Embeddings and reranks (``llm`` False) keep the interactive
    budget (review L2, L3)."""
    if not _interactive():
        return INGEST_RETRY
    chat = _chat_wait() if llm else None
    if chat is None:
        return INTERACTIVE_RETRY
    return RetryPolicy(
        attempts=INTERACTIVE_RETRY.attempts, budget_s=chat.wait_s, wait=chat
    )


def busy_error(exc: BaseException) -> BaseException | None:
    """The busy provider answer behind ``exc``, following cause links.

    Keyed on the definitive status like ``accounting.provider_status``, so a
    429 surfaces as busy whichever exception type carried it.
    """
    seen: set[int] = set()
    current: BaseException | None = exc
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        status = getattr(current, "status_code", None)
        if status is None:
            status = getattr(getattr(current, "response", None), "status_code", None)
        if (
            isinstance(current, elitellm.ProviderBusy)
            or status in elitellm.BUSY_STATUSES
        ):
            return current
        current = current.__cause__ or current.__context__
    return None


def _provider_retry_after(busy: BaseException) -> float | None:
    """The wait the provider itself asked for, never a synthesized one."""
    if isinstance(busy, elitellm.ProviderBusy):
        return busy.provider_retry_after
    return getattr(busy, "retry_after", None)


def _busy_wait_s(busy: BaseException, attempt: int) -> float:
    retry_after = getattr(busy, "retry_after", None)
    if retry_after is not None:
        return float(retry_after)
    return 0.5 * (2**attempt) * random.uniform(0.75, 1.25)


async def _retry_or_raise(
    exc: BaseException,
    *,
    attempt: int,
    policy: RetryPolicy,
    deadline: float,
    retry_any: bool,
) -> float:
    """Sleep before the next attempt and return its deadline, or raise once
    the call is over.

    ``retry_any`` also retries failures that are not busy answers; streaming
    callers use it for pre-byte failures, whose cause is usually transport.
    """
    busy = busy_error(exc)
    last = attempt >= policy.attempts - 1
    if busy is None:
        if last or not retry_any:
            raise exc
        wait = 0.25 * (2**attempt)
    else:
        wait = _busy_wait_s(busy, attempt)
    chat = policy.wait if busy is not None else None
    if chat is not None:
        # A chat's busy answer gets a window of its own, its Retry-After and
        # then the line, so the first one always goes back in (review M1).
        deadline = time.monotonic() + policy.budget_s
    if last or time.monotonic() + wait > deadline:
        if busy is None:
            raise exc
        raise elitellm.ProviderBusy(
            str(busy) or "the provider is busy",
            status_code=accounting.provider_status(busy),
            retry_after=wait,
            provider_retry_after=_provider_retry_after(busy),
        ) from exc
    # A chat shows the waiting status, not the busy answer, until it is back
    # in its model's line (Epo 2026-10-29); a Stop ends the wait (review L1).
    if chat is not None and chat.on_wait is not None:
        chat.on_wait()
    if chat is None or chat.left is None:
        await asyncio.sleep(wait)
    else:
        try:
            async with asyncio.timeout(wait):
                await chat.left.wait()
        except TimeoutError:
            pass
        else:
            raise CallNotStarted("the client left while the call waited")
    if chat is not None and chat.on_granted is not None:
        chat.on_granted()
    return deadline


# Another attempt would get the same answer, so these end a ``transient`` call
# at once (decided 2026-10-15, parts design Q7).
DEFINITIVE_CLIENT_ERRORS = frozenset({400, 401, 403, 404, 422})


class UnusableAnswer(RuntimeError):
    """An empty answer, or one cut off at the output cap: a failed attempt."""


def _usable_text(resp: Any) -> str | None:
    """The answer's text, or None when it is empty or cut off at the cap."""
    text = (getattr(elitellm.message_from_response(resp), "content", "") or "").strip()
    choices = getattr(resp, "choices", None) or []
    finish = getattr(choices[0], "finish_reason", None) if choices else None
    cut = finish == "length" or getattr(resp, "status", None) == "incomplete"
    return text if text and not cut else None


async def _call_with_retry(
    attempt_call: Any,
    *,
    retry_any: bool = False,
    transient: bool = False,
    llm: bool = True,
) -> Any:
    """Run ``attempt_call(deadline)`` under the current retry policy.

    ``retry_any`` also retries failures that are not busy answers, for calls
    where one dropped attempt is a permanent loss rather than a user retry.
    ``transient`` does the same except for a definitive client error.
    ``llm`` False marks an embedding or rerank, which never waits in line.
    """
    policy = retry_policy(llm=llm)
    deadline = time.monotonic() + policy.budget_s
    for attempt in range(policy.attempts):
        try:
            return await attempt_call(deadline)
        except asyncio.CancelledError:
            raise
        except (registry.RegistryError, accounting.SettlementError):
            raise
        except Exception as exc:  # noqa: BLE001 - the policy re-raises or sleeps
            deadline = await _retry_or_raise(
                exc,
                attempt=attempt,
                policy=policy,
                deadline=deadline,
                retry_any=retry_any
                or (
                    transient
                    and accounting.provider_status(exc) not in DEFINITIVE_CLIENT_ERRORS
                ),
            )
    raise AssertionError("retry loop must return or raise")


def _as_spec(model: ModelConfig) -> ModelConfig:
    if isinstance(model, ModelConfig):
        return model
    raise registry.RegistryError("a pinned ModelConfig is required")


def resolve_query_model(
    provider_slug: str | None = None,
    model_slug: str | None = None,
    version: int | None = None,
    *,
    requested: str | None = None,
    slot: registry.Slot = registry.Slot.CHAT,
) -> ModelConfig:
    """Resolve the exact pinned chat/generate/editor/quiz model.

    ``requested`` is accepted for API compatibility and ignored: a client-
    supplied model string must never override the pin. An empty pin is an
    error for these slots, not a cue to use the live default.
    """
    del requested
    return registry.resolve_pinned(provider_slug, model_slug, version, slot)


_QWEN3_EMBED_MARKER = "qwen3-embedding"


def is_qwen3_embedding(spec: ModelConfig) -> bool:
    return _QWEN3_EMBED_MARKER in spec.model_slug.lower()


def format_query(query: str, spec: ModelConfig) -> str:
    """Shape a search query for the workspace's embedding pin.

    ``spec`` must be that pin — the same row ingest used — so a Qwen3
    workspace gets the instruct form and any other pinned model is left
    alone. Lexical search keeps the raw query.
    """
    if not is_qwen3_embedding(spec):
        return query
    return qwen3_query(query)


def _record_name(spec: ModelConfig) -> str:
    return spec.model_slug


async def embed(texts: list[str], *, spec: ModelConfig) -> list[list[float]]:
    """Embed texts in provider-sized batches, preserving input order.

    ``spec`` is explicit because the two callers get it from different places
    and neither may guess: indexing uses the workspace pin installed on the job,
    and query embedding reads the same pin off the workspace row. Comparing a
    query against chunks embedded by a different model returns ranked nonsense
    with no error, so there is no default to fall back to.

    This sends ``texts`` unchanged. Query prefixes belong in
    :func:`format_query`, called only by search.

    The dimension is part of the column type, so a provider that ignores the
    ``dimensions`` request must fail loudly here rather than write a vector
    Postgres will reject halfway through a file.
    """
    if not texts:
        return []
    out: list[list[float]] = []
    dim = spec.embedding_dim
    for start in range(0, len(texts), cfg.embedding_batch):
        batch = texts[start : start + cfg.embedding_batch]

        async def _one(deadline: float, batch: list[str] = batch) -> Any:
            async with _tracked_call(
                kind=accounting.KIND_EMBEDDING,
                purpose=accounting.KIND_EMBEDDING,
                spec=spec,
                deadline=deadline,
            ) as call_id:
                resp = await elitellm.embed_batch(spec, batch, dimensions=dim)
                obs.record_embedding(spec.provider_slug, _record_name(spec), resp)
                block = getattr(resp, "usage", None)
                await accounting.settle(
                    call_id=call_id,
                    kind=accounting.KIND_EMBEDDING,
                    purpose=accounting.KIND_EMBEDDING,
                    thinking="",
                    spec=spec,
                    usage=extract_usage(block, provider=spec.provider_slug),
                )
            return resp

        resp = await _call_with_retry(_one, llm=False)
        ordered = sorted(resp.data, key=lambda d: d.index)
        for item in ordered:
            vector = list(item.embedding)
            if len(vector) != dim:
                raise RuntimeError(
                    f"embedding model {spec.model_slug} returned dim "
                    f"{len(vector)} != {dim}; the halfvec column width is fixed, "
                    "so fix the registry and re-ingest"
                )
            out.append(vector)
    return out


# The whole wait a search sees for a rerank, busy retry included. Past it
# search keeps fused order.
RERANK_TIMEOUT_S = 5.0

# Rerank requests a search stopped waiting for, held until they settle.
_detached: set[asyncio.Future[Any]] = set()


async def rerank(query: str, documents: list[str], *, spec: ModelConfig) -> list[float]:
    """Relevance of each document to ``query``, in document order.

    Settles as kind ``rerank`` at zero credits, labeled with ``spec``'s catalog
    row. The search waits at most :data:`RERANK_TIMEOUT_S` for the scores,
    admission and busy retry included. The provider request is not cut off
    there: it keeps the whole-call bound of any non-streaming call, so one that
    answers after the search moved on, or after the search was cancelled, still
    settles its measured usage. The settlement always finishes in the
    background.
    """
    bound = time.monotonic() + RERANK_TIMEOUT_S

    async def _one(deadline: float) -> Any:
        async with _tracked_call(
            kind=accounting.KIND_RERANK,
            purpose=accounting.KIND_RERANK,
            spec=spec,
            deadline=min(deadline, bound),
        ) as call_id:
            raw = await elitellm.rerank(spec, query, documents)
            accounting.settle_in_background(
                call_id=call_id,
                kind=accounting.KIND_RERANK,
                purpose=accounting.KIND_RERANK,
                thinking="",
                spec=spec,
                usage=extract_usage(raw, provider=spec.provider_slug),
            )
        return raw

    request = asyncio.ensure_future(_call_with_retry(_one, llm=False))
    _detached.add(request)
    request.add_done_callback(_detached.discard)
    raw = await asyncio.wait_for(
        asyncio.shield(request), max(0.0, bound - time.monotonic())
    )
    scores = raw.get("scores") if isinstance(raw, dict) else None
    if (
        not isinstance(scores, list)
        or len(scores) != len(documents)
        or not all(
            isinstance(score, (int, float)) and math.isfinite(score) for score in scores
        )
    ):
        raise elitellm.ProviderError("rerank answered without one score per document")
    return [float(score) for score in scores]


async def complete(
    messages: list[dict[str, Any]],
    *,
    model: ModelConfig,
    temperature: float | None = None,
    tools: list[dict[str, Any]] | None = None,
    response_format: dict[str, Any] | None = None,
    max_tokens: int | None = None,
    reasoning: bool | None = None,
    call_purpose: str = "llm",
) -> Any:
    """One completion, returning the raw message (may carry tool calls)."""
    resp = await complete_response(
        messages,
        model=model,
        temperature=temperature,
        tools=tools,
        response_format=response_format,
        max_tokens=max_tokens,
        reasoning=reasoning,
        call_purpose=call_purpose,
    )
    return elitellm.message_from_response(resp)


@_slotted
async def complete_response(
    messages: list[dict[str, Any]],
    *,
    model: ModelConfig,
    temperature: float | None = None,
    tools: list[dict[str, Any]] | None = None,
    response_format: dict[str, Any] | None = None,
    max_tokens: int | None = None,
    reasoning: bool | None = None,
    call_purpose: str = "llm",
) -> Any:
    """One completion as a chat-completion-shaped response.

    Interactive callers run over the streaming transport and the stream is
    assembled here, so the idle timeout is what bounds them: a long quiz or
    checkpoint summary fails on silence, not on a whole-call clock. Ingest
    keeps the plain request under its own larger bound, and there (the file
    summary) an empty or cut-off answer is a failed attempt: it settles, then
    takes the next attempt like a transient error.
    """
    spec = _as_spec(model)
    thinking = elitellm.resolve_thinking(spec, reasoning)
    submitted_messages = provider_messages(messages)
    context = measure_request_context(
        messages,
        model=spec,
        tools=tools,
        response_format=response_format,
    )
    streamed = _interactive()

    async def _one(deadline: float) -> Any:
        receipt = _StreamReceipt() if streamed else None
        async with _tracked_call(
            kind=accounting.KIND_LLM,
            purpose=call_purpose,
            thinking=thinking,
            context=context,
            spec=spec,
            deadline=deadline,
            stream=receipt,
        ) as call_id:
            if receipt is not None:
                assembled = await _stream_via_adapter(
                    spec,
                    submitted_messages,
                    tools,
                    temperature,
                    None,
                    receipt=receipt,
                    max_tokens=max_tokens,
                    reasoning=reasoning,
                    response_format=response_format,
                )
                if assembled.status == "error":
                    raise elitellm.ProviderError(
                        assembled.error or "provider stream failed"
                    )
                usage = assembled.usage
                message = dict(assembled.provider_message)
                message.setdefault("role", "assistant")
                message.setdefault("content", assembled.text)
                resp = elitellm.chat_response(
                    message,
                    finish_reason="length"
                    if assembled.status == "incomplete"
                    else ("tool_calls" if assembled.tool_calls else "stop"),
                    usage=usage,
                )
            else:
                resp = await elitellm.complete(
                    spec,
                    submitted_messages,
                    temperature=temperature,
                    tools=tools,
                    response_format=response_format,
                    max_tokens=max_tokens,
                    reasoning=reasoning,
                    input_items=messages_to_responses_input(submitted_messages)
                    if elitellm.uses_responses(
                        spec, tools=bool(tools), reasoning=reasoning
                    )
                    else None,
                )
                usage = response_usage(resp, provider=spec.provider_slug)
            obs.record_normalized(
                spec.provider_slug,
                _record_name(spec),
                usage.input_tokens,
                usage.output_tokens,
                cached_read_tokens=usage.cached_read_tokens,
                cache_write_tokens=usage.cache_write_tokens,
                reasoning_tokens=usage.reasoning_tokens,
                cache_anomaly=usage.anomaly,
            )
            await accounting.settle(
                call_id=call_id,
                kind=accounting.KIND_LLM,
                purpose=call_purpose,
                thinking=thinking,
                spec=spec,
                usage=usage,
            )
        if not streamed and _usable_text(resp) is None:
            raise UnusableAnswer("empty or cut-off answer")
        return resp

    return await _call_with_retry(_one, transient=not streamed)


async def complete_text(
    messages: list[dict[str, Any]],
    *,
    model: ModelConfig,
    temperature: float | None = None,
    max_tokens: int | None = None,
    reasoning: bool | None = None,
    call_purpose: str = "llm",
) -> str:
    message = await complete(
        messages,
        model=model,
        temperature=temperature,
        max_tokens=max_tokens,
        reasoning=reasoning,
        call_purpose=call_purpose,
    )
    return (getattr(message, "content", "") or "").strip()


def provider_messages(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Drop private keys the loop tags onto rows before they reach a provider."""
    out: list[dict[str, Any]] = []
    drop = {"_kind", "citations", "id"}
    for message in messages:
        out.append(
            {
                k: v
                for k, v in message.items()
                if k not in drop and not str(k).startswith("_")
            }
        )
    return out


def message_tokens(message: dict[str, Any]) -> int:
    """One message's estimate, computed when it is first measured and kept on
    the message (Epo 2026-10-24, Q238), so no model call walks the whole
    context again. Attached page captures count by pixel size, not base64."""
    kept = accounting.kept_tokens(message)
    if kept is not None:
        return kept
    (text,), image_tokens = capture.split_images(provider_messages([message]))
    return accounting.keep_tokens(
        message, accounting.estimate_context_value(text) + image_tokens
    )


def measure_request_context(
    messages: list[dict[str, Any]],
    *,
    model: ModelConfig,
    tools: list[dict[str, Any]] | None = None,
    response_format: dict[str, Any] | None = None,
) -> accounting.ContextComposition:
    """A request's estimate: its messages' kept estimates summed, plus its tool
    schemas. Telemetry, the model input budget and compaction read it; exact
    counts are not needed in real time (Q238)."""
    spec = _as_spec(model)
    system = conversation = 0
    for message in messages:
        if message.get("role") == "system":
            system += message_tokens(message)
        else:
            conversation += message_tokens(message)
    schemas = [*(tools or []), *([response_format] if response_format else [])]
    return accounting.ContextComposition(
        system_tokens=system,
        tool_tokens=accounting.estimate_context_value(schemas) if schemas else 0,
        conversation_tokens=conversation,
        window_tokens=max(0, int(spec.context_window_tokens)),
    )


def messages_to_responses_input(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    for message in messages:
        role = message.get("role")
        if message.get("output_items"):
            items.extend(message["output_items"])
            has_text = any(
                str(item.get("type") or "") in ("message", "output_text")
                or item.get("role") == "assistant"
                for item in message["output_items"]
            )
            if message.get("content") and not has_text:
                items.append({"role": "assistant", "content": message["content"]})
            continue
        if role == "tool":
            items.append(
                {
                    "type": "function_call_output",
                    "call_id": message.get("tool_call_id"),
                    "output": message.get("content") or "",
                }
            )
            continue
        if role == "assistant" and message.get("tool_calls"):
            content = message.get("content") or ""
            if content:
                items.append({"role": "assistant", "content": content})
            for call in message["tool_calls"]:
                fn = call.get("function") or {}
                items.append(
                    {
                        "type": "function_call",
                        "call_id": call.get("id"),
                        "name": fn.get("name"),
                        "arguments": fn.get("arguments") or "",
                    }
                )
            continue
        if role in ("system", "user", "assistant"):
            items.append({"role": role, "content": _responses_content(message)})
    return items


def _responses_content(message: dict[str, Any]) -> Any:
    """Chat-completions content parts in the Responses API's input shape."""
    content = message.get("content")
    if not isinstance(content, list):
        return content or ""
    parts: list[dict[str, Any]] = []
    for part in content:
        if not isinstance(part, dict):
            continue
        if part.get("type") == "image_url":
            url = (part.get("image_url") or {}).get("url", "")
            parts.append({"type": "input_image", "image_url": url, "detail": "auto"})
        elif part.get("type") == "text":
            parts.append({"type": "input_text", "text": str(part.get("text") or "")})
    return parts


@_slotted
async def stream_agent_response(
    messages: list[dict[str, Any]],
    *,
    model: ModelConfig,
    tools: list[dict[str, Any]] | None = None,
    temperature: float | None = None,
    on_event: Any | None = None,
    call_purpose: str = accounting.PURPOSE_AGENT,
    response_format: dict[str, Any] | None = None,
    stopped: Callable[[], bool] | None = None,
) -> AssembledResponse:
    """Stream one tool-capable model response into a normalized assembly.

    Failures before the first provider byte are retried on a new call id
    under the retry policy; a busy answer waits for Retry-After. A byte from
    the provider, or a token already handed to the client from this call,
    makes the attempt final: abandon and raise. The client not having seen
    SSE yet does not make a post-byte failure retryable. Once ``stopped()``
    says the turn was stopped, a failure raises instead of retrying.
    """
    spec = _as_spec(model)
    thinking = elitellm.resolve_thinking(spec)
    submitted_messages = provider_messages(messages)
    context = measure_request_context(
        messages,
        model=spec,
        tools=tools,
        response_format=response_format,
    )
    policy = retry_policy()
    deadline = time.monotonic() + policy.budget_s
    for attempt in range(policy.attempts):
        received = _StreamReceipt()
        try:
            async with _tracked_call(
                kind=accounting.KIND_LLM,
                purpose=call_purpose,
                thinking=thinking,
                context=context,
                spec=spec,
                deadline=deadline,
                stream=received,
            ) as call_id:
                assembled = await _stream_via_adapter(
                    spec,
                    submitted_messages,
                    tools,
                    temperature,
                    on_event,
                    receipt=received,
                    response_format=response_format,
                )
                obs.record_normalized(
                    spec.provider_slug,
                    _record_name(spec),
                    assembled.usage.input_tokens,
                    assembled.usage.output_tokens,
                    cached_read_tokens=assembled.usage.cached_read_tokens,
                    cache_write_tokens=assembled.usage.cache_write_tokens,
                    reasoning_tokens=assembled.usage.reasoning_tokens,
                    cache_anomaly=assembled.usage.anomaly,
                )
                await accounting.settle(
                    call_id=call_id,
                    kind=accounting.KIND_LLM,
                    purpose=call_purpose,
                    thinking=thinking,
                    spec=spec,
                    usage=assembled.usage,
                )
            return assembled
        except asyncio.CancelledError:
            raise
        except (registry.RegistryError, accounting.SettlementError):
            raise
        except Exception as exc:
            if received.seen:
                raise
            if stopped is not None and stopped():
                raise
            deadline = await _retry_or_raise(
                exc,
                attempt=attempt,
                policy=policy,
                deadline=deadline,
                retry_any=True,
            )
            # A stop during the wait (a backoff or the provider's Retry-After)
            # starts no next attempt either.
            if stopped is not None and stopped():
                raise
    raise AssertionError("retry loop must return or raise")


async def _stream_via_adapter(
    spec: ModelConfig,
    messages: list[dict[str, Any]],
    tools: list[dict[str, Any]] | None,
    temperature: float | None,
    on_event: Any | None,
    *,
    receipt: _StreamReceipt | None = None,
    max_tokens: int | None = None,
    reasoning: bool | None = None,
    response_format: dict[str, Any] | None = None,
) -> AssembledResponse:
    if elitellm.uses_responses(spec, tools=bool(tools), reasoning=reasoning):
        assembler: ChatCompletionsAssembler | OpenAIResponsesAssembler = (
            OpenAIResponsesAssembler()
        )
        input_items = messages_to_responses_input(provider_messages(messages))
    else:
        assembler = ChatCompletionsAssembler(spec.provider_slug)
        input_items = None
    stream = elitellm.stream(
        spec,
        provider_messages(messages),
        temperature=temperature,
        tools=tools,
        max_tokens=max_tokens,
        reasoning=reasoning,
        input_items=input_items,
        response_format=response_format,
    )
    async for chunk in stream:
        if receipt is not None:
            receipt.seen = True
        for item in assembler.push(chunk):
            if receipt is not None and item.usage is not None:
                receipt.usage = item.usage
            if on_event is not None:
                on_event(item)
    return assembler.finish()


@_slotted_stream
async def stream_text(
    messages: list[dict[str, Any]],
    *,
    model: ModelConfig,
    temperature: float | None = None,
    max_tokens: int | None = None,
    reasoning: bool | None = None,
):
    """Yield text deltas. Pre-byte failures retry like the agent stream."""
    spec = _as_spec(model)
    thinking = elitellm.resolve_thinking(spec, reasoning)
    submitted_messages = provider_messages(messages)
    context = measure_request_context(messages, model=spec)
    policy = retry_policy()
    deadline = time.monotonic() + policy.budget_s
    for attempt in range(policy.attempts):
        received = _StreamReceipt()
        try:
            async with _tracked_call(
                kind=accounting.KIND_LLM,
                purpose="llm",
                thinking=thinking,
                context=context,
                spec=spec,
                deadline=deadline,
                stream=received,
            ) as call_id:
                usage = NormalizedUsage()
                stream = elitellm.stream(
                    spec,
                    submitted_messages,
                    temperature=temperature,
                    max_tokens=max_tokens,
                    reasoning=reasoning,
                    input_items=messages_to_responses_input(submitted_messages)
                    if elitellm.uses_responses(spec, reasoning=reasoning)
                    else None,
                )
                async for chunk in stream:
                    received.seen = True
                    obs.record_stream_chunk(
                        spec.provider_slug, _record_name(spec), chunk
                    )
                    if getattr(chunk, "usage", None) is not None:
                        usage = response_usage(chunk, provider=spec.provider_slug)
                        received.usage = usage
                    choices = getattr(chunk, "choices", None) or []
                    delta = ""
                    if choices:
                        delta = (
                            getattr(getattr(choices[0], "delta", None), "content", "")
                            or ""
                        )
                    if not delta:
                        etype = str(getattr(chunk, "type", "") or "")
                        if etype in (
                            "response.output_text.delta",
                            "response.text.delta",
                        ):
                            delta = str(getattr(chunk, "delta", "") or "")
                    if delta:
                        yield delta
                await accounting.settle(
                    call_id=call_id,
                    kind=accounting.KIND_LLM,
                    purpose="llm",
                    thinking=thinking,
                    spec=spec,
                    usage=usage,
                )
            return
        except asyncio.CancelledError:
            raise
        except (registry.RegistryError, accounting.SettlementError):
            raise
        except Exception as exc:
            if received.seen:
                raise
            deadline = await _retry_or_raise(
                exc,
                attempt=attempt,
                policy=policy,
                deadline=deadline,
                retry_any=True,
            )


# A page is about 460 output tokens; the cap ends a degenerate loop early.
VLM_PAGE_MAX_TOKENS = 2_000


@_slotted
async def read_page(
    data_url: str, *, credit_micros: int, scripted: str | None = None
) -> str | None:
    """Read one text-less page with the captioning-slot VLM.

    One read: the ingest policy's attempts, each its own call. A busy provider
    waits and, past the budget, raises ProviderBusy so the job re-pends. A
    transient error, an empty answer or one cut off at the output cap takes the
    next attempt; after the last, or at a definitive client error, the page is
    unread (None). Only a usable read is charged, at ``credit_micros``.

    ``scripted`` (UAT only, ``ingest/uat.py``) is the read's text: the call is
    opened and settled at ``credit_micros`` as a read, with no provider call.
    """
    spec = registry.captioning_spec()
    thinking = elitellm.resolve_thinking(spec, reasoning=False)
    messages = [
        {"role": "system", "content": VLM_PAGE_PROMPT},
        {
            "role": "user",
            "content": [{"type": "image_url", "image_url": {"url": data_url}}],
        },
    ]
    context = measure_request_context(messages, model=spec)

    async def _one(deadline: float) -> str:
        async with _tracked_call(
            kind=accounting.KIND_LLM,
            purpose="vlm_page",
            thinking=thinking,
            context=context,
            spec=spec,
            deadline=deadline,
            # A gate of its own, apart from the captioning model's ingest share:
            # at most CAPY_VLM_PAGE_CAPACITY in flight across every worker.
            capacity=("vlm_page", cfg.vlm_page_capacity),
        ) as call_id:
            if scripted is None:
                resp = await elitellm.complete(
                    spec, messages, reasoning=False, max_tokens=VLM_PAGE_MAX_TOKENS
                )
                obs.record_completion(spec.provider_slug, _record_name(spec), resp)
                read = _usable_text(resp)
                usage = response_usage(resp, provider=spec.provider_slug)
            else:
                read, usage = scripted, NormalizedUsage()
            await accounting.settle(
                call_id=call_id,
                kind=accounting.KIND_LLM,
                purpose="vlm_page",
                thinking=thinking,
                spec=spec,
                usage=usage,
                credit_micros=credit_micros if read else 0,
            )
        # Raised after settling at 0, so it counts as one of the attempts.
        if read is None:
            raise UnusableAnswer("empty or cut-off page read")
        return read

    try:
        return await _call_with_retry(_one, transient=True)
    except asyncio.CancelledError:
        raise
    except (accounting.SettlementError, elitellm.ProviderBusy):
        raise
    except Exception:
        log.warning("VLM page read failed", exc_info=True)
        return None


@_slotted
async def caption_image(data_url: str, prompt: str) -> str:
    """Describe a standalone image upload so it becomes searchable text.

    The ingest policy's attempts (parts design Q7): a transient error, an
    empty answer or one cut off at the output cap takes the next attempt; a
    definitive client error ends the call. Past that budget a busy provider
    raises ProviderBusy so the job re-pends instead of spending an attempt,
    since the caption is the file's whole content.
    """
    spec = registry.captioning_spec()
    caption_thinking = elitellm.resolve_thinking(spec, reasoning=False)
    # The prompt rides as the system message (decision 2026-10-15, made when
    # Relace refused an image with no system prompt, tools or earlier turns).
    messages = [
        {"role": "system", "content": prompt},
        {
            "role": "user",
            "content": [{"type": "image_url", "image_url": {"url": data_url}}],
        },
    ]
    context = measure_request_context(messages, model=spec)

    async def _one(deadline: float) -> str:
        async with _tracked_call(
            kind=accounting.KIND_LLM,
            purpose="image_caption",
            thinking=caption_thinking,
            context=context,
            spec=spec,
            deadline=deadline,
        ) as call_id:
            # Captions never inherit a user's chat reasoning level. The
            # provider adapter resolves this to the model's fixed minimum.
            resp = await elitellm.complete(spec, messages, reasoning=False)
            obs.record_completion(spec.provider_slug, _record_name(spec), resp)
            await accounting.settle(
                call_id=call_id,
                kind=accounting.KIND_LLM,
                purpose="image_caption",
                thinking=caption_thinking,
                spec=spec,
                usage=response_usage(resp, provider=spec.provider_slug),
            )
        caption = _usable_text(resp)
        # Raised after settling, so it counts as one of the attempts.
        if caption is None:
            raise UnusableAnswer("empty or cut-off caption")
        return caption

    try:
        return await _call_with_retry(_one, transient=True)
    except asyncio.CancelledError:
        raise
    except (accounting.SettlementError, elitellm.ProviderBusy):
        # After a settlement error the provider already returned and the
        # receipt was retried through its deadline, so a new call only adds
        # cost; a busy provider re-pends the job.
        raise
    except Exception:
        log.warning("image caption failed", exc_info=True)
        return ""
