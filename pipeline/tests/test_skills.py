"""Skills: listed on read_skill, read on demand, and required by the writes
that use their formats while their text is still in the request."""

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
    assert f"- materials: {skills.SKILLS['materials'].when}." in described

    text = (await tools._read_skill({"name": "materials"}, ctx)).text()
    assert text.startswith("# Skill: materials\n")
    assert contract.FORMATS["question"] in text and contract.FORMATS["note"] in text
    assert "Writing from the library" not in text
    ctx.library = True
    assert (
        "Writing from the library"
        in (await tools._read_skill({"name": "materials"}, ctx)).text()
    )
    assert (await tools._read_skill({"name": "nope"}, ctx)).refused


async def test_writes_need_the_skill_while_its_text_is_in_the_request(monkeypatch):
    monkeypatch.setattr(tools, "_gateway_ready", lambda: True)
    ctx = ToolContext(workspace_id="ws", user_id="u", operations=_EDITOR)

    refused = await tools.run("create_material", {"kind": "note", "content": "x"}, ctx)
    assert refused.refused and 'read_skill({"name": "materials"})' in refused.text()

    read = skills.render("materials", "instructions")
    messages = [{"role": "tool", "tool_call_id": "c1", "content": read}]
    assert skills.retained(messages) == {"materials"}
    # A turn note that folded the result away drops the skill again.
    assert skills.retained([{"role": "user", "content": read}]) == set()

    note = {"type": "insert_markdown", "after_block_id": None, "markdown": "x"}
    fix = {"type": "replace_text", "expected_text": "a", "text": "b"}
    assert skills.missing("edit_document", {"commands": [note]}, set()) == "materials"
    assert skills.missing("edit_document", {"commands": [fix]}, set()) is None
    assert skills.missing("create_material", {}, {"materials"}) is None
