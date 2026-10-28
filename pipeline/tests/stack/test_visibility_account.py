"""Account chat: each read loads its item's changes through Go's per-item
check (/api/internal/changes)."""

from __future__ import annotations

import pytest

from pipeline.retrieval import tools

pytestmark = pytest.mark.stack


async def test_account_reads_carry_each_items_changes(stack, turn):
    """T8: a member workspace's DOCX another member edited and the user's own
    edited .md each come with their changes, through read_document and
    inspect_office_document, and the .md's passage says it has edits not
    indexed; a file the user only has a link to is not found."""
    shared = stack.workspace(owner="u_owner", members=("u_editor",))
    docx = stack.fixture("u_owner", shared, "lesson.docx")
    await stack.index_file(shared, docx, f"Lesson {stack.marker()}.")
    paragraph = next(
        p
        for p in stack.inspect(shared, {"kind": "source_file", "id": docx}, {})[
            "scoped"
        ]["paragraphs"]
        if len(p["text"]) > 3
    )
    edited = stack.marker()
    stack.edit(
        "u_owner",
        shared,
        {"kind": "source_file", "id": docx},
        [
            {
                "type": "replace_text",
                "target_id": paragraph["id"],
                "expected_text": paragraph["text"],
                "text": f"{paragraph['text']} {edited}",
            }
        ],
        office=True,
    )
    own = stack.workspace(owner="u_editor", members=())
    word, name = stack.marker(), f"{stack.marker()}.md"
    text = f"# Tides\n\nTides {word} flood twice a day.\n"
    md = stack.upload("u_editor", own, name, text.encode())
    await stack.index_file(own, md, text)
    mine = stack.marker()
    stack.edit(
        "u_editor",
        own,
        {"kind": "source_file", "id": md},
        [{"type": "replace_text", "expected_text": "twice", "text": f"twice {mine}"}],
    )

    reads = await turn(
        stack.account("u_editor"),
        [("search", "search_files_content", {"query": f"Tides {word}"})],
        [
            ("docx", "read_document", {"file_id": docx}),
            ("md", "read_document", {"file_id": md}),
            ("link", "read_document", {"file_id": "f_e2e_link"}),
        ],
    )
    inspected = await turn(
        stack.account("u_editor"),
        [("skill", "read_skill", {"name": "office_building"})],
        [("docx", "inspect_office_document", {"file_id": docx})],
    )

    # Q527: the passage of an edited file says so, as workspace chat's do.
    assert f'"{name}" has 1 edit not indexed yet' in reads.result("search")
    assert edited in reads.changes("docx") and mine in reads.changes("md")
    assert tools.NO_ACCOUNT_ITEM.format(id="f_e2e_link") in reads.result("link")
    assert edited in inspected.changes("docx")


async def test_an_account_note_with_no_workspace_is_found_and_read(stack, turn):
    """T8: a note account chat creates in No workspace is found by
    search_files_summary and read by inspect_document."""
    title = stack.marker()
    await turn(
        stack.account("u_editor"),
        [
            ("skill", "read_skill", {"name": "editing"}),
            ("notes", "read_skill", {"name": "note_building"}),
        ],
        [
            (
                "create",
                "create_material",
                {
                    "kind": "note",
                    "title": f"Estuary {title}",
                    "content": "Brackish water.",
                },
            )
        ],
    )
    [(note,)] = stack.sql(
        "SELECT id FROM materials WHERE workspace_id IS NULL AND title=%s",
        (f"Estuary {title}",),
    )

    done = await turn(
        stack.account("u_editor"),
        [("find", "search_files_summary", {"query": title})],
        [("read", "inspect_document", {"target": {"kind": "material", "id": note}})],
    )

    assert note in done.result("find")
    assert "Brackish water." in done.result("read")
