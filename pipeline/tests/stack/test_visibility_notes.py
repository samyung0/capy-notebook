"""Notes: saved changes since the note's index reach inspect_document, Go
computing them from the stored content against the indexed blocks."""

from __future__ import annotations

import json

import pytest

from pipeline.retrieval import pending_hints, store

pytestmark = pytest.mark.stack


def _chart(block_id: str, title: str, series: list[list[float]]) -> dict:
    return {
        "type": "chart",
        "id": block_id,
        "children": [{"text": ""}],
        "block": {
            "type": "chart",
            "kind": "bar",
            "title": title,
            "labels": [f"r{i}" for i in range(len(series[0]))],
            "series": [{"name": f"S{n}", "values": v} for n, v in enumerate(series)],
        },
    }


def _fence(block: dict) -> str:
    return "```chart\n" + json.dumps(block["block"]) + "\n```"


async def test_a_notes_text_and_chart_changes_reach_its_inspect(stack, turn):
    """T5: a paragraph change and a small chart change as text, a heavy chart
    change as a data placeholder that resolve_source_change reads."""
    ws = stack.workspace()
    small = _chart("vis_small", "Tides", [[1, 2, 3]])
    # Over the 150-token budget a chart change is a placeholder (Epo 2026-10-17).
    heavy = _chart(
        "vis_heavy", "Salinity", [[float(i + n) for i in range(45)] for n in range(3)]
    )
    note = stack.call(
        "u_owner",
        "POST",
        f"/api/workspaces/{ws}/materials",
        json={
            "kind": "note",
            "title": f"Marsh {stack.marker()}",
            "content": {
                "schemaVersion": 1,
                "value": [
                    {
                        "type": "p",
                        "id": "vis_p",
                        "children": [{"text": "Marsh notes."}],
                    },
                    small,
                    heavy,
                ],
            },
        },
    )["id"]
    await stack.index_note(ws, note)
    shown = {
        b["id"]: b["text"]
        for b in stack.inspect(ws, {"kind": "material", "id": note})["blocks"]
    }
    word, title = stack.marker(), stack.marker()
    small["block"]["title"] = title
    for series in heavy["block"]["series"]:
        series["values"] = [1000.0 + i * 7 for i in range(45)]
    stack.edit(
        "u_editor",
        ws,
        {"kind": "material", "id": note},
        [
            {
                "type": "replace_text",
                "target_id": "vis_p",
                "expected_text": "Marsh notes.",
                "text": f"Marsh notes {word}.",
            },
            *(
                {
                    "type": "replace_block",
                    "block_id": block["id"],
                    "expected_text": shown[block["id"]],
                    "markdown": _fence(block),
                }
                for block in (small, heavy)
            ),
        ],
    )

    # A replaced block takes a new id: the read names both.
    _, small_id, heavy_id = (
        b["id"] for b in stack.inspect(ws, {"kind": "material", "id": note})["blocks"]
    )

    done = await turn(
        stack.owner(ws),
        [("read", "inspect_document", {"target": {"kind": "material", "id": note}})],
        [
            (
                "resolve",
                "resolve_source_change",
                {"material_id": note, "block_id": heavy_id},
            )
        ],
    )

    changes = json.loads(done.result("read").rsplit("\n", 1)[1])
    by_block = {c["blockId"]: c for c in changes[0]["changes"]}
    assert word in by_block["vis_p"]["after"]
    assert title in by_block[small_id]["after"]
    assert by_block[heavy_id]["kind"] == "data"
    assert "1308" in done.result("resolve")  # the heavy chart's last value now


