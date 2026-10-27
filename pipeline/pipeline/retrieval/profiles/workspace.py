"""Workspace chat's profile: today's prompt, tools, turn context and skills,
unchanged byte for byte (pinned by tests/test_chat_profiles.py against the
pre-account-chat output)."""

from __future__ import annotations

from ...prompts import chat as chat_prompts
from .. import tools
from . import Profile

PROFILE = Profile(
    name="workspace",
    schemas=tools.schemas_for,
    messages=chat_prompts.chat_messages,
    mode_lines=chat_prompts.MODE_LINES,
    send_back={
        (True, False): chat_prompts.SEND_BACK,
        (True, True): chat_prompts.SEND_BACK_TOOL,
        (False, False): chat_prompts.SEND_BACK_READ_ONLY,
        (False, True): chat_prompts.SEND_BACK_TOOL_READ_ONLY,
    },
)
