"""Shrink a chat transcript when it nears the model's context window.

The 90% line is the product rule: leave the last turns verbatim, fold the
middle into one summary, and clip leftovers if the summary is still huge.
"""

from __future__ import annotations

import logging
from typing import Any

from .. import registry
from ..registry import ModelConfig
from . import models
from .chunking import clip_to_tokens, estimate_tokens

log = logging.getLogger("evo.retrieval.compact")

COMPACT_RATIO = 0.90
KEEP_TAIL = 6
SUMMARY_TOKENS = 1024


def estimate_messages(messages: list[dict[str, Any]]) -> int:
    total = 0
    for message in messages:
        total += estimate_tokens(str(message.get("content") or ""))
        for call in message.get("tool_calls") or []:
            fn = call.get("function") or {}
            total += estimate_tokens(str(fn.get("arguments") or ""))
    return total


def needs_compact(messages: list[dict[str, Any]], spec: ModelConfig) -> bool:
    return estimate_messages(messages) >= int(
        registry.context_window(spec) * COMPACT_RATIO
    )


def _serialize(messages: list[dict[str, Any]]) -> str:
    lines: list[str] = []
    for message in messages:
        role = message.get("role") or "user"
        content = str(message.get("content") or "").strip()
        if content:
            lines.append(f"{role}: {content}")
        for call in message.get("tool_calls") or []:
            fn = call.get("function") or {}
            lines.append(f"tool {fn.get('name')}: {fn.get('arguments')}")
    return "\n\n".join(lines)


def _clip_messages(
    messages: list[dict[str, Any]], spec: ModelConfig
) -> list[dict[str, Any]]:
    budget = registry.input_budget(spec)
    used = 0
    out: list[dict[str, Any]] = []
    for message in messages:
        piece = dict(message)
        content = str(piece.get("content") or "")
        room = max(200, budget - used)
        clipped = clip_to_tokens(content, room)
        if clipped != content:
            piece["content"] = clipped
        used += estimate_tokens(str(piece.get("content") or ""))
        out.append(piece)
        if used >= budget:
            break
    return out


def _tail_start(messages: list[dict[str, Any]], head_len: int) -> int:
    start = max(head_len, len(messages) - KEEP_TAIL)
    while start > head_len and messages[start].get("role") == "tool":
        start -= 1
    return start


async def compact_messages(
    messages: list[dict[str, Any]], spec: ModelConfig
) -> list[dict[str, Any]]:
    if not needs_compact(messages, spec):
        return messages
    head = messages[:1] if messages and messages[0].get("role") == "system" else []
    tail_start = _tail_start(messages, len(head))
    middle = messages[len(head) : tail_start]
    tail = messages[tail_start:]
    if not middle:
        return _clip_messages(messages, spec)
    blob = clip_to_tokens(
        _serialize(middle), max(2000, registry.input_budget(spec) // 4)
    )
    try:
        summary = await models.complete_text(
            [
                {
                    "role": "system",
                    "content": (
                        "Summarize this study conversation for a later turn. "
                        "Keep facts, citation numbers, and decisions. Drop filler."
                    ),
                },
                {"role": "user", "content": blob},
            ],
            model=spec,
            max_tokens=SUMMARY_TOKENS,
            reasoning=False,
        )
    except models.UserKeyError:
        raise
    except Exception:
        log.warning("chat compact failed", exc_info=True)
        return _clip_messages(messages, spec)
    summary = (summary or "").strip() or blob
    compacted = [
        *head,
        {"role": "user", "content": "Earlier conversation:\n" + summary},
        *tail,
    ]
    if needs_compact(compacted, spec):
        return _clip_messages(compacted, spec)
    return compacted
