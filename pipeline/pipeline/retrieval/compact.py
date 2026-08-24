"""Shrink a chat transcript when it nears the model's input budget.

Conversation checkpoints are a separate rolling summary owned by Go. This
module is the in-request guard: tool results and protocol items accumulated
after planning starts.
"""

from __future__ import annotations

import json
import logging
from copy import deepcopy
from typing import Any

from .. import registry
from ..registry import ModelConfig
from . import accounting, models
from .chunking import clip_to_tokens, estimate_tokens

log = logging.getLogger("evo.retrieval.compact")

COMPACT_RATIO = 0.90
KEEP_TAIL = 6
SUMMARY_TOKENS = 1024
PROTOCOL_OVERHEAD = 512


def estimate_messages(messages: list[dict[str, Any]]) -> int:
    total = 0
    for message in messages:
        total += estimate_tokens(str(message.get("content") or ""))
        for call in message.get("tool_calls") or []:
            fn = call.get("function") or {}
            total += estimate_tokens(str(fn.get("arguments") or ""))
        for item in message.get("output_items") or []:
            total += estimate_tokens(json.dumps(item, default=str)[:4000])
    return total


def estimate_schemas(schemas: list[dict[str, Any]] | None) -> int:
    if not schemas:
        return 0
    return estimate_tokens(json.dumps(schemas)) + PROTOCOL_OVERHEAD


def needs_compact(
    messages: list[dict[str, Any]],
    spec: ModelConfig,
    *,
    extra: int = 0,
) -> bool:
    budget = registry.input_budget(spec)
    return estimate_messages(messages) + extra >= int(budget * COMPACT_RATIO)


def fits_request(
    messages: list[dict[str, Any]],
    spec: ModelConfig,
    *,
    extra: int = 0,
) -> bool:
    return estimate_messages(messages) + extra <= registry.input_budget(spec)


def _serialize(messages: list[dict[str, Any]]) -> str:
    lines: list[str] = []
    for message in messages:
        role = message.get("role") or "user"
        content = str(message.get("content") or "").strip()
        if content:
            lines.append(f"{role}: {content}")
        if message.get("citations"):
            lines.append("sources: " + json.dumps(message["citations"]))
        for call in message.get("tool_calls") or []:
            fn = call.get("function") or {}
            lines.append(f"tool {fn.get('name')}: {fn.get('arguments')}")
    return "\n\n".join(lines)


def _summary_messages(
    system: str,
    user: str,
    spec: ModelConfig,
) -> list[dict[str, str]]:
    available = max(
        0,
        registry.input_budget(spec) - estimate_tokens(system) - PROTOCOL_OVERHEAD,
    )
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": clip_to_tokens(user, available)},
    ]


def _is_tool_group_start(message: dict[str, Any]) -> bool:
    return bool(message.get("role") == "assistant" and message.get("tool_calls"))


def _group_bounds(messages: list[dict[str, Any]]) -> list[tuple[int, int]]:
    """Inclusive ranges of complete assistant-tool groups or single messages."""
    groups: list[tuple[int, int]] = []
    i = 0
    while i < len(messages):
        if _is_tool_group_start(messages[i]):
            end = i + 1
            while end < len(messages) and messages[end].get("role") == "tool":
                end += 1
            groups.append((i, end))
            i = end
            continue
        groups.append((i, i + 1))
        i += 1
    return groups


def openai_live_chain_start(messages: list[dict[str, Any]]) -> int:
    """Index of the last user item that still has function/reasoning items after it.

    Those items must be replayed untouched. Compact only the prefix.
    """
    last_user = -1
    for i, message in enumerate(messages):
        if message.get("role") == "user":
            last_user = i
    if last_user < 0:
        return len(messages)
    after = messages[last_user + 1 :]
    if any(
        m.get("role") == "tool"
        or m.get("tool_calls")
        or m.get("output_items")
        or m.get("type") in ("function_call", "function_call_output", "reasoning")
        for m in after
    ):
        return last_user
    return len(messages)


