"""The chat agent: a capped tool loop over the workspace index.

One user send is one turn. Each streamed model response is either narration
(if it also calls tools) or the persisted answer (first completed response
with text and no tools). There is no second answer completion.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any

from .. import obs
from ..config import cfg
from . import accounting, compact, events, models, store, tools
from .chunking import estimate_tokens
from .limits import (
    MAX_CONCURRENT,
    PLANNING_RESPONSES,
    STOP_ANSWER,
    STOP_CLIENT_GONE,
    STOP_ERROR,
    STOP_PLANNING_CAP,
    STOP_TURN_FAILED,
    TOOLS_PER_RESPONSE,
    TOOLS_PER_TURN,
    TurnBudget,
)
from .locale import response_language_rule
from .stream import AssembledResponse, StreamEvent, ToolCall
from .tools import ToolContext, ToolResult, TurnFailed

log = logging.getLogger("evo.retrieval.agent")

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
    return SYSTEM_PROMPT + "\n- " + response_language_rule(locale)


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
    if name == "list_sources":
        return "listing sources"
    if name == "describe_documents":
        ids = args.get("file_ids") or []
        return ", ".join(str(i) for i in ids[:8])
    if name == "read_document":
        return str(args.get("file_id") or "")
    if name == "generate_material":
        return str(args.get("kind") or "")
    return ""


CLIENT_ERROR = "The chat agent hit an internal error."
CLIENT_ERROR_CODE = "agent_failed"


@dataclass
class ClientDrop:
    """Set when the browser or Go hop is gone. The current provider call still
    finishes and settles. The loop does not start another one.
    """

    dropped: bool = False

    def mark(self) -> None:
        self.dropped = True


def _client_gone(client: ClientDrop | None) -> bool:
    return bool(client and client.dropped)


def _history_turns(history: list[dict[str, Any]] | None) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for turn in history or []:
        role = turn.get("role")
        if role in ("user", "assistant") and turn.get("content"):
            row: dict[str, Any] = {
                "id": turn.get("id") or "",
                "role": role,
                "content": turn["content"],
            }
            out.append(row)
    return out


def _with_usage(event: dict[str, Any]) -> dict[str, Any]:
    usage = obs.current_usage()
    if usage is not None and not usage.is_empty():
        event["usage"] = usage.as_dict()
        event["tokenCount"] = usage.input_tokens + usage.output_tokens
    return event


def _client_error() -> dict[str, Any]:
    return _with_usage(events.error(CLIENT_ERROR, CLIENT_ERROR_CODE))


async def _admit_checkpoint(
    *,
    messages: list[dict[str, Any]],
    history: list[dict[str, Any]],
    checkpoint: dict[str, Any] | None,
    spec: models.ModelConfig,
    schemas: list[dict[str, Any]],
    budget: TurnBudget,
    query_msg: dict[str, Any],
) -> tuple[list[dict[str, Any]], dict[str, Any] | None]:
    if not compact.needs_compact(messages, spec, schemas=schemas):
        return messages, None
    completed = [turn for turn in history if turn.get("id")]
    if not completed:
        return messages, None
    through = str(completed[-1]["id"])

    def _count() -> None:
        budget.completion_calls += 1
        budget.compaction_calls += 1

    folded = await compact.summarize_checkpoint(
        prior_summary=str((checkpoint or {}).get("summary") or ""),
        turns=completed,
        current_user_message=str(query_msg.get("content") or ""),
        spec=spec,
        on_compact=_count,
    )
    replacement = {
        "throughMessageId": through,
        "summary": folded,
        "providerSlug": spec.provider_slug,
        "modelSlug": spec.model_slug,
        "modelVersion": spec.version,
        "estimatedTokens": estimate_tokens(folded),
    }
    rebuilt = [messages[0]]
    rebuilt.append(
        {
            "role": "user",
            "content": "Earlier conversation:\n" + folded,
            "_kind": "memory",
            "_memory": folded,
        }
    )
    rebuilt.append(query_msg)
    budget.checkpoint_rewrites += 1
    return rebuilt, replacement


async def run_agent(
    *,
    query: str,
    ctx: ToolContext,
    history: list[dict[str, Any]] | None,
    model: models.ModelConfig,
    locale: str | None = None,
    checkpoint: dict[str, Any] | None = None,
    client: ClientDrop | None = None,
) -> AsyncIterator[dict[str, Any]]:
    budget = TurnBudget()
    ctx.budget = budget
    spec = models._as_spec(model)
    citation_version = 0
    activity: list[dict[str, Any]] = []
    answer = ""
    block_n = 0

    if ctx.file_ids:
        active_scope = await tools.resolve_current_scope(ctx)
        if isinstance(active_scope, ToolResult):
            yield _with_usage(events.error(active_scope.text(), "invalid_scope"))
            return

    messages: list[dict[str, Any]] = [
        {"role": "system", "content": system_prompt(locale)}
    ]
    if checkpoint and checkpoint.get("summary"):
        messages.append(
            {
                "role": "user",
                "content": "Earlier conversation:\n" + str(checkpoint["summary"]),
                "_kind": "memory",
                "_memory": str(checkpoint["summary"]),
            }
        )
    prior = _history_turns(history)
    messages.extend({"role": t["role"], "content": t["content"]} for t in prior)
    query_msg = {"role": "user", "content": query, "_kind": "query"}
    messages.append(query_msg)

    schemas = tools.schemas_for(ctx)
    try:
        messages, replacement = await _admit_checkpoint(
            messages=messages,
            history=prior,
            checkpoint=checkpoint,
            spec=spec,
            schemas=schemas,
            budget=budget,
            query_msg=query_msg,
        )
    except models.UserKeyError as exc:
        yield _with_usage(dict(exc.as_event()))
        return
    except compact.ContextTooLarge as exc:
        yield _with_usage(events.error(str(exc), "context_too_large"))
        return
    except compact.InvalidSummary:
        log.warning("checkpoint summarizer returned invalid output", exc_info=True)
        yield _with_usage(
            events.error(
                "The conversation could not be compacted.", "compaction_failed"
            )
        )
        return
    if replacement:
        yield events.checkpoint(replacement)

    planning_cap = min(cfg.agent_max_steps, PLANNING_RESPONSES)
    state = accounting.current()
    terminal_pending = bool(
        state and state.credits_exhausted and state.terminal_call_allowed
    )
    step = 0

    while step < planning_cap or terminal_pending:
        if _client_gone(client):
            budget.stop_reason = STOP_CLIENT_GONE
            return
        terminal_call = terminal_pending
        terminal_pending = False
        tools_off = terminal_call or step == planning_cap - 1
        active_schemas = None if tools_off else schemas

        yield events.phase("planning")
        try:

            def _count() -> None:
                budget.completion_calls += 1
                budget.compaction_calls += 1

            messages = await compact.compact_messages(
                messages,
                spec,
                schemas=active_schemas,
                protect_live_chain=True,
                on_compact=_count,
                allow_summary=not terminal_call,
            )
            state = accounting.current()
            if (
                state
                and state.credits_exhausted
                and state.terminal_call_allowed
                and not terminal_call
            ):
                terminal_call = True
                tools_off = True
                active_schemas = None
                messages = await compact.compact_messages(
                    messages,
                    spec,
                    schemas=active_schemas,
                    protect_live_chain=True,
                    allow_summary=False,
                )
            if _client_gone(client):
                budget.stop_reason = STOP_CLIENT_GONE
                return
            budget.estimated_input_tokens += compact.request_context(
                messages, spec, schemas=active_schemas
            ).total_tokens
            block_n += 1
            block_id = f"b{block_n}"
            pending_q: asyncio.Queue[StreamEvent | None] = asyncio.Queue()

            def _on_event(
                ev: StreamEvent, q: asyncio.Queue[StreamEvent | None] = pending_q
            ) -> None:
                q.put_nowait(ev)

            budget.completion_calls += 1
            budget.planning_rounds += 1
            step += 1
            stream_task = asyncio.create_task(
                models.stream_agent_response(
                    messages,
                    model=spec,
                    tools=None if tools_off else schemas,
                    on_event=_on_event,
                    call_purpose=(
                        accounting.PURPOSE_TERMINAL
                        if terminal_call
                        else accounting.PURPOSE_AGENT
                    ),
                )
            )

            async def _finish(
                task: asyncio.Task[AssembledResponse] = stream_task,
                q: asyncio.Queue[StreamEvent | None] = pending_q,
            ) -> AssembledResponse:
                try:
                    return await asyncio.shield(task)
                finally:
                    q.put_nowait(None)

            finisher = asyncio.create_task(_finish())
            started = False
            try:
                while True:
                    ev = await pending_q.get()
                    if ev is None:
                        break
                    if ev.kind == "text" and ev.text and not _client_gone(client):
                        if not started:
                            yield events.block_start(block_id)
                            started = True
                        yield events.block_delta(block_id, ev.text)
                assembled = await asyncio.shield(finisher)
            except asyncio.CancelledError:
                assembled = await asyncio.shield(finisher)
                raise
            finally:
                if not stream_task.done():
                    try:
                        await asyncio.shield(stream_task)
                    except Exception:
                        log.exception("provider call failed after the SSE writer left")
        except models.UserKeyError as exc:
            if not _client_gone(client):
                yield _with_usage(dict(exc.as_event()))
            budget.stop_reason = STOP_ERROR
            return
        except compact.ContextTooLarge as exc:
            if not _client_gone(client):
                yield _with_usage(events.error(str(exc), "context_too_large"))
            budget.stop_reason = STOP_ERROR
            return
        except compact.InvalidSummary:
            log.warning("live compaction returned invalid output", exc_info=True)
            if not _client_gone(client):
                yield _with_usage(
                    events.error(
                        "The conversation could not be compacted.",
                        "compaction_failed",
                    )
                )
            budget.stop_reason = STOP_ERROR
            return
        except Exception:
            log.exception("agent step failed")
            if not _client_gone(client):
                yield _client_error()
            budget.stop_reason = STOP_ERROR
            return

        budget.reported_input_tokens += assembled.usage.input_tokens
        budget.cached_read_tokens += assembled.usage.cached_read_tokens
        budget.cache_write_tokens += assembled.usage.cache_write_tokens
        budget.reasoning_tokens += assembled.usage.reasoning_tokens

        if _client_gone(client):
            budget.stop_reason = STOP_CLIENT_GONE
            return

        calls = assembled.tool_calls
        text = assembled.text.strip()
        state = accounting.current()
        exhausted = bool(state and state.credits_exhausted)
        if terminal_call:
            calls = []
        if calls:
            if not started and text:
                yield events.block_start(block_id)
                started = True
                yield events.block_delta(block_id, assembled.text)
            if started:
                yield events.block_end(block_id, "narration")
                activity.append(
                    {"id": block_id, "kind": "narration", "text": assembled.text}
                )
            yield events.phase("running_tools")
            if assembled.provider_message:
                assistant = dict(assembled.provider_message)
                assistant.setdefault("role", "assistant")
                assistant.setdefault("content", assembled.text)
                if not assistant.get("tool_calls"):
                    assistant["tool_calls"] = [
                        {
                            "id": call.id,
                            "type": "function",
                            "function": {
                                "name": call.name,
                                "arguments": call.arguments,
                            },
                        }
                        for call in calls
                    ]
            else:
                assistant = {
                    "role": "assistant",
                    "content": assembled.text,
                    "tool_calls": [
                        {
                            "id": call.id,
                            "type": "function",
                            "function": {
                                "name": call.name,
                                "arguments": call.arguments,
                            },
                        }
                        for call in calls
                    ],
                }
            if assembled.output_items:
                assistant["output_items"] = assembled.output_items
            messages.append(assistant)
            try:
                async for event in _run_tools(calls, ctx, budget, messages):
                    if event.get("type") == "_tool_message":
                        continue
                    if event.get("type") == "activity":
                        activity.append(event["block"])
                        continue
                    if event.get("type") == "citations":
                        citation_version += 1
                        event = {**event, "version": citation_version}
                    yield event
            except TurnFailed:
                yield _client_error()
                budget.stop_reason = STOP_TURN_FAILED
                return
            if exhausted and state and state.terminal_call_allowed:
                terminal_pending = True
            continue

        if text:
            if not started:
                yield events.phase("answering")
                yield events.block_start(block_id)
                yield events.block_delta(block_id, assembled.text)
            yield events.block_end(block_id, "answer")
            answer = assembled.text
            budget.stop_reason = STOP_ANSWER
            break
        budget.stop_reason = budget.stop_reason or STOP_PLANNING_CAP
        break

    if not budget.stop_reason:
        budget.stop_reason = STOP_PLANNING_CAP

    await _record_searches(ctx, answer)
    done: dict[str, Any] = events.done(
        None,
        0,
        budget.as_dict(),
        activity,
        answer,
    )
    usage = obs.current_usage()
    if usage is not None and not usage.is_empty():
        done["usage"] = usage.as_dict()
        done["tokenCount"] = usage.input_tokens + usage.output_tokens
    yield done


_CITATION_RE = re.compile(r"\[(\d{1,3})\]")


async def _record_searches(ctx: ToolContext, answer: str) -> None:
    """Write the turn's search events with the hits the answer cited.

    Only turns that reach ``done`` are recorded; a turn that errors out or
    loses its client has no answer to attribute and is visible in the logs.
    Telemetry never fails the turn.
    """
    if not ctx.search_events:
        return
    cited_chunks: set[str] = set()
    for match in _CITATION_RE.finditer(answer):
        n = int(match.group(1))
        if 1 <= n <= len(ctx.citations):
            cited_chunks.add(ctx.citations[n - 1].chunk_id)
    for event in ctx.search_events:
        event["cited"] = [chunk_id in cited_chunks for chunk_id in event["chunk_ids"]]
        event["trace_id"] = obs.trace_id()
        event["workspace_id"] = ctx.workspace_id
        event["actor_user_id"] = ctx.user_id or None
        event["message_id"] = ctx.assistant_message_id
    try:
        await store.record_search_events(ctx.search_events)
    except Exception:
        log.warning("search telemetry write failed", exc_info=True)


async def _run_tools(
    calls: list[ToolCall],
    ctx: ToolContext,
    budget: TurnBudget,
    messages: list[dict[str, Any]],
) -> AsyncIterator[dict[str, Any]]:
    accepted: list[tuple[ToolCall, dict[str, Any], str]] = []
    results: list[tuple[ToolCall, ToolResult]] = []
    for call in calls:
        args = _parse_args(call.arguments)
        args["_tool_call_id"] = call.id
        limit_text = _limit_for(
            call,
            budget,
            len(accepted),
            search_used=any(name == "search_workspace" for _, _, name in accepted),
        )
        if limit_text:
            result = tools._refused(limit_text)
            results.append((call, result))
            yield events.tool_start(call.id, call.name, _describe(call.name, args))
            yield events.tool_end(call.id, "refused")
            yield {
                "type": "activity",
                "block": {
                    "id": call.id,
                    "kind": "tool",
                    "callId": call.id,
                    "name": call.name,
                    "detail": _describe(call.name, args),
                    "status": "refused",
                },
            }
            continue
        accepted.append((call, args, call.name))
        budget.note_tool(call.name)

    work = [(call, args, name) for call, args, name in accepted]
    executed: dict[str, ToolResult] = {}
    if work:
        mutating = any(
            (tools.spec_for(name) and tools.spec_for(name).mutates)
            for _, _, name in work
        )
        if mutating:
            peak = 1
            for call, args, name in work:
                yield events.tool_start(call.id, name, _describe(name, args))
                executed[call.id] = await tools.run(name, args, ctx)
            budget.peak_parallel_tools = max(budget.peak_parallel_tools, peak)
        else:
            peak = min(len(work), MAX_CONCURRENT)
            budget.peak_parallel_tools = max(budget.peak_parallel_tools, peak)
            sem = asyncio.Semaphore(MAX_CONCURRENT)

            async def _one(
                call: ToolCall, args: dict[str, Any], name: str
            ) -> tuple[str, ToolResult]:
                async with sem:
                    return call.id, await tools.run(name, args, ctx)

            for call, args, name in work:
                yield events.tool_start(call.id, name, _describe(name, args))
            gathered = await asyncio.gather(
                *[_one(call, args, name) for call, args, name in work]
            )
            for call_id, result in gathered:
                executed[call_id] = result

    for call, args, name in work:
        result = executed[call.id]
        results.append((call, result))
        status = "refused" if result.refused else "success"
        yield events.tool_end(call.id, status)
        yield {
            "type": "activity",
            "block": {
                "id": call.id,
                "kind": "tool",
                "callId": call.id,
                "name": name,
                "detail": _describe(name, args),
                "status": status,
            },
        }

    # Original call order: accepted refusals already in results in encounter order.
    # Rebuild in original `calls` order.
    by_id = {call.id: result for call, result in results}
    ordered: list[tuple[ToolCall, ToolResult]] = []
    for call in calls:
        if call.id in by_id:
            ordered.append((call, by_id[call.id]))

    added = False
    for call, result in ordered:
        numbered = tools.assign_citations(ctx, result.passages)
        if numbered:
            added = True
        text = tools.limit_tool_result(tools.render_result(result, numbered))
        result.text_parts = [text]
        messages.append({"role": "tool", "tool_call_id": call.id, "content": text})

    if added and ctx.citations:
        yield events.citations([p.as_citation() for p in ctx.citations], 0)


def _limit_for(
    call: ToolCall,
    budget: TurnBudget,
    accepted_here: int,
    *,
    search_used: bool = False,
) -> str | None:
    if call.name == "search_workspace" and search_used:
        return (
            "This response already used search_workspace. Use those passages, "
            "or search again in the next step."
        )
    if accepted_here >= TOOLS_PER_RESPONSE:
        return (
            f"This response already used its {TOOLS_PER_RESPONSE} tool-call limit. "
            "Answer from the results you have."
        )
    if budget.tool_calls_turn >= TOOLS_PER_TURN:
        return (
            f"This turn already used its {TOOLS_PER_TURN} tool-call limit. "
            "Answer from the results you have."
        )
    return None
