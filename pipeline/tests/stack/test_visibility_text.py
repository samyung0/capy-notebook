"""Text files: a stored edit's effects reach the hints and the read, and the
turn's own edit rides the next read."""

from __future__ import annotations

import pytest

pytestmark = pytest.mark.stack


async def test_a_text_edit_reaches_the_hints_and_each_read(stack, turn):
    """T4: the collaborator's change is hinted under a message naming two of
    its words and appended to the read; after the owner's own edit that turn,
    the next read appends the new change."""
    ws = stack.workspace()
    text = "# Wetlands\n\nSalt marshes trap sediment.\n\nMudflats feed birds.\n"
    file_id = stack.upload("u_owner", ws, f"{stack.marker()}.md", text.encode())
    await stack.index_file(ws, file_id, text)
    first, second, own = stack.marker(), stack.marker(), stack.marker()
    stack.edit(
        "u_editor",
        ws,
        {"kind": "source_file", "id": file_id},
        [
            {
                "type": "replace_text",
                "expected_text": "trap sediment",
                "text": f"trap {first} {second} sediment",
            }
        ],
    )

    done = await turn(
        stack.owner(ws),
        [
            ("skill", "read_skill", {"name": "editing"}),
            ("read", "read_document", {"file_id": file_id}),
        ],
        [
            (
                "edit",
                "edit_document",
                {
                    "target": {"kind": "source_file", "id": file_id},
                    "commands": [
                        {
                            "type": "replace_text",
                            "expected_text": "feed birds",
                            "text": f"feed {own} birds",
                        }
                    ],
                },
            )
        ],
        [("again", "read_document", {"file_id": file_id})],
        query=f"What do my notes say about {first} {second}?",
    )

    assert file_id in done.hints() and first in done.hints()
    assert first in done.changes("read")
    assert own in done.changes("again")
