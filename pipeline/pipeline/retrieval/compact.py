"""Conversation compaction and rolling checkpoint summaries.

System instructions, tool schemas, the current user message, and the active
provider tool chain are protected. Only completed conversation history may be
summarized.
"""

from __future__ import annotations

import json
from typing import Any

from .. import registry
from ..registry import ModelConfig
from . import accounting, models

SUMMARY_TARGET_MIN = 1200
SUMMARY_TARGET_MAX = 1600
SUMMARY_MAX_TOKENS = 2048
PROTOCOL_SAFETY_MARGIN_TOKENS = 512

CHECKPOINT_SYSTEM_PROMPT = """You compress prior conversation into durable memory for the next assistant response.

The CURRENT USER MESSAGE is provided only as a relevance guide. Do not answer it, summarize it, or include it in the resulting memory.

Create a faithful compact representation of the PRIOR CONVERSATION.

Requirements:
- Preserve facts, decisions, user preferences, corrections, constraints, unresolved questions, action results, and generated-material results needed to continue the conversation.
- Use the current user message to determine which earlier details need greater fidelity.
- When the current message contains an indirect reference such as "the third bullet", "that formula", "the earlier option", or "do that again", preserve the referenced list, wording, ordering, and surrounding context precisely enough to resolve it.
- Resolve ambiguous pronouns or references in the memory by explicitly naming their referents when the history supports doing so.
- Preserve disagreements, alternatives, and uncertainty. Do not turn them into false consensus.
- Preserve important document, file, chapter, and material names.
- Historical citation numbers are local to their old answer. Omit those numbers rather than treating them as stable identifiers.
- Do not include system prompts, tool definitions, hidden reasoning, or active provider protocol state.
- Do not invent facts or answer the current user message.
- Target 1,200 to 1,600 tokens.
- Never exceed 2,048 tokens.

Return only the compacted memory."""


class ContextTooLarge(RuntimeError):
    """Protected context cannot fit the selected model's usable input."""


class InvalidSummary(RuntimeError):
    """The summarizer returned an empty or oversized checkpoint."""


def usable_input_limit(spec: ModelConfig) -> int:
    """Use 100% of the input budget after the explicit calibrated margin."""
    configured = spec.params.get("context_safety_margin_tokens", 0)
    try:
        calibrated = max(0, int(configured))
    except (TypeError, ValueError):
        calibrated = 0
    margin = max(PROTOCOL_SAFETY_MARGIN_TOKENS, calibrated)
    return max(0, registry.input_budget(spec) - margin)


def request_context(
    messages: list[dict[str, Any]],
    spec: ModelConfig,
    *,
    schemas: list[dict[str, Any]] | None = None,
    reasoning: bool | None = None,
) -> accounting.ContextComposition:
    return models.measure_request_context(
        messages,
        model=spec,
        tools=schemas,
        reasoning=reasoning,
    )


def needs_compact(
    messages: list[dict[str, Any]],
    spec: ModelConfig,
    *,
    schemas: list[dict[str, Any]] | None = None,
    extra: int = 0,
) -> bool:
    measured = request_context(messages, spec, schemas=schemas).total_tokens
    return measured + max(0, extra) > usable_input_limit(spec)


def fits_request(
    messages: list[dict[str, Any]],
    spec: ModelConfig,
    *,
    schemas: list[dict[str, Any]] | None = None,
    extra: int = 0,
) -> bool:
    return not needs_compact(messages, spec, schemas=schemas, extra=extra)


def _checkpoint_turn(turn: dict[str, Any]) -> dict[str, str]:
    return {
        "role": str(turn.get("role") or "user"),
        "content": str(turn.get("content") or ""),
    }


def _summary_messages(
    *,
    prior_memory: str,
    turns: list[dict[str, Any]],
    current_user_message: str,
) -> list[dict[str, str]]:
    payload = {
        "previous_memory": prior_memory,
        "new_completed_messages": [_checkpoint_turn(turn) for turn in turns],
        "current_user_message": current_user_message,
    }
    return [
        {"role": "system", "content": CHECKPOINT_SYSTEM_PROMPT},
        {
            "role": "user",
            "content": json.dumps(
                payload,
                ensure_ascii=False,
                separators=(",", ":"),
            ),
        },
    ]


def _summary_input_fits(
    *,
    prior_memory: str,
    turns: list[dict[str, Any]],
    current_user_message: str,
    spec: ModelConfig,
) -> bool:
    return fits_request(
        _summary_messages(
            prior_memory=prior_memory,
            turns=turns,
            current_user_message=current_user_message,
        ),
        spec,
    )


