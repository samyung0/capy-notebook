"""Skills: listed on read_skill, read on demand, and required by the writes
that need them while their text is still in the request."""

from __future__ import annotations

from pipeline.retrieval import contract, skills, tools
from pipeline.retrieval.tools import ToolContext

_EDITOR = frozenset(
    {"source.read", "material.read", "material.create", "document.edit"}
)


async def test_read_skill_lists_the_skills_and_returns_the_formats():
    ctx = ToolContext(workspace_id="ws", user_id="u", operations=_EDITOR)
    described = next(
        s["function"]["description"]
        for s in tools.schemas_for(ctx)
        if s["function"]["name"] == "read_skill"
    )
    for name, skill in skills.SKILLS.items():
        assert f"- {name}: {skill.when}." in described

    text = (await tools._read_skill({"name": "workspace_building"}, ctx)).text()
    assert text.startswith("# Skill: workspace_building\n")
    assert contract.FORMATS["question"] in text and contract.FORMATS["note"] in text
    editing = (await tools._read_skill({"name": "editing"}, ctx)).text()
    assert "Ledger and budget" in editing and "Pass excerpt_ids" not in editing
    ctx.library = True
    assert (
        "Practice from the library"
        in (await tools._read_skill({"name": "workspace_building"}, ctx)).text()
    )
    assert (
        "Pass excerpt_ids" in (await tools._read_skill({"name": "editing"}, ctx)).text()
    )
    assert (await tools._read_skill({"name": "nope"}, ctx)).refused


async def test_writes_need_the_skill_while_its_text_is_in_the_request(monkeypatch):
    monkeypatch.setattr(tools, "_gateway_ready", lambda: True)
    ctx = ToolContext(workspace_id="ws", user_id="u", operations=_EDITOR)

    refused = await tools.run("create_material", {"kind": "note", "content": "x"}, ctx)
    assert refused.refused
    assert (
        'read_skill({"name": "editing"}) and read_skill({"name": "workspace_building"})'
        in (refused.text())
    )

    read = skills.render("editing", "instructions")
    messages = [{"role": "tool", "tool_call_id": "c1", "content": read}]
    assert skills.retained(messages) == {"editing"}
    # A turn note that folded the result away drops the skill again.
    assert skills.retained([{"role": "user", "content": read}]) == set()

    note = {"type": "insert_markdown", "after_block_id": None, "markdown": "x"}
    fix = {"type": "replace_text", "expected_text": "a", "text": "b"}
    # A plain edit needs the basics only; new note sections need the formats too.
    assert skills.missing("edit_document", {"commands": [fix]}, set()) == ["editing"]
    assert skills.missing("edit_document", {"commands": [note]}, {"editing"}) == [
        "workspace_building"
    ]
    assert skills.missing("create_material", {}, set(skills.SKILLS)) == []
