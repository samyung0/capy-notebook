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
    ``take`` answers at once; ``wait`` queues in arrival order. Every
    successful take or wait is paired with one ``release``, which hands the
    slot straight to the oldest waiter."""

    def __init__(self, size: int) -> None:
        self.size = size
        self.used = 0
        self._waiters: deque[asyncio.Future[None]] = deque()

    def take(self) -> bool:
        if self.used >= self.size or self._waiters:
            return False
        self.used += 1
        return True

    async def wait(self, budget_s: float) -> bool:
        """Take a slot after the requests already waiting, or False once
        ``budget_s`` runs out. A cancelled waiter (its client gone) leaves the
        queue and passes on a slot handed to it as it left."""
        if self.take():
            return True
        waiter = asyncio.get_running_loop().create_future()
        self._waiters.append(waiter)
        try:
            async with asyncio.timeout(budget_s):
                await waiter
        except TimeoutError:
            pass
        except BaseException:
            if waiter.done() and not waiter.cancelled():
                self.release()
            raise
        finally:
            if waiter in self._waiters:
                self._waiters.remove(waiter)
        # Handed a slot just as the budget ran out still counts.
        return waiter.done() and not waiter.cancelled()

    def release(self) -> None:
        while self._waiters:
            waiter = self._waiters.popleft()
            if not waiter.done():
                waiter.set_result(None)
                return
        self.used -= 1


# The retrieval service is one uvicorn process (Epo 2026-10-24, rate-limit
# audit; openwiki/agentic-retrieval.md "Process capacity"): chat and generate
# requests running at once, past which a chat waits up to CHAT_SLOT_WAIT_S in
# arrival order (Q268) and a generate answers provider_busy;
REQUEST_SLOTS = Slots(64)
CHAT_SLOT_WAIT_S = 30.0
# Office captures in flight to the parser, whose queue ingest shares;
OFFICE_CAPTURE_SLOTS = Slots(1)
# and threads for deck scripts, page renders and capture downloads, so they
# never hold the default executor every model call's admission runs on. Two
# also bound the memory of side-by-side image decodes (at Pillow's pixel limit
# up to 1.3 GiB each for a WebP, 0.1 GiB for a JPEG; capture._decoded).
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