def _clip_group(messages: list[dict[str, Any]], available: int) -> list[dict[str, Any]]:
    if available <= 0:
        return []
    out = deepcopy(_strip_output_items(messages))
    original = [str(message.get("content") or "") for message in out]
    content_tokens = [estimate_tokens(text) for text in original]
    fixed = deepcopy(out)
    for message in fixed:
        message["content"] = ""
    fixed_tokens = estimate_messages(fixed)
    if fixed_tokens > available:
        for message in out:
            for call in message.get("tool_calls") or []:
                fn = call.get("function") or {}
                if fn.get("arguments"):
                    fn["arguments"] = clip_to_tokens(str(fn["arguments"]), 64)
        fixed = deepcopy(out)
        for message in fixed:
            message["content"] = ""
        fixed_tokens = estimate_messages(fixed)
    room = max(0, available - fixed_tokens)
    total = sum(content_tokens)
    for index, message in enumerate(out):
        if total <= room:
            break
        share = int(room * content_tokens[index] / total) if total else 0
        message["content"] = clip_to_tokens(original[index], share)
    if estimate_messages(out) <= available:
        return out
    for message in out:
        message["content"] = ""
    return out if estimate_messages(out) <= available else []


def clip_messages(
    messages: list[dict[str, Any]],
    spec: ModelConfig,
    *,
    extra: int = 0,
) -> list[dict[str, Any]]:
    """Keep the system message and newest complete groups. Drop the old middle."""
    budget = max(0, registry.input_budget(spec) - extra)
    if not messages:
        return messages
    head: list[dict[str, Any]] = []
    rest = messages
    if messages[0].get("role") == "system":
        head = [messages[0]]
        rest = messages[1:]
    groups = _group_bounds(rest)
    kept: list[dict[str, Any]] = []
    used = estimate_messages(head)
    for start, end in reversed(groups):
        chunk = rest[start:end]
        cost = estimate_messages(chunk)
        if used + cost > budget:
            if not kept:
                fitted = _clip_group(chunk, budget - used)
                if fitted:
                    kept = fitted
                    used += estimate_messages(fitted)
            continue
        kept = chunk + kept
        used += cost
        if used >= budget:
            break
    return head + kept


def _tail_start(messages: list[dict[str, Any]], head_len: int) -> int:
    start = max(head_len, len(messages) - KEEP_TAIL)
    while start > head_len and messages[start].get("role") == "tool":
        start -= 1
    return start


