"""Workload limits and telemetry for the chat agent.

These are workload limits, not billing. The credit guard is a billing cutoff
and bounds nothing else. Provider-call, query-embedding, and cumulative
input counts are measurements. The pinned model input budget bounds each call.
"""

from __future__ import annotations

import asyncio
import contextvars
import functools
import json
import logging
import random
import time
from collections import deque
from collections.abc import Awaitable, Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import TypeVar

from ..config import cfg

log = logging.getLogger("capy.limits")

T = TypeVar("T")


class Slots:
    """A process-wide cap on running work, used from the event loop only.
    ``take`` answers at once; ``wait`` queues in arrival order (``join`` then
    ``wait_for``, for a caller that must be in the queue before it does
    anything else). Every successful take or wait is paired with one
    ``release``, which hands the slot straight to the oldest waiter."""

    def __init__(self, size: int) -> None:
        self.size = size
        self.used = 0
        self._waiters: deque[asyncio.Future[None]] = deque()

    def full(self) -> bool:
        return self.used >= self.size or bool(self._waiters)

    def take(self) -> bool:
        if self.full():
            return False
        self.used += 1
        return True

    def join(self) -> asyncio.Future[None]:
        """Queue behind the requests already waiting, from this moment on: a
        slot freed before the caller first awaits is handed to it (Q359)."""
        waiter = asyncio.get_running_loop().create_future()
        self._waiters.append(waiter)
        return waiter

    async def wait(self, budget_s: float) -> bool:
        """Take a slot after the requests already waiting, or False once
        ``budget_s`` runs out."""
        return self.take() or await self.wait_for(self.join(), budget_s)

    async def wait_for(
        self,
        waiter: asyncio.Future[None],
        budget_s: float,
        left: asyncio.Event | None = None,
        on_wait: Callable[[], None] | None = None,
    ) -> bool:
        """Wait in the queue until ``waiter`` is handed a slot: True holding
        it, False once ``budget_s`` runs out or ``left`` is set (the client is
        gone); ``on_wait`` runs first. A request that leaves the queue,
        cancelled or failing included, passes on a slot handed to it as it
        left, so no slot is lost and the next waiter is not skipped (Q340,
        Q359)."""
        gone = asyncio.ensure_future(left.wait()) if left is not None else None
        try:
            if on_wait is not None:
                on_wait()
            async with asyncio.timeout(budget_s):
                await asyncio.wait(
                    {waiter} if gone is None else {waiter, gone},
                    return_when=asyncio.FIRST_COMPLETED,
                )
        except TimeoutError:
            pass
        except BaseException:
            if self._leave(waiter):
                self.release()
            raise
        finally:
            if gone is not None:
                gone.cancel()
        held = self._leave(waiter)
        if held and left is not None and left.is_set():
            self.release()
            return False
        # Handed a slot just as the budget ran out still counts.
        return held

    def _leave(self, waiter: asyncio.Future[None]) -> bool:
        """Take ``waiter`` out of the queue; True when it was handed a slot."""
        if waiter in self._waiters:
            self._waiters.remove(waiter)
        return waiter.done()

    def release(self) -> None:
        if self._waiters:
            self._waiters.popleft().set_result(None)
            return
        self.used -= 1


@dataclass(frozen=True)
class CallSlotPolicy:
    """How a request's model calls take a CALL_SLOTS slot: ``wait_s`` 0
    answers provider_busy at once; ``on_wait`` runs each time a call starts
    waiting and ``on_granted`` when a call that waited gets its slot; once
    ``left`` is set (the client is gone) a call starts nothing, waiting or
    not."""

    wait_s: float
    on_wait: Callable[[], None] | None = None
    left: asyncio.Event | None = None
    on_granted: Callable[[], None] | None = None


_call_slot_policy: contextvars.ContextVar[CallSlotPolicy | None] = (
    contextvars.ContextVar("call_slot_policy", default=None)
)


