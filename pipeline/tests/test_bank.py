"""Question bank tools over the gateway: exams and subjects in the tool
description, a subject's topics, a topic's questions a page at a time, cards
that show what a question asks, and copies made by the gateway."""

from __future__ import annotations

from pipeline.retrieval import bank, tools


def _question(qid: str, stem: str, asks: str) -> dict:
    content = {
        "id": qid,
        "stem": [{"type": "text", "text": stem}] if stem else [],
        "parts": [{"blocks": [{"type": "text", "text": asks}], "marks": 2}],
    }
    return {"id": qid, "question": content, "answerTypes": ["matching"]}


def test_a_card_shows_the_passage_opening_then_what_is_asked():
    passage = "The nineteenth century is a period often called the Romantic era. " * 4
    text = bank.card(
        _question("q1", passage, "Choose the correct heading for each paragraph.")
    )
    head, opening, asks = text.split("\n")
    assert head == "q1 · 1 part, 2 marks · matching"
    assert opening.startswith("The nineteenth century") and opening.endswith("…")
    assert asks == "Choose the correct heading for each paragraph."


def _gateway(monkeypatch):
    """The gateway's bank routes, as Go answers them."""
    seen: list[tuple[str, dict]] = []

    async def read(path, payload, failure):
        seen.append((path, payload))
        if path.endswith("/bank/read"):
            return {
                "id": payload["questionId"],
                "question": {"id": "q1"},
                "sources": [],
                "exam": "IELTS",
                "subject": "Academic Reading",
                "topic": "Headings",
            }
        if payload.get("topicId"):
            if payload["topicId"] != "ielts-headings":
                return tools._refused(
                    "Could not list: No bank topic.", code="unavailable_target"
                )
            if payload.get("answerType") not in (None, "matching"):
                return {"total": 0, "questions": []}
            offset = payload["offset"]
            rows = [
                _question(f"q{n}", "", "Choose a heading.")
                for n in range(offset, min(offset + bank.PAGE, 60))
            ]
            return {"total": 60, "questions": rows}
        if payload.get("subjectId"):
            return {
                "topics": [
                    {
                        "id": "ielts-headings",
                        "label": "Choosing paragraph headings",
                        "questions": 60,
                    }
                ]
            }
        return {
            "subjects": [
                {
                    "exam": "hkdse",
                    "examLabel": "HKDSE",
                    "id": "hkdse-maths",
                    "label": "Mathematics",
                    "questions": 900,
                },
                {
                    "exam": "ielts",
                    "examLabel": "IELTS",
                    "id": "ielts-reading",
                    "label": "Academic Reading",
                    "questions": 198,
                },
            ]
        }

    monkeypatch.setattr(tools, "_gateway_read", read)
    monkeypatch.setattr(tools, "_gateway_ready", lambda: True)
    return seen


async def test_listing_walks_exams_subjects_topics_and_pages(monkeypatch):
    _gateway(monkeypatch)
    ctx = tools.ToolContext(
        workspace_id="ws",
        user_id="u",
        operations=frozenset({"library.read", "material.create"}),
        library=True,
    )

    # The exams and subjects ride in the description, as calls to make.
    await tools.load_bank_catalog(ctx)
    described = {
        s["function"]["name"]: s["function"]["description"]
        for s in tools.schemas_for(ctx)
    }
    assert (
        '- list_question_bank({"subject": "ielts-reading"}): IELTS Academic Reading '
        "(198 questions)"
    ) in described["list_question_bank"]
    assert "copy_questions" in described, "copying goes with the bank tools"

    listed = (await tools._list_question_bank({"subject": "ielts-reading"}, ctx)).text()
    assert "- ielts-headings: Choosing paragraph headings · 60 questions" in listed

    # A subject passed with its topic is ignored: the topic id is enough.
    first = (
        await tools._list_question_bank(
            {"subject": "ielts-reading", "topic": "ielts-headings"}, ctx
        )
    ).text()
    assert first.startswith("Topic ielts-headings: questions 1-50 of 60.")
    assert first.endswith("Next page: offset 50.")
    last = (
        await tools._list_question_bank({"topic": "ielts-headings", "offset": 50}, ctx)
    ).text()
    assert "questions 51-60 of 60." in last and "Next page" not in last

    for args in ({}, {"topic": "nope"}, {"topic": "ielts-headings", "offset": 60}):
        refused = await tools._list_question_bank(args, ctx)
        assert refused.refused, args
    assert (
        "IELTS · Academic Reading"
        in (await tools._read_question({"question_id": "q1"}, ctx)).text()
    )


