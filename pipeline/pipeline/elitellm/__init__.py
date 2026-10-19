"""Hand-rolled provider transport. Callers pass a resolved snapshot."""

from .client import (
    BUSY_STATUSES,
    CONTINUITY_KEYS,
    ProviderBusy,
    ProviderError,
    assistant_message_from_obj,
    chat_response,
    complete,
    context_components,
    embed_batch,
    message_from_response,
    observed_continuity,
    output_budget,
    rerank,
    resolve_thinking,
    stream,
    uses_responses,
)

__all__ = [
    "BUSY_STATUSES",
    "CONTINUITY_KEYS",
    "ProviderBusy",
    "ProviderError",
    "assistant_message_from_obj",
    "chat_response",
    "complete",
    "context_components",
    "embed_batch",
    "message_from_response",
    "observed_continuity",
    "output_budget",
    "rerank",
    "resolve_thinking",
    "stream",
    "uses_responses",
]
