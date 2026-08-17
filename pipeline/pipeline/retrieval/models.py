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
import logging
from typing import Any

from openai import AsyncOpenAI

from .. import obs, registry
from ..config import ProviderCfg, cfg
from ..registry import ModelConfig

log = logging.getLogger("evo.models")

_clients: dict[str, AsyncOpenAI] = {}


def client(provider: ProviderCfg) -> AsyncOpenAI:
    key = f"{provider.base_url}|{provider.api_key[:8]}"
    existing = _clients.get(key)
    if existing is None:
        existing = AsyncOpenAI(
            api_key=provider.api_key or "missing",
            base_url=provider.base_url or None,
            timeout=cfg.provider_timeout_s,
        )
        _clients[key] = existing
    return existing


def client_for(spec: ModelConfig) -> AsyncOpenAI:
    return client(registry.provider_cfg_for(spec))


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
    """Resolve the exact pinned chat/generate/editor model.

    ``requested`` is accepted for API compatibility and ignored: a client-
    supplied model string must never override the pin. An empty pin is an
    error for these surfaces, not a cue to use the live default.
    """
    del requested
    return registry.resolve_pinned(key, version, surface)


async def embed(texts: list[str], *, spec: ModelConfig) -> list[list[float]]:
    """Embed texts in provider-sized batches, preserving input order.

    ``spec`` is explicit because the two callers get it from different places
    and neither may guess: indexing uses the workspace pin installed on the job,
    and query embedding reads the same pin off the workspace row. Comparing a
    query against chunks embedded by a different model returns ranked nonsense
    with no error, so there is no default to fall back to.

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
        resp = await api.embeddings.create(
            model=spec.provider_model_id, input=batch, dimensions=dim
        )
        obs.record_embedding(spec.provider_slug, spec.provider_model_id, resp)
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
    resp = await api.chat.completions.create(**kwargs)
    obs.record_completion(spec.provider_slug, spec.provider_model_id, resp)
    return resp.choices[0].message if resp.choices else None


async def complete_response(
    messages: list[dict[str, Any]],
    *,
    model: str | ModelConfig,
    temperature: float | None = None,
    max_tokens: int | None = None,
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
    resp = await api.chat.completions.create(**kwargs)
    obs.record_completion(spec.provider_slug, spec.provider_model_id, resp)
    return resp


async def complete_text(
    messages: list[dict[str, Any]],
    *,
    model: str | ModelConfig,
    temperature: float | None = None,
) -> str:
    message = await complete(messages, model=model, temperature=temperature)
    return (getattr(message, "content", "") or "").strip()


async def stream_text(
    messages: list[dict[str, Any]],
    *,
    model: str | ModelConfig,
    temperature: float | None = None,
    max_tokens: int | None = None,
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
    stream = await api.chat.completions.create(**kwargs)
    async for chunk in stream:
        obs.record_stream_chunk(spec.provider_slug, spec.provider_model_id, chunk)
        delta = (chunk.choices[0].delta.content or "") if chunk.choices else ""
        if delta:
            yield delta


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
