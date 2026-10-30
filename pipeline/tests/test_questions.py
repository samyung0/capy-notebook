"""Agent-written questions: the three small shapes in one add_questions call,
every problem named with its path, what was expected and what was sent,
add_questions saving its valid questions, and a note's quiz fences
(retrieval/questions.py)."""

from __future__ import annotations

import json
from pathlib import Path

from pipeline.retrieval import library, questions, tools
from pipeline.retrieval.tools import QuizStore, ToolContext, ToolResult

# Go's agenttools test validates these as a quiz (TestExpandedQuestionsAreValid).
EXPANDED = (
    Path(__file__).resolve().parents[2]
    / "server/internal/agenttools/testdata/expanded_questions.json"
)

MCQ = {
    "question": "Which ion rushes into the axon during depolarisation?",
    "options": ["Sodium", "Potassium", "Chloride"],
    "correct": "Sodium",
    "explanation": "Voltage-gated sodium channels open first.",
}
SHORT = {
    "question": "What is the resting potential?",
    "accepted": ["-70"],
    "unit": "mV",
}
OPEN = {
    "question": "Explain why the action potential travels one way.",
    "marks": 2,
    "markscheme": [
        {"text": "The membrane behind is refractory", "marks": 1},
        {"text": "Sodium channels there cannot reopen yet", "marks": 1},
    ],
    "model_answer": "The patch behind is refractory: its sodium channels are inactivated.",
    "hints": ["What state are the channels behind in?"],
}
PLOT = {
    "type": "plot",
    "title": "Action potential",
    "xTitle": "Time (ms)",
    "yTitle": "Membrane potential (mV)",
    "series": [{"name": "Vm", "points": [[0, -70], [1, 30], [2, -80], [4, -70]]}],
}
CHART = {
    "type": "chart",
    "kind": "bar",
    "title": "Ion concentrations",
    "labels": ["Na+", "K+"],
    "series": [{"name": "Outside (mM)", "values": [145, 5]}],
}


def _expanded() -> list[dict]:
    ids = iter(questions.question_id("m_1", "call_1", n) for n in range(5))
    return [
        questions.expand("mcq", MCQ, next(ids)),
        questions.expand("short", SHORT, next(ids)),
        questions.expand("open", OPEN, next(ids)),
        questions.with_media(
            questions.expand("mcq", {**MCQ, "explanation": ""}, next(ids)), PLOT
        ),
        questions.with_media(
            questions.expand(
                "short", {"question": "Name the ion.", "accepted": ["K+"]}, next(ids)
            ),
            CHART,
        ),
    ]


def test_the_shapes_expand_into_the_question_format_go_accepts():
    """The server fills ids, one part, 1 mark for a simple question, paper
    layout, letter labels and the solution from the explanation (empty without
    one); the fixture is what Go validates."""
    expanded = _expanded()
    assert expanded == json.loads(EXPANDED.read_text(encoding="utf-8"))
    mcq, short, open_ = expanded[:3]
    answer = mcq["parts"][0]["answer"]
    # Options are shuffled by the question id: the same order on a retry, and
    # the correct index follows the option.
    assert sorted(answer["options"]) == sorted(MCQ["options"])
    assert answer["options"][answer["correct"][0]] == "Sodium"
    assert answer == questions.expand("mcq", MCQ, mcq["id"])["parts"][0]["answer"]
    assert any(
        questions.expand("mcq", MCQ, f"q_{n}")["parts"][0]["answer"]["correct"] != [0]
        for n in range(8)
    ), "the written first option does not stay first"
    assert mcq["parts"][0]["solution"] == [
        {"type": "text", "text": "Voltage-gated sodium channels open first."}
    ]
    assert short["parts"][0]["solution"] == [] and short["parts"][0]["marks"] == 1
    assert open_["parts"][0]["answer"]["accepted"] == [OPEN["model_answer"]]
    # Without a model_answer the part has no sample answer (Epo 2026-10-15).
    bare = {k: v for k, v in OPEN.items() if k != "model_answer"}
    assert questions.expand("open", bare, "q_9")["parts"][0]["answer"]["accepted"] == []
    assert [b["type"] for b in expanded[3]["parts"][0]["blocks"]] == ["text", "plot"]


