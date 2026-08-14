"""The chat agent: a capped tool loop over the workspace index.

The loop is bounded at ``EVO_AGENT_MAX_STEPS`` rounds. That bound is the design,
not a safety valve. An unbounded agent on a cheap model spends its budget
re-searching with rephrased queries; a bounded one is forced to answer from what
it has, which is also what keeps latency and cost predictable for a study app.

To stop the first turn being a wasted round trip, the loop is primed with one
retrieval before the model is asked anything. A question about the user's
sources almost always needs their sources, so making the model ask for them
costs a round trip and teaches it nothing.
"""

from __future__ import annotations

import json
import logging
from collections.abc import AsyncIterator
from typing import Any

from .. import obs
from ..config import cfg
from . import models, tools
from .locale import response_language_rule
from .search import Passage, search
from .tools import ToolContext

log = logging.getLogger("evo.retrieval.agent")

SYSTEM_PROMPT = (
    "You are a study assistant answering strictly from the user's own uploaded "
    "sources.\n"
    "\n"
    "Rules:\n"
    "- Ground every claim in retrieved passages. Cite them inline as [1], [2] "
    "using the numbers shown with each passage.\n"
    "- If the passages do not answer the question, say so plainly and say what "
    "the sources do cover. Never fill a gap from general knowledge without "
    "labelling it as outside the sources.\n"
    "- For questions that span documents, retrieve from each relevant document "
    "before comparing them, and attribute each side of the comparison.\n"
    "- Prefer answering over searching again. You have a small, fixed number of "
    "tool calls."
)


def system_prompt(locale: str | None) -> str:
    return SYSTEM_PROMPT + "\n- " + response_language_rule(locale)


async def _prime(ctx: ToolContext, query: str) -> list[Passage]:
    passages = await search(
        workspace_id=ctx.workspace_id, query=query, file_ids=ctx.file_ids or None
    )
    return passages


def _priming_message(numbered: list[tuple[int, Passage]]) -> str:
    if not numbered:
        return (
            "An initial search of the workspace returned nothing. Use list_sources "
            "to see what is available before answering."
        )
    body = "\n\n".join(passage.as_context(n) for n, passage in numbered)
    return f"Passages retrieved for this question:\n\n{body}"


async def run_agent(
    *,
    query: str,
    ctx: ToolContext,
    history: list[dict[str, Any]] | None,
    model: str | models.ModelConfig,
    locale: str | None = None,
) -> AsyncIterator[dict[str, Any]]:
    """Drive the loop, yielding {'type': ...} events for the SSE relay.

    Events: tool (progress), citations (once, before the answer), token, done.
    """
    numbered = tools.remember(ctx, await _prime(ctx, query))
    yield {"type": "tool", "tool": "search_workspace", "detail": query}

    messages: list[dict[str, Any]] = [
        {"role": "system", "content": system_prompt(locale)}
    ]
    for turn in history or []:
        role = turn.get("role")
        if role in ("user", "assistant") and turn.get("content"):
            messages.append({"role": role, "content": turn["content"]})
    messages.append({"role": "user", "content": query})
    messages.append({"role": "user", "content": _priming_message(numbered)})

    schemas = tools.schemas_for(ctx)
    for step in range(cfg.agent_max_steps):
        # The final round drops the tools entirely rather than asking nicely:
        # a model that emits one more tool call here would strand the turn with
        # no answer at all.
        last = step == cfg.agent_max_steps - 1
        try:
            message = await models.complete(
                messages, model=model, tools=None if last else schemas
            )
        except Exception as exc:
            log.exception("agent step failed")
            yield {"type": "error", "message": str(exc)}
            return
        if message is None:
            break

        calls = list(getattr(message, "tool_calls", None) or [])
        if not calls:
            break

        messages.append(
            {
                "role": "assistant",
                "content": message.content or "",
                "tool_calls": [
                    {
                        "id": call.id,
                        "type": "function",
                        "function": {
                            "name": call.function.name,
                            "arguments": call.function.arguments,
                        },
                    }
                    for call in calls
                ],
            }
        )
        for call in calls:
            name = call.function.name
            args = _parse_args(call.function.arguments)
            yield {"type": "tool", "tool": name, "detail": _describe(name, args)}
            result = await tools.run(name, args, ctx)
            messages.append(
                {"role": "tool", "tool_call_id": call.id, "content": result}
            )

    if ctx.citations:
        yield {
            "type": "citations",
            "citations": [p.as_citation() for p in ctx.citations],
        }

    # Compose the answer as a plain streamed completion. Splitting the final
    # turn from the tool loop means the user never waits on a response that
    # might turn out to be another tool call.
    messages.append(
        {
            "role": "user",
            "content": (
                "Now answer the original question using the passages above, with "
                "inline [n] citations. Do not call any more tools."
            ),
        }
    )
    async for token in models.stream_text(messages, model=model, temperature=0.4):
        yield {"type": "token", "text": token}

    # done carries the whole turn's spend: the prime search embedding, every
    # tool-loop completion, and the streamed answer. The gateway settles the
    # reservation it opened against this one number, so a turn abandoned before
    # this event settles at zero rather than being estimated.
    done: dict[str, Any] = {"type": "done"}
    usage = obs.current_usage()
    if usage is not None and not usage.is_empty():
        done["usage"] = usage.as_dict()
        done["tokenCount"] = usage.input_tokens + usage.output_tokens
    yield done


def _parse_args(raw: str | None) -> dict[str, Any]:
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _describe(name: str, args: dict[str, Any]) -> str:
    if name == "search_workspace":
        return str(args.get("query") or "")
    if name == "read_document":
        return str(args.get("file_id") or "")
    if name == "related_concepts":
        return str(args.get("concept") or "")
    if name == "generate_material":
        return str(args.get("kind") or "")
    return ""