def bind_call_slots(policy: CallSlotPolicy) -> contextvars.Token:
    """Bind the policy for the model calls of this request; with none bound
    (the ingest worker, a test) a call takes no slot."""
    return _call_slot_policy.set(policy)


def reset_call_slots(token: contextvars.Token) -> None:
    _call_slot_policy.reset(token)


def call_slot_policy() -> CallSlotPolicy | None:
    return _call_slot_policy.get()


@dataclass(eq=False)
class LineWaiter:
    """One call waiting in a gate's line: its call id, its spend session
    (which names its requester), and the seconds of the lease it is granted."""

    id: str
    session: str
    lease_s: int
    turn: asyncio.Future[None] = field(
        default_factory=lambda: asyncio.get_running_loop().create_future()
    )
    # Its row is in the shared line (``Admit``).
    stored: bool = False


# One round of a line's pump: store ``store`` (its new waiters, or all of them
# to keep their rows alive), drop ``gone`` (waiters that left, with any lease
# granted to them as they left) and grant leases to the waiters among
# ``waiting`` whose turn it is, answering their ids.
Admit = Callable[[list[LineWaiter], list[LineWaiter], list[str]], Awaitable[set[str]]]

# A waiting call's row lives this long unless its process renews it, which it
# does every LINE_REFRESH_S, so a dead process's calls leave the line on
# their own; the pump asks for turns every LINE_POLL_S, or at once when a
# call on the gate ends in this process.
LINE_TTL_S = 6
LINE_REFRESH_S = 2.0
LINE_POLL_S = (0.1, 0.3)


class ModelLine:
    """The calls in this process waiting at one capacity gate (Epo
    2026-11-04): every caller of the model, interactive or ingest. The line
    itself is shared across processes in Postgres, which ranks every waiting
    call round-robin by requester (the user, or the ingest job) and hands the
    free leases to the first ones. One pump per line asks for the turns of all
    of this process's calls at once."""

    def __init__(self, admit: Admit) -> None:
        self._admit = admit
        self.waiters: dict[str, LineWaiter] = {}
        self._gone: set[str] = set()
        self._wake = asyncio.Event()
        self._pump: asyncio.Task[None] | None = None
        self._refreshed = 0.0

    @property
    def waiting(self) -> int:
        return len(self.waiters)

    async def wait(
        self, waiter: LineWaiter, budget_s: float, left: asyncio.Event | None
    ) -> bool:
        """Wait for ``waiter``'s turn: True holding its lease (id ``waiter.id``),
        False once ``budget_s`` runs out or ``left`` is set (the client is gone).
        A turn granted just as the budget ran out still counts."""
        self.waiters[waiter.id] = waiter
        self._run()
        gone = asyncio.ensure_future(left.wait()) if left is not None else None
        try:
            await asyncio.wait(
                {waiter.turn} if gone is None else {waiter.turn, gone},
                timeout=max(budget_s, 0),
                return_when=asyncio.FIRST_COMPLETED,
            )
        except BaseException:
            self._leave(waiter)
            raise
        finally:
            if gone is not None:
                gone.cancel()
        if waiter.turn.done() and not (left is not None and left.is_set()):
            return True
        self._leave(waiter)
        return False

    def _leave(self, waiter: LineWaiter) -> None:
        """Out of the line. Its row, and a lease granted to it as it left, go
        in the pump's next round."""
        self.waiters.pop(waiter.id, None)
        self._gone.add(waiter.id)
        self._run()

    def freed(self) -> None:
        """A call on the gate ended here: ask for turns now."""
        self._wake.set()

    def _run(self) -> None:
        self._wake.set()
        if self._pump is None or self._pump.done():
            self._pump = asyncio.ensure_future(self._rounds())

    async def _rounds(self) -> None:
        while self.waiters or self._gone:
            self._wake.clear()
            waiting = list(self.waiters.values())
            refresh = time.monotonic() - self._refreshed >= LINE_REFRESH_S
            store = waiting if refresh else [w for w in waiting if not w.stored]
            gone = list(self._gone)
            self._gone.clear()
            try:
                granted = await self._admit(store, waiting, gone)
            except Exception:
                log.warning("model line round failed", exc_info=True)
                self._gone.update(gone)
                granted = set()
            else:
                for waiter in store:
                    waiter.stored = True
                if refresh:
                    self._refreshed = time.monotonic()
            for call_id in granted:
                waiter = self.waiters.pop(call_id, None)
                if waiter is None:
                    self._gone.add(call_id)  # it left as its lease was granted
                else:
                    waiter.turn.set_result(None)
            if not self.waiters and not self._gone:
                break
            try:
                async with asyncio.timeout(random.uniform(*LINE_POLL_S)):
                    await self._wake.wait()
            except TimeoutError:
                pass


