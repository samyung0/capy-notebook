"""Make a quiz: recording page windows, pairing the mark scheme by label, and
the run's report (pipeline.retrieval.extraction)."""

from __future__ import annotations

import json
from types import SimpleNamespace

import pytest

from pipeline.registry import ModelConfig
from pipeline.retrieval import extraction

MODEL = ModelConfig(
    version=1,
    provider_name="DeepSeek",
    model_name="Flash",
    provider_slug="deepseek",
    model_slug="deepseek-flash",
    thinking_levels=("instant", "low"),
    default_thinking="low",
    context_window_tokens=1_000_000,
)


def _text(text: str) -> list[dict]:
    return [{"type": "text", "text": text}]


def _mcq(label: str, options: list[str]) -> dict:
    return {
        "label": label,
        "stem": [],
        "parts": [
            {
                "label": "",
                "blocks": _text(f"Question {label}"),
                "answer": {"type": "mcq", "options": options},
                "marks": 1,
            }
        ],
    }


def _open(label: str, parts: list[tuple[str, int]]) -> dict:
    return {
        "label": label,
        "stem": _text("Given f(x)."),
        "parts": [
            {
                "label": part,
                "blocks": _text(f"Find {part}."),
                "answer": {"type": "open"},
                "marks": marks,
            }
            for part, marks in parts
        ],
    }


def _call(name: str, args: dict, n: int = 0) -> dict:
    return {
        "id": f"call_{name}_{n}",
        "type": "function",
        "function": {"name": name, "arguments": json.dumps(args)},
    }


def _page(number: int, text: str = "") -> extraction.Page:
    async def image() -> str:
        return "data:image/jpeg;base64,AA=="

    return extraction.Page(number, "paper.pdf", text, image)


def test_label_key_compares_printed_labels():
    assert extraction.label_key("Q3.") == extraction.label_key("3")
    assert extraction.label_key("(b)(ii)") == extraction.label_key("b ii") == "b.ii"


def test_record_keeps_printed_option_order_and_part_labels():
    held = extraction.record(_mcq("7", ["D text", "A text", "C text", "B text"]))
    assert held.label == "7" and held.part_labels == [""]
    assert held.question["parts"][0]["answer"]["options"] == [
        "D text",
        "A text",
        "C text",
        "B text",
    ]
    assert held.question["layout"] == "paper"
    assert extraction.keyless(held.question)


def test_stand_ins_fill_only_the_missing_keys_for_the_validator():
    held = extraction.record(_open("4", [("a", 3), ("b", 1)]))
    checked = extraction._stand_ins(held.question)
    assert [len(p["markscheme"]) for p in checked["parts"]] == [1, 1]
    assert [p["markscheme"][0]["marks"] for p in checked["parts"]] == [3, 1]
    assert held.question["parts"][0]["markscheme"] == []


def test_pair_fills_letters_points_answers_and_solutions():
    mcq = extraction.record(_mcq("12", ["a", "b", "c", "d"]))
    long = extraction.record(_open("3", [("a", 1), ("b(i)", 2)]))
    entries = extraction._merged(
        extraction.entries_from(
            {
                "entries": [
                    {"question": "12", "part": "", "answer": "C"},
                    {
                        "question": "3",
                        "part": "(a)",
                        "answer": "x = 2",
                        "points": [{"text": "1A", "marks": 1}],
                        "solution": "x = 2",
                    },
                    {
                        "question": "Q3",
                        "part": "b(i)",
                        "points": [
                            {"text": "1M", "marks": 1},
                            {"text": "1A", "marks": 2},
                        ],
                    },
                ]
            }
        )
    )
    assert extraction.pair(mcq, entries) and extraction.pair(long, entries)
    assert mcq.question["parts"][0]["answer"]["correct"] == [2]
    first, second = long.question["parts"]
    assert first["markscheme"] == [{"text": "1A", "marks": 1}]
    assert first["answer"]["accepted"] == ["x = 2"]
    assert first["solution"] == _text("x = 2")
    # The scheme's marks replace the split the model made of a printed total.
    assert second["marks"] == 3
    assert not extraction.keyless(long.question)


def test_marking_points_fit_the_quiz_item_cap():
    points = [{"text": f"step {i}", "marks": 1} for i in range(8)]
    items = extraction._items(points)
    assert len(items) == extraction.limits.QUIZ_MARKSCHEME_MAX
    assert sum(item["marks"] for item in items) == 8


async def test_a_failing_provider_costs_an_attempt_not_the_run(monkeypatch):
    monkeypatch.setattr(extraction, "ATTEMPT_WAIT_S", 0)
    calls = []

    async def busy_once():
        calls.append("call")
        if len(calls) == 1:
            raise extraction.elitellm.ProviderBusy("too busy")
        return "read"

    assert await extraction._attempted(busy_once) == "read"
    assert len(calls) == 2

    async def refused():
        calls.append("refused")
        raise TimeoutError("silent")

    with pytest.raises(TimeoutError):
        await extraction._attempted(refused)
    assert calls.count("refused") == extraction.ATTEMPTS


def test_page_texts_spread_passages_over_their_pages():
    texts = extraction.page_texts(
        [
            {"text": "one", "page_start": 1, "page_end": 2},
            {"text": "two", "page_start": 2, "page_end": 2},
            {"text": "caption", "page_start": None, "page_end": None},
        ]
    )
    assert texts == {1: "one\n\ncaption", 2: "one\n\ntwo"}


