"""Workload limits and telemetry for the chat agent.

These are workload limits, not billing. Platform-paid and BYOK turns share
the same planning and tool caps; the credit guard is a platform-paid billing
cutoff and bounds nothing else. Provider-call, query-embedding, and cumulative
input counts are measurements. The pinned model input budget bounds each call.
"""

from __future__ import annotations

from dataclasses import dataclass, field

# Planning responses and the per-response cap are the binding limits; the
# per-turn cap is their product on purpose, so a turn that uses every call
# ends on the tools-off last response rather than on a limit_reached refusal.
PLANNING_RESPONSES = 8
TOOLS_PER_RESPONSE = 2
TOOLS_PER_TURN = PLANNING_RESPONSES * TOOLS_PER_RESPONSE
MAX_CONCURRENT = 4

# Curate mode builds materials instead of answering, so it has no planning
# ceiling for any payer and no per-turn tool count. The stall guard is the
# workload bound: it ends a turn whose responses stop completing ledger todos.
KNOWLEDGE_TOOLS_PER_RESPONSE = 4
CURATE_STALL_RESPONSES = 4
# A learner's request has to fit the library evidence of a whole turn.
CURATE_MIN_CONTEXT_WINDOW_TOKENS = 200_000

STOP_ANSWER = "answer"
STOP_PLANNING_CAP = "planning_cap"
# Curate only: the stall guard ran the last response with tools off, whether or
# not that response answered. The credit guard's terminal call is not this: a
# silent one reports planning_cap, the same as outside curate, so operators
# sizing CURATE_STALL_RESPONSES do not read billing cutoffs as stalls.
STOP_CURATE_STALL = "curate_stall"
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
