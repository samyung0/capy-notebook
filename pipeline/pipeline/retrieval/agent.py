"""The chat agent: a capped tool loop over the workspace index.

One user send is one turn. Each streamed model response is either narration
(if it also calls tools) or the persisted answer (first completed response
with text and no tools). The answer is a structured JSON list of claims that
name their passages (``structured.py``); the agent renders the prose itself,
renumbering citations 1..k in order of first appearance, and streams that prose
claim by claim. One repair call rewrites a plain-prose answer as JSON; if that
fails too, the raw text is the answer with no citations.
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any

from .. import elitellm, obs, registry
from ..config import cfg
from ..prompts import chat as chat_prompts
from ..prompts import curate as curate_prompts
from . import (
    accounting,
    capture,
    citation_regions,
    compact,
    events,
    evidence,
    library,
    models,
    pending,
    store,
    tools,
)
from .chunking import estimate_tokens
from .limits import (
    CURATE_MIN_CONTEXT_WINDOW_TOKENS,
    CURATE_STALL_RESPONSES,
    CURATE_WRITE_ERROR_GRACE,
    CURATE_WRITE_ERROR_GRACE_MAX,
    KNOWLEDGE_TOOLS_PER_RESPONSE,
    MAX_CONCURRENT,
    PLANNING_RESPONSES,
    STOP_ANSWER,
    STOP_CLIENT_GONE,
    STOP_CURATE_STALL,
    STOP_ERROR,
    STOP_PLANNING_CAP,
    STOP_TURN_FAILED,
    TOOLS_PER_RESPONSE,
    TOOLS_PER_TURN,
    TurnBudget,
)

# The curate write tools: an errored call is an attempt at progress.
WRITE_TOOLS = frozenset({"create_material", "edit_document"})
from .stream import AssembledResponse, StreamEvent, ToolCall
from .structured import (
    JSON_OBJECT,
    PlainRenderer,
    StreamRenderer,
    parse_structured,
    render_structured,
)
from .tools import ToolContext, ToolResult, TurnFailed

log = logging.getLogger("capy.retrieval.agent")


def _parse_args(raw: str | None) -> dict[str, Any]:
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _describe(name: str, args: dict[str, Any]) -> str:
    if name in ("search_workspace", "search_knowledge"):
        return str(args.get("query") or "")
    if name == "browse_knowledge":
        return str(args.get("topic") or "")
    if name == "read_knowledge":
        return str(args.get("excerpt_id") or "")
    if name == "create_ledger":
        return f"{len(args.get('todos') or [])} todos"
    if name == "capture_knowledge_page":
        return f"{args.get('excerpt_id') or ''} page {args.get('page')}"
    if name == "list_sources":
        return "listing sources"
    if name == "describe_documents":
        ids = args.get("file_ids") or []
        return ", ".join(str(i) for i in ids[:8])
    if name == "read_document":
        return str(args.get("file_id") or "")
    if name == "capture_page":
        page = args.get("page")
        bbox = args.get("bbox")
        detail = f"page {page}" if page is not None else ""
        if isinstance(bbox, list) and len(bbox) == 4:
            detail += " region " + ",".join(str(int(v)) for v in bbox)
        return detail
    if name == "create_material":
        return str(args.get("kind") or "")
    if name in ("trash_file", "restore_file", "inspect_document", "edit_document"):
        target = args.get("target") or {}
        return str(target.get("id") or "") if isinstance(target, dict) else ""
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


def _with_usage(event: dict[str, Any]) -> dict[str, Any]:
    usage = obs.current_usage()
    if usage is not None and not usage.is_empty():
        event["usage"] = usage.as_dict()
        event["tokenCount"] = usage.input_tokens + usage.output_tokens
    return event


def _client_error(exc: BaseException) -> dict[str, Any]:
    return _with_usage(
        obs.reported_event(events.error(CLIENT_ERROR, CLIENT_ERROR_CODE), exc)
    )


def _busy_error(exc: elitellm.ProviderBusy) -> dict[str, Any]:
    event = events.error(models.BUSY_ERROR, models.BUSY_ERROR_CODE)
    event["retryAfterSeconds"] = models.busy_retry_after_s(exc)
    return _with_usage(event)


async def _admit_checkpoint(
    *,
    messages: list[dict[str, Any]],
    history: list[dict[str, Any]],
    checkpoint: dict[str, Any] | None,
    spec: models.ModelConfig,
    schemas: list[dict[str, Any]],
    budget: TurnBudget,
    query_msg: dict[str, Any],
    extra: int = 0,
) -> tuple[list[dict[str, Any]], dict[str, Any] | None]:
    if not compact.needs_compact(messages, spec, schemas=schemas, extra=extra):
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
    rebuilt = [messages[0], chat_prompts.memory_message(folded), query_msg]
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
    """The turn, plus the one piece of it that outlives the turn.

    However the loop ends — the answer, the stall guard, a failure, a lost
    client — a curate turn's ledger changes go back to the conversation.
    """
    try:
        async for event in _run_turn(
            query=query,
            ctx=ctx,
            history=history,
            model=model,
            locale=locale,
            checkpoint=checkpoint,
            client=client,
        ):
            yield event
    finally:
        await tools.store_ledger(ctx)


async def _run_turn(
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
    cited_order: list[int] = []
    block_n = 0

    if ctx.curate:
        reason = await _curate_unavailable(ctx, spec)
        if reason:
            log.warning("curate turn refused: %s", reason)
            yield _with_usage(
                events.error(
                    "Curate mode is unavailable for this chat.", "model_unavailable"
                )
            )
            return

    if ctx.file_ids is not None:
        active_scope = await tools.resolve_current_scope(ctx)
        if isinstance(active_scope, ToolResult):
            yield _with_usage(events.error(active_scope.text(), "invalid_scope"))
            return

    ctx.pending_sources = await pending.load(ctx.workspace_id, ctx.file_ids)
    prior = await evidence.history_turns(history, ctx)
    messages = chat_prompts.chat_messages(
        locale=locale,
        checkpoint=checkpoint,
        history=prior,
        query=query,
        curate=ctx.curate,
    )
    query_msg = messages[-1]

    schemas = tools.schemas_for(ctx)
    _, pending_reserve, pending_omitted = pending.reserve(
        messages, ctx.pending_sources, spec, schemas
    )
    if ctx.pending_sources.files:
        yield ctx.pending_sources.event(pending_omitted)
    try:
        await ctx.pending_sources.validate()
        messages, replacement = await _admit_checkpoint(
            messages=messages,
            history=prior,
            checkpoint=checkpoint,
            spec=spec,
            schemas=schemas,
            budget=budget,
            query_msg=query_msg,
            extra=pending_reserve,
        )
    except pending.SourceChanged as exc:
        yield _with_usage(events.error(str(exc), exc.code))
        return
    except models.UserKeyError as exc:
        yield _with_usage(dict(exc.as_event()))
        return
    except compact.ContextTooLarge as exc:
        yield _with_usage(events.error(str(exc), "context_too_large"))
        return
    except compact.InvalidSummary as exc:
        log.warning("checkpoint summarizer returned invalid output", exc_info=True)
        yield _with_usage(
            obs.reported_event(
                events.error(
                    "The conversation could not be compacted.", "compaction_failed"
                ),
                exc,
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
    # Curate has no planning ceiling; the stall guard is what ends a turn whose
    # responses stop changing the ledger, and it is its own stop reason.
    stalled = 0
    stall_stop = False
    # Errored writes earn the guard extra responses (limits.CURATE_WRITE_ERROR_GRACE).
    write_errors = 0

    while ctx.curate or step < planning_cap or terminal_pending:
        if _client_gone(client):
            budget.stop_reason = STOP_CLIENT_GONE
            return
        terminal_call = terminal_pending
        terminal_pending = False
        if ctx.curate:
            stall_limit = CURATE_STALL_RESPONSES + CURATE_WRITE_ERROR_GRACE * min(
                write_errors, CURATE_WRITE_ERROR_GRACE_MAX
            )
            tools_off = terminal_call or stalled >= stall_limit
            if tools_off and not terminal_call:
                stall_stop = True
                log.warning(
                    "curate stall guard: %d responses completed no todo "
                    "(limit %d after %d errored writes); %d of %d ledger todos done",
                    stalled,
                    stall_limit,
                    write_errors,
                    sum(1 for todo in ctx.ledger.todos if todo.done),
                    len(ctx.ledger.todos),
                )
        else:
            tools_off = terminal_call or step == planning_cap - 1
        active_schemas = None if tools_off else schemas

        yield events.phase("planning")
        try:

            def _count() -> None:
                budget.completion_calls += 1
                budget.compaction_calls += 1

            # Captures ride outside ``messages``; the budget still has to hold the
            # ones whose exchange is still live. ponytail: the post-fold fit check
            # inside compact_messages reuses this count, so the step that folds an
            # exchange over-counts its captures once; recompute inside compaction
            # if a turn ever fails on that margin.
            image_tokens = capture.image_tokens(ctx.captures, messages)
            ledger_message = _ledger_message(ctx, query, final=tools_off)
            ledger_tokens = (
                estimate_tokens(str(ledger_message["content"])) if ledger_message else 0
            )
            outside = image_tokens + ledger_tokens
            pending_message, pending_reserve, omitted = pending.reserve(
                messages, ctx.pending_sources, spec, active_schemas, extra=outside
            )
            if omitted != pending_omitted:
                pending_omitted = omitted
                yield ctx.pending_sources.event(omitted)
            await ctx.pending_sources.validate()
            messages = await compact.compact_messages(
                messages,
                spec,
                schemas=active_schemas,
                protect_live_chain=True,
                on_compact=_count,
                extra=pending_reserve + outside,
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
                    extra=pending_reserve + outside,
                )
            if _client_gone(client):
                budget.stop_reason = STOP_CLIENT_GONE
                return
            request_messages = capture.inject_images(
                _inject_ledger(
                    pending.inject(messages, pending_message), ledger_message
                ),
                ctx.pending_images,
                spec.provider_slug,
            )
            budget.estimated_input_tokens += compact.request_context(
                request_messages, spec, schemas=active_schemas
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
            await ctx.pending_sources.validate()
            stream_task = asyncio.create_task(
                models.stream_agent_response(
                    request_messages,
                    model=spec,
                    tools=None if tools_off else schemas,
                    on_event=_on_event,
                    call_purpose=(
                        accounting.PURPOSE_TERMINAL
                        if terminal_call
                        else accounting.PURPOSE_AGENT
                    ),
                    # With tools offered, json_object made GLM skip the search
                    # and invent an answer; the prompt rule carries the format.
                    # A curate answer is plain prose, so it never asks for JSON.
                    response_format=(
                        None if ctx.curate or not tools_off else JSON_OBJECT
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
            renderer = (
                PlainRenderer()
                if ctx.curate
                else StreamRenderer(lambda: len(ctx.citations))
            )
            # Text is held back until its shape is known: a JSON answer streams
            # as rendered prose from its first brace; plain prose (narration, or
            # an answer that ignored the format) is emitted once the response
            # ends, so the browser never sees text the turn will replace. The
            # [k] markers are renumbered, so the citation list follows them.
            started = False
            sent_order = 0
            try:
                while True:
                    ev = await pending_q.get()
                    if ev is None:
                        break
                    if ev.kind != "text" or not ev.text:
                        continue
                    prose = renderer.push(ev.text)
                    if prose and not _client_gone(client):
                        if not started:
                            yield events.block_start(block_id)
                            started = True
                        if len(renderer.order) > sent_order:
                            sent_order = len(renderer.order)
                            citation_version += 1
                            yield events.citations(
                                _ordered_citations(ctx, renderer.order),
                                citation_version,
                                final=True,
                            )
                        yield events.block_delta(block_id, prose)
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
        except pending.SourceChanged as exc:
            if not _client_gone(client):
                yield _with_usage(events.error(str(exc), exc.code))
            budget.stop_reason = STOP_ERROR
            return
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
        except compact.InvalidSummary as exc:
            log.warning("live compaction returned invalid output", exc_info=True)
            if not _client_gone(client):
                yield _with_usage(
                    obs.reported_event(
                        events.error(
                            "The conversation could not be compacted.",
                            "compaction_failed",
                        ),
                        exc,
                    )
                )
            budget.stop_reason = STOP_ERROR
            return
        except elitellm.ProviderBusy as exc:
            log.warning("agent step: provider busy: %s", exc)
            if not _client_gone(client):
                yield _busy_error(exc)
            budget.stop_reason = STOP_ERROR
            return
        except Exception as exc:
            log.exception("agent step failed")
            event = _client_error(exc)
            if not _client_gone(client):
                yield event
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
        # A tools-off call ends the turn: curate has no planning ceiling, so a
        # call the model emits anyway must not start another round.
        if terminal_call or tools_off:
            calls = []
        if calls:
            tail = renderer.finish()
            narration = renderer.text if renderer.json_shaped else assembled.text
            if narration.strip():
                if not started:
                    yield events.block_start(block_id)
                    started = True
                    yield events.block_delta(block_id, narration)
                elif tail:
                    yield events.block_delta(block_id, tail)
            if started:
                yield events.block_end(block_id, "narration")
                activity.append(
                    {"id": block_id, "kind": "narration", "text": narration}
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
            # Progress is the ledger's first creation or a completed todo;
            # nothing else in a response counts against the stall guard.
            progress_before = ctx.ledger.progress
            write_calls = {c.id for c in calls if c.name in WRITE_TOOLS}
            try:
                async for event in _run_tools(calls, ctx, budget, messages):
                    if event.get("type") == "_tool_message":
                        continue
                    if event.get("type") == "activity":
                        activity.append(event["block"])
                        continue
                    if (
                        event.get("type") == "tool_end"
                        and event.get("callId") in write_calls
                        and event.get("outcome") != "succeeded"
                    ):
                        write_errors += 1
                    yield event
            except pending.SourceChanged as exc:
                yield _with_usage(events.error(str(exc), exc.code))
                budget.stop_reason = STOP_ERROR
                return
            except TurnFailed as exc:
                yield _client_error(exc)
                budget.stop_reason = STOP_TURN_FAILED
                return
            stalled = 0 if ctx.ledger.progress > progress_before else stalled + 1
            if exhausted and state and state.terminal_call_allowed:
                terminal_pending = True
            continue

        if text:
            if not started:
                yield events.phase("answering")
            if not renderer.raw:
                # No deltas reached us (a non-streaming adapter); render whole.
                renderer.push(assembled.text)
            tail = renderer.finish()
            if renderer.json_shaped and renderer.text and not renderer.invalid:
                # Streamed as rendered prose; a JSON that did not close keeps
                # the prose shown so far rather than a second answer. A closed
                # object with an invalid shape is repaired below.
                if not renderer.complete:
                    log.warning(
                        "structured answer did not parse; keeping streamed prose"
                    )
                if not started:
                    yield events.block_start(block_id)
                    started = True
                    yield events.block_delta(block_id, renderer.text)
                elif tail:
                    yield events.block_delta(block_id, tail)
                answer, cited_order = renderer.text, list(renderer.order)
            else:
                if renderer.invalid:
                    log.warning("structured answer had an invalid shape; repairing")
                answer, cited_order = await _repair_answer(
                    request_messages, assembled.text, ctx, spec, budget
                )
                sent_order = 0
                # A repeated block_start resets whatever prose was streamed
                # before the bad entry arrived; the repaired text replaces it.
                yield events.block_start(block_id)
                started = True
                yield events.block_delta(block_id, answer)
            yield events.block_end(block_id, "answer")
            if ctx.curate:
                # No citations in curate mode: the attribution the user sees is
                # the provenance footer on each created material. An answer the
                # stall guard forced still reports the guard.
                budget.stop_reason = STOP_CURATE_STALL if stall_stop else STOP_ANSWER
                break
            final_citations = await citation_regions.refine(
                ctx.workspace_id,
                [
                    ctx.citations[n - 1]
                    for n in cited_order
                    if 1 <= n <= len(ctx.citations)
                ],
            )
            if not (
                0 < sent_order == len(cited_order)
            ) or final_citations != _ordered_citations(ctx, cited_order):
                citation_version += 1
                yield events.citations(final_citations, citation_version, final=True)
            budget.stop_reason = STOP_ANSWER
            break
        # No text and no tool calls. In curate that is one wasted response, not
        # the end of the turn: it completes no todo, so it counts against the
        # stall guard and the loop asks again. Once tools are already off there
        # is nothing left to ask for. Only the stall guard reports itself: a
        # silent terminal call is a billing cutoff, and it reports what the same
        # call reports outside curate.
        if ctx.curate and not tools_off:
            stalled += 1
            continue
        budget.stop_reason = budget.stop_reason or (
            STOP_CURATE_STALL if stall_stop else STOP_PLANNING_CAP
        )
        break

    if not budget.stop_reason:
        # Only a non-curate turn can leave the loop: curate has no ceiling.
        budget.stop_reason = STOP_PLANNING_CAP

    await _record_searches(ctx, cited_order)
    done: dict[str, Any] = events.done(
        None,
        0,
        budget.as_dict(),
        activity,
        answer,
    )
    done["toolEvidence"] = evidence.pack(ctx, cited_order)
    usage = obs.current_usage()
    if usage is not None and not usage.is_empty():
        done["usage"] = usage.as_dict()
        done["tokenCount"] = usage.input_tokens + usage.output_tokens
    yield done


async def _curate_unavailable(ctx: ToolContext, spec: models.ModelConfig) -> str:
    """Why this turn cannot run in curate mode, or empty when it can.

    The subject list read is the check: a library that is configured but down
    has to become a typed ``model_unavailable`` here rather than a generic
    ``agent_failed`` from the first tool call.
    """
    if not library.enabled():
        return "the knowledge library is not configured"
    window = registry.context_window(spec)
    if window < CURATE_MIN_CONTEXT_WINDOW_TOKENS:
        return (
            f"{spec.provider_slug}/{spec.model_slug} has a {window}-token window, "
            f"below the {CURATE_MIN_CONTEXT_WINDOW_TOKENS} curate mode needs"
        )
    try:
        await tools.load_library_catalog(ctx)
    except Exception as exc:  # noqa: BLE001 - any failure to reach the library
        return f"the knowledge library did not answer: {exc}"
    if not ctx.library_catalog:
        # No subject holds an excerpt, so nothing is published: every knowledge
        # call would come back empty or refused, which is not a workload the
        # turn should spend its stall budget discovering.
        return "the knowledge library has no published subjects"
    return ""


def _ledger_message(
    ctx: ToolContext, query: str, *, final: bool = False
) -> dict[str, Any] | None:
    if not ctx.curate:
        return None
    return curate_prompts.ledger_message(query, ctx.ledger, final=final)


def _inject_ledger(
    messages: list[dict[str, Any]], message: dict[str, Any] | None
) -> list[dict[str, Any]]:
    """Place the ledger right after the query, outside the message list."""
    if message is None:
        return messages
    index = compact._current_query_index(messages)
    return [*messages[: index + 1], message, *messages[index + 1 :]]


def _ordered_citations(ctx: ToolContext, order: list[int]) -> list[dict[str, Any]]:
    """The answer's citation list: used passages only, in [k] order."""
    return [
        ctx.citations[n - 1].as_citation()
        for n in order
        if 1 <= n <= len(ctx.citations)
    ]


