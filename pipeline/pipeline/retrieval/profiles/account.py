"""Account chat's profile (todo-account-chat.md): the chat across the user's
owned and member workspaces and their files with no workspace.

Its tools are the contract's ``account`` scope (tools._offered). The two
create tools, create_material and create_deck, take an optional
``workspace_id`` here only: this profile adds it to its copy of their schema,
and tools.run moves it out before checking the call against Go's definition,
which stays byte for byte. Omitted, the item lands in No workspace.
Skills replace their workspace wording (skills.text).
"""

from __future__ import annotations

import copy
from typing import Any

from ...prompts import account_chat
from ...prompts import chat as chat_prompts
from .. import tools
from ..tools import ToolContext
from . import Profile

WORKSPACE_ID = {
    "type": "string",
    "minLength": 1,
    "description": "The workspace to create it in (workspace_id from list_files), "
    "only when the user names one they can edit; omit it to create it in No "
    "workspace.",
}


def schemas(ctx: ToolContext) -> list[dict[str, Any]]:
    out = tools.schemas_for(ctx)
    for i, schema in enumerate(out):
        if schema["function"]["name"] in tools.DESTINATION_TOOLS:
            schema = copy.deepcopy(schema)
            schema["function"]["parameters"]["properties"]["workspace_id"] = (
                WORKSPACE_ID
            )
            out[i] = schema
    return out


def messages(*, locale: str | None, writes: bool = True, **kwargs: Any) -> list[dict]:
    return chat_prompts.chat_messages(
        locale=locale,
        writes=writes,
        head=account_chat.system_prompt(locale, writes=writes),
        mode_lines=account_chat.MODE_LINES,
        **kwargs,
    )


PROFILE = Profile(
    name="account",
    schemas=schemas,
    messages=messages,
    mode_lines=account_chat.MODE_LINES,
    send_back={
        (True, False): account_chat.SEND_BACK,
        (True, True): account_chat.SEND_BACK_TOOL,
        (False, False): account_chat.SEND_BACK_READ_ONLY,
        (False, True): account_chat.SEND_BACK_TOOL_READ_ONLY,
    },
)