def test_a_call_names_every_problem_with_its_path_and_the_shape_to_copy():
    found = questions.check(
        {
            "quiz_id": "mat_1",
            "questions": [
                MCQ,
                {**MCQ, "markscheme": [{"text": "a", "marks": 1}]},
                {
                    "question": "Resting potential?",
                    "accepted": ["about -70"],
                    "fixedUnit": "mV",
                    "unit": "mV",
                },
                {"question": "Which ion?", "options": ["Na+", "K+"], "correct": 0},
                {"question": "Which ion?", "options": ["Na+", "K+"]},
            ],
        },
    )
    # A field outside the kind is dropped from an otherwise whole question and
    # named in the success result; a question refused anyway still names it.
    assert [i.index for i in found.valid] == [0, 1]
    assert found.notes == [
        (
            'Dropped questions[1].markscheme: unknown field, sent [{"text": "a", "marks": 1}]; '
            "a multiple-choice or short-answer question has no markscheme; a written answer "
            "marked on one is an open question"
        )
    ]
    assert found.listing().splitlines() == [
        '- questions[2].fixedUnit: unknown field, sent "mV"; the field is unit',
        (
            "- questions[2].accepted[0]: expected a plain number because unit is set "
            '(like "9.8", "-70" or "3/4"); sent "about -70"'
        ),
        (
            "- questions[3].correct: expected text, the correct option copied exactly "
            "(not its index); sent 0"
        ),
        (
            "- questions[4].correct: missing; expected the one correct option, copied "
            "exactly from options"
        ),
        questions.SHAPES["short"],
        questions.SHAPES["mcq"],
    ]


def test_the_correct_option_and_an_open_questions_marks_are_checked():
    found = questions.check(
        {"title": "T", "questions": [{**MCQ, "correct": "sodium"}, {"question": "?"}]},
    )
    assert found.items[0].problems == [
        (
            'questions[0].correct: expected one of the options, copied exactly: "Sodium", '
            '"Potassium", "Chloride"; sent "sodium"'
        )
    ]
    assert found.items[0].structural is False
    assert found.items[1].problems == [
        (
            "questions[1]: expected a multiple-choice question (options and correct), a "
            "short answer (accepted) or an open question (marks and markscheme); "
            "sent the fields question"
        )
    ]
    # model_answer is optional (Epo 2026-10-15): only the marks are named.
    unsure = {k: v for k, v in OPEN.items() if k != "model_answer"}
    opened = questions.check(
        {"quiz_id": "mat_1", "questions": [{**unsure, "marks": 3}]}
    )
    assert opened.call == [] and opened.items[0].problems == [
        (
            "questions[0].markscheme: expected item marks adding up to marks (3); sent "
            "items adding up to 2"
        ),
    ]
    # An open question carrying options is still open: options is named, and
    # the open shape is the one to copy.
    stray = questions.check({"title": "T", "questions": [{**OPEN, "options": ["a"]}]})
    assert stray.listing().splitlines() == [
        (
            '- questions[0].options: unknown field, sent ["a"]; an open question has no '
            "options; multiple choice is its own question, worth 1 mark"
        ),
        questions.SHAPES["open"],
    ]
    both = questions.check({"questions": [OPEN], "title": "T", "quiz_id": "q"})
    assert both.call == [
        (
            "quiz_id, title: expected exactly one, quiz_id to add to a quiz or title to "
            "create one; sent both"
        )
    ]
    # Every place problem at once, not the first of them.
    placed = questions.check({"questions": [MCQ], "chapter_id": "ch"})
    assert placed.call == [
        (
            "quiz_id, title: expected exactly one, quiz_id to add to a quiz or title to "
            "create one; sent neither"
        ),
        (
            "chapter_id: files a new quiz, so it goes with title; adding to a quiz takes "
            "quiz_id alone"
        ),
    ]


