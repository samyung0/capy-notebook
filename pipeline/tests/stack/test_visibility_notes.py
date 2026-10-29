"""Notes: saved changes since the note's index reach inspect_document, Go
computing them from the stored content against the indexed blocks."""

from __future__ import annotations

import json
import os

import pytest

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


@pytest.mark.skipif(
    os.environ.get("COLLABORATION_DOCUMENT_LAYOUT") == "blocks",
    reason="a blocks note takes no agent edits until they act on block ids "
    "(todo-blocksuite-spike.md boundary 3, D16)",
)
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
    """T6: a note create_material wrote lists under its chapter and inspects
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
                    "chapter_id": f"ch_{ws}",
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
    assert listed.index(f"Chapter {ws}") < listed.index(note)
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
