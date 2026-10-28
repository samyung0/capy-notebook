"""The chat agent: a capped tool loop over the workspace index.

One user send is one turn. Each streamed model response is either narration
(if it also calls tools) or the persisted answer (first completed response
with text and no tools). The answer is an OpenUI Lang program whose blocks
name their passages (``openui.py``); the program streams through as written
and the citation list follows it, each entry carrying the passage number the
program cites so the browser numbers the markers 1..k in reading order. Local
parser recovery keeps usable partial answers and Markdown stays readable;
unusable output shows an error without another model request.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import shutil
from collections.abc import AsyncIterator
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime
from typing import Any

from .. import elitellm, obs, registry
from ..config import cfg
from ..prompts import chat as chat_prompts
from . import (
    accounting,
    capture,
    citation_regions,
    compact,
    events,
    evidence,
    library,
    models,
    openui,
    pending,
    pending_hints,
    profiles,
    scripted,
    skills,
    store,
    tools,
    turn_context,
)
from .chunking import estimate_tokens
from .limits import (
    BUILD_TOOLS_PER_TURN,
    CHAT_SLOT_WAIT_S,
    MAX_CONCURRENT,
    PLANNING_RESPONSES,
    STALL_RESPONSES,
    STOP_ANSWER,
    STOP_CLIENT_GONE,
    STOP_ERROR,
    STOP_PLANNING_CAP,
    STOP_STALL,
    STOP_TOOL_CAP,
    STOP_TURN_FAILED,
    TOOLS_PER_RESPONSE,
    WRITE_ERROR_GRACE,
    WRITE_ERROR_GRACE_MAX,
    CallSlotPolicy,
    TurnBudget,
    bind_call_slots,
    reset_call_slots,
)

# The write tools. The turn's first successful one starts the build budget,
# each successful one is stall-guard progress, and an errored one is an
# attempt at progress.
WRITE_TOOLS = frozenset(
    {
        "create_material",
        "create_workspace",
        "add_questions",
        "add_question_media",
        "edit_document",
        "create_deck",
        "write_slide",
        "edit_office_document",
    }
)
from .openui import LangRenderer
from .response_guard import (
    FLAGGED_CODE,
    FLAGGED_MESSAGE,
    ResponseGuard,
    contains_arg_markup,
    contains_tool_protocol,
)
from .search import Passage
from .stream import AssembledResponse, StreamEvent, ToolCall
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


# Tools whose rows name a workspace resource, and where its id sits.
_TARGET_TOOLS = ("trash_file", "restore_file", "inspect_document", "edit_document")
_FILE_TOOLS = ("read_document", "inspect_office_document", "edit_office_document")


def _target_id(name: str, args: dict[str, Any]) -> str:
    if name in _TARGET_TOOLS:
        target = args.get("target")
        return str(target.get("id") or "") if isinstance(target, dict) else ""
    if name in _FILE_TOOLS:
        return str(args.get("file_id") or "")
    if name in ("add_questions", "add_question_media"):
        return str(args.get("quiz_id") or "")
    return ""


def _excerpt_id(name: str, args: dict[str, Any]) -> str:
    if name in ("read_knowledge", "capture_knowledge_page"):
        return str(args.get("excerpt_id") or "")
    return ""


async def _resolve_labels(ctx: ToolContext, calls: list[ToolCall]) -> None:
    """Names for the targets of this response's calls that the turn has not
    shown yet: one lookup per store for the whole response, none when every
    target is known. A failed lookup leaves the row with the id."""
    opened = ctx.open_resource
    if opened.get("id") and opened.get("title"):
        ctx.labels.setdefault(opened["id"], opened["title"])
    resources: list[str] = []
    excerpts: list[str] = []
    for call in calls:
        args = _parse_args(call.arguments)
        for wanted, found in (
            (resources, _target_id(call.name, args)),
            (excerpts, _excerpt_id(call.name, args)),
        ):
            if found and found not in ctx.labels and found not in wanted:
                wanted.append(found)
    try:
        # An account turn's names come from its listing and reads.
        if resources and not ctx.account:
            ctx.labels.update(await store.resource_titles(ctx.workspace_id, resources))
        if excerpts and library.enabled():
            ctx.labels.update(await library.excerpt_labels(excerpts))
    except Exception:
        log.warning("tool row labels unavailable", exc_info=True)


def _describe(name: str, args: dict[str, Any], ctx: ToolContext | None = None) -> str:
    """The tool row's detail: what the call is about, in words the learner
    reads (a title, a query, a page), at most 240 characters."""
    labels = ctx.labels if ctx is not None else {}

    def named(found: str) -> str:
        return labels.get(found, found)

    if name in (
        "search_workspace",
        "search_files_summary",
        "search_files_content",
        "search_knowledge",
        "search_web",
    ):
        detail = str(args.get("query") or "")
    elif name == "read_knowledge":
        detail = named(_excerpt_id(name, args))
    elif name == "read_skill":
        detail = str(args.get("name") or "")
    elif name in ("capture_page", "capture_knowledge_page"):
        page = args.get("page")
        detail = f"page {page}" if page is not None else ""
    elif name == "list_sources":
        detail = "listing sources"
    elif name == "list_workspaces":
        detail = "listing workspaces"
    elif name == "create_workspace":
        detail = str(args.get("name") or "") or "New Workspace"
    elif name in ("create_material", "create_deck"):
        detail = str(args.get("title") or "")
    elif name in ("add_questions", "add_question_media"):
        detail = str(args.get("title") or "") or named(_target_id(name, args))
    elif name == "write_slide":
        detail = f"slide {args.get('slide')}"
    elif name == "edit_office_document" and not args.get("file_id"):
        # A create names the new file by its title; malformed commands name
        # nothing (the model's arguments are unchecked here).
        commands = args.get("commands")
        first = commands[0] if isinstance(commands, list) and commands else {}
        detail = str(first.get("title") or "") if isinstance(first, dict) else ""
    else:
        detail = named(_target_id(name, args))
    return detail[:240]


CLIENT_ERROR = "The chat agent hit an internal error."
CLIENT_ERROR_CODE = "agent_failed"


@dataclass
class ClientDrop:
    """Set when the Go hop is gone (``dropped``) or the user pressed Stop
    (``stopped``, Epo 2026-10-21). Either way the calls already running finish
    and settle, and the loop starts no other model or tool call. Only a dropped
    hop stops the stream: a stopped turn still sends Go what its running calls
    did. ``left`` is set by either, so a call waiting for its slot gives up its
    place at once and no other call starts, the summarizer's included
    (``models.call_slot``, Q359).
    """

    dropped: bool = False
    stopped: bool = False
    left: asyncio.Event = field(default_factory=asyncio.Event, repr=False)

    def mark(self) -> None:
        self.dropped = True
        self.left.set()

    def stop(self) -> None:
        self.stopped = True
        self.left.set()


def _client_gone(client: ClientDrop | None) -> bool:
    return bool(client and (client.dropped or client.stopped))


class _SlotWaits:
    """Where a turn's model call that waits for a call slot says so: the queue
    the turn drains at that moment, as the waiting status on each wait (Epo
    2026-10-24, inner-turn slots), and the phase from before the wait the
    moment the call gets its slot (Q359). A chat's model calls (the
    checkpoint, a compaction, a response) all run in the planning phase."""

    def __init__(self) -> None:
        self.queue: asyncio.Queue[Any] | None = None

    def report(self) -> None:
        self._put(events.phase("waiting_capacity"))

    def granted(self) -> None:
        self._put(events.phase("planning"))

    def _put(self, event: dict[str, Any]) -> None:
        if self.queue is not None:
            self.queue.put_nowait(event)


async def _while_waiting(
    task: asyncio.Future[Any], waits: _SlotWaits, client: ClientDrop | None
) -> AsyncIterator[dict[str, Any]]:
    """Await ``task``, a step whose model calls run outside the response
    stream (a checkpoint or compaction summary), passing on each slot wait it
    reports until the client leaves (Q359), as the response stream does.
    Leaving early cancels the step, as awaiting it directly would."""
    queue: asyncio.Queue[Any] = asyncio.Queue()
    waits.queue = queue
    try:
        while not task.done():
            getter = asyncio.ensure_future(queue.get())
            try:
                await asyncio.wait({task, getter}, return_when=asyncio.FIRST_COMPLETED)
            finally:
                getter.cancel()
            if getter.done() and not getter.cancelled() and not _client_gone(client):
                yield getter.result()
    except BaseException:
        task.cancel()
        raise
    finally:
        waits.queue = None


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


def busy_error(exc: elitellm.ProviderBusy) -> dict[str, Any]:
    """The in-stream provider_busy error: a busy model call, or a chat that
    waited past its budget for a turn slot (service.py) or a call slot
    (``models.call_slot``)."""
    event = events.error(models.BUSY_ERROR, models.BUSY_ERROR_CODE)
    event["retryAfterSeconds"] = models.busy_retry_after_s(exc)
    return _with_usage(event)


def _flagged_error() -> dict[str, Any]:
    return _with_usage(events.error(FLAGGED_MESSAGE, FLAGGED_CODE))


def with_turn_state(event: dict[str, Any], ctx: ToolContext) -> dict[str, Any]:
    """An event that ends the turn without an answer carries the turn so far:
    its activity and its evidence (Epo 2026-10-21), with the passages the
    answer cited before it ended (Epo 2026-10-22)."""
    event["activity"] = ctx.activity
    event["toolEvidence"] = evidence.pack(ctx, ctx.cited_shown)
    return event


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
    # The query and what follows it (its hint message) stay as they are, the
    # query with its mode note, since the folded history held the last one.
    after = messages[compact._current_query_index(messages) + 1 :]
    rebuilt = [
        messages[0],
        chat_prompts.memory_message(folded),
        chat_prompts.with_mode_note(query_msg),
        *after,
    ]
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
    script: scripted.Script | None = None,
) -> AsyncIterator[dict[str, Any]]:
    """The turn, plus the one piece of it that outlives the turn.

    However the loop ends — the answer, the stall guard, a failure, a lost
    client — its deck working directory goes away. Every error event carries
    the turn so far, and a turn without an answer still records its searches.
    ``script`` is UAT's scripted turn (``scripted.py``): its steps stand in
    for the model.
    """
    ended = False
    # Each model call of the turn takes a call slot, waiting up to 60 s in
    # arrival order with the waiting status (Epo 2026-10-24, inner-turn slots).
    waits = _SlotWaits()
    slots = bind_call_slots(
        CallSlotPolicy(
            CHAT_SLOT_WAIT_S,
            on_wait=waits.report,
            left=client.left if client else None,
            on_granted=waits.granted,
        )
    )
    try:
        async for event in _run_turn(
            query=query,
            ctx=ctx,
            history=history,
            model=model,
            locale=locale,
            checkpoint=checkpoint,
            client=client,
            script=script,
            waits=waits,
        ):
            if event["type"] in ("done", "error"):
                for frame in close_cut_edits(ctx):
                    yield frame
            if event["type"] == "error":
                with_turn_state(event, ctx)
            ended = ended or event["type"] in ("done", "error")
            yield event
        if client and client.stopped and not ended:
            # Stop: what the calls running at the stop did goes to the stopped
            # turn's record, never back to the model in this turn (Epo 2026-10-21).
            yield _with_usage(
                events.turn_checkpoint(
                    list(ctx.activity),
                    evidence.pack(ctx, ctx.cited_shown),
                    stopped=True,
                )
            )
    finally:
        # Every step runs even if one fails (Q359). Before the await: a
        # cancelled record must not leave the directory. The policy reset
        # comes last: in another context (the generator finalized elsewhere)
        # it raises.
        if ctx.deck_dir:
            shutil.rmtree(ctx.deck_dir, ignore_errors=True)
        try:
            await _record_searches(ctx, [])  # a no-op once the answer recorded them
        finally:
            reset_call_slots(slots)


async def _run_turn(
    *,
    query: str,
    ctx: ToolContext,
    history: list[dict[str, Any]] | None,
    model: models.ModelConfig,
    locale: str | None = None,
    checkpoint: dict[str, Any] | None = None,
    client: ClientDrop | None = None,
    script: scripted.Script | None = None,
    waits: _SlotWaits,
) -> AsyncIterator[dict[str, Any]]:
    budget = TurnBudget()
    ctx.budget = budget
    spec = models._as_spec(model)
    citation_version = 0
    activity = ctx.activity
    answer = ""
    cited_order: list[int] = []
    block_n = 0

    try:
        if elitellm.resolve_thinking(spec) in ("", "instant"):
            raise registry.RegistryError("Chat requires thinking to be enabled.")
    except registry.RegistryError as exc:
        yield _with_usage(events.error(str(exc), "model_unavailable"))
        return

    # Loaded whatever the Workspace only switch says, so the tool list does
    # not change with it. A library that is down or empty leaves its tools off
    # this turn rather than failing it.
    try:
        await tools.load_library_catalog(ctx)
    except Exception:  # any failure to reach the library
        log.warning("knowledge library unavailable for this turn", exc_info=True)
    profile = profiles.of(ctx)
    # An account turn has no workspace chapters, open item or pending
    # sources (Go forwards those for workspace turns only).
    if not ctx.account:
        ctx.chapters, open_chapter = await store.workspace_chapters(
            ctx.workspace_id, ctx.open_resource.get("id")
        )
        if open_chapter:
            ctx.open_resource["chapter_id"] = open_chapter

    if ctx.file_ids is not None and not ctx.account:
        active_scope = await tools.resolve_current_scope(ctx)
        if isinstance(active_scope, ToolResult):
            yield _with_usage(events.error(active_scope.text(), "invalid_scope"))
            return

    # Account chat loads each item's changes when it reads it (Epo 2026-10-28).
    if ctx.account:
        ctx.pending_sources = pending.PendingSources.for_account(ctx.user_id)
    else:
        ctx.pending_sources = await pending.load(ctx.workspace_id, ctx.file_ids)
    # Changes reach the agent only for the documents it reads (Epo 2026-10-20).
    ctx.pending_sources.read_ids = set()
    prior = await evidence.history_turns(history, ctx)
    schemas = profile.schemas(ctx)
    if spec.provider_slug == "zai":
        schemas = [*schemas, ASK_USER_SCHEMA]
    # A viewer is offered no write tool, and told so.
    can_write = any(s["function"]["name"] in WRITE_TOOLS for s in schemas)
    # Account chat lists its workspaces once, with the conversation's first
    # message; list_workspaces gives the current list (Epo 2026-10-28).
    sent_query = query
    if ctx.account and not history and not checkpoint:
        ctx.workspaces_shown = tools.workspaces_text(ctx)
        sent_query = f"{ctx.workspaces_shown}\n\n{query}"
    messages = profile.messages(
        locale=locale,
        checkpoint=checkpoint,
        history=prior,
        query=sent_query,
        workspace_only=ctx.workspace_only,
        mode_shown=evidence.mode_shown(history),
        writes=can_write,
    )
    query_msg = messages[-1]
    # Q221 (Epo 2026-10-24): a first-turn reply that is only an AskUser
    # question goes back to the model once, so the learner gets the answer
    # before the offer; a learner who cannot write is asked for the answer
    # alone. Until it is sent back, a reply streams nothing before a part
    # other than the question shows (_ANSWER_PART).
    send_back_ok = not prior and not (checkpoint or {}).get("summary")
    sent_back = False
    # Unindexed edits matching the user's words, not hinted earlier in the
    # conversation, follow the message as source data (Epo 2026-10-20).
    earlier = {
        hint.key
        for message in prior
        if message.get("_kind") == pending_hints.KIND
        for hint, _ in message["_hints"]
    }
    hint_message = pending_hints.message(
        await pending_hints.for_message(query, ctx.pending_sources, skip=earlier)
    )
    if hint_message is not None:
        messages.append(hint_message)
        ctx.pending_hints = hint_message["_hints"]
    ctx.hinted = earlier | {hint.key for hint, _ in ctx.pending_hints}

    # Pending changes reach the agent in the tool result of a read of their
    # document (pending.PendingSources.for_read); none are sent up front.
    reported_omitted: set[str] = set()
    try:
        await ctx.pending_sources.validate()
        admitted = asyncio.ensure_future(
            _admit_checkpoint(
                messages=messages,
                history=prior,
                checkpoint=checkpoint,
                spec=spec,
                schemas=schemas,
                budget=budget,
                query_msg=query_msg,
            )
        )
        async for waiting in _while_waiting(admitted, waits, client):
            yield waiting
        messages, replacement = admitted.result()
    except pending.SourceChanged as exc:
        yield _with_usage(events.error(str(exc), exc.code))
        return
    except models.CallNotStarted:
        budget.stop_reason = STOP_CLIENT_GONE
        return
    except elitellm.ProviderBusy as exc:
        yield busy_error(exc)
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
    # Once a write lands the turn has no planning ceiling; the stall guard is
    # what ends one whose responses stop landing writes, and it is its own stop
    # reason.
    writes = 0
    stalled = 0
    stall_stop = False
    tool_stop = False
    # Errored writes earn the guard extra responses (limits.WRITE_ERROR_GRACE).
    write_errors = 0
    # A tools-off response that called tools anyway gets one more response.
    refused_off = False

    # The response after a send-back runs even past the planning cap.
    send_back_pending = False

    while (
        writes
        or step < planning_cap
        or terminal_pending
        or refused_off
        or send_back_pending
    ):
        if _client_gone(client):
            budget.stop_reason = STOP_CLIENT_GONE
            return
        send_back_pending = False
        terminal_call = terminal_pending
        terminal_pending = False
        building = writes > 0
        # A turn that can write gets the build wording of the notices: writes
        # are refused until the writing skill is in the request.
        writing = building or skills.EDITING in skills.retained(messages)
        stall_limit = STALL_RESPONSES + WRITE_ERROR_GRACE * min(
            write_errors, WRITE_ERROR_GRACE_MAX
        )
        if building:
            tool_stop = budget.tool_calls_turn >= BUILD_TOOLS_PER_TURN
            tools_off = terminal_call or tool_stop or stalled >= stall_limit
            if tools_off and not terminal_call and not tool_stop:
                stall_stop = True
                log.warning(
                    "stall guard: %d responses landed no write "
                    "(limit %d after %d errored writes); %d writes landed",
                    stalled,
                    stall_limit,
                    write_errors,
                    writes,
                )
        else:
            tools_off = terminal_call or step >= planning_cap - 1
        tools_off = tools_off or refused_off
        # A tools-off call still sends the tools under the default tool_choice;
        # only the turn context says tools are off. Dropping them, or sending
        # tool_choice "none" (Relace then leaves them out of the prompt), changes
        # the start of the request and misses the provider's cache for the whole
        # turn (2026-10-15). The credit guard's terminal call drops them to make
        # room.
        active_schemas = None if terminal_call else schemas

        yield events.phase("planning")
        guard = ResponseGuard()
        try:

            def _count() -> None:
                budget.completion_calls += 1
                budget.compaction_calls += 1

            # Attached images ride outside ``messages`` until the answer, within
            # the turn's image budget (Q349), so the compaction budget holds them.
            tools.keep_images_within_budget(ctx)  # Q349
            image_tokens = capture.image_tokens(ctx.captures, ctx.pending_images)
            ctx.library_evidence.activate(messages, ctx.library_reads)
            allowance = ""
            if building and not tools_off:
                allowance = (
                    f"\nResponses remaining without a successful write: {stall_limit - stalled}. "
                    "Batch needed reads and page captures, then write from the evidence "
                    "already read. Searching does not reset this allowance. "
                    f"Tool calls remaining this turn: {BUILD_TOOLS_PER_TURN - budget.tool_calls_turn}."
                )
            elif not tools_off:
                # The model cannot see the cap otherwise and reads until it is
                # gone; a refused write then has no response left to redo it.
                allowance = (
                    f"\nResponses remaining this turn, this one included: {planning_cap - step}; "
                    "the last has tools off."
                ) + (
                    " Write before then: a successful write lifts this limit."
                    if writing
                    else ""
                )
            context_tokens = estimate_tokens(
                str(
                    turn_context.message(
                        ctx, final=tools_off, allowance=allowance, writing=writing
                    )["content"]
                )
            )
            outside = image_tokens + context_tokens
            if not ctx.pending_sources.omitted_ids <= reported_omitted:
                # A read's changes were too large to pass on: offer Process.
                reported_omitted |= ctx.pending_sources.omitted_ids
                yield ctx.pending_sources.event(True)
            await ctx.pending_sources.validate()
            compacting = asyncio.ensure_future(
                compact.compact_messages(
                    messages,
                    spec,
                    schemas=active_schemas,
                    protect_live_chain=True,
                    on_compact=_count,
                    extra=outside,
                    allow_summary=not terminal_call,
                )
            )
            async for waiting in _while_waiting(compacting, waits, client):
                yield waiting
            messages = compacting.result()
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
                compacting = asyncio.ensure_future(
                    compact.compact_messages(
                        messages,
                        spec,
                        schemas=active_schemas,
                        protect_live_chain=True,
                        allow_summary=False,
                        extra=outside,
                    )
                )
                async for waiting in _while_waiting(compacting, waits, client):
                    yield waiting
                messages = compacting.result()
            if _client_gone(client):
                budget.stop_reason = STOP_CLIENT_GONE
                return
            # Compacted IDs/summaries cannot stand in for retained full reads.
            ctx.library_evidence.activate(messages, ctx.library_reads)
            ctx.skills_read = skills.retained(messages)
            _append_turn_context(
                messages,
                turn_context.message(
                    ctx, final=tools_off, allowance=allowance, writing=writing
                ),
            )
            request_messages = capture.inject_images(
                messages,
                ctx.pending_images,
                spec.provider_slug,
                {c["callId"]: int(c["estimatedImageTokens"]) for c in ctx.captures},
            )
            ctx.images_sent.update(ctx.pending_images)
            budget.estimated_input_tokens += compact.request_context(
                request_messages, spec, schemas=active_schemas
            ).total_tokens
            block_n += 1
            block_id = f"b{block_n}"
            # Stream events, and the waiting status if the call waits for its slot.
            pending_q: asyncio.Queue[Any] = asyncio.Queue()
            waits.queue = pending_q

            def _on_event(ev: StreamEvent, q: asyncio.Queue[Any] = pending_q) -> None:
                q.put_nowait(ev)

            budget.completion_calls += 1
            budget.planning_rounds += 1
            step += 1
            await ctx.pending_sources.validate()
            stream_task = asyncio.create_task(
                # A UAT scripted turn answers from its script, never a provider.
                script.respond(step - 1, _on_event)
                if script is not None
                else models.stream_agent_response(
                    request_messages,
                    model=spec,
                    tools=active_schemas,
                    on_event=_on_event,
                    # A stopped turn starts no retry of this call.
                    stopped=lambda: _client_gone(client),
                    call_purpose=(
                        accounting.PURPOSE_TERMINAL
                        if terminal_call
                        else accounting.PURPOSE_AGENT
                    ),
                )
            )

            async def _finish(
                task: asyncio.Task[AssembledResponse] = stream_task,
                q: asyncio.Queue[Any] = pending_q,
            ) -> AssembledResponse:
                try:
                    return await asyncio.shield(task)
                finally:
                    q.put_nowait(None)

            finisher = asyncio.create_task(_finish())
            renderer = LangRenderer(lambda: len(ctx.citations))
            # Text is held back until its shape is known: a program streams from
            # its first statement; plain prose (narration, or an answer that
            # ignored the format) is emitted once the response ends. The citation list
            # grows as statements complete and is settled in reading order.
            started = False
            sent_citations: list[dict[str, Any]] = []
            # A reply the send-back may return is held until it shows a part
            # other than the question.
            holding = send_back_ok and not sent_back
            held = ""
            try:
                while True:
                    ev = await pending_q.get()
                    if ev is None:
                        break
                    if isinstance(ev, dict):  # the call waits for its slot
                        if not _client_gone(client):
                            yield ev
                        continue
                    if ev.kind != "text" or not ev.text:
                        continue
                    prose = renderer.push(guard.push(ev.text))
                    if holding and prose:
                        held += prose
                        if not _ANSWER_PART.search(renderer.raw):
                            continue
                        prose, held, holding = held, "", False
                    if prose and not _client_gone(client):
                        if not started:
                            yield events.block_start(block_id)
                            started = True
                        if len(renderer.order) > len(sent_citations):
                            sent_citations = _ordered_citations(ctx, renderer.order)
                            ctx.cited_shown = list(renderer.order)
                            citation_version += 1
                            yield events.citations(
                                sent_citations, citation_version, final=True
                            )
                        yield events.block_delta(block_id, prose)
                assembled = await asyncio.shield(finisher)
            except asyncio.CancelledError:
                assembled = await asyncio.shield(finisher)
                raise
            finally:
                waits.queue = None
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
                yield busy_error(exc)
            budget.stop_reason = STOP_ERROR
            return
        except Exception as exc:
            if _client_gone(client):
                # A stop or a lost hop is not a failure of the turn.
                log.info("agent step ended after the client left: %s", exc)
                budget.stop_reason = STOP_CLIENT_GONE
                return
            log.exception("agent step failed")
            yield _flagged_error() if guard.flagged else _client_error(exc)
            budget.stop_reason = STOP_ERROR
            return

        budget.reported_input_tokens += assembled.usage.input_tokens
        budget.cached_read_tokens += assembled.usage.cached_read_tokens
        budget.cache_write_tokens += assembled.usage.cache_write_tokens
        budget.reasoning_tokens += assembled.usage.reasoning_tokens

        if _client_gone(client):
            ctx.evidence_notes.extend(_cancelled(c, ctx) for c in assembled.tool_calls)
            budget.stop_reason = STOP_CLIENT_GONE
            return

        # GLM sometimes writes its AskUser call as text in its own call
        # markup; it is read back as the call it meant.
        text_ask = (
            text_ask_user(assembled.text)
            if spec.provider_slug == "zai" and not renderer.answer_shaped
            else None
        )
        if text_ask is not None:
            prose, ask_call = text_ask
            assembled = replace(
                assembled,
                text=prose,
                tool_calls=[*assembled.tool_calls, ask_call],
                provider_message=(
                    {**assembled.provider_message, "content": prose}
                    if assembled.provider_message
                    else {}
                ),
            )
        leaked = contains_tool_protocol(assembled.text) or (
            not renderer.answer_shaped and contains_arg_markup(assembled.text)
        )
        if (guard.flagged and text_ask is None) or leaked:
            if not tools_off:
                budget.stop_reason = STOP_ERROR
                yield _flagged_error()
                return
            # GLM writes a tool call as text when tools are off. The turn ends
            # as if it had reached its cap: the call text is dropped, the
            # materials already made stay, and prose sent before it is narration.
            log.warning("tools-off response wrote a tool call as text; ending the turn")
            if started:
                yield events.block_end(block_id, "narration")
                activity.append(
                    {"id": block_id, "kind": "narration", "text": renderer.raw}
                )
            budget.stop_reason = (
                STOP_TOOL_CAP
                if tool_stop
                else STOP_STALL
                if stall_stop
                else STOP_PLANNING_CAP
            )
            break

        # Complete a harmless suffix that looked like the start of a marker.
        tail = renderer.push(guard.finish())
        if tail and started:
            yield events.block_delta(block_id, tail)

        calls = assembled.tool_calls
        text = assembled.text.strip()
        asked = (
            None
            if renderer.answer_shaped
            else ask_user_answer(calls, text, len(ctx.citations))
        )
        ask_only = (
            send_back_ok
            and not sent_back
            and not started
            and _ask_only(renderer, text, asked)
        )
        if asked is not None:
            calls, text = [], asked
        state = accounting.current()
        exhausted = bool(state and state.credits_exhausted)
        # A tools-off call ends the turn: once a write has landed there is no
        # planning ceiling, so a call the model emits anyway must not start
        # another round. The first such response is answered without running
        # its calls and asked once more; a second one's calls are dropped.
        refuse = bool(calls) and tools_off and not terminal_call and not refused_off
        if (terminal_call or tools_off) and not refuse:
            calls = []
        if calls:
            tail = renderer.finish()
            narration = renderer.text if renderer.answer_shaped else assembled.text
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
            if not refuse:
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
            if refuse:
                refused_off = True
                messages.extend(
                    {
                        "role": "tool",
                        "tool_call_id": call.id,
                        "content": TOOL_CAP_RESULT if tool_stop else TOOLS_OFF_RESULT,
                    }
                    for call in calls
                )
                continue
            # Progress is a write that landed; nothing else in a response
            # counts against the stall guard.
            writes_before = writes
            write_calls = {c.id for c in calls if c.name in WRITE_TOOLS}
            results_from = len(messages)
            try:
                async for event in _run_tools(
                    calls, ctx, budget, messages, building=building, client=client
                ):
                    if event.get("type") == "_tool_message":
                        continue
                    if event.get("type") == "activity":
                        # Counted by block: a cut Office edit's tool_end
                        # comes in a later batch, or at the turn's end.
                        block = event["block"]
                        activity.append(block)
                        if block["callId"] in write_calls:
                            if block["outcome"] == "succeeded":
                                writes += 1
                            else:
                                write_errors += 1
                        continue
                    yield event
            except pending.SourceChanged as exc:
                yield _with_usage(events.error(str(exc), exc.code))
                budget.stop_reason = STOP_ERROR
                return
            except TurnFailed as exc:
                yield _client_error(exc)
                budget.stop_reason = STOP_TURN_FAILED
                return
            # Go saves the turn so far: a stop, a crash or a lost stream keeps
            # every finished batch (Epo 2026-10-21).
            ctx.skills_read = skills.retained(messages)
            yield events.turn_checkpoint(
                list(activity), evidence.pack(ctx, cited_order)
            )
            stalled = 0 if writes > writes_before else stalled + 1
            # A read of the office_building skill offers the Office tools from
            # the next response on, appended so the rest of the request's
            # prefix stays cached (Epo 2026-10-20).
            if ctx.office_tools and not any(
                s["function"]["name"] in tools.OFFICE_TOOLS for s in schemas
            ):
                schemas = schemas + [
                    s
                    for s in profile.schemas(ctx)
                    if s["function"]["name"] in tools.OFFICE_TOOLS
                ]
            # The next response is the last with tools: say so where the model
            # reads first, under each result (Epo 2026-10-14).
            last_with_tools = (
                stalled
                == STALL_RESPONSES
                + WRITE_ERROR_GRACE * min(write_errors, WRITE_ERROR_GRACE_MAX)
                - 1
                if writes
                else step == planning_cap - 2
            )
            if last_with_tools:
                notice = (
                    STALL_NOTICE
                    if writes
                    else LAST_TOOLS_NOTICE
                    if skills.EDITING in skills.retained(messages)
                    else LAST_ANSWER_NOTICE
                )
                for message in messages[results_from:]:
                    if message.get("role") == "tool" and isinstance(
                        message.get("content"), str
                    ):
                        message["content"] += notice
            if exhausted and state and state.terminal_call_allowed:
                terminal_pending = True
            continue

        if text and ask_only and not terminal_call and not exhausted:
            # Nothing of the reply was shown; the next response answers.
            sent_back = True
            send_back_pending = True
            messages.extend(
                _send_back(assembled, asked, writes=can_write, texts=profile.send_back)
            )
            continue

        if text:
            if not started:
                yield events.phase("answering")
            if asked is not None:
                # The question replaces the held-back prose as a whole program.
                renderer = LangRenderer(lambda: len(ctx.citations))
                renderer.push(asked)
            elif not renderer.raw:
                # No deltas reached us (a non-streaming adapter); render whole.
                renderer.push(assembled.text)
            tail = renderer.finish()
            if renderer.answer_shaped:
                if not started:
                    yield events.block_start(block_id)
                    started = True
                    yield events.block_delta(block_id, renderer.text)
                elif tail:
                    yield events.block_delta(block_id, tail)
                answer, cited_order = renderer.text, renderer.reading_order()
            else:
                # Plain Markdown is already usable. Malformed programs above
                # keep their local parser recovery; neither path calls the model
                # again. A bare Answer([...]) gets its root (openui.with_root).
                answer, cited_order = renderer.raw, renderer.reading_order()
                yield events.block_start(block_id)
                started = True
                yield events.block_delta(block_id, answer)
            yield events.block_end(block_id, "answer")
            cited = [n for n in cited_order if 1 <= n <= len(ctx.citations)]
            final_citations = await citation_regions.refine(
                ctx.workspace_id, [ctx.citations[n - 1] for n in cited]
            )
            # Refinement rebuilds the dicts, so the passage number goes back on.
            for citation, n in zip(final_citations, cited, strict=True):
                citation["n"] = n
            # The final list is sent whenever it differs from the live one, and
            # at least once, so the relay always persists the answer's own list.
            if final_citations != sent_citations or not sent_citations:
                citation_version += 1
                yield events.citations(final_citations, citation_version, final=True)
            # An answer the stall guard or the tool cap forced still reports it.
            budget.stop_reason = (
                STOP_TOOL_CAP
                if tool_stop
                else STOP_STALL
                if stall_stop
                else STOP_ANSWER
            )
            break
        if not building:
            budget.stop_reason = STOP_ERROR
            yield _with_usage(
                events.error("The model returned an empty answer.", "invalid_answer")
            )
            return
        # No text and no tool calls. Once a write has landed that is one wasted
        # response, not the end of the turn: it lands no write, so it counts
        # against the stall guard and the loop asks again. Once tools are
        # already off there is nothing left to ask for. Only the stall guard
        # reports itself: a silent terminal call is a billing cutoff.
        if not tools_off:
            stalled += 1
            continue
        budget.stop_reason = budget.stop_reason or (
            STOP_TOOL_CAP
            if tool_stop
            else STOP_STALL
            if stall_stop
            else STOP_PLANNING_CAP
        )
        break

    if not budget.stop_reason:
        # Only a turn with no write landed leaves the loop at its ceiling.
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


# Under every tool result of the response before a turn's last one with tools
# under the planning cap: a turn that can write is told to write, one that
# cannot to answer.
LAST_TOOLS_NOTICE = (
    "\n\nYour next response is the last one with tools in this turn. Write what "
    "you have now (create or edit the material), or the turn ends without it."
)
LAST_ANSWER_NOTICE = (
    "\n\nYour next response is the last one with tools in this turn. Answer the "
    "learner with what you have found."
)
# The stall guard's turn instead: say why the tools go off (Epo 2026-10-15).
STALL_NOTICE = (
    "\n\nYou must start writing the materials and files now! This turn will "
    "end otherwise."
)
# The result of each call a tools-off response made anyway; nothing ran. Past
# the tool cap the result names the cap (Epo 2026-10-15).
TOOL_CAP_RESULT = (
    "You have exceeded the tool call limit! Any more tool calls will be dropped."
)
TOOLS_OFF_RESULT = (
    "Not run: tools are off for this response. Do not send any tool calls; "
    "answer now as the turn context asks."
)

# The answer component the model sometimes calls as a tool (GLM, 2026-10-14).
ASK_USER = "AskUser"

# GLM is offered AskUser as a real tool: it calls it as one, and DigitalOcean
# drops calls to tools the request does not list (decision 2026-10-21). A call
# still ends the turn on its question (ask_user_answer). The wording follows the
# answer format's AskUser (prompts/openui_lang.txt).
ASK_USER_SCHEMA = {
    "type": "function",
    "function": {
        "name": ASK_USER,
        "description": (
            "Ask the user a question they answer before you continue, shown in "
            "a question panel and answered in their next message; it ends your "
            "turn. Use it only when you must have their input (which document, "
            "which depth, what the material is for), never for simple follow-up "
            "questions, and ask at most three."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "question": {"type": "string"},
                "choices": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Two to five short options, or [] for a free-text answer.",
                },
            },
            "required": ["question", "choices"],
        },
    },
}


# The answer format's limit on questions (prompts/openui_lang.txt).
ASK_USER_MAX = 3


# A statement of an answer part other than the question: a reply holding one
# is not only an AskUser question (Q221).
_ANSWER_PART = re.compile(
    r"^\s*[A-Za-z_]\w*\s*=\s*(?!Answer\b|AskUser\b)[A-Z]\w*\s*\(", re.MULTILINE
)


def _ask_only(renderer: LangRenderer, prose: str, asked: str | None) -> bool:
    """The reply is only AskUser questions: a tool-called AskUser with no
    prose, or a program whose parts are only AskUser components."""
    if asked is not None:
        return not prose
    if not renderer.answer_shaped:
        return False
    try:
        names = {call.name for call in openui.walk(openui.parse(renderer.text))}
    except openui.ParseError:
        return False
    return ASK_USER in names and names <= {"Answer", ASK_USER}


def _send_back(
    assembled: AssembledResponse,
    asked: str | None,
    *,
    writes: bool,
    texts: dict[tuple[bool, bool], str],
) -> list[dict[str, Any]]:
    """The reply as sent, then the send-back: as the result of each AskUser
    call when the model called the tool, else as a user message. A learner who
    cannot write gets the texts that ask for the answer alone. ``texts`` are
    the profile's, by (writes, as a tool result)."""
    assistant = dict(assembled.provider_message)
    assistant.setdefault("role", "assistant")
    assistant.setdefault("content", assembled.text)
    if assembled.output_items:
        assistant["output_items"] = assembled.output_items
    asks = [call for call in assembled.tool_calls if call.name == ASK_USER]
    if asked is None or not asks:
        assistant.pop("tool_calls", None)
        return [assistant, {"role": "user", "content": texts[(writes, False)]}]
    assistant["tool_calls"] = [
        {
            "id": call.id,
            "type": "function",
            "function": {"name": call.name, "arguments": call.arguments},
        }
        for call in asks
    ]
    return [
        assistant,
        *(
            {
                "role": "tool",
                "tool_call_id": call.id,
                "content": texts[(writes, True)],
            }
            for call in asks
        ),
    ]


