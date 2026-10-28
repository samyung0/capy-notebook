"""Office files: a collaborator's saved edit reaches the owner's next turn
through Go's /source-changes and the collaboration service's effects reader."""

from __future__ import annotations

import pytest

pytestmark = pytest.mark.stack


async def test_an_xlsx_cell_edit_reaches_search_and_the_office_read(stack, turn):
    """T2: the sheet's stale passage says its edits are not indexed, and the
    read of another range hands the model the cell's before and after."""
    ws = stack.workspace()
    file_id = stack.fixture("u_owner", ws, "grades.xlsx")
    word = stack.marker()
    await stack.index_file(ws, file_id, f"Grades {word}: Collaborator scored 17.")
    after = stack.marker()
    stack.edit(
        "u_editor",
        ws,
        {"kind": "source_file", "id": file_id},
        [
            {
                "type": "set_range",
                "sheet": "Grades",
                "range": "B3",
                "expected": [["17"]],
                "values": [[after]],
            }
        ],
        office=True,
    )

    done = await turn(
        stack.owner(ws),
        [
            ("skill", "read_skill", {"name": "office_building"}),
            ("search", "search_workspace", {"query": f"Grades {word}"}),
        ],
        [
            (
                "read",
                "inspect_office_document",
                {"file_id": file_id, "sheet": "Grades", "range": "A1:A2"},
            )
        ],
    )

    assert "has 1 edit not indexed yet" in done.result("search")
    read = done.changes("read")
    assert '"label":"Grades!B3"' in read and after in read


@pytest.mark.parametrize(
    ("name", "target"),
    [("lesson.docx", "paragraphs"), ("lesson.pptx", "slide")],
)
async def test_a_docx_or_pptx_text_edit_rides_the_files_first_read(
    stack, turn, name, target
):
    """T3: read_document appends the collaborator's change once per turn."""
    ws = stack.workspace()
    file_id = stack.fixture("u_owner", ws, name)
    await stack.index_file(ws, file_id, f"Lesson {stack.marker()}.")
    office = {"slide": 1} if target == "slide" else {}
    scoped = stack.inspect(ws, {"kind": "source_file", "id": file_id}, office)["scoped"]
    paragraph = next(p for p in scoped["paragraphs"] if len(p["text"]) > 3)
    after = stack.marker()
    stack.edit(
        "u_editor",
        ws,
        {"kind": "source_file", "id": file_id},
        [
            {
                "type": "replace_text",
                "target_id": paragraph["id"],
                "expected_text": paragraph["text"],
                "text": f"{paragraph['text']} {after}",
            }
        ],
        office=True,
    )

    done = await turn(
        stack.owner(ws),
        [("first", "read_document", {"file_id": file_id})],
        [("again", "read_document", {"file_id": file_id})],
    )

    assert after in done.changes("first")
    assert after not in done.result("again")
