"""Skills: listed on read_skill, read on demand, and required by the writes
that need them while their text is still in the request."""

from __future__ import annotations

from pipeline.retrieval import contract, evidence, skills, tools
from pipeline.retrieval.tools import ToolContext

_EDITOR = frozenset(
    {"source.read", "material.read", "material.create", "document.edit"}
)


async def test_read_skill_lists_the_skills_and_returns_the_formats():
    ctx = ToolContext(workspace_id="ws", user_id="u", operations=_EDITOR)

    def described() -> str:
        return next(
            s["function"]["description"]
            for s in tools.schemas_for(ctx)
            if s["function"]["name"] == "read_skill"
        )

    # The output-files preference's building skill is the chapters'; the
    # other is for a request that asks for its format (Epo 2026-10-14).
    listed = described()
    assert f"- editing: {skills.SKILLS['editing'].when}." in listed
    assert f"- office_building: {skills.SKILLS['office_building'].when}." in listed
    assert "main explainers are notes." in listed
    assert "PowerPoint deck (create_deck, write_slide), only when the request" in listed
    ctx.study_preferences = {"mainFormat": "deck"}
    listed = described()
    assert "main explainers are decks." in listed
    assert "adding note sections, only when the request asks for a note" in listed

    text = (await tools._read_skill({"name": "note_building"}, ctx)).text()
    assert text.startswith("# Skill: note_building\n")
    assert contract.FORMATS["note"] in text and "Quizzes: add_questions" not in text
    editing = (await tools._read_skill({"name": "editing"}, ctx)).text()
    assert "Budget:" in editing and "excerpt_ids are" not in editing
    assert "add_questions" in editing and "Flashcards:" in editing
    assert "Edits not yet in search show up as hints" in editing
    office = (await tools._read_skill({"name": "office_building"}, ctx)).text()
    assert (
        "a call's commands up to 256 KB, writing up to 10,000 cells; split larger edits"
        in office
    )
    ctx.library = True
    assert (
        "Practice from the library"
        in (await tools._read_skill({"name": "note_building"}, ctx)).text()
    )
    assert (
        "excerpt_ids are" in (await tools._read_skill({"name": "editing"}, ctx)).text()
    )
    assert (await tools._read_skill({"name": "nope"}, ctx)).refused


async def test_writes_need_the_skill_while_its_text_is_in_the_request(monkeypatch):
    monkeypatch.setattr(tools, "_gateway_ready", lambda: True)
    ctx = ToolContext(workspace_id="ws", user_id="u", operations=_EDITOR)

    refused = await tools.run("create_material", {"kind": "note", "content": "x"}, ctx)
    assert refused.refused
    # The refusal carries both skills, which count as read once it is in the
    # request; only the short refusal is the error the chat stores.
    assert refused.error == skills.refusal(["editing", "note_building"])
    building = skills.render(
        "note_building", skills.SKILLS["note_building"].text(False)
    )
    assert refused.text().endswith(building)
    carried = [{"role": "tool", "tool_call_id": "c0", "content": refused.text()}]
    assert skills.retained(carried) == {"editing", "note_building"}

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
        "note_building"
    ]
    rewrite = {
        "type": "replace_block",
        "block_id": "b",
        "expected_text": "a",
        "markdown": "b",
    }
    assert skills.missing("edit_document", {"commands": [rewrite]}, {"editing"}) == [
        "note_building"
    ]
    assert skills.missing("create_material", {}, set(skills.SKILLS)) == []
    # Only a note needs note_building; a quiz or flashcards need editing alone.
    cards = {"kind": "flashcards", "cards": []}
    assert skills.missing("create_material", cards, set()) == ["editing"]
    assert skills.missing("add_questions", {}, set()) == ["editing"]


async def test_a_later_turn_replays_the_skills_an_earlier_turn_read():
    ctx = ToolContext(workspace_id="ws", user_id="u", operations=_EDITOR)
    ctx.skills_read = {"editing", "note_building"}
    saved = evidence.pack(ctx, [])
    assert saved["skills"] == ["editing", "note_building"]

    def turn(n):
        return [
            {"id": f"u{n}", "role": "user", "content": "Make a note"},
            {
                "id": f"a{n}",
                "role": "assistant",
                "content": "Done",
                "toolEvidence": saved,
            },
        ]

    history = await evidence.history_turns([*turn(1), *turn(2)], ctx)
    replayed = [m for m in history if m.get("_kind") == "skill"]
    # Once each, where first read, with the current text.
    assert [m["id"] for m in replayed] == ["a1", "a1"]
    assert replayed[0]["content"] == skills.render(
        "editing", skills.SKILLS["editing"].text(False)
    )
    assert skills.retained(history) == {"editing", "note_building"}
