"""Workload limits and telemetry for the chat agent.

These are workload limits, not billing. Platform-paid and BYOK turns share
the same planning and tool caps; the credit guard is a platform-paid billing
cutoff and bounds nothing else. Provider-call, query-embedding, and cumulative
input counts are measurements. The pinned model input budget bounds each call.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from ..config import cfg

# Every turn: at most this many tool calls in one response.
TOOLS_PER_RESPONSE = 4
MAX_CONCURRENT = 4

# A turn without ledger todos (an answer or a single-item build) gets this many
# responses, the last with tools off; the turn context counts them down. A turn
# that needs more room creates a ledger. CAPY_AGENT_MAX_STEPS can only lower
# it; the prompt states this value.
PLANNING_RESPONSES = min(cfg.agent_max_steps, 12)

# Once the turn's ledger has todos there is no response ceiling: the tool cap
# bounds productive turns, and the stall guard ends one whose responses stop
# completing todos.
LEDGER_TOOLS_PER_TURN = 160
STALL_RESPONSES = 5
# A write that errors is an attempt at progress: each of the first two errored
# writes in a turn (agent.WRITE_TOOLS) grants the stall guard two more
# responses, so the threshold is at most 5 + 4.
WRITE_ERROR_GRACE = 2
WRITE_ERROR_GRACE_MAX = 2

STOP_ANSWER = "answer"
STOP_PLANNING_CAP = "planning_cap"
STOP_TOOL_CAP = "tool_cap"
# Ledger turns only: the stall guard ran the last response with tools off,
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