MODEL_LINES: dict[str, ModelLine] = {}


def model_line(key: str, admit: Admit) -> ModelLine:
    """The line at one gate (``provider:model``, or a gate of its own such as
    the audio transcription tasks'); ``admit`` serves it from its first caller
    on."""
    line = MODEL_LINES.get(key)
    if line is None:
        line = MODEL_LINES[key] = ModelLine(admit)
    return line


# The retrieval service is one uvicorn process (Epo 2026-10-24, rate-limit
# audit; openwiki/agentic-retrieval.md "Process capacity"): model calls in
# flight (Q292, inner-turn slots), each taking a slot for its request and
# response and giving it back while its turn runs tools;
CALL_SLOTS = Slots(64)
# chat turns and generate requests in progress, each holding its history and
# captures in memory while it waits or runs tools (up to about 7.4 MiB with 16
# captures): 96 in production's 3 GiB, 48 in UAT's 1.5 GiB (Q338, Q343;
# CAPY_TURN_SLOTS);
TURN_SLOTS = Slots(cfg.turn_slots)
# past either a chat waits up to this long in arrival order, with the waiting
# status (Q268, Q293), and anything else answers provider_busy at once. Every
# interactive call also waits up to this long in its model's line (Epo
# 2026-11-04);
CHAT_SLOT_WAIT_S = 60.0
# and threads for deck scripts, page renders, capture downloads and Office
# picture decodes, so they never hold the default executor every model call's
# admission runs on. Two also bound the memory of side-by-side image decodes
# (a 5-megapixel source up to about 130 MiB; at Pillow's pixel limit up to
# 1.3 GiB for a WebP, 0.1 GiB for a JPEG; capture._decoded).
RENDER_THREADS = 2
_render_pool = ThreadPoolExecutor(RENDER_THREADS, thread_name_prefix="capy-render")


async def render_thread(fn: Callable[..., T], /, *args: object) -> T:
    """``asyncio.to_thread`` on the render pool."""
    call = functools.partial(contextvars.copy_context().run, fn, *args)
    return await asyncio.get_running_loop().run_in_executor(_render_pool, call)


# Every turn: at most this many tool calls in one response.
TOOLS_PER_RESPONSE = 4
MAX_CONCURRENT = 4

# Until its first successful write (an answer, or a build still reading) a turn
# gets this many responses, the last with tools off; the turn context counts
# them down. CAPY_AGENT_MAX_STEPS can only lower it; the prompt states this
# value.
PLANNING_RESPONSES = min(cfg.agent_max_steps, 12)

# Once a write has landed there is no response ceiling: the tool cap bounds
# productive turns, and the stall guard ends one whose responses stop landing
# writes (agent.WRITE_TOOLS).
BUILD_TOOLS_PER_TURN = 160
STALL_RESPONSES = 5
# A write that errors is an attempt at progress: each of the first two errored
# writes in a turn (agent.WRITE_TOOLS) grants the stall guard two more
# responses, so the threshold is at most 5 + 4.
WRITE_ERROR_GRACE = 2
WRITE_ERROR_GRACE_MAX = 2