async def test_run_validates_continues_pairs_and_reports(monkeypatch):
    """Two windows (pages 1-2, page 3): question 1 is refused once and recorded
    again, question 2 runs onto page 3, question 3 is never recorded and question 4 has
    no scheme entry."""
    replies = iter(
        [
            # Outline.
            SimpleNamespace(content='{"questions": ["1", "2", "3", "4"]}'),
            # Window 1: 1 is refused (no options), 2 recorded.
            {
                "role": "assistant",
                "content": "",
                "tool_calls": [
                    _call(
                        "record_question",
                        {"questions": [_mcq("1", []), _open("2", [("a", 2)])]},
                    )
                ],
            },
            {
                "role": "assistant",
                "content": "",
                "tool_calls": [
                    _call("record_question", {"questions": [_mcq("1", ["p", "q"])]}, 1)
                ],
            },
            {"role": "assistant", "content": "DONE"},
            # Window 2: 2 continues with part b; 4 recorded.
            {
                "role": "assistant",
                "content": "",
                "tool_calls": [
                    _call(
                        "continue_question",
                        {
                            "label": "2",
                            "parts": [
                                {
                                    "label": "b",
                                    "blocks": _text("Hence find b."),
                                    "answer": {"type": "open"},
                                    "marks": 1,
                                }
                            ],
                        },
                    ),
                    _call("record_question", {"questions": [_mcq("4", ["r", "s"])]}, 2),
                ],
            },
            {"role": "assistant", "content": "DONE"},
        ]
    )
    windows: list[dict] = []

    async def complete(messages, **kwargs):
        if kwargs.get("tools"):
            windows.append(messages[1]["content"][0]["text"])
        return next(replies)

    async def scheme(files, *, model):
        return extraction.entries_from(
            {
                "entries": [
                    {"question": "1", "part": "", "answer": "B"},
                    {
                        "question": "2",
                        "part": "a",
                        "points": [{"text": "1M", "marks": 2}],
                    },
                    {
                        "question": "2",
                        "part": "b",
                        "points": [{"text": "1A", "marks": 1}],
                    },
                    {"question": "9", "part": "", "answer": "A"},
                ]
            }
        )

    async def validate(question):
        options = question["parts"][0]["answer"].get("options")
        return (
            "invalid question: choice answers require two options"
            if options == []
            else None
        )

    monkeypatch.setattr(extraction.models, "complete", complete)
    monkeypatch.setattr(extraction, "parse_schemes", scheme)
    events = [
        event
        async for event in extraction.run(
            [_page(1, "1. ... 2. ..."), _page(2), _page(3)],
            [extraction.SchemeFile("scheme.pdf", "1. B")],
            model=MODEL,
            validate=validate,
        )
    ]
    assert [e["type"] for e in events] == ["questions", "questions", "done"]
    # Only labels and the open question carry into the second window.
    assert "Already recorded: 1, 2." in windows[-1] and '"label": "2"' in windows[-1]
    done = events[-1]
    report = done["report"]
    assert report["recorded"] == ["1", "2", "4"]
    assert report["missing"] == ["3"]
    assert report["unanswered"] == ["4"]
    assert report["unpaired"] == ["9"]
    first, second = done["questions"]
    assert first["parts"][0]["answer"]["correct"] == [1]
    assert [p["markscheme"] for p in second["parts"]] == [
        [{"text": "1M", "marks": 2}],
        [{"text": "1A", "marks": 1}],
    ]


def test_extract_route_refuses_first_then_streams(monkeypatch):
    """/extract answers a refused request with a 400 before streaming, and a
    run's events as SSE, giving its turn slot back at the end."""
    from fastapi.testclient import TestClient

    from pipeline.retrieval import limits
    from pipeline.retrieve import service

    secret = "s" * 32
    monkeypatch.setattr(service.cfg, "pipeline_secret", secret)
    monkeypatch.setattr(limits, "TURN_SLOTS", limits.Slots(1))
    body = {
        "thinking": "low",
        "providerSlug": "deepseek",
        "modelSlug": "deepseek-flash",
        "configVersion": 1,
        "workspaceId": "ws_1",
        "paper": [{"fileId": "f_1", "name": "paper.pdf", "pages": [17]}],
        "answerFiles": [],
        "spendSessionId": "ps_1",
    }
    http = TestClient(service.app)  # no lifespan: no database
    headers = {"X-Pipeline-Secret": secret}

    async def refuse(workspace_id, paper, answers):
        raise extraction.ExtractionRefused(
            "page_out_of_range", "paper.pdf has 16 pages; page 17 is past its end."
        )

    monkeypatch.setattr(extraction, "prepare", refuse)
    refused = http.post("/extract", json=body, headers=headers)
    assert refused.status_code == 400
    assert refused.json()["code"] == "page_out_of_range"
    assert limits.TURN_SLOTS.used == 0

    async def prepare(workspace_id, paper, answers):
        return [_page(1)], []

    async def run(pages, schemes, *, model, validate):
        yield {"type": "questions", "questions": []}
        yield {"type": "done", "questions": [], "report": {"missing": []}}

    monkeypatch.setattr(extraction, "prepare", prepare)
    monkeypatch.setattr(extraction, "run", run)
    monkeypatch.setattr(service.models, "resolve_query_model", lambda *a, **k: MODEL)
    monkeypatch.setattr(service, "_bind_accounting", lambda session_id: None)
    streamed = http.post("/extract", json=body, headers=headers)
    assert streamed.status_code == 200
    events = [
        json.loads(line[len("data: ") :])
        for line in streamed.text.splitlines()
        if line.startswith("data: ")
    ]
    assert [e["type"] for e in events] == ["questions", "done"]
    assert limits.TURN_SLOTS.used == 0
