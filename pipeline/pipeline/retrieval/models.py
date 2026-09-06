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
import logging
import math
import random
import time
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any

from .. import elitellm, obs, registry
from ..config import cfg
from ..prompts.retrieval import qwen3_query
from ..registry import ModelConfig
from . import accounting
from .stream import (
    AssembledResponse,
    ChatCompletionsAssembler,
    OpenAIResponsesAssembler,
)
from .usage_extract import NormalizedUsage, extract_usage

log = logging.getLogger("capy.models")

INVALID_KEY = "invalid_key"
KEY_FAILED = "key_failed"
INVALID_KEY_MSG = "The provider rejected this key."
KEY_FAILED_MSG = "Something went wrong, please double check if the key is valid."
BUSY_ERROR_CODE = "provider_busy"
BUSY_ERROR = "The model is busy right now. Try again in a moment."


def busy_retry_after_s(exc: BaseException) -> int:
    """Whole seconds a client should wait before retrying a busy call."""
    retry_after = getattr(exc, "retry_after", None)
    if retry_after is None or retry_after <= 0:
        retry_after = accounting.BUSY_RETRY_AFTER_S
    return max(1, math.ceil(retry_after))


class UserKeyError(RuntimeError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message

    def as_event(self) -> dict[str, str]:
        return {"type": "error", "code": self.code, "message": self.message}


def classify_user_key_error(exc: BaseException) -> UserKeyError | None:
    if registry.current_request_llm().paid_by != "user":
        return None
    status = getattr(exc, "status_code", None)
    name = type(exc).__name__.lower()
    if status in (401, 403) or "authentication" in name or "permission" in name:
        return UserKeyError(INVALID_KEY, INVALID_KEY_MSG)
    text = str(exc).lower()
    if any(
        token in text
        for token in (
            "invalid api key",
            "incorrect api key",
            "invalid_api_key",
            "authentication",
            "unauthorized",
            "forbidden",
        )
    ):
        return UserKeyError(INVALID_KEY, INVALID_KEY_MSG)
    return UserKeyError(KEY_FAILED, KEY_FAILED_MSG)


@asynccontextmanager
async def _tracked_call(
    *,
    kind: str,
    purpose: str,
    thinking: str = "",
    context: accounting.ContextComposition | None = None,
    spec: ModelConfig | None = None,
    deadline: float | None = None,
):
    call_id = accounting.new_call_id()
    await accounting.open_call(
        call_id,
        kind=kind,
        purpose=purpose,
        thinking=thinking,
        context=context,
        spec=spec,
        deadline=deadline,
    )
    try:
        yield call_id
    except asyncio.CancelledError:
        # Cancellation stops this request locally but does not prove that the
        # provider stopped before spending. Keep the exact call id open for a
        # late receipt or the receipt-deadline sweeper.
        raise
    except BaseException as exc:
        if not isinstance(exc, accounting.SettlementError) and (
            accounting.definitive_provider_failure(exc)
        ):
            await accounting.abandon_call(call_id, exc)
        raise
    finally:
        # The attempt is over whichever way it ended; free its slot so the
        # next waiter is not held behind an abandoned or settled call.
        await accounting.release_call(call_id)


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


INTERACTIVE_RETRY = RetryPolicy(attempts=2, budget_s=3.0)
INGEST_RETRY = RetryPolicy(attempts=4, budget_s=120.0)


def _interactive() -> bool:
    state = accounting.current()
    return state is None or state.settlement_mode != "ingest"


def retry_policy() -> RetryPolicy:
    return INTERACTIVE_RETRY if _interactive() else INGEST_RETRY


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
) -> None:
    """Sleep before the next attempt, or raise once the call is over.

    ``retry_any`` also retries failures that are not busy answers; streaming
    callers use it for pre-byte failures, whose cause is usually transport.
    """
    busy = busy_error(exc)
    last = attempt >= policy.attempts - 1
    if busy is None:
        if last or not retry_any:
            _raise_user_key(exc)
        wait = 0.25 * (2**attempt)
    else:
        wait = _busy_wait_s(busy, attempt)
    if last or time.monotonic() + wait > deadline:
        if busy is None:
            _raise_user_key(exc)
        raise elitellm.ProviderBusy(
            str(busy) or "the provider is busy",
            status_code=accounting.provider_status(busy),
            retry_after=wait,
            provider_retry_after=_provider_retry_after(busy),
        ) from exc
    await asyncio.sleep(wait)


