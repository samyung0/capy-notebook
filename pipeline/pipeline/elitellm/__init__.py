"""Hand-rolled provider transport. Callers pass a resolved snapshot."""

from .client import (
    CONTINUITY_KEYS,
    ProviderError,
    assistant_message_from_obj,
    complete,
    context_components,
    embed_batch,
    message_from_response,
    observed_continuity,
    resolve_thinking,
    stream,
    transport_model_slug,
    transport_provider_slug,
    uses_responses,
)

__all__ = [
    "CONTINUITY_KEYS",
    "ProviderError",
    "assistant_message_from_obj",
    "complete",
    "context_components",
    "embed_batch",
    "message_from_response",
    "observed_continuity",
    "resolve_thinking",
    "stream",
    "transport_model_slug",
    "transport_provider_slug",
    "uses_responses",
]
