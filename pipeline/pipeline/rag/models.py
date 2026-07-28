"""Adapter functions mapping our role-based model spec onto LightRAG's slots:
``llm_model_func``, the ``vlm`` role config, and ``embedding_func``.

Routing (per the project's existing spec):
- embedding      -> OpenRouter ``qwen/qwen3-embedding-4b`` (dim 2560, pinned)
- ingest LLM     -> DeepSeek ``deepseek-v4-flash`` (cheap graph extraction)
- query LLM      -> DeepSeek, defaults to ``deepseek-v4-pro``; ``deepseek-v4-flash``
                    stays reachable via a per-request contextvar dispatcher
- vlm/caption    -> Gemini ``gemini-3.1-flash-lite-preview`` (DeepSeek is text-only);
                    wired as LightRAG's ``vlm`` role for i/t/e multimodal analysis

All providers are reached over the OpenAI-compatible API, so a single
``AsyncOpenAI`` client style works for every role.
"""

from __future__ import annotations

import contextvars
from collections.abc import Callable
from typing import Any

import numpy as np
from lightrag.llm.openai import openai_complete_if_cache
from lightrag.utils import EmbeddingFunc
from openai import AsyncOpenAI

from ..config import ProviderCfg, cfg

# Per-request override for the query model (set by the retrieval service). The
# ingest worker never touches it, so ingest always uses its fixed model.
query_model_override: contextvars.ContextVar[str | None] = contextvars.ContextVar(
    "query_model_override", default=None
)

_clients: dict[str, AsyncOpenAI] = {}


def _client(p: ProviderCfg) -> AsyncOpenAI:
    key = f"{p.base_url}|{p.api_key[:8]}"
    client = _clients.get(key)
    if client is None:
        client = AsyncOpenAI(
            api_key=p.api_key or "missing", base_url=p.base_url or None
        )
        _clients[key] = client
    return client


# --------------------------------------------------------------- embeddings


def make_embedding_func() -> EmbeddingFunc:
    """OpenRouter Qwen3-Embedding-4B with the dimension pinned (matryoshka).

    The dimension is part of the vector-store schema, so it must never drift:
    we always request ``dimensions`` and hard-fail if the provider returns a
    different size.
    """
    model = cfg.embedding_model
    dim = cfg.embedding_dim
    provider = cfg.embedding

    async def _embed(texts: list[str]) -> np.ndarray:
        if not texts:
            return np.zeros((0, dim), dtype=np.float32)
        client = _client(provider)
        resp = await client.embeddings.create(
            model=model, input=list(texts), dimensions=dim
        )
        vectors = [d.embedding for d in resp.data]
        out = np.array(vectors, dtype=np.float32)
        if out.shape[1] != dim:
            raise RuntimeError(
                f"embedding model {model} returned dim {out.shape[1]} != EMBEDDING_DIM {dim}; "
                "fix EMBEDDING_DIM (and re-ingest) — the vector store schema is fixed at first use."
            )
        return out

    return EmbeddingFunc(
        embedding_dim=dim, max_token_size=cfg.embedding_max_tokens, func=_embed
    )


# ------------------------------------------------------------------- text LLM


def make_llm_func(model: str) -> Callable:
    """A fixed-model DeepSeek text completion func (used for ingest)."""
    provider = cfg.llm

    async def llm_model_func(
        prompt: str,
        system_prompt: str | None = None,
        history_messages: list | None = None,
        **kwargs: Any,
    ) -> str:
        return await openai_complete_if_cache(
            model,
            prompt,
            system_prompt=system_prompt,
            history_messages=history_messages or [],
            base_url=provider.base_url,
            api_key=provider.api_key,
            **kwargs,
        )

    return llm_model_func


def make_query_llm_func() -> Callable:
    """Query-side DeepSeek func that honours a per-request model override.

    Defaults to ``EVO_QUERY_MODEL`` (pro); a request may switch to
    ``EVO_QUERY_MODEL_ALT`` (flash) via ``query_model_override``.
    """
    provider = cfg.llm
    allowed = cfg.query_models
    default = cfg.query_model

    async def llm_model_func(
        prompt: str,
        system_prompt: str | None = None,
        history_messages: list | None = None,
        **kwargs: Any,
    ) -> str:
        chosen = query_model_override.get() or default
        if chosen not in allowed:
            chosen = default
        return await openai_complete_if_cache(
            chosen,
            prompt,
            system_prompt=system_prompt,
            history_messages=history_messages or [],
            base_url=provider.base_url,
            api_key=provider.api_key,
            **kwargs,
        )

    return llm_model_func


# ----------------------------------------------------------------- vlm role


def make_vlm_func() -> Callable:
    """Gemini func for LightRAG's ``vlm`` role (i/t/e multimodal analysis).

    The merged pipeline calls the vlm role as
    ``func(prompt, stream=False, image_inputs=[{base64, mime_type, ...}],
    response_format={"type": "json_object"})``; ``openai_complete_if_cache``
    natively renders ``image_inputs`` into an OpenAI-style multimodal message,
    so this is a plain pass-through with Gemini credentials.
    """
    provider = cfg.vision
    model = cfg.vision_model

    async def vlm_model_func(
        prompt: str,
        system_prompt: str | None = None,
        history_messages: list | None = None,
        **kwargs: Any,
    ) -> str:
        return await openai_complete_if_cache(
            model,
            prompt,
            system_prompt=system_prompt,
            history_messages=history_messages or [],
            base_url=provider.base_url,
            api_key=provider.api_key,
            **kwargs,
        )

    return vlm_model_func