async def test_an_agent_note_and_its_quiz_edit_reach_the_next_turn(stack, turn):
    """T6: a note create_material wrote lists under its topic and inspects
    block by block; a member's save of its quiz shows in the note's changes
    at the quiz's block."""
    ws = stack.workspace()
    chart, flow, kept, removed = (stack.marker() for _ in range(4))
    content = "\n\n".join(
        [
            "Marsh plants.",
            "```chart\n"
            + json.dumps(
                {
                    "type": "chart",
                    "kind": "bar",
                    "title": chart,
                    "labels": ["a", "b"],
                    "series": [{"name": "S", "values": [1, 2]}],
                }
            )
            + "\n```",
            f"```mermaid\nflowchart LR\n  {flow} --> Marsh\n```",
            (
                "```quiz\nquestions:\n"
                f'  - question: "{kept} which zone floods daily?"\n'
                '    options: ["Low marsh", "High marsh"]\n'
                '    correct: "Low marsh"\n'
                f'  - question: "{removed} how often do tides flood?"\n'
                '    options: ["Twice", "Once"]\n'
                '    correct: "Twice"\n```'
            ),
        ]
    )
    await turn(
        stack.owner(ws),
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
                    "title": f"Marsh {chart}",
                    "topic_id": f"ch_{ws}",
                    "content": content,
                },
            )
        ],
    )
    [(note,)] = stack.sql(
        "SELECT id FROM materials WHERE workspace_id=%s AND kind='note'", (ws,)
    )
    [(quiz,)] = stack.sql(
        "SELECT id FROM materials WHERE workspace_id=%s AND kind='quiz'", (ws,)
    )
    await stack.index_note(ws, note)
    question = next(
        json.loads(child["text"])["id"]
        for block in stack.inspect(ws, {"kind": "material", "id": quiz})["blocks"]
        for child in block.get("children") or []
        if removed in child["text"]
    )
    stack.edit(
        "u_editor",
        ws,
        {"kind": "material", "id": quiz},
        [{"type": "remove_question", "question_id": question}],
    )

    done = await turn(
        stack.owner(ws),
        [("list", "list_sources", {})],
        [("read", "inspect_document", {"target": {"kind": "material", "id": note}})],
    )

    listed = done.result("list")
    assert listed.index(f"Topic {ws}") < listed.index(note)
    read = done.result("read")
    assert chart in read and flow in read
    assert f"embedded quiz material id={quiz}" in read
    [change] = json.loads(read.rsplit("\n", 1)[1])[0]["changes"]
    assert change["label"].startswith("material_ref ")
    # The quiz's index text: its question and options (stored shuffled), no
    # answer key.
    assert set(change["before"].split("\n")) == {
        "",
        f"{removed} how often do tides flood?",
        "- Twice",
        "- Once",
    }


async def test_a_hidden_items_unindexed_edits_reach_only_those_who_edit(stack, turn):
    """T10 (security regression): a hidden note and file with unindexed edits. A
    viewer's turn whose message and search name words of those edits gets no hints
    and no search tail, and its model never sees the items' ids; an editor's gets
    both."""
    ws = stack.workspace()
    stack.sql(
        "INSERT INTO workspace_members (workspace_id, user_id, role)"
        " VALUES (%s, 'u_viewer', 'viewer')",
        (ws,),
    )
    note = stack.call(
        "u_owner",
        "POST",
        f"/api/workspaces/{ws}/materials",
        json={
            "kind": "note",
            "title": f"Marsh {stack.marker()}",
            "content": {
                "schemaVersion": 1,
                "value": [
                    {
                        "type": "p",
                        "id": "hid_a",
                        "children": [{"text": "Marsh notes."}],
                    },
                    {"type": "p", "id": "hid_b", "children": [{"text": "Tide notes."}]},
                ],
            },
        },
    )["id"]
    await stack.index_note(ws, note)
    text = "# Dunes\n\nDunes hold sand.\n\nGrass binds them.\n"
    file_id = stack.upload("u_owner", ws, f"{stack.marker()}.md", text.encode())
    await stack.index_file(ws, file_id, text)
    hinted = f"{stack.marker()} {stack.marker()}"
    searched = f"{stack.marker()} {stack.marker()}"
    stack.edit(
        "u_editor",
        ws,
        {"kind": "material", "id": note},
        [
            {
                "type": "replace_text",
                "target_id": "hid_a",
                "expected_text": "Marsh notes.",
                "text": f"Marsh {hinted}.",
            },
            {
                "type": "replace_text",
                "target_id": "hid_b",
                "expected_text": "Tide notes.",
                "text": f"Tide {searched}.",
            },
        ],
    )
    stack.edit(
        "u_editor",
        ws,
        {"kind": "source_file", "id": file_id},
        [
            {
                "type": "replace_text",
                "expected_text": "hold sand",
                "text": f"hold {hinted} sand",
            },
            {
                "type": "replace_text",
                "expected_text": "binds them",
                "text": f"binds {searched} them",
            },
        ],
    )
    stack.call("u_owner", "PUT", f"/api/materials/{note}/hidden", json={"hidden": True})
    stack.call("u_owner", "PUT", f"/api/files/{file_id}/hidden", json={"hidden": True})

    async def turn_of(user: str, readers: list[str]):
        """`user`'s turn, with the hidden readers service.py binds for their role."""
        token = store.bind_hidden_readers(readers)
        try:
            return await turn(
                stack.owner(ws, user),
                [("search", "search_workspace", {"query": searched})],
                query=f"What do my notes say about {hinted}?",
            )
        finally:
            store.reset_hidden_readers(token)

    viewer = await turn_of("u_viewer", [])
    editor = await turn_of("u_editor", [ws])

    assert not viewer.hints()
    assert pending_hints.SEARCH_HEADING not in viewer.result("search")
    for item in (note, file_id):
        assert item not in str(viewer.requests)
        assert item in editor.hints() and item in editor.result("search")
    assert hinted.split()[0] in editor.hints()
    assert pending_hints.SEARCH_HEADING in editor.result("search")
    assert searched.split()[0] in editor.result("search")