def test_a_blank_field_is_left_out_unless_the_kind_needs_it():
    """Blank means absent (null, "", "null", [] or {}): the 2026-10-13 runs
    sent accepted: [] on multiple choice, unit: "", back: "", quiz_id: "" and
    "null". A field the question's kind needs stays, so it keeps its own
    message; an unknown field with content is dropped and named."""
    sent = {
        "title": "T",
        "quiz_id": "null",
        "chapter_id": "",
        "questions": [
            {**MCQ, "accepted": [], "unit": "", "explanation": None, "back": ""},
            {**SHORT, "accepted": [], "options": None},
            {**MCQ, "back": "Sodium"},
        ],
    }
    clean = questions.drop_blanks("add_questions", sent)
    mcq = {k: v for k, v in MCQ.items() if k != "explanation"}
    assert clean == {
        "title": "T",
        "questions": [mcq, {**SHORT, "accepted": []}, {**MCQ, "back": "Sodium"}],
    }
    found = questions.check(clean)
    assert found.call == [] and [i.kind for i in found.items] == ["mcq", "short", "mcq"]
    assert [i.problems for i in found.items] == [
        [],
        ["questions[1].accepted: expected at least 1 items; sent 0"],
        [],
    ]
    assert found.notes == ['Dropped questions[2].back: unknown field, sent "Sodium"']
    # A quiz fence's question too, and media by its block's schema.
    assert questions.drop_question_blanks({**OPEN, "hints": [], "unit": "null"}) == {
        k: v for k, v in OPEN.items() if k != "hints"
    }
    # YAML's ~ (null) reads as text in a fence; it is blank too.
    assert questions.drop_question_blanks({**SHORT, "unit": "~"}) == {
        k: v for k, v in SHORT.items() if k != "unit"
    }
    media = {
        "quiz_id": "q",
        "question_id": "q1",
        "media": {**CHART, "title": "", "xTitle": ""},
    }
    assert questions.drop_blanks("add_question_media", media)["media"] == {
        **CHART,
        "title": "",
    }


def test_an_accepted_answer_written_with_its_unit_keeps_the_number():
    found = questions.check(
        {
            "title": "T",
            "questions": [
                {"question": "Rate?", "accepted": ["5%", "5 %", "5"], "unit": "%"},
                {**SHORT, "accepted": ["-70mV", "about -70 mV"]},
            ],
        },
    )
    assert found.items[0].problems == [] and found.items[0].value["accepted"] == ["5"]
    assert found.items[1].value["accepted"] == ["-70", "about -70 mV"]
    assert found.items[1].problems == [
        (
            "questions[1].accepted[1]: expected a plain number because unit is set "
            '(like "9.8", "-70" or "3/4"); sent "about -70 mV"'
        )
    ]


def _ctx(monkeypatch) -> ToolContext:
    monkeypatch.setattr(tools, "_gateway_ready", lambda: True)
    return ToolContext(
        workspace_id="ws",
        user_id="u",
        assistant_message_id="m_1",
        operations=frozenset({"material.create", "document.edit"}),
    )


def _store(quiz: list[dict], written: list) -> QuizStore:
    async def load(quiz_id):
        if quiz_id != "mat_q":
            return tools._refused("not a quiz", code="unavailable_target")
        return "Neurons", quiz

    async def create(args, made, books):
        written.append(("create", made))
        return tools._receipt_result(
            {
                "outcome": "succeeded",
                "effect": {
                    "operation": "created",
                    "resource": {
                        "kind": "material",
                        "id": "mat_new",
                        "title": args["title"],
                    },
                },
            }
        )

    async def edit(quiz_id, commands, books, images):
        written.append(("edit", commands))
        if images:
            written.append(("figures", images))
        return tools._receipt_result(
            {
                "outcome": "succeeded",
                "effect": {
                    "operation": "edited",
                    "resource": {"kind": "material", "id": quiz_id, "title": "Neurons"},
                },
            }
        )

    return QuizStore(load, create, edit)


async def test_add_questions_saves_the_valid_questions_and_names_the_rest(monkeypatch):
    """The valid questions land after the quiz's last question, in order; the
    left-out one is named for resending in its place. A chapter_id beside
    quiz_id is ignored and said so."""
    ctx = _ctx(monkeypatch)
    written: list = []
    store = _store([{"id": "q_old", "stem": [], "parts": []}], written)
    args = {
        "quiz_id": "mat_q",
        "chapter_id": "ch_1",
        "questions": [MCQ, {**SHORT, "accepted": ["minus seventy"]}, SHORT],
        "_tool_call_id": "call_1",
    }
    result = await tools.write_questions(args, ctx, store)

    assert result.outcome == "succeeded"
    [(kind, commands)] = written
    first, third = (questions.question_id("m_1", "call_1", n) for n in range(2))
    assert kind == "edit"
    assert [
        (c["type"], c["after_question_id"], c["question"]["id"]) for c in commands
    ] == [
        ("add_question", "q_old", first),
        ("add_question", first, third),
    ]
    text = result.text()
    assert f"- {first}: Which ion rushes into the axon during depolarisation?" in text
    assert f"send them again with quiz_id mat_q, after_question_id {first}:" in text
    assert (
        "- questions[1].accepted[0]: expected a plain number because unit is set"
        in text
    )
    assert text.endswith("chapter_id ignored: quiz mat_q keeps its chapter.")

    # Nothing valid: nothing is written and every problem comes back at once.
    refused = await tools.write_questions(
        {**args, "questions": [{"question": "?", "options": ["a"], "correct": "b"}]},
        ctx,
        store,
    )
    assert refused.refused and len(written) == 1
    assert (
        refused.error
        == "Not applied: 2 problems, listed below; fix them all and send the call again."
    )
    assert "- questions[0].options: expected at least 2 items; sent 1" in refused.text()


