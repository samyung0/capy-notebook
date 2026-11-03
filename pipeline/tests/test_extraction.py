"""Make a quiz: recording page windows with their keys, pairing the mark
scheme by label, and the run's report (pipeline.retrieval.extraction)."""

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
    thinking_levels=("instant", "low", "mid"),
    default_thinking="mid",
    context_window_tokens=1_000_000,
)
AI = extraction.AI_WRITTEN["en"]


def _text(text: str) -> list[dict]:
    return [{"type": "text", "text": text}]


def _mcq(
    label: str, options: list[str], correct: int = 0, source: str = "worked_out"
) -> dict:
    return {
        "label": label,
        "stem": [],
        "parts": [
            {
                "label": "",
                "blocks": _text(f"Question {label}"),
                "answer": {"type": "mcq", "options": options, "correct": [correct]},
                "marks": 1,
                "key_source": source,
                "solution": f"Why {label}.",
            }
        ],
    }


def _open_part(label: str, marks: int) -> dict:
    return {
        "label": label,
        "blocks": _text(f"Find {label}."),
        "answer": {
            "type": "open",
            "points": [{"text": f"1A for {label}", "marks": marks}],
            "accepted": [f"answer {label}"],
        },
        "marks": marks,
        "key_source": "worked_out",
        "solution": f"Work for {label}.",
    }


