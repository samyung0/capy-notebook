"""Agent-written questions: the three small shapes, every problem named with
its path, what was expected and what was sent, add_questions saving its valid
questions, and a note's quiz fences (retrieval/questions.py)."""

from __future__ import annotations

import json
from pathlib import Path

from pipeline.retrieval import questions, tools
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
    assert mcq["parts"][0]["answer"] == {
        "type": "mcq",
        "options": ["Sodium", "Potassium", "Chloride"],
        "correct": [0],
    }
    assert mcq["parts"][0]["solution"] == [
        {"type": "text", "text": "Voltage-gated sodium channels open first."}
    ]
    assert short["parts"][0]["solution"] == [] and short["parts"][0]["marks"] == 1
    assert open_["parts"][0]["answer"]["accepted"] == [OPEN["model_answer"]]
    assert [b["type"] for b in expanded[3]["parts"][0]["blocks"]] == ["text", "plot"]


def test_a_call_names_every_problem_with_its_path_and_the_shape_to_copy():
    found = questions.check(
        "add_questions",
        {
            "quiz_id": "mat_1",
            "questions": [
                MCQ,
                {**MCQ, "markscheme": [{"text": "a", "marks": 1}]},
                {
                    "question": "Resting potential?",
                    "accepted": ["-70 mV"],
                    "fixedUnit": "mV",
                    "unit": "mV",
                },
                {"question": "Which ion?", "options": ["Na+", "K+"], "correct": 0},
                {"question": "Which ion?", "options": ["Na+", "K+"]},
            ],
        },
    )
    assert [i.index for i in found.valid] == [0]
    assert found.listing().splitlines() == [
        (
            '- questions[1].markscheme: unknown field, sent [{"text": "a", "marks": 1}]; a '
            "multiple-choice or short-answer question has no markscheme; a written answer "
            "marked on one is add_open_question"
        ),
        '- questions[2].fixedUnit: unknown field, sent "mV"; the field is unit',
        (
            "- questions[2].accepted[0]: expected a plain number because unit is set "
            '(like "9.8", "-70" or "3/4"); sent "-70 mV"'
        ),
        (
            "- questions[3].correct: expected text, the correct option copied exactly "
            "(not its index); sent 0"
        ),
        (
            "- questions[4].correct: missing; expected the one correct option, copied "
            "exactly from options"
        ),
        questions.SHAPES["mcq"],
        questions.SHAPES["short"],
    ]


def test_the_correct_option_and_an_open_questions_marks_are_checked():
    found = questions.check(
        "add_questions",
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
            "questions[1]: expected a multiple-choice question (options and correct) or a "
            "short answer (accepted); sent the fields question"
        )
    ]
    opened = questions.check(
        "add_open_question",
        {
            "quiz_id": "mat_1",
            **{k: v for k, v in OPEN.items() if k != "model_answer"},
            "marks": 3,
        },
    )
    assert opened.call == [
        "model_answer: missing; expected a full-marks answer",
        "markscheme: expected item marks adding up to marks (3); sent items adding up to 2",
    ]
    created = questions.check("add_open_question", {**OPEN, "title": "T"})
    assert created.call == [
        (
            'title: unknown field, sent "T"; a new quiz starts with add_questions; add '
            "the open question to it by quiz_id"
        ),
        (
            "quiz_id: missing; expected the id of the quiz to add to (add_questions' "
            "result gives a new quiz's id)"
        ),
    ]
    # Every place problem at once, not the first of them.
    placed = questions.check("add_questions", {"questions": [MCQ], "chapter_id": "ch"})
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


def _ctx(monkeypatch) -> ToolContext:
    monkeypatch.setattr(tools, "_gateway_ready", lambda: True)
    ctx = ToolContext(
        workspace_id="ws",
        user_id="u",
        assistant_message_id="m_1",
        operations=frozenset({"material.create", "document.edit"}),
    )
    ctx.ledger.todos = [tools.LedgerTodo(id=0, text="quiz")]
    ctx.ledger.next_todo_id = 1
    return ctx


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

    async def edit(quiz_id, commands, books):
        written.append(("edit", commands))
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
    left-out one is named for resending in its place, and the todo stays open
    until it lands."""
    ctx = _ctx(monkeypatch)
    written: list = []
    store = _store([{"id": "q_old", "stem": [], "parts": []}], written)
    args = {
        "quiz_id": "mat_q",
        "todo": 0,
        "questions": [MCQ, {**SHORT, "accepted": ["minus seventy"]}, SHORT],
        "_tool_call_id": "call_1",
    }
    result = await tools.write_questions("add_questions", args, ctx, store)

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
    assert "Todo 0 stays open until they are added." in text
    assert not ctx.ledger.todos[0].done

    # Nothing valid: nothing is written and every problem comes back at once.
    refused = await tools.write_questions(
        "add_questions",
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


async def test_a_new_quiz_takes_its_first_questions_and_completes_the_todo(monkeypatch):
    ctx = _ctx(monkeypatch)
    written: list = []
    result = await tools.write_questions(
        "add_questions",
        {
            "title": "Neurons",
            "todo": 0,
            "questions": [MCQ, SHORT],
            "_tool_call_id": "c",
        },
        ctx,
        _store([], written),
    )
    assert result.outcome == "succeeded" and ctx.ledger.todos[0].done
    [(kind, made)] = written
    assert kind == "create" and [q["parts"][0]["answer"]["type"] for q in made] == [
        "mcq",
        "short",
    ]
    assert result.text().startswith(
        "Created quiz 'Neurons' (id mat_new) with 2 question(s):"
    )


async def test_media_goes_after_the_question_text(monkeypatch):
    ctx = _ctx(monkeypatch)
    ctx.ledger.todos = []
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

    refused = await tools.write_media(
        {
            "quiz_id": "mat_q",
            "question_id": "q_9",
            "media": {"type": "figure", "id": "fig_1"},
            "_tool_call_id": "d",
        },
        ctx,
        store,
    )
    assert refused.refused
    assert refused.detail.splitlines() == [
        (
            '- media.type: expected "chart", "plot" or "graph" (library figures go into '
            'notes only); sent "figure"'
        ),
        '- question_id: expected a question id of this quiz (q_1); sent "q_9"',
    ]


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
    assert mcq["parts"][0]["answer"] == {
        "type": "mcq",
        "options": ["Yes", "No"],
        "correct": [1],
    }
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


async def test_a_refused_write_also_names_its_question_problems(monkeypatch):
    """A ledger refusal carries the call's question problems too, so one resend
    fixes both."""
    ctx = _ctx(monkeypatch)
    result = await tools.write_questions(
        "add_questions",
        {"title": "T", "questions": [{**MCQ, "correct": "x"}], "_tool_call_id": "c"},
        ctx,
        _store([], []),
    )
    assert isinstance(result, ToolResult) and result.refused
    assert result.error.startswith("add_questions needs todo")
    assert (
        "Also fix these before sending it again:\n- questions[0].correct"
        in result.detail
    )