async def test_a_new_quiz_takes_its_first_questions_of_every_kind(monkeypatch):
    ctx = _ctx(monkeypatch)
    written: list = []
    store = _store([], written)
    result = await tools.write_questions(
        {"title": "Neurons", "questions": [MCQ, SHORT, OPEN], "_tool_call_id": "c"},
        ctx,
        store,
    )
    assert result.outcome == "succeeded"
    [(kind, made)] = written
    assert kind == "create" and [q["parts"][0]["answer"]["type"] for q in made] == [
        "mcq",
        "short",
        "open",
    ]
    assert [q["parts"][0]["marks"] for q in made] == [1, 1, 2]
    assert result.text().startswith(
        "Created quiz 'Neurons' (id mat_new) with 3 question(s):"
    )

    # A quiz may start with open questions only.
    written.clear()
    second = {**OPEN, "question": "Why is conduction faster in myelinated axons?"}
    result = await tools.write_questions(
        {"title": "Essays", "questions": [OPEN, second], "_tool_call_id": "d"},
        ctx,
        store,
    )
    assert result.outcome == "succeeded", result.text()
    [(_, made)] = written
    assert [q["parts"][0]["answer"]["type"] for q in made] == ["open", "open"]


async def test_an_open_question_whose_marks_do_not_add_up_is_left_out(monkeypatch):
    ctx = _ctx(monkeypatch)
    written: list = []
    result = await tools.write_questions(
        {
            "quiz_id": "mat_q",
            "questions": [{**OPEN, "marks": 3}, MCQ],
            "_tool_call_id": "c",
        },
        ctx,
        _store([{"id": "q_old", "stem": [], "parts": []}], written),
    )
    assert result.outcome == "succeeded"
    [(_, [command])] = written
    assert command["question"]["parts"][0]["answer"]["type"] == "mcq"
    assert (
        "- questions[0].markscheme: expected item marks adding up to marks (3); sent "
        "items adding up to 2"
    ) in result.text()


async def test_media_goes_after_the_question_text(monkeypatch):
    ctx = _ctx(monkeypatch)
    written: list = []
    quiz = [questions.expand("mcq", MCQ, "q_1")]
    store = _store(quiz, written)
    added = await tools.write_media(
        {"quiz_id": "mat_q", "question_id": "q_1", "media": PLOT, "_tool_call_id": "c"},
        ctx,
        store,
    )
    assert added.outcome == "succeeded", added.text()
    [(_, [command])] = written
    assert command["type"] == "replace_question" and command["question_id"] == "q_1"
    assert [b["type"] for b in command["question"]["parts"][0]["blocks"]] == [
        "text",
        "plot",
    ]

    # A line needs two points; a scatter takes one.
    point = {**PLOT, "series": [{"name": "Vm", "points": [[0, -70]]}]}
    one = await tools.write_media(
        {
            "quiz_id": "mat_q",
            "question_id": "q_1",
            "media": point,
            "_tool_call_id": "f",
        },
        ctx,
        store,
    )
    assert one.refused and "expected 2 or more points for a line; sent 1" in one.detail
    dot = await tools.write_media(
        {
            "quiz_id": "mat_q",
            "question_id": "q_1",
            "media": {**point, "kind": "scatter"},
            "_tool_call_id": "g",
        },
        ctx,
        store,
    )
    assert dot.outcome == "succeeded", dot.text()
    # A stacked chart's extra series are cut, and the result says so.
    stacked = {
        **CHART,
        "kind": "stacked",
        "series": [*CHART["series"], {"name": "Inside", "values": [12, 140]}],
    }
    cut = await tools.write_media(
        {
            "quiz_id": "mat_q",
            "question_id": "q_1",
            "media": stacked,
            "_tool_call_id": "e",
        },
        ctx,
        store,
    )
    assert cut.outcome == "succeeded", cut.text()
    assert (
        written[-1][1][0]["question"]["parts"][0]["blocks"][-1]["series"]
        == CHART["series"]
    )
    assert "only the first was kept" in cut.text()
    # A series short of its labels is padded with null (an empty cell).
    short = {**CHART, "series": [{"name": "Outside (mM)", "values": [145]}]}
    padded = await tools.write_media(
        {
            "quiz_id": "mat_q",
            "question_id": "q_1",
            "media": short,
            "_tool_call_id": "h",
        },
        ctx,
        store,
    )
    assert padded.outcome == "succeeded", padded.text()
    block = written[-1][1][0]["question"]["parts"][0]["blocks"][-1]
    assert block["series"][0]["values"] == [145, None]
    assert "padded with null" in padded.text()

    refused = await tools.write_media(
        {
            "quiz_id": "mat_q",
            "question_id": "q_9",
            "media": {"type": "image", "url": "https://e.com/a.png"},
            "_tool_call_id": "d",
        },
        ctx,
        store,
    )
    assert refused.refused
    assert refused.detail.splitlines() == [
        '- media.type: expected "chart", "plot" or "figure"; sent "image"',
        '- question_id: expected a question id of this quiz (q_1); sent "q_9"',
    ]


