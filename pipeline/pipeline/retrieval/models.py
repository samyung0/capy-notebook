"""Model clients. Every provider is OpenAI-compatible, so one client shape does.

Routing is owned by the model registry: a pinned (model_key, version) resolves
to a provider_slug, base_url, and provider_model_id. Nothing here resolves a
surface default — every entry point takes the pin its caller was priced for.

Every provider call in the system passes through this module. That makes it
the only place token usage has to be captured, and the only place a missing
capture can hide — if a new call site is added elsewhere, its spend is
invisible and the user is silently not charged for it.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
from typing import Any

from openai import AsyncOpenAI, AuthenticationError, PermissionDeniedError

from .. import obs, registry
from ..config import ProviderCfg, cfg
from ..registry import ModelConfig
from . import accounting
from .stream import (
    AssembledResponse,
    ChatCompletionsAssembler,
    OpenAIResponsesAssembler,
)
from .usage_extract import extract_usage

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
    if isinstance(exc, (AuthenticationError, PermissionDeniedError)) or status in (
        401,
        403,
    ):
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


def _raise_user_key(exc: BaseException) -> None:
    mapped = classify_user_key_error(exc)
    if mapped is not None:
        raise mapped from exc
    raise exc


_clients: dict[str, AsyncOpenAI] = {}

_QUIZ_GRADE_TOKENS = 80
_ANTHROPIC_BUDGETS = {
    "low": 2048,
    "medium": 8192,
    "high": 16384,
    "xhigh": 32768,
    "max": 65536,
}


def _client_cache_key(
    provider: ProviderCfg, extra_headers: dict[str, str] | None
) -> str:
    header_key = ",".join(f"{k}={v}" for k, v in sorted((extra_headers or {}).items()))
    digest = hashlib.sha256((provider.api_key or "").encode()).hexdigest()
    return f"{provider.base_url}|{digest}|{header_key}"


def client(
    provider: ProviderCfg, extra_headers: dict[str, str] | None = None
) -> AsyncOpenAI:
    key = _client_cache_key(provider, extra_headers)
    existing = _clients.get(key)
    if existing is None:
        existing = AsyncOpenAI(
            api_key=provider.api_key or "missing",
            base_url=provider.base_url or None,
            timeout=cfg.provider_timeout_s,
            max_retries=0,
            default_headers=extra_headers or None,
        )
        _clients[key] = existing
    return existing


def client_for(spec: ModelConfig) -> AsyncOpenAI:
    try:
        provider = registry.provider_cfg_for(spec)
    except registry.RegistryError as exc:
        if registry.current_request_llm().paid_by == "user":
            raise UserKeyError(KEY_FAILED, KEY_FAILED_MSG) from exc
        raise
    return client(
        provider,
        extra_headers=registry.extra_headers_for(spec) or None,
    )


def _effort_for(spec: ModelConfig, effort: str) -> str:
    allowed = spec.reasoning_efforts()
    if effort and effort in allowed:
        return effort
    fallback = spec.reasoning_default_effort()
    if fallback and fallback in allowed:
        return fallback
    return ""


def _resolve_reasoning_mode(spec: ModelConfig) -> str:
    req = registry.current_request_llm()
    mode = req.reasoning_mode or spec.reasoning_default_mode()
    if mode not in ("on", "off"):
        mode = spec.reasoning_default_mode()
    if not spec.reasoning_can_disable():
        return "on"
    return mode


def quiz_grade_max_tokens(_model: str | ModelConfig | None = None) -> int:
    """Short grade JSON. The grade call always disables thinking."""
    return _QUIZ_GRADE_TOKENS


def _apply_reasoning(
    spec: ModelConfig,
    kwargs: dict[str, Any],
    *,
    reasoning: bool | None = None,
) -> None:
    if reasoning is False:
        mode = "off"
        effort = ""
    else:
        mode = _resolve_reasoning_mode(spec)
        effort = _effort_for(spec, registry.current_request_llm().reasoning_effort)
    extra = dict(kwargs.get("extra_body") or {})
    slug = spec.provider_slug
    if slug == "openai":
        # GPT-5.3+ Chat Completions reject function tools unless effort is none.
        # complete() still uses this path. The chat agent uses /v1/responses.
        if kwargs.get("tools"):
            effort = "none"
        elif mode != "off":
            if not effort:
                raise registry.RegistryError(
                    f"{spec.model_key} v{spec.version} reasoning is on but "
                    "the catalog lists no usable effort"
                )
        else:
            effort = "none"
        kwargs["reasoning_effort"] = effort
        kwargs.pop("temperature", None)
        return
    if slug == "deepseek":
        extra["thinking"] = {"type": "disabled" if mode == "off" else "enabled"}
        if mode == "on":
            if not effort:
                raise registry.RegistryError(
                    f"{spec.model_key} v{spec.version} reasoning is on but "
                    "the catalog lists no usable effort"
                )
            kwargs["reasoning_effort"] = effort
        kwargs["extra_body"] = extra
        return
    if slug == "anthropic":
        kwargs.pop("temperature", None)
        if mode == "off":
            extra["thinking"] = {"type": "disabled"}
        elif not effort:
            raise registry.RegistryError(
                f"{spec.model_key} v{spec.version} reasoning is on but "
                "the catalog lists no usable effort"
            )
        elif spec.reasoning_style() == "budget":
            budget = _ANTHROPIC_BUDGETS.get(effort)
            if budget is None:
                raise registry.RegistryError(
                    f"{spec.model_key} v{spec.version} has no thinking "
                    f"budget for effort {effort!r}"
                )
            extra["thinking"] = {"type": "enabled", "budget_tokens": budget}
        else:
            extra["thinking"] = {"type": "adaptive"}
            extra["output_config"] = {"effort": effort}
        kwargs["extra_body"] = extra


def _as_spec(model: str | ModelConfig) -> ModelConfig:
    if isinstance(model, ModelConfig):
        return model
    return registry.bootstrap_llm(model)


def resolve_query_model(
    key: str | None = None,
    version: int | None = None,
    *,
    requested: str | None = None,
    surface: str = registry.SURFACE_CHAT,
) -> ModelConfig:
    """Resolve the exact pinned chat/generate/editor/quiz model.

    ``requested`` is accepted for API compatibility and ignored: a client-
    supplied model string must never override the pin. An empty pin is an
    error for these surfaces, not a cue to use the live default.
    """
    del requested
    return registry.resolve_pinned(key, version, surface)


# Qwen3-Embedding is instruction-aware. The card's query form is
# ``Instruct: {task}\nQuery:{query}``; documents stay raw. OpenRouter does not
# add this. Skipping it is valid but the card reports about 1 to 5% worse retrieval.
_QWEN3_EMBED_MARKER = "qwen3-embedding"
_QWEN3_QUERY_TASK = (
    "Given a question about the user's notes and uploaded materials, "
    "retrieve relevant passages that answer the question"
)


def is_qwen3_embedding(spec: ModelConfig) -> bool:
    return _QWEN3_EMBED_MARKER in spec.provider_model_id.lower()


def format_query(query: str, spec: ModelConfig) -> str:
    """Shape a search query for the workspace's embedding pin.

    ``spec`` must be that pin — the same row ingest used — so a Qwen3
    workspace gets the instruct form and any other pinned model is left
    alone. Lexical search keeps the raw query.
    """
    if not is_qwen3_embedding(spec):
        return query
    return f"Instruct: {_QWEN3_QUERY_TASK}\nQuery:{query}"


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
    api = client_for(spec)
    dim = spec.embedding_dim
    for start in range(0, len(texts), cfg.embedding_batch):
        batch = texts[start : start + cfg.embedding_batch]
        call_id = accounting.new_call_id()
        resp = await api.embeddings.create(
            model=spec.provider_model_id, input=batch, dimensions=dim
        )
        obs.record_embedding(spec.provider_slug, spec.provider_model_id, resp)
        block = getattr(resp, "usage", None)
        await accounting.settle(
            call_id=call_id,
            kind=accounting.KIND_EMBEDDING,
            purpose=accounting.KIND_EMBEDDING,
            spec=spec,
            usage=extract_usage(block, provider=spec.provider_slug),
        )
        ordered = sorted(resp.data, key=lambda d: d.index)
        for item in ordered:
            vector = list(item.embedding)
            if len(vector) != dim:
                raise RuntimeError(
                    f"embedding model {spec.provider_model_id} returned dim "
                    f"{len(vector)} != {dim}; the halfvec column width is fixed, "
                    "so fix the registry and re-ingest"
                )
            out.append(vector)
    return out


async def complete(
    messages: list[dict[str, Any]],
    *,
    model: str | ModelConfig,
    temperature: float | None = None,
    tools: list[dict[str, Any]] | None = None,
    response_format: dict[str, Any] | None = None,
    max_tokens: int | None = None,
    reasoning: bool | None = None,
    call_purpose: str = "llm",
) -> Any:
    """One chat completion, returning the raw message (may carry tool calls)."""
    spec = _as_spec(model)
    api = client_for(spec)
    kwargs: dict[str, Any] = {
        "model": spec.provider_model_id,
        "messages": messages,
        "temperature": spec.temperature() if temperature is None else temperature,
    }
    if tools:
        kwargs["tools"] = tools
        kwargs["tool_choice"] = "auto"
    if response_format:
        kwargs["response_format"] = response_format
    if max_tokens is not None:
        kwargs["max_tokens"] = max_tokens
    _apply_reasoning(spec, kwargs, reasoning=reasoning)
    call_id = accounting.new_call_id()
    try:
        resp = await api.chat.completions.create(**kwargs)
    except Exception as exc:  # noqa: BLE001 - provider errors become UserKeyError
        _raise_user_key(exc)
    obs.record_completion(spec.provider_slug, spec.provider_model_id, resp)
    await accounting.settle(
        call_id=call_id,
        kind=accounting.KIND_LLM,
        purpose=call_purpose,
        spec=spec,
        usage=extract_usage(getattr(resp, "usage", None), provider=spec.provider_slug),
    )
    return resp.choices[0].message if resp.choices else None


async def complete_response(
    messages: list[dict[str, Any]],
    *,
    model: str | ModelConfig,
    temperature: float | None = None,
    max_tokens: int | None = None,
    reasoning: bool | None = None,
    call_purpose: str = "llm",
) -> Any:
    """Like complete, but returns the full response so callers can read usage."""
    spec = _as_spec(model)
    api = client_for(spec)
    kwargs: dict[str, Any] = {
        "model": spec.provider_model_id,
        "messages": messages,
        "temperature": spec.temperature() if temperature is None else temperature,
    }
    if max_tokens is not None:
        kwargs["max_tokens"] = max_tokens
    _apply_reasoning(spec, kwargs, reasoning=reasoning)
    call_id = accounting.new_call_id()
    try:
        resp = await api.chat.completions.create(**kwargs)
    except Exception as exc:  # noqa: BLE001 - provider errors become UserKeyError
        _raise_user_key(exc)
    obs.record_completion(spec.provider_slug, spec.provider_model_id, resp)
    await accounting.settle(
        call_id=call_id,
        kind=accounting.KIND_LLM,
        purpose=call_purpose,
        spec=spec,
        usage=extract_usage(getattr(resp, "usage", None), provider=spec.provider_slug),
    )
    return resp


async def complete_text(
    messages: list[dict[str, Any]],
    *,
    model: str | ModelConfig,
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


def _flat_tools(schemas: list[dict[str, Any]] | None) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for schema in schemas or []:
        fn = schema.get("function") or schema
        out.append(
            {
                "type": "function",
                "name": fn.get("name"),
                "description": fn.get("description") or "",
                "parameters": fn.get("parameters")
                or {"type": "object", "properties": {}},
            }
        )
    return out


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


def _openai_responses_reasoning(
    spec: ModelConfig, reasoning: bool | None
) -> dict[str, Any]:
    if reasoning is False:
        return {"effort": "none"}
    mode = _resolve_reasoning_mode(spec)
    effort = _effort_for(spec, registry.current_request_llm().reasoning_effort)
    if mode == "off":
        return {"effort": "none"}
    if not effort:
        raise registry.RegistryError(
            f"{spec.model_key} v{spec.version} reasoning is on but "
            "the catalog lists no usable effort"
        )
    return {"effort": effort}


async def stream_agent_response(
    messages: list[dict[str, Any]],
    *,
    model: str | ModelConfig,
    tools: list[dict[str, Any]] | None = None,
    temperature: float | None = None,
    on_event: Any | None = None,
    call_purpose: str = accounting.PURPOSE_AGENT,
) -> AssembledResponse:
    """Stream one tool-capable model response into a normalized assembly."""
    spec = _as_spec(model)
    api = client_for(spec)
    call_id = accounting.new_call_id()
    if spec.provider_slug == "openai":
        assembled = await _stream_openai_responses(api, spec, messages, tools, on_event)
    else:
        assembled = await _stream_chat_tools(
            api, spec, messages, tools, temperature, on_event
        )
    obs.record_normalized(
        spec.provider_slug,
        spec.provider_model_id,
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
        spec=spec,
        usage=assembled.usage,
    )
    return assembled


async def _stream_openai_responses(
    api: Any,
    spec: ModelConfig,
    messages: list[dict[str, Any]],
    tools: list[dict[str, Any]] | None,
    on_event: Any | None,
) -> AssembledResponse:
    kwargs: dict[str, Any] = {
        "model": spec.provider_model_id,
        "input": messages_to_responses_input(provider_messages(messages)),
        "store": False,
        "stream": True,
        "include": ["reasoning.encrypted_content"],
        "reasoning": _openai_responses_reasoning(spec, None),
    }
    if tools:
        kwargs["tools"] = _flat_tools(tools)
        kwargs["tool_choice"] = "auto"
    assembler = OpenAIResponsesAssembler()
    try:
        stream = await api.responses.create(**kwargs)
        async for event in stream:
            for item in assembler.push(event):
                if on_event is not None:
                    on_event(item)
    except Exception as exc:  # noqa: BLE001
        _raise_user_key(exc)
    return assembler.finish()


async def _stream_chat_tools(
    api: Any,
    spec: ModelConfig,
    messages: list[dict[str, Any]],
    tools: list[dict[str, Any]] | None,
    temperature: float | None,
    on_event: Any | None,
) -> AssembledResponse:
    kwargs: dict[str, Any] = {
        "model": spec.provider_model_id,
        "messages": provider_messages(messages),
        "temperature": spec.temperature() if temperature is None else temperature,
        "stream": True,
        "stream_options": {"include_usage": True},
    }
    if tools:
        kwargs["tools"] = tools
        kwargs["tool_choice"] = "auto"
    _apply_reasoning(spec, kwargs)
    assembler = ChatCompletionsAssembler(spec.provider_slug)
    try:
        stream = await api.chat.completions.create(**kwargs)
        async for chunk in stream:
            for item in assembler.push(chunk):
                if on_event is not None:
                    on_event(item)
    except Exception as exc:  # noqa: BLE001
        _raise_user_key(exc)
    return assembler.finish()


async def stream_text(
    messages: list[dict[str, Any]],
    *,
    model: str | ModelConfig,
    temperature: float | None = None,
    max_tokens: int | None = None,
    reasoning: bool | None = None,
):
    spec = _as_spec(model)
    api = client_for(spec)
    kwargs: dict[str, Any] = {
        "model": spec.provider_model_id,
        "messages": messages,
        "temperature": spec.temperature() if temperature is None else temperature,
        "stream": True,
        "stream_options": {"include_usage": True},
    }
    if max_tokens is not None:
        kwargs["max_tokens"] = max_tokens
    _apply_reasoning(spec, kwargs, reasoning=reasoning)
    try:
        stream = await api.chat.completions.create(**kwargs)
        async for chunk in stream:
            obs.record_stream_chunk(spec.provider_slug, spec.provider_model_id, chunk)
            delta = (chunk.choices[0].delta.content or "") if chunk.choices else ""
            if delta:
                yield delta
    except Exception as exc:  # noqa: BLE001 - provider errors become UserKeyError
        _raise_user_key(exc)


_CAPTION_ATTEMPTS = 3


async def caption_image(data_url: str, prompt: str) -> str:
    """Describe one figure so it becomes searchable text. Best effort.

    Retried with backoff, unlike the other model calls: a figure-heavy document
    issues hundreds of these at once, so a provider rate limit is an expected
    condition rather than an outage, and one dropped caption is one figure
    permanently missing from the index.
    """
    spec = registry.vision_spec()
    api = client_for(spec)
    for attempt in range(_CAPTION_ATTEMPTS):
        try:
            resp = await api.chat.completions.create(
                model=spec.provider_model_id,
                temperature=spec.temperature(0.2),
                messages=[
                    {
                        "role": "user",
                        "content": [
                            {"type": "text", "text": prompt},
                            {"type": "image_url", "image_url": {"url": data_url}},
                        ],
                    }
                ],
            )
            obs.record_completion(spec.provider_slug, spec.provider_model_id, resp)
            return (
                (resp.choices[0].message.content or "").strip() if resp.choices else ""
            )
        except asyncio.CancelledError:
            raise
        except Exception:
            if attempt == _CAPTION_ATTEMPTS - 1:
                log.warning("image caption failed", exc_info=True)
                return ""
            await asyncio.sleep(2**attempt)
    return ""