def _strip_output_items(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for message in messages:
        if "output_items" in message:
            out.append({k: v for k, v in message.items() if k != "output_items"})
        else:
            out.append(message)
    return out


def _known_sources(
    prior_refs: list[dict[str, Any]] | None, turns: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    seen: dict[str, dict[str, Any]] = {}
    for ref in list(prior_refs or []):
        if isinstance(ref, dict) and ref.get("fileId"):
            seen[str(ref.get("chunkId") or ref["fileId"])] = ref
    for turn in turns:
        for citation in turn.get("citations") or []:
            if isinstance(citation, dict) and citation.get("fileId"):
                seen[str(citation.get("chunkId") or citation["fileId"])] = citation
    return list(seen.values())


async def _compact_span(
    messages: list[dict[str, Any]],
    spec: ModelConfig,
    *,
    extra: int = 0,
    on_compact: Any | None = None,
) -> list[dict[str, Any]]:
    head = messages[:1] if messages and messages[0].get("role") == "system" else []
    tail_start = _tail_start(messages, len(head))
    middle = messages[len(head) : tail_start]
    tail = messages[tail_start:]
    if not middle:
        return clip_messages(messages, spec, extra=extra)
    blob = clip_to_tokens(
        _serialize(middle), max(2000, registry.input_budget(spec) // 4)
    )
    try:
        if on_compact is not None:
            on_compact()
        system = (
            "Summarize this study conversation for a later turn. "
            "Keep facts, source identities, and decisions. Drop filler. "
            "Do not treat citation numbers as stable across turns."
        )
        summary = await models.complete_text(
            _summary_messages(system, blob, spec),
            model=spec,
            max_tokens=SUMMARY_TOKENS,
            reasoning=False,
            call_purpose=accounting.PURPOSE_LIVE_COMPACTION,
        )
    except (models.UserKeyError, accounting.AccountingError):
        raise
    except Exception:
        log.warning("chat compact failed", exc_info=True)
        return clip_messages(messages, spec, extra=extra)
    summary = (summary or "").strip() or blob
    compacted = [
        *head,
        {"role": "user", "content": "Earlier conversation:\n" + summary},
        *tail,
    ]
    if needs_compact(compacted, spec, extra=extra):
        return clip_messages(compacted, spec, extra=extra)
    return compacted


async def compact_messages(
    messages: list[dict[str, Any]],
    spec: ModelConfig,
    *,
    extra: int = 0,
    protect_openai_chain: bool = False,
    on_compact: Any | None = None,
    allow_summary: bool = True,
) -> list[dict[str, Any]]:
    if not needs_compact(messages, spec, extra=extra):
        return messages
    if not allow_summary:
        return clip_messages(messages, spec, extra=extra)
    if protect_openai_chain:
        locked = openai_live_chain_start(messages)
        prefix = messages[:locked]
        suffix = messages[locked:]
        if suffix and needs_compact(prefix, spec, extra=extra):
            compacted_prefix = await _compact_span(
                prefix, spec, extra=extra, on_compact=on_compact
            )
            out = compacted_prefix + suffix
            if needs_compact(out, spec, extra=extra):
                return await _compact_span(
                    _strip_output_items(out),
                    spec,
                    extra=extra,
                    on_compact=on_compact,
                )
            return out
        if suffix:
            return await _compact_span(
                _strip_output_items(messages),
                spec,
                extra=extra,
                on_compact=on_compact,
            )
    return await _compact_span(messages, spec, extra=extra, on_compact=on_compact)


async def summarize_checkpoint(
    *,
    prior_summary: str,
    turns: list[dict[str, Any]],
    spec: ModelConfig,
    prior_refs: list[dict[str, Any]] | None = None,
    on_compact: Any | None = None,
) -> dict[str, Any]:
    """Fold the previous checkpoint plus newly old turns into one summary."""
    blob = clip_to_tokens(
        (prior_summary + "\n\n" if prior_summary else "") + _serialize(turns),
        max(2000, registry.input_budget(spec) // 4),
    )
    known = _known_sources(prior_refs, turns)
    user = blob
    if known:
        user += "\n\nKnown sources:\n" + json.dumps(known)
    if on_compact is not None:
        on_compact()
    system = (
        "Summarize this study conversation. Return JSON with keys "
        "summary (string) and source_refs (array of objects with "
        "fileId, chunkId, fileName, pageStart, pageEnd, snippet). "
        "Pick source_refs from Known sources when present. "
        "Keep only sources the summary actually uses. Snippets stay "
        "under 200 characters."
    )
    raw = await models.complete_text(
        _summary_messages(system, user, spec),
        model=spec,
        max_tokens=SUMMARY_TOKENS,
        reasoning=False,
        call_purpose=accounting.PURPOSE_CHECKPOINT,
    )
    parsed = _parse_checkpoint(raw)
    if parsed is None:
        return {"summary": (raw or "").strip() or blob, "source_refs": []}
    return parsed


def _parse_checkpoint(raw: str | None) -> dict[str, Any] | None:
    text = (raw or "").strip()
    if not text:
        return None
    try:
        start = text.find("{")
        end = text.rfind("}")
        if start < 0 or end <= start:
            return None
        data = json.loads(text[start : end + 1])
    except json.JSONDecodeError:
        return None
    if not isinstance(data, dict):
        return None
    summary = str(data.get("summary") or "").strip()
    refs = data.get("source_refs") or data.get("sourceRefs") or []
    if not isinstance(refs, list):
        refs = []
    cleaned: list[dict[str, Any]] = []
    for ref in refs:
        if not isinstance(ref, dict):
            continue
        file_id = str(ref.get("fileId") or ref.get("file_id") or "")
        chunk_id = str(ref.get("chunkId") or ref.get("chunk_id") or "")
        if not file_id:
            continue
        cleaned.append(
            {
                "fileId": file_id,
                "chunkId": chunk_id,
                "fileName": str(ref.get("fileName") or ref.get("file_name") or ""),
                "pageStart": ref.get("pageStart") or ref.get("page_start"),
                "pageEnd": ref.get("pageEnd") or ref.get("page_end"),
                "snippet": str(ref.get("snippet") or "")[:200],
            }
        )
    return {"summary": summary or text, "source_refs": cleaned}