async def test_a_library_figure_goes_after_the_question_text(monkeypatch):
    """A figure read this turn becomes the question's image block: its crop
    goes to Go to store as the quiz's own asset, its caption carries the
    printed credit, and the excerpt listing it is credited."""
    ctx = _ctx(monkeypatch)
    ctx.library_reads.note("e_1", 0, "1.1")
    figure = library.Figure(
        id="fig_1", book_title="B", page=3, bbox=[0, 0, 500, 500],
        label="Figure 2.1: A cell", description="", credit="CC BY 4.0", decorative=False,
        excluded=False, withheld=False, object_key="books/x.pdf", bytes=1,
        excerpt_ids=["e_1"],
    )  # fmt: skip
    credited: list = []

    async def figures(ids):
        return {i: figure for i in ids if i == "fig_1"}

    async def render(*_args):
        return b"\xff\xd8\xffjpeg", [0, 0, 500, 500], (640, 480)

    async def provenance(ids):
        credited.extend(ids)
        return [{"id": "b", "title": "B", "excerptIds": list(ids), "version": 1}]

    monkeypatch.setattr(tools.library, "figures", figures)
    monkeypatch.setattr(tools.library, "provenance", provenance)
    monkeypatch.setattr(tools.capture, "render_knowledge", render)
    written: list = []
    store = _store([questions.expand("mcq", MCQ, "q_1")], written)
    args = {"quiz_id": "mat_q", "question_id": "q_1", "_tool_call_id": "c"}

    unknown = await tools.write_media(
        {**args, "media": {"type": "figure", "id": "fig_9"}}, ctx, store
    )
    assert unknown.refused and "fig_9 is not a library figure" in unknown.text()
    long = await tools.write_media(
        {**args, "media": {"type": "figure", "id": "fig_1", "caption": "x" * 501}},
        ctx,
        store,
    )
    assert long.refused and "expected at most 500 characters; sent 501" in long.detail
    credited.clear()
    # A blank caption is absent: the printed label stands in.
    added = await tools.write_media(
        {**args, "media": {"type": "figure", "id": "fig_1", "caption": "null"}},
        ctx,
        store,
    )
    assert added.outcome == "succeeded", added.text()
    [(_, [command]), (_, images)] = written
    assert command["question"]["parts"][0]["blocks"][-1] == {
        "type": "image",
        "image": {"assetId": "figure:fig_1"},
        "width": 640,
        "height": 480,
        "description": "Figure 2.1: A cell",
        "attribution": "Figure 2.1: A cell (CC BY 4.0)",
    }
    assert images == {"fig_1": b"\xff\xd8\xffjpeg"}
    assert credited == ["e_1"], "the figure's excerpt is credited without being named"


