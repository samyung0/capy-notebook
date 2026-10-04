"""Question bank listing: exams and subjects in the tool description, a
subject's topics, a topic's questions a page at a time, and cards that show
what a question asks."""

from __future__ import annotations

from pipeline.retrieval import bank, tools


def _question(qid: str, stem: str, asks: str) -> dict:
    content = {
        "id": qid,
        "stem": [{"type": "text", "text": stem}] if stem else [],
        "parts": [{"blocks": [{"type": "text", "text": asks}], "marks": 2}],
    }
    return {
        "id": qid,
        "content": content,
        "question_types": ["matching_headings"],
        "sources": [],
        "topic_id": "ielts-headings",
        "topic": "Choosing paragraph headings",
        "subject": "Academic Reading",
        "exam": "ielts",
    }


def test_a_card_shows_the_passage_opening_then_what_is_asked():
    passage = "The nineteenth century is a period often called the Romantic era. " * 4
    text = bank.card(
        _question("q1", passage, "Choose the correct heading for each paragraph.")
    )
    head, opening, asks = text.split("\n")
    assert head == "q1 · 1 part, 2 marks · matching_headings"
    assert opening.startswith("The nineteenth century") and opening.endswith("…")
    assert asks == "Choose the correct heading for each paragraph."


async def test_listing_walks_exams_subjects_topics_and_pages(monkeypatch):
    async def _subjects():
        return [
            {
                "exam": "hkdse",
                "exam_label": "HKDSE",
                "id": "hkdse-maths",
                "label": "Mathematics",
                "questions": 900,
            },
            {
                "exam": "ielts",
                "exam_label": "IELTS",
                "id": "ielts-reading",
                "label": "Academic Reading",
                "questions": 198,
            },
        ]

    async def _topics(subject_id):
        if subject_id != "ielts-reading":
            return []
        return [
            {
                "id": "ielts-headings",
                "label": "Choosing paragraph headings",
                "questions": 60,
            }
        ]

    async def _questions(topic_id, offset):
        if topic_id != "ielts-headings":
            return 0, []
        rows = [
            _question(f"q{n}", "", "Choose a heading.")
            for n in range(offset, min(offset + bank.PAGE, 60))
        ]
        return 60, rows

    monkeypatch.setattr(bank, "subjects", _subjects)
    monkeypatch.setattr(bank, "topics", _topics)
    monkeypatch.setattr(bank, "questions", _questions)
    monkeypatch.setattr(bank, "enabled", lambda: True)
    ctx = tools.ToolContext(
        workspace_id="ws", operations=frozenset({"library.read"}), library=True
    )

    # The exams and subjects ride in the description, as calls to make.
    await tools.load_bank_catalog(ctx)
    described = next(
        s["function"]["description"]
        for s in tools.schemas_for(ctx)
        if s["function"]["name"] == "list_question_bank"
    )
    assert (
        '- list_question_bank({"subject": "ielts-reading"}): IELTS Academic Reading '
        "(198 questions)"
    ) in described

    listed = (await tools._list_question_bank({"subject": "ielts-reading"}, ctx)).text()
    assert "- ielts-headings: Choosing paragraph headings · 60 questions" in listed

    # A subject passed with its topic is ignored: the topic id is enough.
    first = (
        await tools._list_question_bank(
            {"subject": "ielts-reading", "topic": "ielts-headings"}, ctx
        )
    ).text()
    assert first.startswith(
        "ielts · Academic Reading · Choosing paragraph headings: questions 1-50 of 60."
    )
    assert first.endswith("Next page: offset 50.")
    last = (
        await tools._list_question_bank({"topic": "ielts-headings", "offset": 50}, ctx)
    ).text()
    assert "questions 51-60 of 60." in last and "Next page" not in last

    for args in (
        {},
        {"subject": "nope"},
        {"topic": "nope"},
        {"topic": "ielts-headings", "offset": 60},
    ):
        refused = await tools._list_question_bank(args, ctx)
        assert refused.refused, args
