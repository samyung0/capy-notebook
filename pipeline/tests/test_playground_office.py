"""The agent playground's local Office files (lab/playground/scripts/office.py):
production's edit_office_document and inspect_office_document against the real
office-service engine, with the gateway's Office routes answered in process.
Skipped unless OFFICE_SERVICE_BIN names a built engine (lab/playground/README.md,
"Office files")."""

from __future__ import annotations

import os
import shutil
from pathlib import Path

import pytest

from pipeline.config import cfg
from pipeline.retrieval import store, tools

SCRIPTS = Path(__file__).resolve().parents[2] / "lab/playground/scripts"

pytestmark = pytest.mark.skipif(
    not os.environ.get("OFFICE_SERVICE_BIN")
    or not Path(os.environ["OFFICE_SERVICE_BIN"]).is_file()
    or not shutil.which("go"),
    reason="needs OFFICE_SERVICE_BIN (a built office-service) and go",
)


@pytest.fixture
def run(monkeypatch, tmp_path):
    monkeypatch.syspath_prepend(str(SCRIPTS))
    import office

    async def outline(_workspace_id):
        return {"chapters": [], "files": []}

    async def reload_pending(_ctx, _file_id):
        return None

    monkeypatch.setattr(cfg, "gateway_url", "http://playground.invalid")
    monkeypatch.setattr(cfg, "pipeline_secret", "playground")
    monkeypatch.setattr(store, "workspace_outline", outline)
    monkeypatch.setattr(tools, "_reload_pending", reload_pending)
    state = {"run_dir": tmp_path / "run", "extra": []}
    try:
        with office.local_gateway(state):
            yield state
    finally:
        office.close()


async def test_a_created_workbook_reads_back_and_a_stale_write_shows_the_range(run):
    ctx = tools.ToolContext(
        workspace_id="ws_playground",
        user_id="playground",
        operations=frozenset({"source.read", "document.edit"}),
        assistant_message_id="run",
        office_tools=True,
    )
    ctx.skills_read = {"editing", "office_building"}

    created = await tools.run(
        "edit_office_document",
        {
            "_tool_call_id": "c1",
            "commands": [
                {"type": "create", "format": "xlsx", "title": "Grades"},
                {
                    "type": "set_range",
                    "sheet": "Sheet1",
                    "range": "A1:B1",
                    "expected": [["", ""]],
                    "values": [["2", "=A1*3"]],
                },
            ],
        },
        ctx,
    )
    assert created.text_parts == [
        "Created file 'Grades.xlsx' (id f_local_1). It is now in the workspace."
    ]
    assert (run["run_dir"] / "materials/f_local_1.xlsx").stat().st_size > 0
    assert run["extra"][-1]["file"] == "runs/run/materials/f_local_1.xlsx"

    read = await tools.run(
        "inspect_office_document",
        {"file_id": "f_local_1", "sheet": "Sheet1", "range": "A1:B1"},
        ctx,
    )
    assert "A1: 2\nB1: =A1*3 → 6" in read.text_parts[0]

    stale = await tools.run(
        "edit_office_document",
        {
            "_tool_call_id": "c2",
            "file_id": "f_local_1",
            "commands": [
                {
                    "type": "set_range",
                    "sheet": "Sheet1",
                    "range": "A1:B1",
                    "expected": [["3", "=A1*3"]],
                    "values": [["4", "=A1*3"]],
                }
            ],
        },
        ctx,
    )
    assert stale.refused and stale.error_code == "stale_target"
    assert "Range Sheet1!A1:B1 now holds, as TSV:\n2\t=A1*3" in stale.detail