def test_a_note_quiz_fence_takes_the_same_shapes():
    """Fence questions are YAML in the three shapes, expanded before the note
    leaves the pipeline; answers keep their text as written (0.50, No)."""
    fence = (
        "# Neurons\n\n```quiz\nquestions:\n"
        "  - question: Is a neuron at rest charged?\n    options: [Yes, No]\n    correct: No\n"
        "  - question: Resting potential?\n    accepted: [-70.0]\n    unit: mV\n"
        "  - question: Explain repolarisation.\n    marks: 1\n"
        "    markscheme:\n      - text: K+ leaves the cell\n        marks: 1\n"
        "    model_answer: Potassium flows out.\n```\n"
    )
    ids = iter(["q_a", "q_b", "q_c"])
    [text], found = questions.note_fences([fence], lambda _: "content", ids.__next__)
    assert not found.problems()
    body = json.loads(text.split("```quiz\n")[1].split("\n```")[0])
    mcq, short, open_ = body["questions"]
    answer = mcq["parts"][0]["answer"]
    assert sorted(answer["options"]) == ["No", "Yes"]
    assert answer["options"][answer["correct"][0]] == "No"
    assert short["parts"][0]["answer"]["accepted"] == ["-70.0"]
    assert open_["parts"][0]["marks"] == 1 and open_["id"] == "q_c"

    bad = fence.replace("correct: No", "correct: Maybe").replace(
        "marks: 1\n    markscheme", "markscheme"
    )
    [kept], found = questions.note_fences(
        [bad], lambda _: "content", iter(["q"] * 3).__next__
    )
    assert kept == bad
    assert found.problems() == [
        (
            "content quiz fence 1 questions[0].correct: expected one of the options, copied "
            'exactly: "Yes", "No"; sent "Maybe"'
        ),
        (
            "content quiz fence 1 questions[2].marks: missing; expected a whole number of "
            "marks from 1 to 20"
        ),
    ]
    summary, listing = questions.refusal(found)
    assert summary.startswith("Not applied: 2 problems")
    assert "A quiz fence lists its questions in YAML, in these shapes:" in listing


def _fenced(markdown: str) -> tuple[str, questions.Check]:
    [text], found = questions.note_fences(
        [markdown], lambda _: "content", iter(["q_a", "q_b"]).__next__
    )
    return text, found


def test_chart_and_plot_fences_are_repaired_where_they_mean_one_thing():
    """A plot written as YAML (4 runs), a missing type (2) and a chart kind as
    a chart fence's type (1) become the JSON the converter reads, each named
    in one line; a body that is not a mapping stays as written."""
    plot_yaml = (
        "- item\n  ```plot\n  title: Vm\n  xTitle: t\n  yTitle: V\n"
        "  series:\n    - name: a\n      points: [[0, 1], [1, 2]]\n  ```\n"
    )
    text, found = _fenced(plot_yaml)
    assert text == (
        '- item\n  ```plot\n  {"type":"plot","title":"Vm","xTitle":"t","yTitle":"V",'
        '"series":[{"name":"a","points":[[0,1],[1,2]]}]}\n  ```\n'
    )
    assert found.notes == [
        'Repaired content plot fence 1: read it from YAML; a plot fence is JSON; added "type": "plot".'
    ]
    chart = {k: v for k, v in CHART.items() if k != "kind"}
    text, found = _fenced(f"```chart\n{json.dumps({**chart, 'type': 'bar'})}\n```\n")
    assert json.loads(text.split("\n")[1]) == CHART
    assert found.notes == [
        'Repaired content chart fence 1: "type": "bar" is a chart kind, so it went to kind.'
    ]
    text, found = _fenced(f"```chart\n{json.dumps(CHART)}\n```\n")
    assert json.loads(text.split("\n")[1]) == CHART and found.notes == []
    # A pie or stacked chart keeps its first series (Epo 2026-10-14).
    inside = {"name": "Inside (mM)", "values": [12, 140]}
    pie = {**CHART, "kind": "pie", "series": [*CHART["series"], inside]}
    text, found = _fenced(f"```chart\n{json.dumps(pie)}\n```\n")
    assert json.loads(text.split("\n")[1]) == {**CHART, "kind": "pie"}
    assert found.notes == [
        (
            "Repaired content chart fence 1: a pie or stacked chart draws one "
            "series, so only the first was kept."
        )
    ]
    short = {**CHART, "series": [{"name": "Outside (mM)", "values": [145]}]}
    text, found = _fenced(f"```chart\n{json.dumps(short)}\n```\n")
    assert json.loads(text.split("\n")[1])["series"][0]["values"] == [145, None]
    assert found.notes and "padded with null" in found.notes[0]
    # Left as written, for the converter's error: a body that is not a mapping,
    # one meant as JSON ({) that is not, and YAML whose escapes made control or
    # separator characters (\a of $\alpha$, \P of $\Phi$).
    for kept in (
        "```plot\n- 1\n- 2\n```\n",
        '```chart\n{"type": "chart", "title": "Decay for $\\alpha = 0.5$"}\n```\n',
        '```plot\ntitle: "Decay for $\\alpha$"\nseries: []\n```\n',
        '```plot\ntitle: "$\\Phi$"\nseries: []\n```\n',
    ):
        assert _fenced(kept) == (kept, questions.Check(questions.FENCE)), kept


