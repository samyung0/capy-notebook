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

    async def reload_pending(_ctx, _changed):
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
                {"type": "delete_paragraph", "id": method, "expected_text": "Methods"}
            ],
        },
        ctx,
    )
    assert stale.refused and stale.error_code == "stale_target"
    assert f"Paragraph {method} now reads:\nMethod" in stale.detail