# GLM's own call markup, which it sometimes writes as text: AskUser, then
# <arg_key>name</arg_key><arg_value>value</arg_value> pairs (2026-10-24).
_TEXT_ASK = re.compile(r"(?:<tool_call>\s*)?AskUser\s*(?=<arg_key>)")
_TEXT_ARG = re.compile(
    r"<arg_key>\s*(\w+)\s*</arg_key>\s*<arg_value>(.*?)"
    r"(?=</arg_value>|<arg_key>|</tool_call>|$)",
    re.DOTALL,
)


def text_ask_user(text: str) -> tuple[str, ToolCall] | None:
    """The prose before an AskUser call written as text, and the call, or
    None when the text holds no such call with a question."""
    match = _TEXT_ASK.search(text)
    if match is None:
        return None
    args = {key: value.strip() for key, value in _TEXT_ARG.findall(text[match.end() :])}
    if not args.get("question"):
        return None
    arguments = {key: args[key] for key in ("question", "choices") if key in args}
    call = ToolCall(
        id="text_ask_user",
        name=ASK_USER,
        arguments=json.dumps(arguments, ensure_ascii=False),
    )
    return text[: match.start()].strip(), call


# Citation markers in prose: [3] or [1, 2].
_MARKERS = re.compile(r"\s*\[(\d+(?:\s*,\s*\d+)*)\]")