async def _call_with_retry(attempt_call: Any, *, retry_any: bool = False) -> Any:
    """Run ``attempt_call(deadline)`` under the current retry policy.

    ``retry_any`` also retries failures that are not busy answers, for calls
    where one dropped attempt is a permanent loss rather than a user retry.
    """
    policy = retry_policy()
    deadline = time.monotonic() + policy.budget_s
    for attempt in range(policy.attempts):
        try:
            return await attempt_call(deadline)
        except asyncio.CancelledError:
            raise
        except (UserKeyError, registry.RegistryError, accounting.SettlementError):
            raise
        except Exception as exc:  # noqa: BLE001 - the policy re-raises or sleeps
            await _retry_or_raise(
                exc,
                attempt=attempt,
                policy=policy,
                deadline=deadline,
                retry_any=retry_any,
            )
    raise AssertionError("retry loop must return or raise")


class _ByteFlag:
    def __init__(self) -> None:
        self.seen = False

    def mark(self) -> None:
        self.seen = True


def _raise_user_key(exc: BaseException) -> None:
    # A busy answer is the provider's capacity, not the user's key.
    if busy_error(exc) is None:
        mapped = classify_user_key_error(exc)
        if mapped is not None:
            raise mapped from exc
    raise exc


def quiz_grade_max_tokens(_model: ModelConfig | None = None) -> int:
    """Short grade JSON. The grade call always disables thinking."""
    return 80


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
                try:
                    resp = await elitellm.embed_batch(spec, batch, dimensions=dim)
                except Exception as exc:  # noqa: BLE001
                    _raise_user_key(exc)
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

        resp = await _call_with_retry(_one)
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
    keeps the plain request under its own larger bound.
    """
    spec = _as_spec(model)
    thinking = elitellm.resolve_thinking(spec, reasoning)
    submitted_messages = provider_messages(messages)
    context = measure_request_context(
        messages,
        model=spec,
        tools=tools,
        response_format=response_format,
        reasoning=reasoning,
    )
    streamed = _interactive()

    async def _one(deadline: float) -> Any:
        async with _tracked_call(
            kind=accounting.KIND_LLM,
            purpose=call_purpose,
            thinking=thinking,
            context=context,
            spec=spec,
            deadline=deadline,
        ) as call_id:
            try:
                if streamed:
                    assembled = await _stream_via_adapter(
                        spec,
                        submitted_messages,
                        tools,
                        temperature,
                        None,
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
                    usage = extract_usage(
                        getattr(resp, "usage", None), provider=spec.provider_slug
                    )
            except Exception as exc:  # noqa: BLE001
                _raise_user_key(exc)
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
        return resp

    return await _call_with_retry(_one)


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


def measure_request_context(
    messages: list[dict[str, Any]],
    *,
    model: ModelConfig,
    tools: list[dict[str, Any]] | None = None,
    response_format: dict[str, Any] | None = None,
    reasoning: bool | None = None,
) -> accounting.ContextComposition:
    """Measure the same provider-shaped fields the outbound call will use."""
    spec = _as_spec(model)
    submitted = provider_messages(messages)
    input_items = (
        messages_to_responses_input(submitted)
        if elitellm.uses_responses(spec, tools=bool(tools), reasoning=reasoning)
        else None
    )
    system, conversation, schemas = elitellm.context_components(
        spec,
        submitted,
        tools=tools,
        response_format=response_format,
        reasoning=reasoning,
        input_items=input_items,
    )
    return accounting.measure_components(
        system,
        conversation,
        schemas,
        window_tokens=spec.context_window_tokens,
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
            items.append({"role": role, "content": message.get("content") or ""})
    return items


async def stream_agent_response(
    messages: list[dict[str, Any]],
    *,
    model: ModelConfig,
    tools: list[dict[str, Any]] | None = None,
    temperature: float | None = None,
    on_event: Any | None = None,
    call_purpose: str = accounting.PURPOSE_AGENT,
) -> AssembledResponse:
    """Stream one tool-capable model response into a normalized assembly.

    Failures before the first provider byte are retried on a new call id
    under the retry policy; a busy answer waits for Retry-After. A byte from
    the provider, or a token already handed to the client from this call,
    makes the attempt final: abandon and raise. The client not having seen
    SSE yet does not make a post-byte failure retryable.
    """
    spec = _as_spec(model)
    thinking = elitellm.resolve_thinking(spec)
    submitted_messages = provider_messages(messages)
    context = measure_request_context(
        messages,
        model=spec,
        tools=tools,
    )
    policy = retry_policy()
    deadline = time.monotonic() + policy.budget_s
    for attempt in range(policy.attempts):
        received = _ByteFlag()
        try:
            async with _tracked_call(
                kind=accounting.KIND_LLM,
                purpose=call_purpose,
                thinking=thinking,
                context=context,
                spec=spec,
                deadline=deadline,
            ) as call_id:
                assembled = await _stream_via_adapter(
                    spec,
                    submitted_messages,
                    tools,
                    temperature,
                    on_event,
                    on_provider_byte=received.mark,
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
        except (UserKeyError, registry.RegistryError, accounting.SettlementError):
            raise
        except Exception as exc:
            if received.seen:
                _raise_user_key(exc)
            mapped = classify_user_key_error(exc)
            if mapped is not None and mapped.code == INVALID_KEY:
                raise mapped from exc
            await _retry_or_raise(
                exc,
                attempt=attempt,
                policy=policy,
                deadline=deadline,
                retry_any=True,
            )
    raise AssertionError("retry loop must return or raise")


async def _stream_via_adapter(
    spec: ModelConfig,
    messages: list[dict[str, Any]],
    tools: list[dict[str, Any]] | None,
    temperature: float | None,
    on_event: Any | None,
    on_provider_byte: Any | None = None,
    *,
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
        if on_provider_byte is not None:
            on_provider_byte()
        for item in assembler.push(chunk):
            if on_event is not None:
                on_event(item)
    return assembler.finish()


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
    context = measure_request_context(
        messages,
        model=spec,
        reasoning=reasoning,
    )
    policy = retry_policy()
    deadline = time.monotonic() + policy.budget_s
    for attempt in range(policy.attempts):
        received = _ByteFlag()
        try:
            async with _tracked_call(
                kind=accounting.KIND_LLM,
                purpose="llm",
                thinking=thinking,
                context=context,
                spec=spec,
                deadline=deadline,
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
                    received.mark()
                    obs.record_stream_chunk(
                        spec.provider_slug, _record_name(spec), chunk
                    )
                    block = getattr(chunk, "usage", None)
                    if block is not None:
                        usage = extract_usage(block, provider=spec.provider_slug)
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
        except (UserKeyError, registry.RegistryError, accounting.SettlementError):
            raise
        except Exception as exc:
            if received.seen:
                _raise_user_key(exc)
            mapped = classify_user_key_error(exc)
            if mapped is not None and mapped.code == INVALID_KEY:
                raise mapped from exc
            await _retry_or_raise(
                exc,
                attempt=attempt,
                policy=policy,
                deadline=deadline,
                retry_any=True,
            )


async def caption_image(data_url: str, prompt: str, *, best_effort: bool = True) -> str:
    """Describe one figure so it becomes searchable text.

    Any failure is retried under the ingest policy, since a figure-heavy
    document issues hundreds of these and one dropped caption is one figure
    permanently missing from the index. Past that budget a figure caption is
    dropped, while a standalone image upload, whose caption is the whole
    content, raises ProviderBusy so its job re-pends instead of spending an
    attempt.
    """
    spec = registry.captioning_spec()
    caption_thinking = elitellm.resolve_thinking(spec, reasoning=False)
    messages = [
        {
            "role": "user",
            "content": [
                {"type": "text", "text": prompt},
                {"type": "image_url", "image_url": {"url": data_url}},
            ],
        }
    ]
    context = measure_request_context(messages, model=spec, reasoning=False)

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
                usage=extract_usage(
                    getattr(resp, "usage", None), provider=spec.provider_slug
                ),
            )
            message = elitellm.message_from_response(resp)
            return (getattr(message, "content", "") or "").strip()

    try:
        # A transient failure here loses one figure for good, so every failure
        # gets the policy's attempts, not only busy answers.
        return await _call_with_retry(_one, retry_any=True)
    except asyncio.CancelledError:
        raise
    except accounting.SettlementError:
        # The provider already returned. Settlement has already retried the
        # exact receipt through its deadline, so a new call can only add cost.
        raise
    except elitellm.ProviderBusy:
        if not best_effort:
            raise
        log.warning("image caption dropped: provider busy", exc_info=True)
        return ""
    except Exception:
        log.warning("image caption failed", exc_info=True)
        return ""
