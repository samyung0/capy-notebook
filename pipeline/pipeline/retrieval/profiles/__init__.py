"""What the chat model sees, per conversation scope (todo-account-chat.md):
the system prompt, the tool list, the mode lines and the send-back texts; the
turn context (turn_context.message) and skills (skills.text) read the scope
off the context. A conversation keeps its scope, so its profile, for life
(the provider cache rule). The loop, compaction, citations, events and
metering are shared (agent.py)."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from ..tools import ToolContext


@dataclass(frozen=True)
class Profile:
    name: str
    # The offered tools' model schemas.
    schemas: Callable[[ToolContext], list[dict[str, Any]]]
    # The whole request before the loop (prompts/chat.py chat_messages'
    # signature): system prompt, memory, history and the query.
    messages: Callable[..., list[dict[str, Any]]]
    # The sources switch's notes before a learner message.
    mode_lines: dict[bool, str]
    # Q221's send-back texts: can the learner write -> text.
    send_back: dict[bool, str]


def of(ctx: ToolContext) -> Profile:
    return account.PROFILE if ctx.account else workspace.PROFILE


from . import account, workspace