# OpenRouter's doom-loop ladder, kept in our own loop (Epo 2026-10-29): a tool
# called again with the same arguments is logged at 2 in a row, refused from
# LOOP_REFUSE_AT and ends the turn at LOOP_STOP_AT. Other tools between keep a
# tool's streak; changed arguments restart it.
LOOP_LOG_AT = 2
LOOP_REFUSE_AT = 3
LOOP_STOP_AT = 6

STOP_ANSWER = "answer"
STOP_PLANNING_CAP = "planning_cap"
STOP_TOOL_CAP = "tool_cap"
# Build budget only: the stall guard ran the last response with tools off,
# whether or not that response answered. The credit guard's terminal call is
# not this: a silent one reports planning_cap, so operators sizing
# STALL_RESPONSES do not read billing cutoffs as stalls.
STOP_STALL = "stall"
# The loop ladder ended the turn: one tool called with the same arguments
# LOOP_STOP_AT times in a row.
STOP_LOOP = "loop"
STOP_ERROR = "error"
STOP_TURN_FAILED = "turn_failed"
STOP_CLIENT_GONE = "client_gone"


@dataclass
class TurnBudget:
    planning_rounds: int = 0
    completion_calls: int = 0
    compaction_calls: int = 0
    checkpoint_rewrites: int = 0
    tool_calls_by_name: dict[str, int] = field(default_factory=dict)
    tool_calls_turn: int = 0
    peak_parallel_tools: int = 0
    reported_input_tokens: int = 0
    estimated_input_tokens: int = 0
    cached_read_tokens: int = 0
    cache_write_tokens: int = 0
    reasoning_tokens: int = 0
    embedding_calls: int = 0
    stop_reason: str = ""
    # Per tool: its last arguments (canonical JSON) and how many responses in
    # a row called it with them.
    repeats: dict[str, tuple[str, int]] = field(default_factory=dict)
    # The streak of each call in the response being run, by call id.
    call_repeats: dict[str, int] = field(default_factory=dict)

    def count_repeats(self, calls: list[tuple[str, str, str]]) -> int:
        """Count one response's calls, given as (call id, tool, arguments),
        into the per-tool streaks; identical calls in it count once. Returns
        the longest streak."""
        self.call_repeats = {}
        counted: dict[tuple[str, str], int] = {}
        for call_id, name, arguments in calls:
            key = _canonical(arguments)
            if (name, key) not in counted:
                last, streak = self.repeats.get(name, ("", 0))
                counted[name, key] = streak + 1 if last == key and streak else 1
                self.repeats[name] = (key, counted[name, key])
            self.call_repeats[call_id] = counted[name, key]
        return max(counted.values(), default=0)

    def note_tool(self, name: str) -> None:
        self.tool_calls_by_name[name] = self.tool_calls_by_name.get(name, 0) + 1
        self.tool_calls_turn += 1

    def as_dict(self) -> dict[str, object]:
        return {
            "planningRounds": self.planning_rounds,
            "completionCalls": self.completion_calls,
            "compactionCalls": self.compaction_calls,
            "checkpointRewrites": self.checkpoint_rewrites,
            "toolCallsByName": dict(self.tool_calls_by_name),
            "toolCallsTurn": self.tool_calls_turn,
            "peakParallelTools": self.peak_parallel_tools,
            "reportedInputTokens": self.reported_input_tokens,
            "estimatedInputTokens": self.estimated_input_tokens,
            "cachedReadTokens": self.cached_read_tokens,
            "cacheWriteTokens": self.cache_write_tokens,
            "reasoningTokens": self.reasoning_tokens,
            "embeddingCalls": self.embedding_calls,
            "stopReason": self.stop_reason,
        }


def _canonical(arguments: str) -> str:
    """Arguments compared by meaning, not spelling; text that is not JSON is
    compared as written (a malformed call repeats too)."""
    try:
        return json.dumps(json.loads(arguments or "{}"), sort_keys=True)
    except ValueError:
        return arguments
