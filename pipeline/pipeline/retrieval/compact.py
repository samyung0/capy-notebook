"""Conversation compaction and rolling checkpoint summaries.

System instructions, tool schemas, the current user message, and the most
recent tool exchanges of the turn are protected. Completed history folds into
memory; older exchanges of the current turn fold into an ephemeral turn note.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from .. import elitellm, registry
from ..prompts.chat import (
    SUMMARY_MAX_TOKENS,
    TURN_KEEP_EXCHANGES,
    checkpoint_messages,
    memory_message,
    turn_note_message,
    turn_note_messages,
)
from ..registry import ModelConfig
from . import accounting, models

EFFECTIVE_INPUT_LIMIT_TOKENS = 250_000
PROTOCOL_SAFETY_MARGIN_TOKENS = 512


class ContextTooLarge(RuntimeError):
    """Protected context cannot fit the selected model's usable input."""


class InvalidSummary(RuntimeError):
    """The summarizer returned an empty or oversized checkpoint."""


def usable_input_limit(
    spec: ModelConfig,
    *,
    max_tokens: int | None = None,
    reasoning: bool | None = None,
) -> int:
    """Cap useful input at 250k, then keep an explicit calibrated margin."""
    configured = spec.params.get("context_safety_margin_tokens", 0)
    try:
        calibrated = max(0, int(configured))
    except (TypeError, ValueError):
        calibrated = 0
    margin = max(PROTOCOL_SAFETY_MARGIN_TOKENS, calibrated)
    effective = min(
        registry.context_window(spec)
        - elitellm.output_budget(spec, max_tokens=max_tokens, reasoning=reasoning),
        EFFECTIVE_INPUT_LIMIT_TOKENS,
    )
    return max(0, effective - margin)


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
    max_tokens: int | None = None,
    reasoning: bool | None = None,
) -> bool:
    measured = request_context(
        messages, spec, schemas=schemas, reasoning=reasoning
    ).total_tokens
    return measured + max(0, extra) > usable_input_limit(
        spec, max_tokens=max_tokens, reasoning=reasoning
    )


def fits_request(
    messages: list[dict[str, Any]],
    spec: ModelConfig,
    *,
    schemas: list[dict[str, Any]] | None = None,
    extra: int = 0,
    max_tokens: int | None = None,
    reasoning: bool | None = None,
) -> bool:
    return not needs_compact(
        messages,
        spec,
        schemas=schemas,
        extra=extra,
        max_tokens=max_tokens,
        reasoning=reasoning,
    )


def _summary_input_fits(
    *,
    prior_memory: str,
    turns: list[dict[str, Any]],
    current_user_message: str,
    spec: ModelConfig,
    build: Callable[..., list[dict[str, str]]] = checkpoint_messages,
) -> bool:
    return fits_request(
        build(
            prior_memory=prior_memory,
            turns=turns,
            current_user_message=current_user_message,
        ),
        spec,
        max_tokens=SUMMARY_MAX_TOKENS,
    )


async def _summarize_batch(
    *,
    prior_memory: str,
    turns: list[dict[str, Any]],
    current_user_message: str,
    spec: ModelConfig,
    on_compact: Any | None,
    purpose: str,
    build: Callable[..., list[dict[str, str]]],
) -> str:
    messages = build(
        prior_memory=prior_memory,
        turns=turns,
        current_user_message=current_user_message,
    )
    if not fits_request(messages, spec, max_tokens=SUMMARY_MAX_TOKENS):
        raise ContextTooLarge(
            "The conversation cannot be summarized without truncating protected context."
        )
    if on_compact is not None:
        on_compact()
    raw = await models.complete_text(
        messages,
        model=spec,
        max_tokens=SUMMARY_MAX_TOKENS,
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
    build: Callable[..., list[dict[str, str]]] = checkpoint_messages,
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
            build=build,
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
            build=build,
        )
        batch = [turn]
        if not _summary_input_fits(
            prior_memory=memory,
            turns=batch,
            current_user_message=current_user_message,
            spec=spec,
            build=build,
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
            build=build,
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


def _exchanges(turn: list[dict[str, Any]]) -> list[list[dict[str, Any]]]:
    """Group a turn into assistant tool_calls messages with their tool results."""
    groups: list[list[dict[str, Any]]] = []
    for message in turn:
        if message.get("role") == "assistant" or not groups:
            groups.append([])
        groups[-1].append(message)
    return groups


async def _fold_turn(
    messages: list[dict[str, Any]],
    query_index: int,
    spec: ModelConfig,
    on_compact: Any | None,
) -> list[dict[str, Any]]:
    """Replace this turn's older exchanges with a note; the last ones stay exact."""
    query, *turn = messages[query_index:]
    prior_note = "\n\n".join(
        str(message.get("_note") or "")
        for message in turn
        if message.get("_kind") == "turn_note" and message.get("_note")
    ).strip()
    groups = _exchanges([m for m in turn if m.get("_kind") != "turn_note"])
    fold = [m for group in groups[:-TURN_KEEP_EXCHANGES] for m in group]
    keep = [m for group in groups[-TURN_KEEP_EXCHANGES:] for m in group]
    if not fold:
        return messages
    note = await summarize_checkpoint(
        prior_summary=prior_note,
        turns=fold,
        current_user_message=str(query.get("content") or ""),
        spec=spec,
        on_compact=on_compact,
        purpose=accounting.PURPOSE_LIVE_COMPACTION,
        build=turn_note_messages,
    )
    return [*messages[:query_index], query, turn_note_message(note), *keep]


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
    """Fold history into memory, then this turn's older exchanges into a note."""
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
    if not protected:
        raise ContextTooLarge(
            "Protected context exceeds the selected model's input limit."
        )
    compacted = messages
    if history or prior_memory:
        summary = await summarize_checkpoint(
            prior_summary=prior_memory,
            turns=history,
            current_user_message=str(protected[0].get("content") or ""),
            spec=spec,
            on_compact=on_compact,
            purpose=accounting.PURPOSE_LIVE_COMPACTION,
        )
        compacted = [*messages[:head_count], memory_message(summary), *protected]
        if not needs_compact(compacted, spec, schemas=schemas, extra=extra):
            return compacted
    compacted = await _fold_turn(
        compacted, _current_query_index(compacted), spec, on_compact
    )
    if needs_compact(compacted, spec, schemas=schemas, extra=extra):
        raise ContextTooLarge(
            "Protected context exceeds the selected model's input limit."
        )
    return compacted