def _open(label: str, parts: list[tuple[str, int]], total: int | None = None) -> dict:
    return {
        "label": label,
        **({"total_marks": total} if total else {}),
        "stem": _text("Given f(x)."),
        "parts": [_open_part(part, marks) for part, marks in parts],
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


def test_record_keeps_printed_options_keys_and_ai_written_solutions():
    held = extraction.record(_mcq("7", ["D text", "A text", "C text"], 2), AI)
    part = held.question["parts"][0]
    assert part["answer"] == {
        "type": "mcq",
        "options": ["D text", "A text", "C text"],
        "correct": [2],
    }
    assert part["solution"] == [{"type": "text", "text": "Why 7.", "label": AI}]
    assert held.sources == ["worked_out"]
    printed = extraction.record(_mcq("8", ["a", "b"], 1, "printed"), AI)
    assert "label" not in printed.question["parts"][0]["solution"][0]
    long = extraction.record(_open("3", [("a", 2)]), AI)
    assert long.question["parts"][0]["markscheme"] == [{"text": "1A for a", "marks": 2}]


def test_a_part_must_say_where_its_key_came_from():
    item = _mcq("5", ["a", "b"])
    del item["parts"][0]["key_source"]
    assert "key_source" in extraction._unsourced(extraction.record(item, AI))


def test_pairing_replaces_worked_out_keys_keeps_printed_ones_and_names_disagreements():
    worked = extraction.record(_mcq("12", ["a", "b", "c", "d"], 0), AI)
    printed = extraction.record(_mcq("13", ["a", "b"], 0, "printed"), AI)
    long = extraction.record(_open("3", [("a", 1), ("b(i)", 2)]), AI)
    entries = extraction._merged(
        extraction.entries_from(
            {
                "entries": [
                    {"question": "12", "part": "", "answer": "C", "solution": "C."},
                    {"question": "13", "part": "", "answer": "B"},
                    {
                        "question": "3",
                        "part": "(a)",
                        "answer": "x = 2",
                        "points": [{"text": "1A", "marks": 1}],
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
    first = extraction.pair(worked, entries)
    assert first.held.question["parts"][0]["answer"]["correct"] == [2]
    # The scheme's solution replaces the AI-written one.
    assert first.held.question["parts"][0]["solution"] == _text("C.")
    assert first.held.sources == ["scheme"] and first.disagreed == ["12"]
    second = extraction.pair(printed, entries)
    assert second.held.question["parts"][0]["answer"]["correct"] == [0]
    assert second.disagreed == ["13"]
    third = extraction.pair(long, entries)
    a, b = third.held.question["parts"]
    assert a["markscheme"] == [{"text": "1A", "marks": 1}]
    assert a["answer"]["accepted"] == ["x = 2"]
    # The scheme's marks replace the split the model made of a printed total.
    assert b["marks"] == 3 and third.disagreed == ["3(b(i))"]
    # The recorded question itself is left as it was.
    assert worked.question["parts"][0]["answer"]["correct"] == [0]


def test_marking_points_fit_the_quiz_item_cap():
    points = [{"text": f"step {i}", "marks": 1} for i in range(8)]
    items = extraction._items(points)
    assert len(items) == extraction.limits.QUIZ_MARKSCHEME_MAX
    assert sum(item["marks"] for item in items) == 8


async def test_a_failing_provider_retries_once_then_fails(monkeypatch):
    monkeypatch.setattr(extraction, "ATTEMPT_WAIT_S", 0)
    calls = []

    async def busy_once():
        calls.append("call")
        if len(calls) == 1:
            raise extraction.elitellm.ProviderBusy("too busy")
        return "read"

    assert await extraction._attempted(busy_once) == "read"
    assert len(calls) == 2

    async def silent():
        calls.append("silent")
        raise TimeoutError("silent")

    with pytest.raises(TimeoutError):
        await extraction._attempted(silent)
    assert calls.count("silent") == 2


async def test_scheme_parse_names_entries_by_the_recorded_labels(monkeypatch):
    monkeypatch.setattr(extraction, "ATTEMPT_WAIT_S", 0)
    replies = iter(
        [
            SimpleNamespace(content='{"entries": [{"question": "1", "answ'),
            SimpleNamespace(content='{"entries": [{"question": "1", "answer": "B"}]}'),
        ]
    )
    sent: list[str] = []

    async def complete(messages, **kwargs):
        sent.append(messages[1]["content"])
        return next(replies)

    monkeypatch.setattr(extraction.models, "complete", complete)
    entries = await extraction.parse_schemes(
        [extraction.SchemeFile("answers.txt", "1. B")],
        model=MODEL,
        labels=[("1", [""]), ("3", ["a", "b"])],
    )
    # A reply cut off mid-JSON is a failed attempt, parsed again.
    assert [(e.question, e.answer) for e in entries] == [("1", "B")]
    assert "1; 3: a, b" in sent[0]


def test_page_texts_spread_passages_over_their_pages():
    texts = extraction.page_texts(
        [
            {"text": "one", "page_start": 1, "page_end": 2},
            {"text": "two", "page_start": 2, "page_end": 2},
            {"text": "caption", "page_start": None, "page_end": None},
        ]
    )
    assert texts == {1: "one\n\ncaption", 2: "one\n\ntwo"}


async def test_run_records_keys_continues_pairs_and_reports(monkeypatch):
    """Two windows (pages 1-2, page 3): question 1 is refused once and
    recorded again, question 2's first call is not JSON and is sent again,
    then runs onto page 3, question 3 is never recorded and question 4 has no
    scheme entry, so it keeps its worked-out key."""
    replies = iter(
        [
            # Outline.
            SimpleNamespace(content='{"questions": ["1", "2", "3", "4"]}'),
            # Window 1: 1 is refused (no options) and 2's call closes early.
            {
                "role": "assistant",
                "content": "",
                "tool_calls": [
                    _call("record_question", _mcq("1", [])),
                    {
                        "id": "call_cut",
                        "type": "function",
                        "function": {
                            "name": "record_question",
                            "arguments": json.dumps(_open("2", [("a", 2)])) + "}",
                        },
                    },
                ],
            },
            {
                "role": "assistant",
                "content": "",
                "tool_calls": [
                    _call("record_question", _mcq("1", ["p", "q"]), 1),
                    _call("record_question", _open("2", [("a", 2)], total=4), 3),
                ],
            },
            {"role": "assistant", "content": "DONE"},
            # Window 2: a reply cut off at the cap is asked again; then 2
            # continues with part b and 4 is recorded.
            {"role": "assistant", "content": "", "finish": "length"},
            {
                "role": "assistant",
                "content": "",
                "tool_calls": [
                    _call(
                        "continue_question",
                        {"label": "2", "parts": [_open_part("b", 1)]},
                    ),
                    _call("record_question", _mcq("4", ["r", "s"], 1), 2),
                ],
            },
            {"role": "assistant", "content": "DONE"},
        ]
    )
    windows: list[str] = []
    results: set[str] = set()

    async def complete(messages, **kwargs):
        return next(replies)

    async def complete_response(messages, **kwargs):
        windows.append(messages[1]["content"][0]["text"])
        results.update(m["content"] for m in messages if m["role"] == "tool")
        reply = next(replies)
        return SimpleNamespace(
            choices=[
                SimpleNamespace(
                    finish_reason=reply.pop("finish", "stop"), message=reply
                )
            ],
            usage=SimpleNamespace(output_tokens=100),
        )

    labels_seen: list = []

    async def scheme(files, *, model, labels):
        labels_seen.append(labels)
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
    monkeypatch.setattr(extraction.models, "complete_response", complete_response)
    monkeypatch.setattr(extraction, "parse_schemes", scheme)
    events = [
        event
        async for event in extraction.run(
            [_page(1, "1. ... 2. ..."), _page(2), _page(3)],
            [extraction.SchemeFile("scheme.pdf", "1. B")],
            model=MODEL,
            validate=validate,
            locale="en",
        )
    ]
    assert [e["type"] for e in events] == ["questions", "questions", "done"]
    # Only labels and the open question carry into the second window.
    assert "Already recorded: 1, 2." in windows[-1] and '"label": "2"' in windows[-1]
    assert windows.count(windows[-1]) == 3  # the cut-off reply was asked again
    assert any(
        r.startswith("The arguments were not valid JSON (Extra data") for r in results
    )
    assert labels_seen == [[("1", [""]), ("2", ["a", "b"]), ("4", [""])]]
    done = events[-1]
    report = done["report"]
    assert report["recorded"] == ["1", "2", "4"]
    assert report["missing"] == ["3"]
    assert report["keysWorkedOut"] == ["4"]
    assert report["keyDisagreements"] == ["1"]
    assert report["unpaired"] == ["9"]
    # Question 2 prints 4 marks in all; the scheme's parts add up to 3.
    assert report["marksDiffer"] == ["2"]
    first, second, fourth = done["questions"]
    assert first["parts"][0]["answer"]["correct"] == [1]
    assert [p["markscheme"] for p in second["parts"]] == [
        [{"text": "1M", "marks": 2}],
        [{"text": "1A", "marks": 1}],
    ]
    assert fourth["parts"][0]["answer"]["correct"] == [1]
    assert fourth["parts"][0]["solution"][0]["label"] == AI


async def test_a_run_past_its_output_budget_stops_and_keeps_what_it_has(monkeypatch):
    """A window whose replies run on past the run's output budget (8,000 tokens
    a selected page) ends the run as output_limit; the questions recorded so far
    are saved and the rest are missing."""
    replies = iter(
        [
            {"tool_calls": [_call("record_question", _mcq("1", ["p", "q"]))]},
            {"finish": "length", "tokens": 24_000},
        ]
    )

    async def complete(messages, **kwargs):
        return SimpleNamespace(content='{"questions": ["1", "2"]}')

    async def complete_response(messages, **kwargs):
        reply = next(replies)
        return SimpleNamespace(
            choices=[
                SimpleNamespace(
                    finish_reason=reply.get("finish", "tool_calls"),
                    message={"role": "assistant", "content": "", **reply},
                )
            ],
            usage=SimpleNamespace(output_tokens=reply.get("tokens", 500)),
        )

    async def validate(question):
        return None

    monkeypatch.setattr(extraction.models, "complete", complete)
    monkeypatch.setattr(extraction.models, "complete_response", complete_response)
    events = [
        event
        async for event in extraction.run(
            [_page(1, "1. ... 2. ..."), _page(2), _page(3)],
            [],
            model=MODEL,
            validate=validate,
            locale="en",
        )
    ]
    report = events[-1]["report"]
    assert report["stopped"] == "output_limit"
    assert report["recorded"] == ["1"] and report["missing"] == ["2"]
    assert report["windows"] == 1


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

    async def run(pages, schemes, *, model, validate, locale):
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