async def test_a_created_word_file_reads_back_and_a_stale_delete_shows_the_paragraph(
    run,
):
    ctx = tools.ToolContext(
        workspace_id="ws_playground",
        user_id="playground",
        operations=frozenset({"source.read", "document.edit"}),
        assistant_message_id="run",
        office_tools=True,
    )
    ctx.skills_read = {"editing", "office_building"}
    created = await tools.run(
        "edit_office_document",
        {
            "_tool_call_id": "c1",
            "commands": [
                {"type": "create", "format": "docx", "title": "Lab report"},
                {"type": "insert_paragraph", "text": "Method", "style": "Heading1"},
                {"type": "insert_paragraph", "text": "Ruler", "list": "bullet"},
                {"type": "insert_table", "rows": [["Length", "Period"]]},
            ],
        },
        ctx,
    )
    assert created.text_parts == [
        "Created file 'Lab report.docx' (id f_local_1). It is now in the workspace."
    ]
    read = (
        await tools.run(
            "inspect_office_document", {"file_id": "f_local_1", "count": 10}, ctx
        )
    ).text_parts[0]
    assert ") Method" in read and "(Heading1) Method" in read
    assert "(bullet) Ruler" in read
    assert "row 1 column 2) Period" in read
    assert "Heading1 (heading 1)" in read
    method = next(
        line.split("]")[0][1:] for line in read.splitlines() if line.endswith(" Method")
    )

    stale = await tools.run(
        "edit_office_document",
        {
            "_tool_call_id": "c2",
            "file_id": "f_local_1",
            "commands": [
                {
                    "type": "delete_paragraph",
                    "target_id": method,
                    "expected_text": "Methods",
                }
            ],
        },
        ctx,
    )
    assert stale.refused and stale.error_code == "stale_target"
    assert f"Paragraph {method} now reads:\nMethod" in stale.detail

    # The engine alone counts a call's limits (Epo 2026-10-22): past one,
    # the rest come back in the result, unapplied, by index.
    bold = {
        "type": "format_text",
        "target_id": method,
        "expected_text": "Method",
        "bold": True,
    }
    limited = await tools.run(
        "edit_office_document",
        {"_tool_call_id": "c3", "file_id": "f_local_1", "commands": [bold] * 31},
        ctx,
    )
    assert limited.text().endswith(
        "Not applied: the command at index 30 (counting from 0), past the limit of "
        "30 formatted spans a call; send them in another call."
    )


async def test_a_deck_reads_by_slide_and_a_stale_shape_write_shows_its_text(run):
    import office

    deck = (
        Path(__file__).resolve().parents[2] / "e2e/fixtures/files/basic/lesson.pptx"
    ).read_bytes()
    run.setdefault("office", {})["f_local_deck"] = {
        "id": "f_local_deck",
        "name": "lesson.pptx",
        "format": "pptx",
        "chapter_id": None,
        "base": deck,
        "checkpoint": await office.call("seedOffice", "pptx", office.wire(deck)),
        "edits": [],
    }
    ctx = tools.ToolContext(
        workspace_id="ws_playground",
        user_id="playground",
        operations=frozenset({"source.read", "document.edit"}),
        assistant_message_id="run",
        office_tools=True,
    )
    ctx.skills_read = {"editing", "office_building"}
    slides = (
        await tools.run("inspect_office_document", {"file_id": "f_local_deck"}, ctx)
    ).text_parts[0]
    assert "1. [slide:0:" in slides and "2. [slide:1:" in slides
    assert ": Owner sentence: The launch code is LARCH-17." in slides
    read = (
        await tools.run(
            "inspect_office_document", {"file_id": "f_local_deck", "slide": 1}, ctx
        )
    ).text_parts[0]
    lines = read.splitlines()
    owner = next(i for i, line in enumerate(lines) if line.endswith("LARCH-17."))
    shape = next(
        line.split("]")[0][1:]
        for line in reversed(lines[:owner])
        if not line.startswith("  ")
    )
    text = "Owner sentence: The launch code is LARCH-17."

    written = await tools.run(
        "edit_office_document",
        {
            "_tool_call_id": "c1",
            "file_id": "f_local_deck",
            "commands": [
                {
                    "type": "set_shape_text",
                    "shape_id": shape,
                    "expected_text": text,
                    "paragraphs": ["First point", "Second point"],
                }
            ],
        },
        ctx,
    )
    assert not written.refused, written.error
    read = (
        await tools.run(
            "inspect_office_document", {"file_id": "f_local_deck", "slide": 1}, ctx
        )
    ).text_parts[0]
    assert "] First point\n" in read and "] Second point\n" in read

    stale = await tools.run(
        "edit_office_document",
        {
            "_tool_call_id": "c2",
            "file_id": "f_local_deck",
            "commands": [
                {
                    "type": "set_shape_text",
                    "shape_id": shape,
                    "expected_text": text,
                    "paragraphs": ["x"],
                }
            ],
        },
        ctx,
    )
    assert stale.refused and stale.error_code == "stale_target"
    assert f"Shape {shape} now reads:\nFirst point\nSecond point" in stale.detail
