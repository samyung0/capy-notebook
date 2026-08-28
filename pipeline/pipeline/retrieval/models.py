"""Model clients. Every provider call goes through elitellm.

Routing is owned by the model registry: a pinned provider/model/version resolves
to an exact provider + model slug. Nothing here resolves a surface default —
every entry point takes the pin its caller was priced for.

Every provider call in the system passes through this module. That makes it
the only place token usage has to be captured, and the only place a missing
capture can hide — if a new call site is added elsewhere, its spend is
invisible and the user is silently not charged for it.
"""

from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager
from typing import Any

from .. import elitellm, obs, registry
from ..config import cfg
from ..registry import ModelConfig
from . import accounting
from .stream import (
    AssembledResponse,
    ChatCompletionsAssembler,
    OpenAIResponsesAssembler,
)
from .usage_extract import NormalizedUsage, extract_usage

log = logging.getLogger("evo.models")

INVALID_KEY = "invalid_key"
KEY_FAILED = "key_failed"
INVALID_KEY_MSG = "The provider rejected this key."
KEY_FAILED_MSG = "Something went wrong, please double check if the key is valid."


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
):
    call_id = accounting.new_call_id()
    await accounting.open_call(
        call_id,
        kind=kind,
        purpose=purpose,
        thinking=thinking,
        context=context,
    )
    try:
        yield call_id
    except BaseException:
        await accounting.abandon_call(call_id)
        raise


PRE_BYTE_RETRIES = 2


class _ByteFlag:
    def __init__(self) -> None:
        self.seen = False

    def mark(self) -> None:
        self.seen = True


def _raise_user_key(exc: BaseException) -> None:
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
    surface: registry.Surface = registry.Surface.CHAT,
) -> ModelConfig:
    """Resolve the exact pinned chat/generate/editor/quiz model.

    ``requested`` is accepted for API compatibility and ignored: a client-
    supplied model string must never override the pin. An empty pin is an
    error for these surfaces, not a cue to use the live default.
    """
    del requested
    return registry.resolve_pinned(provider_slug, model_slug, version, surface)