def _cited(prose: str, known: int) -> tuple[str, list[int]]:
    """The prose without its citation markers, and the passages they name:
    an Md carries its passages as numbers, not as markers in its text.
    Markers naming no shown passage stay as written."""
    cited: list[int] = []

    def take(match: re.Match[str]) -> str:
        numbers = [int(n) for n in re.findall(r"\d+", match.group(1))]
        if not all(1 <= n <= known for n in numbers):
            return match.group(0)
        cited.extend(n for n in numbers if n not in cited)
        return ""

    return _MARKERS.sub(take, prose).strip(), cited


def ask_user_answer(calls: list[ToolCall], prose: str, known: int) -> str | None:
    """A response that calls AskUser as a tool meant to end the turn on its
    questions: the answer program with its prose and one AskUser component per
    call that carries a question, at most ASK_USER_MAX, or None when none does
    (Epo 2026-10-14). The prose keeps its citations to the ``known`` shown
    passages."""
    asks = []
    for call in calls:
        if call.name != ASK_USER or len(asks) == ASK_USER_MAX:
            continue
        try:
            args = json.loads(call.arguments or "{}")
        except json.JSONDecodeError:
            continue
        question = args.get("question") if isinstance(args, dict) else None
        if not isinstance(question, str) or not question.strip():
            continue
        choices = args.get("choices")
        if isinstance(choices, str):  # sent as JSON text inside the arguments
            try:
                choices = json.loads(choices)
            except json.JSONDecodeError:
                choices = [choices]
        choices = (
            [str(c) for c in choices if str(c).strip()]
            if isinstance(choices, list)
            else []
        )
        asks.append(
            f"AskUser({json.dumps(question.strip(), ensure_ascii=False)}, "
            f"{json.dumps(choices, ensure_ascii=False)})"
        )
    if not asks:
        return None
    names = [f"ask{n}" for n in range(1, len(asks) + 1)]
    lines = [f"{name} = {ask}" for name, ask in zip(names, asks, strict=True)]
    if prose:
        body, cited = _cited(prose, known)
        passages = f", {json.dumps(cited)}" if cited else ""
        names.insert(0, "intro")
        lines.insert(0, f"intro = Md({json.dumps(body, ensure_ascii=False)}{passages})")
    return f"root = Answer([{', '.join(names)}])\n" + "\n".join(lines)