def test_quiz_and_flashcards_yaml_is_repaired_only_after_a_parse_failure():
    """Trailing commas, LaTeX backslashes in double quotes and unquoted values
    holding ": " (all seen on 2026-10-13) are repaired once a fence fails to
    parse and named in one line; a fence that parses is never touched, and one
    that still fails reports its first error."""
    quiz = (
        "```quiz\nquestions:\n"
        '  - question: "Which is $\\hat{y} = a + bx$?"\n'
        '    options: ["the fit", "the data"],\n'
        "    correct: the fit\n"
        "    explanation: Short the 5 V source; the two 10 Ω resistors are then "
        "in parallel: 10 ∥ 10 = 5 Ω.\n"
        "```\n"
    )
    text, found = _fenced(quiz)
    assert not found.problems()
    [question] = json.loads(text.split("\n")[1])["questions"]
    part = question["parts"][0]
    assert part["blocks"][0]["text"] == "Which is $\\hat{y} = a + bx$?"
    assert part["solution"][0]["text"].endswith("in parallel: 10 ∥ 10 = 5 Ω.")
    assert found.notes == [
        (
            "Repaired content quiz fence 1 (trailing commas, values holding ': ' "
            "quoted, LaTeX backslashes); a YAML line ends without a comma; quote a "
            'YAML value holding ": "; in YAML double quotes write \\\\ for a '
            "backslash."
        )
    ]

    cards = (
        "```flashcards\ncards:\n"
        '  - front: Binomial or normal: "how many of 40 seeds germinate?"\n'
        "    back: Binomial\n    hint: count\n```\n"
    )
    text, found = _fenced(cards)
    assert json.loads(text.split("\n")[1]) == {
        "cards": [
            {
                "front": 'Binomial or normal: "how many of 40 seeds germinate?"',
                "back": "Binomial",
                "hint": "count",
            }
        ]
    }
    assert found.notes[0].startswith(
        "Repaired content flashcards fence 1 (values holding ': ' quoted)"
    )

    # Once a fence fails, a comment stays a comment, a quoted phrase inside a
    # plain value keeps its literal backslash, and flow-list items are fixed.
    repaired = (
        "```quiz\nquestions:\n"
        '  - question: Evaluate "$\\sin x$" at 0\n'
        '    options: ["$\\alpha$", "$\\beta$"],\n'
        '    correct: "$\\alpha$"\n'
        "  - question: g?\n    accepted:\n      - 9.8  # rounded\n      - 9.81\n"
        "```\n"
    )
    text, found = _fenced(repaired)
    assert not found.problems(), found.problems()
    first, second = json.loads(text.split("\n")[1])["questions"]
    assert first["parts"][0]["blocks"][0]["text"] == 'Evaluate "$\\sin x$" at 0'
    assert sorted(first["parts"][0]["answer"]["options"]) == ["$\\alpha$", "$\\beta$"]
    assert second["parts"][0]["answer"]["accepted"] == ["9.8", "9.81"]
    # A body that opens as JSON keeps the commas that end its lines.
    assert questions._repair_yaml('{"a": [1],\n "b": "$\\x$"}\n') == (
        '{"a": [1],\n "b": "$\\x$"}\n',
        [],
    )
    # A longer fence holding a shorter one is passed over whole: the quiz after
    # a python fence closed by four backticks is still expanded.
    longer = "```python\nx = 1\n````\n\n```quiz\nquestions:\n  - question: Q?\n    options: [A, B]\n    correct: A\n```\n"
    text, found = _fenced(longer)
    assert '"correct": [' in text and not found.problems()

    # Parses as written: a plain value keeps its backslash, nothing is noted.
    plain = "```quiz\nquestions:\n  - question: Is $\\hat{y}$ the fit?\n    options: [Yes, No]\n    correct: Yes\n```\n"
    text, found = _fenced(plain)
    assert '"text": "Is $\\\\hat{y}$ the fit?"' in text and found.notes == []
    # Still broken: the first error, not the repaired body's, and the fence as
    # written. The trailing comma is repaired; the unclosed quote is not.
    broken = (
        "```quiz\nquestions:\n  - question: Q?\n    options: [a, b],\n"
        '    correct: a\n    explanation: "unclosed\n```\n'
    )
    text, found = _fenced(broken)
    # The parser's own reason and the line it stopped on (Epo 2026-10-14).
    assert text == broken and found.call == [
        (
            "content quiz fence 1: expected YAML; expected <block end>, but found ',' "
            "on line 3: options: [a, b],"
        )
    ], found.call
    cards_broken = "```flashcards\ncards:\n  - front: a\n```\n"
    assert _fenced(cards_broken)[0] == cards_broken