_QWEN3_EMBED_MARKER = "qwen3-embedding"
_QWEN3_QUERY_TASK = (
    "Given a question about the user's notes and uploaded materials, "
    "retrieve relevant passages that answer the question"
)


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
    return f"Instruct: {_QWEN3_QUERY_TASK}\nQuery:{query}"


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
        async with _tracked_call(
            kind=accounting.KIND_EMBEDDING,
            purpose=accounting.KIND_EMBEDDING,
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
    async with _tracked_call(
        kind=accounting.KIND_LLM,
        purpose=call_purpose,
        thinking=thinking,
        context=context,
    ) as call_id:
        try:
            resp = await elitellm.complete(
                spec,
                submitted_messages,
                temperature=temperature,
                tools=tools,
                response_format=response_format,
                max_tokens=max_tokens,
                reasoning=reasoning,
                input_items=messages_to_responses_input(submitted_messages)
                if elitellm.uses_responses(spec, tools=bool(tools), reasoning=reasoning)
                else None,
            )
        except Exception as exc:  # noqa: BLE001
            _raise_user_key(exc)
        obs.record_completion(spec.provider_slug, _record_name(spec), resp)
        await accounting.settle(
            call_id=call_id,
            kind=accounting.KIND_LLM,
            purpose=call_purpose,
            thinking=thinking,
            spec=spec,
            usage=extract_usage(
                getattr(resp, "usage", None), provider=spec.provider_slug
            ),
        )
    return elitellm.message_from_response(resp)


async def complete_response(
    messages: list[dict[str, Any]],
    *,
    model: ModelConfig,
    temperature: float | None = None,
    max_tokens: int | None = None,
    reasoning: bool | None = None,
    call_purpose: str = "llm",
) -> Any:
    """Like complete, but returns the full response so callers can read usage."""
    spec = _as_spec(model)
    thinking = elitellm.resolve_thinking(spec, reasoning)
    submitted_messages = provider_messages(messages)
    context = measure_request_context(
        messages,
        model=spec,
        reasoning=reasoning,
    )
    async with _tracked_call(
        kind=accounting.KIND_LLM,
        purpose=call_purpose,
        thinking=thinking,
        context=context,
    ) as call_id:
        try:
            resp = await elitellm.complete(
                spec,
                submitted_messages,
                temperature=temperature,
                max_tokens=max_tokens,
                reasoning=reasoning,
                input_items=messages_to_responses_input(submitted_messages)
                if elitellm.uses_responses(spec, reasoning=reasoning)
                else None,
            )
        except Exception as exc:  # noqa: BLE001
            _raise_user_key(exc)
        obs.record_completion(spec.provider_slug, _record_name(spec), resp)
        await accounting.settle(
            call_id=call_id,
            kind=accounting.KIND_LLM,
            purpose=call_purpose,
            thinking=thinking,
            spec=spec,
            usage=extract_usage(
                getattr(resp, "usage", None), provider=spec.provider_slug
            ),
        )
    return resp


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

    Failures before the first provider byte are retried on a new call id.
    A byte from the provider, or a token already handed to the client from
    this call, makes the attempt final: abandon and raise. The client not
    having seen SSE yet does not make a post-byte failure retryable.
    """
    spec = _as_spec(model)
    thinking = elitellm.resolve_thinking(spec)
    submitted_messages = provider_messages(messages)
    context = measure_request_context(
        messages,
        model=spec,
        tools=tools,
    )
    attempts = 1 + PRE_BYTE_RETRIES
    last_exc: BaseException | None = None
    for attempt in range(attempts):
        received = _ByteFlag()
        try:
            async with _tracked_call(
                kind=accounting.KIND_LLM,
                purpose=call_purpose,
                thinking=thinking,
                context=context,
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
        except (UserKeyError, registry.RegistryError):
            raise
        except Exception as exc:
            last_exc = exc
            if received.seen or attempt >= attempts - 1:
                _raise_user_key(exc)
            mapped = classify_user_key_error(exc)
            if mapped is not None and mapped.code == INVALID_KEY:
                raise mapped from exc
            await asyncio.sleep(0.25 * (2**attempt))
    assert last_exc is not None
    raise last_exc


async def _stream_via_adapter(
    spec: ModelConfig,
    messages: list[dict[str, Any]],
    tools: list[dict[str, Any]] | None,
    temperature: float | None,
    on_event: Any | None,
    on_provider_byte: Any | None = None,
) -> AssembledResponse:
    if elitellm.uses_responses(spec, tools=bool(tools)):
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
        input_items=input_items,
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
    spec = _as_spec(model)
    thinking = elitellm.resolve_thinking(spec, reasoning)
    submitted_messages = provider_messages(messages)
    context = measure_request_context(
        messages,
        model=spec,
        reasoning=reasoning,
    )
    async with _tracked_call(
        kind=accounting.KIND_LLM,
        purpose="llm",
        thinking=thinking,
        context=context,
    ) as call_id:
        usage = NormalizedUsage()
        try:
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
                obs.record_stream_chunk(spec.provider_slug, _record_name(spec), chunk)
                block = getattr(chunk, "usage", None)
                if block is not None:
                    usage = extract_usage(block, provider=spec.provider_slug)
                choices = getattr(chunk, "choices", None) or []
                delta = ""
                if choices:
                    delta = (
                        getattr(getattr(choices[0], "delta", None), "content", "") or ""
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
        except Exception as exc:  # noqa: BLE001
            _raise_user_key(exc)
        await accounting.settle(
            call_id=call_id,
            kind=accounting.KIND_LLM,
            purpose="llm",
            thinking=thinking,
            spec=spec,
            usage=usage,
        )


_CAPTION_ATTEMPTS = 3


async def caption_image(data_url: str, prompt: str) -> str:
    """Describe one figure so it becomes searchable text. Best effort.

    Retried with backoff, unlike the other model calls: a figure-heavy document
    issues hundreds of these at once, so a provider rate limit is an expected
    condition rather than an outage, and one dropped caption is one figure
    permanently missing from the index.
    """
    spec = registry.vision_spec()
    messages = [
        {
            "role": "user",
            "content": [
                {"type": "text", "text": prompt},
                {"type": "image_url", "image_url": {"url": data_url}},
            ],
        }
    ]
    for attempt in range(_CAPTION_ATTEMPTS):
        try:
            resp = await elitellm.complete(spec, messages)
            obs.record_completion(spec.provider_slug, _record_name(spec), resp)
            message = elitellm.message_from_response(resp)
            return (getattr(message, "content", "") or "").strip()
        except asyncio.CancelledError:
            raise
        except Exception:
            if attempt == _CAPTION_ATTEMPTS - 1:
                log.warning("image caption failed", exc_info=True)
                return ""
            await asyncio.sleep(2**attempt)
    return ""