async def _repair_answer(
    request_messages: list[dict[str, Any]],
    raw: str,
    ctx: ToolContext,
    spec: models.ModelConfig,
    budget: TurnBudget,
) -> tuple[str, list[int]]:
    """One tools-off JSON call that rewrites a plain-prose answer as claims.

    The original prose was never streamed, so whichever text comes back here
    is the one the browser sees. A second failure keeps the raw text with no
    citations; the failure is logged with that text.
    """
    repair = [
        *request_messages,
        {"role": "assistant", "content": raw},
        {"role": "user", "content": chat_prompts.REPAIR_PROMPT},
    ]
    budget.completion_calls += 1
    try:
        assembled = await models.stream_agent_response(
            repair, model=spec, tools=None, response_format=JSON_OBJECT
        )
    except Exception:
        log.warning("structured answer repair call failed", exc_info=True)
        return raw, []
    budget.reported_input_tokens += assembled.usage.input_tokens
    budget.cached_read_tokens += assembled.usage.cached_read_tokens
    budget.cache_write_tokens += assembled.usage.cache_write_tokens
    budget.reasoning_tokens += assembled.usage.reasoning_tokens
    items = parse_structured(assembled.text)
    if items is None:
        log.warning(
            "structured answer repair did not parse; keeping raw prose: %r",
            assembled.text[:2000],
        )
        return raw, []
    return render_structured(items, len(ctx.citations))


