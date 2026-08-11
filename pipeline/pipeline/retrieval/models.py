"""Model clients. Every provider is OpenAI-compatible, so one client shape does.

Routing:
- embedding   -> OpenRouter ``qwen/qwen3-embedding-4b`` (dim pinned to the
                 halfvec column width)
- ingest LLM  -> DeepSeek flash (summaries, concepts, map-reduce steps)
- query LLM   -> DeepSeek, pro by default, flash selectable per request
- vision      -> Gemini (DeepSeek is text-only), for figure captions
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from openai import AsyncOpenAI

from ..config import ProviderCfg, cfg

log = logging.getLogger("evo.models")

_clients: dict[str, AsyncOpenAI] = {}


def client(provider: ProviderCfg) -> AsyncOpenAI:
    key = f"{provider.base_url}|{provider.api_key[:8]}"
    existing = _clients.get(key)
    if existing is None:
        existing = AsyncOpenAI(
            api_key=provider.api_key or "missing", base_url=provider.base_url or None
        )
        _clients[key] = existing
    return existing


def resolve_query_model(requested: str | None) -> str:
    return requested if requested in cfg.query_models else cfg.query_model


async def embed(texts: list[str]) -> list[list[float]]:
    """Embed texts in provider-sized batches, preserving input order.

    The dimension is part of the column type, so a provider that ignores the
    ``dimensions`` request must fail loudly here rather than write a vector
    Postgres will reject halfway through a file.
    """
    if not texts:
        return []
    out: list[list[float]] = []
    api = client(cfg.embedding)
    for start in range(0, len(texts), cfg.embedding_batch):
        batch = texts[start : start + cfg.embedding_batch]
        resp = await api.embeddings.create(
            model=cfg.embedding_model, input=batch, dimensions=cfg.embedding_dim
        )
        # Providers are permitted to return results out of order; index is
        # authoritative.
        ordered = sorted(resp.data, key=lambda d: d.index)
        for item in ordered:
            vector = list(item.embedding)
            if len(vector) != cfg.embedding_dim:
                raise RuntimeError(
                    f"embedding model {cfg.embedding_model} returned dim "
                    f"{len(vector)} != EMBEDDING_DIM {cfg.embedding_dim}; the "
                    "halfvec column width is fixed, so fix the env and re-ingest"
                )
            out.append(vector)
    return out


async def complete(
    messages: list[dict[str, Any]],
    *,
    model: str,
    temperature: float = 0.3,
    tools: list[dict[str, Any]] | None = None,
    response_format: dict[str, Any] | None = None,
) -> Any:
    """One chat completion, returning the raw message (may carry tool calls)."""
    api = client(cfg.llm)
    kwargs: dict[str, Any] = {
        "model": model,
        "messages": messages,
        "temperature": temperature,
    }
    if tools:
        kwargs["tools"] = tools
        kwargs["tool_choice"] = "auto"
    if response_format:
        kwargs["response_format"] = response_format
    resp = await api.chat.completions.create(**kwargs)
    return resp.choices[0].message if resp.choices else None


async def complete_text(
    messages: list[dict[str, Any]], *, model: str, temperature: float = 0.3
) -> str:
    message = await complete(messages, model=model, temperature=temperature)
    return (getattr(message, "content", "") or "").strip()


async def stream_text(
    messages: list[dict[str, Any]], *, model: str, temperature: float = 0.3
):
    api = client(cfg.llm)
    stream = await api.chat.completions.create(
        model=model, messages=messages, temperature=temperature, stream=True
    )
    async for chunk in stream:
        delta = (chunk.choices[0].delta.content or "") if chunk.choices else ""
        if delta:
            yield delta


async def caption_image(data_url: str, context: str) -> str:
    """Describe one figure so it becomes searchable text. Best effort."""
    api = client(cfg.vision)
    try:
        resp = await api.chat.completions.create(
            model=cfg.vision_model,
            temperature=0.2,
            messages=[
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "text",
                            "text": (
                                "Describe this figure from a study document in two or "
                                "three sentences, naming the concepts it shows so the "
                                "description can be found by search. Context: "
                                + context
                            ),
                        },
                        {"type": "image_url", "image_url": {"url": data_url}},
                    ],
                }
            ],
        )
        return (resp.choices[0].message.content or "").strip() if resp.choices else ""
    except asyncio.CancelledError:
        raise
    except Exception:
        log.warning("image caption failed", exc_info=True)
        return ""
