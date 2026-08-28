"""Normalize provider usage into inclusive cache-read counters.

Discount only proven inclusive shapes: DeepSeek prompt_cache_hit_tokens and
OpenAI cached_tokens nested under input/prompt token details. Missing or
invalid detail is recorded and charged as ordinary input. It does not fail
the request.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass
class NormalizedUsage:
    input_tokens: int = 0
    output_tokens: int = 0
    cached_read_tokens: int = 0
    cache_write_tokens: int = 0
    reasoning_tokens: int = 0
    anomaly: str = ""

    def as_dict(self) -> dict[str, Any]:
        return {
            "inputTokens": self.input_tokens,
            "outputTokens": self.output_tokens,
            "cachedReadTokens": self.cached_read_tokens,
            "cacheWriteTokens": self.cache_write_tokens,
            "reasoningTokens": self.reasoning_tokens,
            "cacheAnomaly": self.anomaly,
        }


def _int(value: Any) -> int:
    try:
        return max(0, int(value or 0))
    except (TypeError, ValueError):
        return 0


def _attr(obj: Any, *names: str) -> Any:
    if obj is None:
        return None
    if isinstance(obj, dict):
        for name in names:
            if name in obj:
                return obj[name]
        return None
    for name in names:
        if hasattr(obj, name):
            return getattr(obj, name)
    return None


def extract_usage(block: Any, *, provider: str = "") -> NormalizedUsage:
    """Parse one terminal provider usage object.

    ``provider`` selects which cache fields are trusted as inclusive of the
    reported input total. Anything else keeps cached_read at 0.
    """
    out = NormalizedUsage()
    if block is None:
        return out
    out.input_tokens = _int(
        _attr(block, "prompt_tokens", "input_tokens", "promptTokens", "inputTokens")
    )
    out.output_tokens = _int(
        _attr(
            block,
            "completion_tokens",
            "output_tokens",
            "completionTokens",
            "outputTokens",
        )
    )
    details = _attr(
        block,
        "input_tokens_details",
        "prompt_tokens_details",
        "inputTokensDetails",
        "promptTokensDetails",
    )
    cached = _int(_attr(details, "cached_tokens", "cachedTokens"))
    if cached == 0:
        cached = _int(_attr(block, "prompt_cache_hit_tokens", "promptCacheHitTokens"))
    anthropic_cached = _int(
        _attr(block, "cache_read_input_tokens", "cacheReadInputTokens")
    )
    if cached == 0:
        cached = anthropic_cached
    writes = _int(_attr(details, "cache_write_tokens", "cacheWriteTokens")) or _int(
        _attr(block, "cache_creation_input_tokens", "cacheCreationInputTokens")
    )
    reasoning = _int(
        _attr(
            _attr(block, "completion_tokens_details", "output_tokens_details"),
            "reasoning_tokens",
            "reasoningTokens",
        )
    )
    out.cache_write_tokens = writes
    out.reasoning_tokens = reasoning

    slug = (provider or "").lower()
    if slug == "anthropic":
        # Anthropic reports ordinary input, cache reads, and cache writes as
        # disjoint counters. Pricing expects input to include every category.
        out.input_tokens += anthropic_cached + writes
        out.cached_read_tokens = anthropic_cached
        if cached and not anthropic_cached:
            out.anomaly = "unproven_cache_shape"
        return out
    proven = slug in ("deepseek", "openai")
    if not proven:
        if cached:
            out.anomaly = "unproven_cache_shape"
        return out
    if cached == 0:
        return out
    if cached > out.input_tokens:
        out.anomaly = "cached_gt_input"
        return out
    if slug == "deepseek":
        miss = _int(_attr(block, "prompt_cache_miss_tokens", "promptCacheMissTokens"))
        if miss and cached + miss != out.input_tokens:
            out.anomaly = "deepseek_cache_not_inclusive"
            return out
    out.cached_read_tokens = cached
    return out


def merge_usage(total: NormalizedUsage, piece: NormalizedUsage) -> NormalizedUsage:
    total.input_tokens += piece.input_tokens
    total.output_tokens += piece.output_tokens
    total.cached_read_tokens += piece.cached_read_tokens
    total.cache_write_tokens += piece.cache_write_tokens
    total.reasoning_tokens += piece.reasoning_tokens
    if piece.anomaly and not total.anomaly:
        total.anomaly = piece.anomaly
    return total
