"""Workload limits and telemetry for the chat agent.

These are workload limits, not billing. Platform-paid and BYOK turns share
the same planning and tool caps; the credit guard is a platform-paid billing
cutoff and bounds nothing else. Provider-call, query-embedding, and cumulative
input counts are measurements. The pinned model input budget bounds each call.
"""

from __future__ import annotations

import asyncio
import contextvars
import functools
from collections import deque
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import TypeVar

from ..config import cfg

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
    ) -> bool:
        """Wait in the queue until ``waiter`` is handed a slot: True holding
        it, False once ``budget_s`` runs out or ``left`` is set (the client is
        gone). A request that leaves the queue, cancelled included, passes on a
        slot handed to it as it left, so no slot is lost and the next waiter is
        not skipped (Q340, Q359)."""
        gone = asyncio.ensure_future(left.wait()) if left is not None else None
        try:
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
# status (Q268, Q293), and anything else answers provider_busy at once;
CHAT_SLOT_WAIT_S = 60.0
# Office captures in flight to the parser, whose queue ingest shares;
OFFICE_CAPTURE_SLOTS = Slots(1)
# and threads for deck scripts, page renders and capture downloads, so they
# never hold the default executor every model call's admission runs on. Two
# also bound the memory of side-by-side image decodes (a 5-megapixel source up
# to about 130 MiB; at Pillow's pixel limit up to 1.3 GiB for a WebP, 0.1 GiB
# for a JPEG; capture._decoded).
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

STOP_ANSWER = "answer"
STOP_PLANNING_CAP = "planning_cap"
STOP_TOOL_CAP = "tool_cap"
# Build budget only: the stall guard ran the last response with tools off,
# whether or not that response answered. The credit guard's terminal call is
# not this: a silent one reports planning_cap, so operators sizing
# STALL_RESPONSES do not read billing cutoffs as stalls.
STOP_STALL = "stall"
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