async def test_an_answer_type_narrows_a_topic_page(monkeypatch):
    seen = _gateway(monkeypatch)
    ctx = tools.ToolContext(
        workspace_id="ws", user_id="u", operations=frozenset({"library.read"})
    )
    args = {"topic": "ielts-headings", "answer_type": "matching"}
    typed = (await tools._list_question_bank(args, ctx)).text()
    assert seen[-1][1]["answerType"] == "matching"
    assert typed.startswith("Topic ielts-headings: matching questions 1-50")

    missing = await tools._list_question_bank(
        {"topic": "ielts-headings", "answer_type": "gaps"}, ctx
    )
    assert missing.refused and "without answer_type" in missing.text()
    # The filter narrows a topic's page; a subject alone is refused before Go.
    calls = len(seen)
    no_topic = await tools._list_question_bank(
        {"subject": "ielts-reading", "answer_type": "matching"}, ctx
    )
    assert no_topic.refused and len(seen) == calls


async def test_without_a_bank_the_tools_are_not_offered(monkeypatch):
    async def unavailable(path, payload, failure):
        return tools._refused("not configured", code="unavailable_target")

    monkeypatch.setattr(tools, "_gateway_read", unavailable)
    monkeypatch.setattr(tools, "_gateway_ready", lambda: True)
    ctx = tools.ToolContext(
        workspace_id="ws",
        user_id="u",
        operations=frozenset({"library.read"}),
        library=True,
    )
    await tools.load_bank_catalog(ctx)
    names = {s["function"]["name"] for s in tools.schemas_for(ctx)}
    assert ctx.bank_catalog == [] and not names & set(tools.BANK_TOOLS)


async def test_copy_questions_asks_the_gateway_and_completes_its_todo(monkeypatch):
    posted: list[tuple[str, dict]] = []

    async def post(path, payload, op_id, ctx, *, failure):
        posted.append((path, payload))
        effect = {
            "operation": "created",
            "resource": {"kind": "material", "id": "mat_q", "title": "Reading"},
        }
        return tools.ToolResult(text_parts=["Created quiz."], effects=[effect])

    monkeypatch.setattr(tools, "_post_operation", post)
    ctx = tools.ToolContext(workspace_id="ws", user_id="u", assistant_message_id="m1")
    await tools._create_ledger({"todos": ["Reading quiz"]}, ctx)
    ctx.ledger.note_read(
        "exc_1", 0, "1.1"
    )  # a library read asks copies for no excerpts
    for args in (
        {"question_ids": ["q1"], "_tool_call_id": "c0", "todo": 0},
        {
            "question_ids": ["q1"],
            "title": "T",
            "quiz_id": "x",
            "_tool_call_id": "c0",
            "todo": 0,
        },
        {
            "question_ids": ["q1"],
            "quiz_id": "x",
            "chapter_id": "c",
            "_tool_call_id": "c0",
            "todo": 0,
        },
    ):
        assert (await tools._copy_questions(args, ctx)).refused, args
    made = await tools._copy_questions(
        {
            "question_ids": ["q1", "q2"],
            "title": "Reading",
            "_tool_call_id": "c1",
            "todo": 0,
        },
        ctx,
    )
    assert not made.refused and ctx.ledger.todo(0).done
    path, payload = posted[-1]
    assert path == "/api/internal/bank/copy"
    assert payload["questionIds"] == ["q1", "q2"] and payload["quizId"] == ""