def _append_turn_context(
    messages: list[dict[str, Any]], message: dict[str, Any]
) -> None:
    """Send this call's turn context last and keep it where it was sent.

    Each request then extends the previous one exactly, so all of it is a
    cached prefix: providers reuse any shared prefix (GLM on Z.AI measured
    2026-10-20), and a context that moved or changed in place would leave
    every step after its old place uncached. A context not yet followed by a
    step is replaced.
    """
    if messages and messages[-1].get("_kind") == "turn_context":
        messages[-1] = message
    else:
        messages.append(message)


def _ordered_citations(ctx: ToolContext, order: list[int]) -> list[dict[str, Any]]:
    """The answer's citation list: used passages only, in the order the
    markers are numbered, each carrying the passage number it stands for."""
    return [
        {**ctx.citations[n - 1].as_citation(), "n": n}
        for n in order
        if 1 <= n <= len(ctx.citations)
    ]


async def _record_searches(ctx: ToolContext, cited_order: list[int]) -> None:
    """Write the turn's search events with the hits the answer cited.

    Every turn records its searches once (``run_agent``); one that ends without
    an answer cites none. Telemetry never fails the turn.
    """
    if ctx.searches_recorded or not ctx.search_events:
        return
    ctx.searches_recorded = True
    cited_chunks = {
        ctx.citations[n - 1].chunk_id
        for n in cited_order
        if 1 <= n <= len(ctx.citations)
    }
    for event in ctx.search_events:
        event["cited"] = [chunk_id in cited_chunks for chunk_id in event["chunk_ids"]]
        event["trace_id"] = obs.trace_id()
        event["workspace_id"] = ctx.workspace_id or None  # None: an account turn
        event["actor_user_id"] = ctx.user_id or None
        event["message_id"] = ctx.assistant_message_id
    try:
        await store.record_search_events(ctx.search_events)
    except Exception:
        log.warning("search telemetry write failed", exc_info=True)


