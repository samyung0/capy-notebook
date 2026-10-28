"""Trash, restore and move as the next turn's reads see them."""

from __future__ import annotations

import pytest

from pipeline.retrieval import tools

pytestmark = pytest.mark.stack


async def test_trash_restore_and_move_carry_a_files_changes(stack, turn):
    """T9: an edited, indexed file the agent trashed leaves the next turn's
    listing, passages, hints and changes, and comes back with its changes when
    restored; moved to another workspace it is listed, found and read with its
    changes there, and the chat that edited it is told it moved out."""
    home, away = stack.workspace(), stack.workspace()
    word = stack.marker()
    text = f"# Dunes\n\nDunes {word} hold sand.\n\nGrass binds them.\n"
    file_id = stack.upload("u_owner", home, f"{stack.marker()}.md", text.encode())
    await stack.index_file(home, file_id, text)
    first, second, own = stack.marker(), stack.marker(), stack.marker()
    stack.edit(
        "u_editor",
        home,
        {"kind": "source_file", "id": file_id},
        [
            {
                "type": "replace_text",
                "expected_text": "hold sand",
                "text": f"hold {first} {second} sand",
            }
        ],
    )
    target = {"kind": "source_file", "id": file_id}
    edit = {
        "target": target,
        "commands": [
            {"type": "replace_text", "expected_text": "binds", "text": f"binds {own}"}
        ],
    }
    await turn(
        stack.owner(home),
        [("skill", "read_skill", {"name": "editing"})],
        [("edit", "edit_document", edit)],
        [("trash", "trash_file", {"target": target})],
    )

    trashed = await turn(
        stack.owner(home),
        [
            ("list", "list_sources", {}),
            ("search", "search_workspace", {"query": f"Dunes {word}"}),
        ],
        [("restore", "restore_file", {"target": target})],
        query=f"What about {first} {second}?",
    )
    restored = await turn(
        stack.owner(home),
        [("list", "list_sources", {})],
        [("read", "read_document", {"file_id": file_id})],
    )
    stack.call(
        "u_owner",
        "POST",
        "/api/files/move",
        json={"fileIds": [file_id], "workspaceId": away},
    )
    moved = await turn(
        stack.owner(away),
        [
            ("list", "list_sources", {}),
            ("search", "search_workspace", {"query": f"Dunes {word}"}),
        ],
        [("read", "read_document", {"file_id": file_id})],
    )
    left = await turn(
        stack.owner(home), [("read", "inspect_document", {"target": target})]
    )

    assert file_id not in trashed.result("list")
    assert file_id not in trashed.result("search") and not trashed.hints()
    assert file_id in restored.result("list")
    assert first in restored.changes("read") and own in restored.changes("read")
    assert file_id in moved.result("list") and word in moved.result("search")
    assert first in moved.changes("read") and own in moved.changes("read")
    assert tools.MOVED_OUT in left.result("read")
