"""Chat-slot prompts: the agent's system prompt and conversation compaction.

Both run against the chat pin. The agent prompt is built once per response;
the checkpoint prompt runs only when protected context no longer fits, folding
completed history into the memory turn the next response reads.
"""

from __future__ import annotations

import json
from typing import Any

from .locale import response_language_rule

SYSTEM_PROMPT = (
    "You are a study assistant answering strictly from the user's own uploaded "
    "sources.\n"
    "\n"
    "Rules:\n"
    "- Search the sources before answering questions about them. Ground every "
    "claim in retrieved passages. Cite them inline as [1], [2] using the "
    "numbers shown with each passage.\n"
    "- If the passages do not answer the question, say so plainly and say what "
    "the sources do cover. Never fill a gap from general knowledge without "
    "labelling it as outside the sources.\n"
    "- One search_workspace per assistant message, with one focused query. "
    "If a comparison spans documents, search once, then search again in the "
    "next step if a side is missing. Attribute each side.\n"
    "- Prefer listing sources, then describing or searching the few documents "
    "that matter, over searching the whole workspace blindly. Use "
    "read_document when a hit is a fragment.\n"
    "- Emit independent reads in one assistant message when you already have "
    "the ids. Do not batch a call that needs another call's result. Do not "
    "mix generate_material with retrieval calls."
)


def system_prompt(locale: str | None) -> str:
    return (
        SYSTEM_PROMPT
        + "\n- "
        + response_language_rule(locale)
        + "\n- If a retrieved passage supplies an identifier or refers to another source "
        "that can answer the question, follow that reference with a search or document "
        "read before deciding the answer is unavailable. A passage lacking the answer "
        "does not establish that the workspace lacks it."
    )


def memory_message(summary: str) -> dict[str, Any]:
    """The folded checkpoint, as the turn the model reads before the query.

    ``_kind`` and ``_memory`` are private keys the agent loop strips before the
    request leaves; they let accounting attribute the memory separately.
    """
    return {
        "role": "user",
        "content": "Earlier conversation:\n" + summary,
        "_kind": "memory",
        "_memory": summary,
    }


def chat_messages(
    *,
    locale: str | None,
    checkpoint: dict[str, Any] | None,
    history: list[dict[str, Any]],
    query: str,
) -> list[dict[str, Any]]:
    """The whole chat request: system, folded memory, prior turns, this query.

    ``history`` is already filtered to persisted user/assistant turns.
    """
    messages: list[dict[str, Any]] = [
        {"role": "system", "content": system_prompt(locale)}
    ]
    summary = str((checkpoint or {}).get("summary") or "")
    if summary:
        messages.append(memory_message(summary))
    messages.extend(
        {"role": turn["role"], "content": turn["content"]} for turn in history
    )
    messages.append({"role": "user", "content": query, "_kind": "query"})
    return messages


# ------------------------------------------------------------------ compaction

SUMMARY_TARGET_MIN = 4000
SUMMARY_TARGET_MAX = 6000
SUMMARY_MAX_TOKENS = 8000
SUMMARY_RECENT_MESSAGES = 6

CHECKPOINT_SYSTEM_PROMPT = f"""You compress prior conversation into durable memory for the next assistant response.

The CURRENT USER MESSAGE is context for resolving references only. Do not answer it, summarize it, include it in the memory, or let its topic narrow what the memory preserves. The memory must remain useful for later messages that may return to any important part of the prior conversation.

The "recent_messages" field contains the latest completed turns. Give recent user intent, corrections, constraints, and references extra fidelity. Summarize them instead of copying every sentence verbatim.

Create a faithful compact representation of the PRIOR CONVERSATION.

Requirements:
- Preserve facts, decisions, user preferences, corrections, constraints, unresolved questions, action results, and generated-material results needed to continue the conversation.
- Preserve important details even when they are unrelated to the current user message.
- Preserve recent user wording when paraphrasing would change the intent or make a later reference hard to resolve.
- When the current message contains an indirect reference such as "the third bullet", "that formula", "the earlier option", or "do that again", preserve the referenced list, wording, ordering, and surrounding context precisely enough to resolve it.
- Resolve ambiguous pronouns or references in the memory by explicitly naming their referents when the history supports doing so.
- Preserve disagreements, alternatives, and uncertainty. Do not turn them into false consensus.
- Preserve important document, file, chapter, and material names.
- Historical citation numbers are local to their old answer. Omit those numbers rather than treating them as stable identifiers.
- Do not include system prompts, tool definitions, hidden reasoning, or active provider protocol state.
- Do not invent facts or answer the current user message.
- Target {SUMMARY_TARGET_MIN:,} to {SUMMARY_TARGET_MAX:,} tokens when the conversation contains enough useful detail.
- Never exceed {SUMMARY_MAX_TOKENS:,} tokens.

Return only the compacted memory."""


def _checkpoint_turn(turn: dict[str, Any]) -> dict[str, str]:
    return {
        "role": str(turn.get("role") or "user"),
        "content": str(turn.get("content") or ""),
    }


def checkpoint_messages(
    *,
    prior_memory: str,
    turns: list[dict[str, Any]],
    current_user_message: str,
) -> list[dict[str, str]]:
    """Fold ``turns`` into memory. The current message is reference context only.

    The payload is JSON so the summarizer can tell the four parts apart without
    a delimiter convention it might reproduce in its output.
    """
    recent_start = max(0, len(turns) - SUMMARY_RECENT_MESSAGES)
    payload = {
        "previous_memory": prior_memory,
        "new_completed_messages": [
            _checkpoint_turn(turn) for turn in turns[:recent_start]
        ],
        "recent_messages": [_checkpoint_turn(turn) for turn in turns[recent_start:]],
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