def _now() -> str:
    """The server clock as RFC 3339 in UTC, to the millisecond."""
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


@dataclass
class _Run:
    """One call's row as the stream showed it: its detail and when it ran."""

    detail: str
    started_at: str
    ended_at: str = ""


def _activity(
    call: ToolCall,
    name: str,
    run: _Run,
    result: ToolResult,
    ctx: ToolContext | None = None,
) -> dict[str, Any]:
    block: dict[str, Any] = {
        "id": call.id,
        "kind": "tool",
        "callId": call.id,
        "name": name,
        "detail": run.detail,
        "outcome": result.outcome,
        "startedAt": run.started_at,
        "endedAt": run.ended_at,
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


CANCELLED = "Not run: the user stopped the turn before this call started."


def _cancelled(call: ToolCall, ctx: ToolContext) -> dict[str, Any]:
    """The record of a call the Stop kept from starting, whatever its tool: it
    has no result for retention to trim (Epo 2026-10-22)."""
    detail = _describe(call.name, _parse_args(call.arguments), ctx)
    return {
        "name": call.name,
        "detail": detail,
        "outcome": "cancelled",
        "text": CANCELLED,
    }


def _tool_start(call: ToolCall, name: str, run: _Run) -> dict[str, Any]:
    return events.tool_start(call.id, name, run.detail, started_at=run.started_at)


def _tool_end(call: ToolCall, result: ToolResult, run: _Run) -> dict[str, Any]:
    run.ended_at = _now()
    return events.tool_end(
        call.id,
        result.outcome,
        error=result.error_payload(),
        effects=result.effects or None,
        undo_payloads=result.undo_payloads or None,
        ended_at=run.ended_at,
    )


def _office_frames(
    ctx: ToolContext,
    name: str,
    result: ToolResult,
    end: dict[str, Any],
    block: dict[str, Any],
) -> list[dict[str, Any]]:
    """A call's closing frames. An Office edit the engine cut at a per-call
    limit sends tool_progress instead and its row stays in progress, its block
    keeping the counts a turn ending now leaves it with; the turn's next
    landed edit of the same file closes it as done after its own frames (Epo
    2026-10-23, Q171)."""
    if name != "edit_office_document" or not result.effects:
        return [end]
    file_id = str((result.effects[0].get("resource") or {}).get("id") or "")
    earlier = ctx.cut_edits.pop(file_id, None)
    frames = [end]
    if result.progress:
        block["applied"], block["total"] = result.progress
        ctx.cut_edits[file_id] = block
        frames = [events.tool_progress(block["callId"], *result.progress)]
    if earlier:
        del earlier["applied"], earlier["total"]
        frames.append(_closing_end(earlier))
    return frames


def _closing_end(block: dict[str, Any]) -> dict[str, Any]:
    """The tool_end of a cut Office edit, as its block stands."""
    return events.tool_end(
        block["callId"],
        block["outcome"],
        effects=block.get("effects"),
        ended_at=block["endedAt"],
        applied=block.get("applied"),
        total=block.get("total"),
    )


def close_cut_edits(ctx: ToolContext) -> list[dict[str, Any]]:
    """At the turn's end, the Office edits still cut close with their counts:
    the rows show the commands not applied."""
    frames = [_closing_end(block) for block in ctx.cut_edits.values()]
    ctx.cut_edits.clear()
    return frames


async def _run_tools(
    calls: list[ToolCall],
    ctx: ToolContext,
    budget: TurnBudget,
    messages: list[dict[str, Any]],
    *,
    building: bool = False,
    client: ClientDrop | None = None,
) -> AsyncIterator[dict[str, Any]]:
    accepted: list[tuple[ToolCall, dict[str, Any], str]] = []
    results: list[tuple[ToolCall, ToolResult]] = []
    runs: dict[str, _Run] = {}
    notes: dict[str, dict[str, Any]] = {}
    first_note = len(ctx.evidence_notes)
    await _resolve_labels(ctx, calls)

    def _start(call: ToolCall, name: str, args: dict[str, Any]) -> dict[str, Any]:
        runs[call.id] = _Run(_describe(name, args, ctx), _now())
        return _tool_start(call, name, runs[call.id])

    def _keep_evidence(call: ToolCall, result: ToolResult) -> None:
        """A call's evidence is kept as it finishes, so a batch cut short keeps
        its finished calls. Full-retention tools return no passages, so their
        text does not wait for the batch's citation numbers."""
        definition = tools.contract.definition(call.name)
        if not definition:
            return
        if definition["retention"] in ("full", "cited_passages"):
            ctx.evidence_passage_ids.update(p.chunk_id for p in result.passages)
        if definition["retention"] == "full":
            notes[call.id] = {
                "name": call.name,
                "detail": runs[call.id].detail,
                "outcome": result.outcome,
                "text": _result_text(result, []),
            }
            ctx.evidence_notes.append(notes[call.id])

    for call in calls:
        # A `_` key is the pipeline's own (a call id, an account destination):
        # one the model sends is dropped (review r1 S2).
        args = {
            k: v
            for k, v in _parse_args(call.arguments).items()
            if not k.startswith("_")
        }
        args["_tool_call_id"] = call.id
        limit_text = _limit_for(
            call,
            budget,
            len(accepted),
            search_used=any(name in _SEARCH_TOOLS for _, _, name in accepted),
            building=building,
        )
        if limit_text:
            result = tools._refused(limit_text, code="limit_reached")
            results.append((call, result))
            yield _start(call, call.name, args)
            yield _tool_end(call, result, runs[call.id])
            _keep_evidence(call, result)
            yield {
                "type": "activity",
                "block": _activity(call, call.name, runs[call.id], result),
            }
            continue
        accepted.append((call, args, call.name))
        budget.note_tool(call.name)

    work = [(call, args, name) for call, args, name in accepted]
    executed: dict[str, ToolResult] = {}
    by_call = {call.id: (call, args, name) for call, args, name in work}

    def _finish(call_id: str, result: ToolResult) -> list[dict[str, Any]]:
        call, _, name = by_call[call_id]
        executed[call_id] = result
        results.append((call, result))
        run = runs[call_id]
        _keep_evidence(call, result)
        end = _tool_end(call, result, run)
        block = _activity(call, name, run, result, ctx)
        return [
            *_office_frames(ctx, name, result, end, block),
            {"type": "activity", "block": block},
        ]

    if work:
        mutating = any(tools.mutates(name) for _, _, name in work)
        if mutating:
            # A mutation keeps the whole response serial, so a create/edit/trash
            # never races a read of the same resource inside one response.
            for call, args, name in work:
                if _client_gone(client):
                    # After a stop the next call never starts.
                    notes[call.id] = _cancelled(call, ctx)
                    ctx.evidence_notes.append(notes[call.id])
                    continue
                yield _start(call, name, args)
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
                yield _start(call, name, args)
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

    # The batch's notes in call order, as the model reads the results.
    ctx.evidence_notes[first_note:] = [notes[c.id] for c in calls if c.id in notes]
    # Retrieved-but-unused passages never reach the browser: the citation
    # list is sent with the answer, renumbered, as its markers appear.
    for call, result in ordered:
        text = _result_text(result, tools.assign_citations(ctx, result.passages))
        ctx.library_evidence.observe(
            call.name, _parse_args(call.arguments), result, text, ctx.library_reads
        )
        result.text_parts = [text]
        message = {"role": "tool", "tool_call_id": call.id, "content": text}
        if result.tail:
            # A search's unindexed edits are hints: condensing drops them.
            message["_hint_tail"] = result.tail
        messages.append(message)


def _result_text(result: ToolResult, numbered: list[tuple[int, Passage]]) -> str:
    """A result as the model reads it: numbered passages, clipped, then its
    unclipped tail and the read document's pending changes."""
    text = tools.limit_tool_result(
        tools.render_result(result, numbered), tail=result.tail
    )
    if result.pending:
        text += "\n\n" + result.pending
    return text


# One search of the user's files per response, in either scope.
_SEARCH_TOOLS = ("search_workspace", "search_files_content")


def _limit_for(
    call: ToolCall,
    budget: TurnBudget,
    accepted_here: int,
    *,
    search_used: bool = False,
    building: bool = False,
) -> str | None:
    if call.name in _SEARCH_TOOLS and search_used:
        return (
            f"This response already used {call.name}. Use those passages, "
            "or search again in the next step."
        )
    if accepted_here >= TOOLS_PER_RESPONSE:
        return (
            f"This response already used its {TOOLS_PER_RESPONSE} tool-call limit. "
            "Continue in the next step."
        )
    # Before the first write lands the response ceiling bounds the turn.
    if building and budget.tool_calls_turn >= BUILD_TOOLS_PER_TURN:
        return (
            f"This turn already used its {BUILD_TOOLS_PER_TURN} tool-call limit. "
            "Report the materials created and any remaining work."
        )
    return None