async def _record_searches(ctx: ToolContext, cited_order: list[int]) -> None:
    """Write the turn's search events with the hits the answer cited.

    Only turns that reach ``done`` are recorded; a turn that errors out or
    loses its client has no answer to attribute and is visible in the logs.
    Telemetry never fails the turn.
    """
    if not ctx.search_events:
        return
    cited_chunks = {
        ctx.citations[n - 1].chunk_id
        for n in cited_order
        if 1 <= n <= len(ctx.citations)
    }
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


def _activity(
    call: ToolCall,
    name: str,
    args: dict[str, Any],
    result: ToolResult,
    ctx: ToolContext | None = None,
) -> dict[str, Any]:
    block: dict[str, Any] = {
        "id": call.id,
        "kind": "tool",
        "callId": call.id,
        "name": name,
        "detail": _describe(name, args),
        "outcome": result.outcome,
    }
    error = result.error_payload()
    if error:
        block["error"] = error
    if result.effects:
        block["effects"] = list(result.effects)
    if ctx is not None and name in ("capture_page", "capture_knowledge_page"):
        # "Looked at page 4": the frontend row; the image itself is not kept.
        for record in ctx.captures:
            if record["callId"] == call.id:
                block["capture"] = {k: record[k] for k in ("page", "bbox", "bytes")}
                break
    return block