async def _summarize_batch(
    *,
    prior_memory: str,
    turns: list[dict[str, Any]],
    current_user_message: str,
    spec: ModelConfig,
    on_compact: Any | None,
    purpose: str,
) -> str:
    messages = _summary_messages(
        prior_memory=prior_memory,
        turns=turns,
        current_user_message=current_user_message,
    )
    if not fits_request(messages, spec):
        raise ContextTooLarge(
            "The conversation cannot be summarized without truncating protected context."
        )
    if on_compact is not None:
        on_compact()
    raw = await models.complete_text(
        messages,
        model=spec,
        max_tokens=SUMMARY_MAX_TOKENS,
        reasoning=False,
        call_purpose=purpose,
    )
    summary = (raw or "").strip()
    if not summary:
        raise InvalidSummary("The conversation summarizer returned no memory.")
    if accounting.estimate_context_value(summary) > SUMMARY_MAX_TOKENS:
        raise InvalidSummary("The conversation summarizer exceeded its token limit.")
    return summary


async def summarize_checkpoint(
    *,
    prior_summary: str,
    turns: list[dict[str, Any]],
    current_user_message: str,
    spec: ModelConfig,
    on_compact: Any | None = None,
    purpose: str = accounting.PURPOSE_CHECKPOINT,
) -> str:
    """Fold all supplied turns, using chronological batches when necessary."""
    memory = str(prior_summary or "").strip()
    batch: list[dict[str, Any]] = []
    for turn in turns:
        candidate = [*batch, turn]
        if _summary_input_fits(
            prior_memory=memory,
            turns=candidate,
            current_user_message=current_user_message,
            spec=spec,
        ):
            batch = candidate
            continue
        if not batch:
            raise ContextTooLarge(
                "One historical message is too large to summarize without truncation."
            )
        memory = await _summarize_batch(
            prior_memory=memory,
            turns=batch,
            current_user_message=current_user_message,
            spec=spec,
            on_compact=on_compact,
            purpose=purpose,
        )
        batch = [turn]
        if not _summary_input_fits(
            prior_memory=memory,
            turns=batch,
            current_user_message=current_user_message,
            spec=spec,
        ):
            raise ContextTooLarge(
                "One historical message is too large to summarize without truncation."
            )
    if batch:
        return await _summarize_batch(
            prior_memory=memory,
            turns=batch,
            current_user_message=current_user_message,
            spec=spec,
            on_compact=on_compact,
            purpose=purpose,
        )
    if memory:
        return memory
    raise InvalidSummary("There is no completed conversation to summarize.")


def _current_query_index(messages: list[dict[str, Any]]) -> int:
    for index, message in enumerate(messages):
        if message.get("_kind") == "query":
            return index
    for index in range(len(messages) - 1, -1, -1):
        if messages[index].get("role") == "user":
            return index
    return len(messages)


async def compact_messages(
    messages: list[dict[str, Any]],
    spec: ModelConfig,
    *,
    schemas: list[dict[str, Any]] | None = None,
    extra: int = 0,
    protect_live_chain: bool = False,
    protect_openai_chain: bool | None = None,
    on_compact: Any | None = None,
    allow_summary: bool = True,
) -> list[dict[str, Any]]:
    """Summarize only history before the exact current user message."""
    del protect_live_chain, protect_openai_chain
    if not needs_compact(messages, spec, schemas=schemas, extra=extra):
        return messages
    if not allow_summary:
        raise ContextTooLarge(
            "Protected context exceeds the selected model's input limit."
        )

    query_index = _current_query_index(messages)
    head_count = 1 if messages and messages[0].get("role") == "system" else 0
    history_slice = messages[head_count:query_index]
    prior_memory = "\n\n".join(
        str(message.get("_memory") or "").strip()
        for message in history_slice
        if message.get("_kind") == "memory" and message.get("_memory")
    ).strip()
    history = [message for message in history_slice if message.get("_kind") != "memory"]
    protected = messages[query_index:]
    if (not history and not prior_memory) or not protected:
        raise ContextTooLarge(
            "Protected context exceeds the selected model's input limit."
        )
    current_user_message = str(protected[0].get("content") or "")
    summary = await summarize_checkpoint(
        prior_summary=prior_memory,
        turns=history,
        current_user_message=current_user_message,
        spec=spec,
        on_compact=on_compact,
        purpose=accounting.PURPOSE_LIVE_COMPACTION,
    )
    compacted = [
        *messages[:head_count],
        {
            "role": "user",
            "content": "Earlier conversation:\n" + summary,
            "_kind": "memory",
            "_memory": summary,
        },
        *protected,
    ]
    if needs_compact(compacted, spec, schemas=schemas, extra=extra):
        raise ContextTooLarge(
            "Protected context exceeds the selected model's input limit."
        )
    return compacted
