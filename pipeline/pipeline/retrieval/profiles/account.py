"""Account chat's profile (todo-account-chat.md): the chat across the user's
owned and member workspaces and their files with no workspace.

Its tools are the contract's ``account`` scope (tools._offered). The tools
that create (tools.DESTINATION_TOOLS) and list_sources take an optional
``workspace_id`` here only (create_chapter a required one): this profile adds
it to its copy of their schema, and tools.run moves it out before checking
the call against Go's definition, which stays byte for byte. Omitted, the item lands in No workspace.
Skills (skills.text) and this profile's copies of the tool descriptions
replace their workspace wording.
"""

from __future__ import annotations

import json
from typing import Any

from ...prompts import account_chat
from ...prompts import chat as chat_prompts
from .. import tools
from ..tools import ToolContext
from . import Profile

WORKSPACE_ID = {
    "type": "string",
    "minLength": 1,
    "description": "Where a new item is created: a workspace the user can edit "
    "(a workspace_id a search, listing or read named) or one create_workspace "
    "just made; omit it to create it in No workspace. An edit of an existing "
    "item ignores it.",
}

# list_sources lists one workspace or the files with no workspace here, under
# workspace chat's name (Q523): this copy's description and workspace_id,
# which tools.run moves out as it does a create's.
LIST_SOURCES = (
    "List one of the user's workspaces by chapter (workspace_id), or without it "
    "their newest files and materials with no workspace, with ids, kinds and "
    "whether the user can edit each."
)
LISTED_WORKSPACE = {
    "description": "A workspace id from search_files_summary, search_files_content "
    "or a read; omit it to list the files with no workspace.",
    "minLength": 1,
    "type": "string",
}

# create_chapter adds to a workspace the user can edit; No workspace has none.
CHAPTER_WORKSPACE = {
    "type": "string",
    "minLength": 1,
    "description": "The workspace to add it to: a workspace_id from list_workspaces, "
    "a search, a listing or a read, of one the user can edit.",
}

# Go's descriptions written for workspace chat, in account words (Epo
# 2026-10-28, T3): the made-from line of the creates and search_web.
WORDING = (
    (
        "named in words or by id: workspace files,",
        "named in words or by id: the user's files,",
    ),
    (
        "(ids from list_sources)",
        "(ids from search_files_summary, list_sources or a read)",
    ),
    (
        "An id or exact name of a workspace item",
        "An id or exact name of one of the user's items",
    ),
    (
        "call it only when the workspace, the library",
        "call it only when the learner's files, the library",
    ),
)


def _reworded(schema: dict[str, Any]) -> dict[str, Any]:
    text = json.dumps(schema)
    for old, new in WORDING:
        text = text.replace(old, new)
    return json.loads(text)


def schemas(ctx: ToolContext) -> list[dict[str, Any]]:
    out = [_reworded(schema) for schema in tools.schemas_for(ctx)]
    for schema in out:
        function = schema["function"]
        if function["name"] == "list_sources":
            function["description"] = LIST_SOURCES
            function["parameters"]["properties"]["workspace_id"] = LISTED_WORKSPACE
        elif function["name"] == "create_chapter":
            parameters = function["parameters"]
            parameters["properties"]["workspace_id"] = CHAPTER_WORKSPACE
            parameters["required"] = [*parameters.get("required", []), "workspace_id"]
        elif function["name"] in tools.DESTINATION_TOOLS:
            function["parameters"]["properties"]["workspace_id"] = WORKSPACE_ID
    # workspace_id lands in its place among the arguments (T3a).
    return [tools.in_writing_order(schema) for schema in out]


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
