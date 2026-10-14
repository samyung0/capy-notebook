"""UAT only: chat turns whose model responses come from a script.

With ``RETRIEVAL_UAT_SCRIPTED_TOOLS=true`` (``config.uat_only_flag``: refused
unless SENTRY_ENVIRONMENT is ``uat``, and the deployment renderer refuses it in
production) a chat message that starts with :data:`MARKER` carries a script::

    [uat-scripted-tools]{"steps": [[{"name": "list_sources", "arguments": {}}], "Done."]}

Each model response of the turn is the script's next step instead of a
provider call: a list of tool calls, or the final answer text. The calls then
run exactly as a model's would: ``tools.run`` offers only what the actor's
operations allow, validates the arguments against the contract and requires
the skills, and the per-response and per-turn caps still apply. A script
therefore reaches nothing a model could not be prompted into; it only makes the
choice deterministic and free. The UAT chat journey uses it to check the tools.
Without the switch the marker is ordinary text and the model answers it.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from ..config import cfg
from .stream import AssembledResponse, StreamEvent, ToolCall

MARKER = "[uat-scripted-tools]"


class ScriptError(ValueError):
    """The marker was there but the script after it is not one."""


@dataclass(frozen=True)
class Script:
    # A tuple of tool calls is one tool-calling response; a string is the answer.
    steps: tuple[tuple[ToolCall, ...] | str, ...]

    async def respond(
        self, index: int, on_event: Callable[[StreamEvent], None]
    ) -> AssembledResponse:
        """The turn's response number ``index`` (0-based). A turn that outlives
        its script gets an empty response, which the agent ends as it would a
        model's."""
        if index >= len(self.steps):
            return AssembledResponse()
        step = self.steps[index]
        if isinstance(step, str):
            on_event(StreamEvent(kind="text", text=step))
            return AssembledResponse(text=step)
        return AssembledResponse(tool_calls=list(step))


def parse(query: str) -> Script | None:
    """The message's script, or None for an ordinary message (always, with
    the switch off)."""
    if not cfg.uat_scripted_tools or not query.startswith(MARKER):
        return None
    try:
        body = json.loads(query[len(MARKER) :])
    except json.JSONDecodeError as exc:
        raise ScriptError(f"the script is not JSON: {exc.msg}") from exc
    steps = body.get("steps") if isinstance(body, dict) else None
    if not isinstance(steps, list) or not steps:
        raise ScriptError('the script needs a non-empty "steps" list')
    return Script(tuple(_step(n, step) for n, step in enumerate(steps, 1)))


def _step(n: int, step: Any) -> tuple[ToolCall, ...] | str:
    if isinstance(step, str) and step.strip():
        return step
    if not isinstance(step, list) or not step:
        raise ScriptError(f"step {n} must be answer text or a list of tool calls")
    calls = []
    for i, call in enumerate(step, 1):
        if (
            not isinstance(call, dict)
            or set(call) - {"name", "arguments"}
            or not isinstance(call.get("name"), str)
            or not isinstance(call.get("arguments", {}), dict)
        ):
            raise ScriptError(f"step {n} call {i} must be {{name, arguments}}")
        calls.append(
            ToolCall(
                id=f"call_uat_{n}_{i}",
                name=call["name"],
                arguments=json.dumps(call.get("arguments", {})),
            )
        )
    return tuple(calls)