def _tool_end(call: ToolCall, result: ToolResult) -> dict[str, Any]:
    return events.tool_end(
        call.id,
        result.outcome,
        error=result.error_payload(),
        effects=result.effects or None,
    )


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
            curate=ctx.curate,
        )
        if limit_text:
            result = tools._refused(limit_text, code="limit_reached")
            results.append((call, result))
            yield events.tool_start(call.id, call.name, _describe(call.name, args))
            yield _tool_end(call, result)
            yield {
                "type": "activity",
                "block": _activity(call, call.name, args, result),
            }
            continue
        accepted.append((call, args, call.name))
        budget.note_tool(call.name)

    work = [(call, args, name) for call, args, name in accepted]
    executed: dict[str, ToolResult] = {}
    by_call = {call.id: (call, args, name) for call, args, name in work}

    def _finish(call_id: str, result: ToolResult) -> list[dict[str, Any]]:
        call, args, name = by_call[call_id]
        executed[call_id] = result
        results.append((call, result))
        return [
            _tool_end(call, result),
            {"type": "activity", "block": _activity(call, name, args, result, ctx)},
        ]

    if work:
        mutating = any(tools.mutates(name) for _, _, name in work)
        if mutating:
            # A mutation keeps the whole response serial, so a create/edit/trash
            # never races a read of the same resource inside one response.
            for call, args, name in work:
                yield events.tool_start(call.id, name, _describe(name, args))
                for event in _finish(call.id, await tools.run(name, args, ctx)):
                    yield event
            budget.peak_parallel_tools = max(budget.peak_parallel_tools, 1)
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
            # Each read reports completion as it finishes rather than waiting for
            # the slowest sibling; the model still sees results in call order.
            for finished in asyncio.as_completed(
                [_one(call, args, name) for call, args, name in work]
            ):
                call_id, result = await finished
                for event in _finish(call_id, result):
                    yield event

    # Original call order: accepted refusals already in results in encounter order.
    # Rebuild in original `calls` order.
    by_id = {call.id: result for call, result in results}
    ordered: list[tuple[ToolCall, ToolResult]] = []
    for call in calls:
        if call.id in by_id:
            ordered.append((call, by_id[call.id]))

    # Retrieved-but-unused passages never reach the browser: the citation
    # list is sent with the answer, renumbered, as its markers appear.
    for call, result in ordered:
        numbered = tools.assign_citations(ctx, result.passages)
        text = tools.limit_tool_result(tools.render_result(result, numbered))
        definition = tools.contract.definition(call.name)
        if definition and definition["retention"] in ("full", "cited_passages"):
            ctx.evidence_passage_ids.update(p.chunk_id for p in result.passages)
        if definition and definition["retention"] == "full":
            ctx.evidence_notes.append(
                {
                    "name": call.name,
                    "detail": _describe(call.name, _parse_args(call.arguments))[:240],
                    "outcome": result.outcome,
                    "text": text,
                }
            )
        result.text_parts = [text]
        messages.append({"role": "tool", "tool_call_id": call.id, "content": text})


def _limit_for(
    call: ToolCall,
    budget: TurnBudget,
    accepted_here: int,
    *,
    search_used: bool = False,
    curate: bool = False,
) -> str | None:
    if call.name == "search_workspace" and search_used:
        return (
            "This response already used search_workspace. Use those passages, "
            "or search again in the next step."
        )
    if curate:
        # No per-turn count in curate mode: a whole set of materials is one turn.
        if accepted_here >= KNOWLEDGE_TOOLS_PER_RESPONSE:
            return (
                f"This response already used its {KNOWLEDGE_TOOLS_PER_RESPONSE} "
                "tool-call limit. Continue in the next step."
            )
        return None
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