async def test_a_refused_write_also_names_its_question_problems(monkeypatch):
    """An excerpt refusal carries the call's question problems too, so one
    resend fixes both."""
    ctx = _ctx(monkeypatch)
    ctx.workspace_only = True
    result = await tools.write_questions(
        {
            "title": "T",
            "questions": [{**MCQ, "correct": "x"}],
            "excerpt_ids": ["e_1"],
            "_tool_call_id": "c",
        },
        ctx,
        _store([], []),
    )
    assert isinstance(result, ToolResult) and result.refused
    assert result.error.startswith("excerpt_ids name library excerpts")
    assert (
        "Also fix these before sending it again:\n- questions[0].correct"
        in result.detail
    )


def test_numbers_with_a_unit_accept_commas_minus_signs_and_unit_words():
    """Epo 2026-10-14: the three slips of that day's runs mean one number."""
    item = {"question": "q", "accepted": ["129,400", "\u221213 V", "190 percent"]}
    assert questions._without_unit({**item, "unit": "V"})["accepted"][1] == "-13"
    assert questions._without_unit({**item, "unit": "%"})["accepted"][2] == "190"
    assert (
        questions._without_unit({**item, "unit": "people"})["accepted"][0] == "129400"
    )
    # A comma that is not a thousands group stays and is refused as before.
    assert questions._without_unit({"accepted": ["1,5"], "unit": "m"})["accepted"] == [
        "1,5"
    ]


def test_an_inspected_quiz_fence_reads_back_as_the_items_it_was_written_from():
    """inspect_document shows a note's quiz as the fence an edit writes, so a
    section copied from it lands (Epo 2026-10-14)."""
    # An open question without a model_answer reads back without one.
    bare = {k: v for k, v in OPEN.items() if k != "model_answer"}
    items = [MCQ, SHORT, OPEN, bare]
    stored = [
        questions.expand(kind, item, f"q_{n}")
        for n, (kind, item) in enumerate(zip(("mcq", "short", "open", "open"), items))
    ]
    fence = "```quiz\n" + json.dumps({"questions": stored}) + "\n```"
    view = questions.quiz_fence_view(fence)
    ids = iter(f"q_{n}" for n in range(4))
    [text], found = questions.note_fences(
        [view + "\n"], lambda _: "content", ids.__next__
    )
    assert not found.problems(), found.problems()
    again = json.loads(text.split("\n")[1])["questions"]

    # The same items come back; multiple-choice options are reshuffled by id.
    def same(q: dict) -> dict:
        item = questions.authored(q)
        return (
            {**item, "options": sorted(item["options"])} if "options" in item else item
        )

    assert [same(q) for q in again] == [same(q) for q in stored]
    assert "model_answer" not in questions.authored(stored[3])
    # A question the fence form cannot write leaves the block as stored.
    stored[0]["stem"] = [{"type": "text", "text": "Context"}]
    assert (
        questions.quiz_fence_view(
            "```quiz\n" + json.dumps({"questions": stored}) + "\n```"
        )
        is None
    )


def test_a_fence_that_is_not_yaml_names_the_line_and_where_latex_goes():
    # The escape is repaired, the unclosed quote is not: the first error shows.
    broken = (
        '```quiz\nquestions:\n  - question: "Is $\\int$ ok?"\n    accepted: ["1"]\n'
        '    explanation: "unclosed\n```\n'
    )
    _, found = _fenced(broken)
    assert found.call == [
        (
            "content quiz fence 1: expected YAML; found unknown escape character 'i' "
            'on line 2: - question: "Is $\\int$ ok?"; in double quotes a backslash '
            "starts an escape, so write LaTeX in single quotes or a | block"
        )
    ], found.call
    # A LaTeX symbol escape is repaired like a letter one.
    spaced = '```quiz\nquestions:\n  - question: "Is $t\\,e^t$ ok?"\n    accepted: ["1"]\n```\n'
    _, found = _fenced(spaced)
    assert not found.problems() and "LaTeX backslashes" in found.notes[0]
    listed = "```html-embed\n- caption: x\n  html: |\n    <p>x</p>\n```\n"
    _, found = _fenced(listed)
    assert found.call == [
        (
            'content html-embed fence 1: expected a YAML mapping, caption: "…" and '
            "html: | on its own lines; sent a list"
        )
    ]
