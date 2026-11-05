"""Make a quiz: the map, copy batches and solve calls, the answer files in the first
message, and the run's report (pipeline.retrieval.extraction)."""

from __future__ import annotations

import asyncio
import base64
import copy
import io
import json
import re
from types import SimpleNamespace

import pymupdf
import pytest
from PIL import Image

from pipeline import registry
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


def _text(text: str) -> list[dict]:
    return [{"type": "text", "text": text}]


def _mcq(label: str, options: list[str], correct: int = 0) -> dict:
    return {
        "label": label,
        "stem": [],
        "parts": [
            {
                "label": "",
                "blocks": _text(f"Question {label}"),
                "answer": {"type": "mcq", "options": options, "correct": [correct]},
                "marks": 1,
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


def _jpeg(size: int = 1000) -> str:
    buffer = io.BytesIO()
    Image.new("L", (size, size), 255).save(buffer, "JPEG")
    return "data:image/jpeg;base64," + base64.b64encode(buffer.getvalue()).decode()


# A blank page 1000 px a side: a grid unit is a pixel and no box finds ink.
BLANK_PAGE = _jpeg()


def _page(
    number: int,
    text: str = "",
    crops: list | None = None,
    regions: tuple = (),
    layer: str = extraction.SCAN,
) -> extraction.Page:
    async def image() -> str:
        return BLANK_PAGE

    async def crop(box: list[float]) -> tuple[bytes, tuple[int, int]]:
        if crops is not None:
            crops.append((number, box))
        return b"jpeg %d" % number, (400, 300)

    return extraction.Page(number, "paper.pdf", text, image, crop, regions, layer)


def test_label_key_compares_printed_labels():
    assert extraction.label_key("Q3.") == extraction.label_key("3")
    assert extraction.label_key("(b)(ii)") == extraction.label_key("b ii") == "b.ii"


def test_record_keeps_printed_options_keys_and_solutions():
    held = extraction.record(_mcq("7", ["D text", "A text", "C text"], 2))
    part = held.question["parts"][0]
    assert part["answer"] == {
        "type": "mcq",
        "options": ["D text", "A text", "C text"],
        "correct": [2],
    }
    assert part["solution"] == [{"type": "text", "text": "Why 7."}]
    long = extraction.record(_open("3", [("a", 2)]))
    assert long.question["parts"][0]["markscheme"] == [{"text": "1A for a", "marks": 2}]


def test_option_lines_copied_into_the_text_are_taken_out():
    """Options the model wrote into the part's text as well as into the
    answer are shown once: lettered lines in a block, two to a line, or a
    part holding only them (its stem becomes its text). Lines that differ
    from the options stay."""
    options = ["$3$ .", "$3^{2n+6}$", "9", "$\\frac{1}{2}$"]
    item = _mcq("2", options)
    item["parts"][0]["blocks"] = _text(
        "Simplify $9^n$.\nA.  $3$ .\nB.  $3^{2n+6}$ .\nC. 9    D. $\\frac{1}{2}$"
    )
    part = extraction.record(item).question["parts"][0]
    assert part["blocks"] == _text("Simplify $9^n$.")
    assert part["answer"]["options"] == options

    only = _mcq("3", ["52", "68"])
    only["stem"] = _text("Find the number of dots.")
    only["parts"][0]["blocks"] = _text("A. 52\nB. 68")
    question = extraction.record(only).question
    assert question["stem"] == []
    assert question["parts"][0]["blocks"] == _text("Find the number of dots.")

    other = _mcq("4", ["52", "68"])
    other["parts"][0]["blocks"] = _text("A. 52 apples\nB. 68")
    assert extraction.record(other).question["parts"][0]["blocks"] == _text(
        "A. 52 apples\nB. 68"
    )


def test_plain_option_lines_are_taken_out_too():
    """2022 Paper 2, run 81 at window 3: the options again as plain lines with
    no letter, the part holding only them. Also one a block, lettered or not,
    and after the part's own text; lines out of order stay."""
    options = ["48 kg.", "50 kg.", "53 kg.", "60 kg."]
    plain = _mcq("29", options)
    plain["stem"] = _text("The mean weight of the actresses is")
    plain["parts"][0]["blocks"] = _text("48 kg.\n\n50 kg.\n\n53 kg.\n\n60 kg.")
    question = extraction.record(plain).question
    assert question["stem"] == []
    assert question["parts"][0]["blocks"] == _text(
        "The mean weight of the actresses is"
    )
    assert question["parts"][0]["answer"]["options"] == options

    math = ["$\\frac{1}{5}$", "$\\frac{1}{7}$", "$\\frac{1}{9}$", "$\\frac{1}{10}$"]
    after = _mcq("28", math)
    after["parts"][0]["blocks"] = _text("Find the probability.\n\n" + "\n\n".join(math))
    assert extraction.record(after).question["parts"][0]["blocks"] == _text(
        "Find the probability."
    )

    apart = _mcq("24", ["$a$.", "$b$.", "$c$.", "$d$."])
    apart["parts"][0]["blocks"] = [
        *_text("In the figure,"),
        *_text("A. $a$."),
        *_text("B. $b$."),
        *_text("C. $c$."),
        *_text("D. $d$."),
    ]
    assert extraction.record(apart).question["parts"][0]["blocks"] == _text(
        "In the figure,"
    )

    plain_apart = _mcq("25", ["1", "2"])
    plain_apart["parts"][0]["blocks"] = [*_text("Pick one."), *_text("1"), *_text("2")]
    assert extraction.record(plain_apart).question["parts"][0]["blocks"] == _text(
        "Pick one."
    )

    # The letter inside the math, and the line typeset where the option is not.
    in_math = _mcq("25", ["$(8, 60^\\circ)$.", "$(8, 120^\\circ)$."])
    in_math["parts"][0]["blocks"] = _text(
        "Find it.\n$A.\\ (8, 60^\\circ)$.\n$B.\\ (8, 120^\\circ)$."
    )
    assert extraction.record(in_math).question["parts"][0]["blocks"] == _text(
        "Find it."
    )
    typeset = _mcq("20", ["82 cm", "100 cm"])
    typeset["parts"][0]["blocks"] = _text(
        "Find it.\nA. $82\\text{ cm}$.\nB. $100\\text{ cm}$."
    )
    assert extraction.record(typeset).question["parts"][0]["blocks"] == _text(
        "Find it."
    )

    bare_letter = _mcq("30", ["a relay", "a thermistor"])
    bare_letter["stem"] = _text("Which one?")
    bare_letter["parts"][0]["blocks"] = _text("A a relay\nB a thermistor")
    assert extraction.record(bare_letter).question["parts"][0]["blocks"] == _text(
        "Which one?"
    )

    shuffled = _mcq("26", ["1", "2"])
    shuffled["parts"][0]["blocks"] = _text("Pick one.\n2\n1")
    assert extraction.record(shuffled).question["parts"][0]["blocks"] == _text(
        "Pick one.\n2\n1"
    )


def test_a_one_part_question_shows_its_text_once():
    """A one-part question whose stem repeats its part's text keeps it once,
    in the part; a stem that differs stays."""
    item = _mcq("5", ["$540", "$600"])
    item["stem"] = _text("A fan is sold at a discount of $30\\%$.")
    item["parts"][0]["blocks"] = _text("A fan is sold at a discount of  $30\\%$.")
    question = extraction.record(item).question
    assert question["stem"] == []
    assert question["parts"][0]["blocks"] == _text(
        "A fan is sold at a discount of  $30\\%$."
    )
    other = _mcq("6", ["a", "b"])
    other["stem"] = _text("Given f(x).")
    assert extraction.record(other).question["stem"] == _text("Given f(x).")
    tail = _mcq("7", ["2", "3"])
    tail["stem"] = _text("Let 5a = 6c. Find $\\frac{a}{c}$.")
    tail["parts"][0]["blocks"] = _text("Find $\\frac{a}{c}$.")
    assert extraction.record(tail).question["stem"] == _text("Let 5a = 6c.")


def test_a_sub_parts_lead_in_starts_its_blocks():
    """The text printed under (b) before (i), given as b(i)'s lead_in, is its
    first block, once even when the blocks also hold it."""
    item = _open("8", [("a", 2), ("b(i)", 1)])
    item["parts"][1]["lead_in"] = "It is given that AC = 25 cm."
    question = extraction.record(item).question
    assert question["parts"][1]["blocks"] == _text(
        "It is given that AC = 25 cm."
    ) + _text("Find b(i).")
    item["parts"][1]["blocks"] = _text("It is given that AC = 25 cm.") + _text("x")
    again = extraction.record(item).question["parts"][1]["blocks"]
    assert [b["text"] for b in again] == ["It is given that AC = 25 cm.", "x"]


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


def test_page_texts_spread_passages_over_their_pages():
    texts = extraction.page_texts(
        [
            {"text": "one", "page_start": 1, "page_end": 2},
            {"text": "two", "page_start": 2, "page_end": 2},
            {"text": "caption", "page_start": None, "page_end": None},
        ]
    )
    assert texts == {1: "one\n\ncaption", 2: "one\n\ntwo"}


def _figure_regions() -> tuple[tuple, tuple]:
    """Page 5: a figure in two boxes with its caption. Page 6: a chart."""
    region = extraction.layout.Region
    return (
        region("image", 0.97, [100.0, 200.0, 300.0, 400.0]),
        region("image", 0.9, [320.0, 210.0, 500.0, 390.0]),
        region("figure_title", 0.8, [200.0, 405.0, 400.0, 420.0]),
        region("text", 0.9, [100.0, 500.0, 900.0, 600.0]),
    ), (region("chart", 0.884, [50.4, 60.6, 700.0, 800.0]),)


# ------------------------------------------------------------ map, copy, solve


async def _ok(question):
    return None


def _row(
    label: str,
    first: int = 5,
    last: int = 5,
    parts: str = "none",
    figures: str = "none",
) -> str:
    return f"{label} | pages {first}-{last} | parts {parts} | figures {figures}"


def _copy(item: dict, first: int = 5, last: int = 5, **extra) -> dict:
    """A copy call for ``item``: its answers are not sent."""
    out = extraction._keyless(item)
    return {"figures": [], "pages": [first, last], **out, **extra}


def _answers(item: dict) -> dict:
    """The record_answers call that goes with ``item``."""
    parts = []
    for part in item["parts"]:
        answer = part["answer"]
        given = {
            "label": part["label"],
            "solution": part["solution"],
            "accepted": answer.get("accepted", []),
        }
        for name in ("correct", "points"):
            if name in answer:
                given[name] = answer[name]
        parts.append(given)
    return {"label": item["label"], "parts": parts}


def _tools(*calls: tuple[str, dict]) -> dict:
    return {
        "tool_calls": [_call(name, args, n) for n, (name, args) in enumerate(calls)]
    }


class Script:
    """models.complete_response by the thread's last user message: the map's reply,
    then each ask's replies in turn, then DONE. ``fail`` gives an ask exceptions to
    raise before its next reply, ``before`` something to await first."""

    def __init__(
        self,
        map_text: str,
        replies: dict | None = None,
        fail: dict | None = None,
        before: dict | None = None,
    ):
        self.map_text = map_text
        self.replies = {ask: list(r) for ask, r in (replies or {}).items()}
        self.fail = {ask: list(r) for ask, r in (fail or {}).items()}
        self.before = before or {}
        self.sent: list[dict] = []

    async def __call__(self, messages, **kwargs):
        last = next(m["content"] for m in reversed(messages) if m["role"] == "user")
        ask = last if isinstance(last, str) else "map"
        self.sent.append(
            {
                "ask": ask,
                "messages": copy.deepcopy(messages),
                "thinking": registry.current_request_llm().thinking,
                **kwargs,
            }
        )
        if ask in self.before:
            await self.before[ask]()
        if self.fail.get(ask):
            raise self.fail[ask].pop(0)
        if ask == "map":
            reply = {"content": self.map_text}
        else:
            remaining = self.replies.get(ask) or []
            reply = dict(remaining.pop(0)) if remaining else {"content": "DONE"}
        finish = reply.pop("finish", "stop")
        tokens = reply.pop("tokens", 100)
        return SimpleNamespace(
            choices=[
                SimpleNamespace(
                    finish_reason=finish,
                    message={"role": "assistant", "content": "", **reply},
                )
            ],
            usage=SimpleNamespace(output_tokens=tokens),
        )

    def asks(self) -> list[str]:
        return [call["ask"] for call in self.sent]


def _no_call(*args, **kwargs):
    raise AssertionError("no other call is expected")


async def _run(
    monkeypatch,
    script: Script,
    pages: list,
    answers=(),
    *,
    complete=_no_call,
    validate=_ok,
):
    monkeypatch.setattr(extraction, "ATTEMPT_WAIT_S", 0)
    monkeypatch.setattr(extraction.models, "complete_response", script)
    monkeypatch.setattr(extraction.models, "complete", complete)
    registry.bind_request_llm("mid")
    return [
        event
        async for event in extraction.run(
            pages, list(answers), model=MODEL, validate=validate
        )
    ]


def test_the_map_reads_its_lines_and_leaves_the_rest():
    rows = extraction.parse_map(
        "Here is the map.\n"
        "1 | pages 2-3 | parts a(i), a(ii), b | figures 1, 2\n"
        "**2** | page 4 | parts none | figures none\n"
    )
    assert rows == [
        extraction.MapRow("1", 2, 3, ["a(i)", "a(ii)", "b"], [1, 2]),
        extraction.MapRow("2", 4, 4, [], []),
    ]


async def test_a_quiz_filled_while_copying_still_answers_what_it_copied(monkeypatch):
    """40 pages of past papers filled the quiz at 100 parts and left all of them with no
    answers (bench/extraction/reports/2026-11-05-remaining-selections.md)."""
    monkeypatch.setattr(extraction.limits, "QUIZ_PARTS_MAX", 1)
    first, second = _mcq("1", ["p", "q"], 1), _mcq("2", ["r", "s"], 0)
    script = Script(
        "\n".join([_row("1"), _row("2")]),
        {
            "Copy questions 1 to 2 now.": [
                _tools(
                    ("record_question", _copy(first)),
                    ("record_question", _copy(second)),
                )
            ],
            "Give the answers to question 1 now.": [
                _tools(("record_answers", _answers(first)))
            ],
        },
    )
    events = await _run(monkeypatch, script, [_page(5)])
    done = events[-1]
    assert done["report"]["stopped"] == "quiz_full"
    assert done["report"]["missing"] == ["2"]
    assert done["report"]["answersMissing"] == []
    assert done["questions"][0]["parts"][0]["answer"]["correct"] == [1]


async def test_a_failing_question_check_is_tried_again_then_fails_its_thread(
    monkeypatch,
):
    monkeypatch.setattr(extraction, "ATTEMPT_WAIT_S", 0)
    answers = iter(
        [
            OSError("connection reset"),
            SimpleNamespace(status_code=200, json=lambda: {"problem": "bad"}),
            SimpleNamespace(status_code=502, json=dict),
            SimpleNamespace(status_code=502, json=dict),
        ]
    )

    def post(path, body):
        answer = next(answers)
        if isinstance(answer, Exception):
            raise answer
        return answer

    monkeypatch.setattr(extraction.tools, "_post_json", post)
    assert await extraction.gateway_validate({}) == "bad"
    with pytest.raises(extraction.elitellm.ProviderError):
        await extraction.gateway_validate({})


def test_labels_keep_letters_and_numbers_of_any_script():
    assert extraction.label_key("①") != extraction.label_key("②")
    assert extraction.label_key("(b)(ii)") == "b.ii"
    assert extraction.label_key("Q3.") == "3"


def test_a_map_row_called_none_is_no_row():
    assert extraction.parse_map("none | pages 1-1 | parts none | figures none") == []


async def test_a_text_paper_goes_as_its_whole_text_with_no_images(monkeypatch):
    """A Word, PowerPoint or text paper: its indexed text under its own heading, a system
    prompt that says so with no figures rule, and no boxes. A figure it names is dropped."""
    item = _mcq("1", ["p", "q"], 1)
    script = Script(
        _row("1", 1, 1),
        {
            "Copy question 1 now.": [
                _tools(
                    (
                        "record_question",
                        _copy(
                            item,
                            1,
                            1,
                            figures=[{"boxes": [], "part": "", "description": "Graph"}],
                        ),
                    )
                )
            ],
            "Give the answers to question 1 now.": [
                _tools(("record_answers", _answers(item)))
            ],
        },
    )
    paper = extraction.Page(
        1, "paper.docx", "Question text.", None, None, layer="born_digital"
    )
    events = await _run(monkeypatch, script, [paper])
    system, user = script.sent[0]["messages"][:2]
    assert system["content"].startswith("You copy the questions in the selected files")
    assert "Figures:" not in system["content"] and "Copying:" in system["content"]
    assert system["content"].endswith(extraction.prompts.SOURCE_RULE)
    assert [block["type"] for block in user["content"]] == ["text", "text"]
    assert user["content"][0]["text"] == (
        "Page 1 of paper.docx. Its indexed text:\n<source>\nQuestion text.\n</source>"
    )
    done = events[-1]
    assert done["report"]["recorded"] == ["1"] and done["report"]["figures"] == []


def test_a_text_paper_counts_its_whole_text_in_the_output_budget():
    def worth(chars: int) -> int:
        return extraction._pages_worth(extraction.Page(1, "a", "x" * chars, None, None))

    assert (worth(1), worth(3_856)) == (1, 8)
    assert worth(extraction.FILE_TEXT_CHARS) == extraction.limits.EXTRACTION_PAGES_MAX


async def test_prepare_reads_a_word_paper_whole(monkeypatch):
    pages = await _prepared(monkeypatch, "doc")
    assert [(p.number, p.text, p.image) for p in pages] == [(1, LINE.strip(), None)]


def test_copying_carries_no_answers_and_answers_require_a_model_answer():
    record_question, record_answers = extraction.prompts.TOOLS
    question = record_question["function"]["parameters"]
    assert question["required"] == ["label", "stem", "parts", "pages", "figures"]
    part = question["properties"]["parts"]["items"]
    assert part["required"] == ["label", "blocks", "answer", "marks"]
    assert sorted(part["properties"]["answer"]["properties"]) == [
        "options",
        "type",
        "unit",
    ]
    given = record_answers["function"]["parameters"]["properties"]["parts"]["items"]
    assert given["required"] == ["label", "accepted", "solution"]
    assert given["properties"]["accepted"]["description"].endswith(
        "open: a short model answer; mcq: an empty list."
    )


async def test_map_copy_and_solve_continue_one_conversation(monkeypatch):
    """18 questions: copy batches of 16 at low, each from the map's messages and
    reply, then solve batches of 8 at mid, each continuing the batch that copied
    them. 48,000 tokens on every call and the same tools."""
    items = {str(n): _mcq(str(n), ["p", "q"], 1) for n in range(1, 19)}
    script = Script(
        "\n".join(_row(label) for label in items),
        {
            "Copy questions 1 to 16 now.": [
                _tools(
                    *(("record_question", _copy(items[str(n)])) for n in range(1, 17))
                )
            ],
            "Copy questions 17 to 18 now.": [
                _tools(*(("record_question", _copy(items[str(n)])) for n in (17, 18)))
            ],
            "Give the answers to questions 1 to 8 now.": [
                _tools(
                    *(("record_answers", _answers(items[str(n)])) for n in range(1, 9))
                )
            ],
            "Give the answers to questions 9 to 16 now.": [
                _tools(
                    *(("record_answers", _answers(items[str(n)])) for n in range(9, 17))
                )
            ],
            "Give the answers to questions 17 to 18 now.": [
                _tools(*(("record_answers", _answers(items[str(n)])) for n in (17, 18)))
            ],
        },
    )
    events = await _run(monkeypatch, script, [_page(5, "Text.")])
    firsts = {}
    for call in script.sent:
        firsts.setdefault(call["ask"], call)
    assert list(firsts) == [
        "map",
        "Copy questions 1 to 16 now.",
        "Copy questions 17 to 18 now.",
        "Give the answers to questions 1 to 8 now.",
        "Give the answers to questions 9 to 16 now.",
        "Give the answers to questions 17 to 18 now.",
    ]
    assert firsts["map"]["thinking"] == "mid"
    assert firsts["map"]["call_purpose"] == "extraction_map"
    assert firsts["Copy questions 1 to 16 now."]["thinking"] == "low"
    assert firsts["Copy questions 1 to 16 now."]["call_purpose"] == "extraction_copy"
    solve = firsts["Give the answers to questions 9 to 16 now."]
    assert solve["thinking"] == "mid" and solve["call_purpose"] == "extraction_solve"
    assert {call["max_tokens"] for call in script.sent} == {48_000}
    assert {
        tuple(tool["function"]["name"] for tool in call["tools"])
        for call in script.sent
    } == {("record_question", "record_answers")}
    # Each copy batch starts from the map's messages and its reply.
    map_messages = firsts["map"]["messages"]
    copy_first = firsts["Copy questions 17 to 18 now."]["messages"]
    assert copy_first[:2] == map_messages
    assert copy_first[2]["content"] == "\n".join(_row(label) for label in items)
    # A solve batch continues the whole copy thread that holds its questions.
    conversation = solve["messages"]
    asked = [m["content"] for m in conversation if m["role"] == "user"][1:]
    assert asked == [
        "Copy questions 1 to 16 now.",
        "Give the answers to questions 9 to 16 now.",
    ]
    roles = [m["role"] for m in conversation[3:-1]]
    assert roles.count("tool") == 16 and roles[-1] == "assistant"
    assert conversation[-2]["content"] == "DONE"
    other = firsts["Give the answers to questions 17 to 18 now."]["messages"]
    assert [m["content"] for m in other if m["role"] == "user"][1:] == [
        "Copy questions 17 to 18 now.",
        "Give the answers to questions 17 to 18 now.",
    ]
    done = events[-1]
    assert done["report"]["recorded"] == [str(n) for n in range(1, 19)]
    assert done["report"]["answersMissing"] == []
    assert done["report"]["windows"] == 2
    assert all(q["parts"][0]["answer"]["correct"] == [1] for q in done["questions"])


async def test_a_copied_question_counts_as_recorded_after_its_batch(monkeypatch):
    """``questions`` goes out after each copy batch, holding the copies, with no
    answers yet: what the screens count as recorded."""
    item = _open("8", [("a", 2), ("b(i)", 1)], total=3)
    item["parts"][1]["lead_in"] = "Data for (b)."
    script = Script(
        _row("8", parts="a, b(i)"),
        {
            "Copy question 8 now.": [_tools(("record_question", _copy(item)))],
            "Give the answers to question 8 now.": [
                _tools(("record_answers", _answers(item)))
            ],
        },
    )
    events = await _run(monkeypatch, script, [_page(5)])
    assert [e["type"] for e in events] == ["questions", "done"]
    [copied] = events[0]["questions"]
    assert copied["parts"][0]["answer"] == {"type": "open", "accepted": [], "hints": []}
    assert (
        copied["parts"][0]["markscheme"] == [] and copied["parts"][0]["solution"] == []
    )
    [saved] = events[1]["questions"]
    assert saved["parts"][1]["blocks"][0] == {"type": "text", "text": "Data for (b)."}
    assert saved["parts"][0]["markscheme"] == [{"text": "1A for a", "marks": 2}]
    assert saved["parts"][0]["answer"]["accepted"] == ["answer a"]
    assert set(saved["parts"][0]["solution"][0]) == {"type", "text"}


async def test_a_copy_is_checked_without_its_keys(monkeypatch):
    """The validator sees placeholder keys, so only what was copied can be refused.
    Pages and figures are required, a key sent anyway is dropped, and answers wait."""
    seen: list[dict] = []

    async def validate(question):
        seen.append(copy.deepcopy(question))
        options = question["parts"][0]["answer"].get("options")
        return "choice answers require two options" if options == ["only"] else None

    good = _mcq("1", ["p", "q"], 1)
    no_pages = extraction._keyless(_mcq("1", ["p", "q"]))
    no_pages["figures"] = []
    outside = _copy(_mcq("1", ["p", "q"]), first=5, last=9)
    no_figures = extraction._keyless(_mcq("1", ["p", "q"]))
    no_figures["pages"] = [5, 5]
    refused = _copy(_mcq("1", ["only"]))
    sent_a_key = {"figures": [], "pages": [5, 5], **good}
    script = Script(
        _row("1"),
        {
            "Copy question 1 now.": [
                _tools(
                    ("record_question", no_pages),
                    ("record_question", outside),
                    ("record_question", no_figures),
                    ("record_question", refused),
                    ("record_answers", _answers(good)),
                    ("other_tool", {}),
                    ("record_question", sent_a_key),
                )
            ],
            "Give the answers to question 1 now.": [
                _tools(("record_answers", _answers(good)))
            ],
        },
    )
    events = await _run(monkeypatch, script, [_page(5)], validate=validate)
    copying = [c for c in script.sent if c["ask"] == "Copy question 1 now."][-1]
    results = [m["content"] for m in copying["messages"] if m["role"] == "tool"]
    assert results == [
        "Question 1: pages: expected [first, last], the page numbers it is on. Fix it and record it again.",
        "Question 1: pages: expected [first, last], the page numbers it is on. Fix it and record it again.",
        "Question 1: figures: give [] when it needs none. Fix it and record it again.",
        "Question 1: choice answers require two options. Fix it and record it again.",
        "Question 1: not yet. Copy every question first; you are asked for the answers later.",
        "There is no tool other_tool.",
        "Question 1: recorded.",
    ]
    assert seen[0]["parts"][0]["answer"]["correct"] == [0]
    assert events[0]["questions"][0]["parts"][0]["answer"]["correct"] == []
    assert events[-1]["questions"][0]["parts"][0]["answer"]["correct"] == [1]


async def test_answers_are_merged_into_the_copy_and_checked(monkeypatch):
    """Refusals name what to fix; an open part needs its model answer; a question
    already copied is not copied again."""
    item = _open("2", [("a", 1), ("b", 2)])
    no_part = _answers(item)
    no_part["parts"][0]["label"] = "z"
    no_model = _answers(item)
    no_model["parts"][1]["accepted"] = []
    script = Script(
        _row("2", parts="a, b"),
        {
            "Copy question 2 now.": [_tools(("record_question", _copy(item)))],
            "Give the answers to question 2 now.": [
                _tools(
                    ("record_answers", {"label": "7", "parts": []}),
                    ("record_answers", no_part),
                    ("record_answers", no_model),
                    ("record_question", _copy(item)),
                    ("record_answers", _answers(item)),
                )
            ],
        },
    )
    events = await _run(monkeypatch, script, [_page(5)])
    solving = script.sent[-1]["messages"]
    results = [m["content"] for m in solving if m["role"] == "tool"][1:]
    assert results == [
        "Question 7: no question with this label was copied. Give the label it was copied with.",
        'Question 2: it has no part "z"; its parts are a, b. Fix it and record it again.',
        "Question 2: 2(b): invalid accepted answers. Fix it and record it again.",
        "Question 2: it is already copied; give its answers with record_answers.",
        "Question 2: recorded.",
    ]
    done = events[-1]
    [saved] = done["questions"]
    assert saved["parts"][0]["solution"] == [{"type": "text", "text": "Work for a."}]
    assert saved["parts"][1]["solution"] == [{"type": "text", "text": "Work for b."}]


async def _one_question(monkeypatch, pages, answers):
    item = _mcq("1", ["p", "q"], 1)
    script = Script(
        _row("1"),
        {
            "Copy question 1 now.": [_tools(("record_question", _copy(item)))],
            "Give the answers to question 1 now.": [
                _tools(("record_answers", _answers(item)))
            ],
        },
    )
    events = await _run(monkeypatch, script, pages, answers)
    return script, events


async def test_answer_files_go_in_the_first_message_and_every_question_is_solved(
    monkeypatch,
):
    """After the boxes and before the ask: text under its heading, an image under its
    own, numbered apart from the question pages. No other call reads them."""

    async def image():
        return "data:image/jpeg;base64,answer"

    answers = [
        extraction.AnswerFile("key.docx", "1. B"),
        extraction.AnswerFile("drawn.jpg", images=((3, image),)),
    ]
    script, events = await _one_question(monkeypatch, [_page(5)], answers)
    content = script.sent[0]["messages"][1]["content"]
    assert content[0]["text"] == "Page image 1: page 5 of paper.pdf."
    assert content[2]["text"].startswith("Boxes on these pages")
    assert content[3]["text"] == (
        "Answer file key.docx. Its indexed text:\n<source>\n1. B\n</source>"
    )
    assert content[4]["text"] == "Answer file page image 1: page 3 of drawn.jpg."
    assert content[5]["image_url"]["url"] == "data:image/jpeg;base64,answer"
    assert content[6]["text"] == extraction.prompts.MAP_ASK
    for call in script.sent[1:]:
        assert call["messages"][1]["content"] == content
    assert "Give the answers to question 1 now." in script.asks()
    assert events[-1]["questions"][0]["parts"][0]["answer"]["correct"] == [1]


def test_no_prompt_says_how_a_question_was_made():
    """Epo 2026-11-05: "i dont care how the quesitons is made"."""
    read = " ".join(
        [
            extraction.prompts.SYSTEM,
            extraction.prompts.SYSTEM_NO_PAGE_TEXT,
            extraction.prompts.MAP_ASK,
            extraction.prompts.LOCATE_SYSTEM,
            json.dumps(extraction.prompts.TOOLS),
        ]
    )
    assert not re.search(r"(?i)\bprint|handwrit", read)


async def test_code_sends_a_repair_for_a_question_left_out(monkeypatch):
    """A map row its batch left out, a number the map skips, and the next number
    printed on a page no row covers each get a repair in the thread, ordered by
    number; an answer a batch left out gets one more call."""
    items = {n: _mcq(str(n), ["p", "q"], 1) for n in (1, 2, 3, 4, 5)}
    script = Script(
        "\n".join([_row("1"), _row("2"), _row("4")]),
        {
            "Copy questions 1 to 4 now.": [
                _tools(
                    ("record_question", _copy(items[1])),
                    ("record_question", _copy(items[4])),
                )
            ],
            "Copy questions 2 to 3 now.": [
                _tools(
                    ("record_question", _copy(items[2])),
                    ("record_question", _copy(items[3])),
                )
            ],
            "Copy question 5 now.": [
                _tools(("record_question", _copy(items[5], 6, 6)))
            ],
            "Give the answers to questions 1 to 5 now.": [
                _tools(*(("record_answers", _answers(items[n])) for n in (1, 2, 3, 5)))
            ],
            "Give the answers to question 4 now.": [
                _tools(("record_answers", _answers(items[4])))
            ],
        },
    )
    pages = [_page(5, "1. x\n2. y\n3. z\n4. w"), _page(6, "5. tail")]
    events = await _run(monkeypatch, script, pages)
    asks = script.asks()
    assert "Copy questions 2 to 3 now." in asks
    assert "Copy question 5 now." in asks
    assert asks.index("Give the answers to question 4 now.") > asks.index(
        "Give the answers to questions 1 to 5 now."
    )
    done = events[-1]
    assert done["report"]["recorded"] == ["1", "2", "3", "4", "5"]
    assert done["report"]["expected"] == ["1", "2", "4"]
    assert done["report"]["missing"] == []
    assert done["report"]["answersMissing"] == []


async def test_a_figure_a_batch_leaves_out_is_filled_from_the_map(monkeypatch):
    """The map lists boxes for a question whose batch named none: its boxes are
    cropped and placed with its text, and stay when its answers arrive."""
    first, _ = _figure_regions()
    item = _mcq("1", ["p", "q"], 1)

    async def read_regions(images):
        return [first]

    monkeypatch.setattr(extraction.layout, "read_regions", read_regions)
    script = Script(
        _row("1", figures="1, 2"),
        {
            "Copy question 1 now.": [_tools(("record_question", _copy(item)))],
            "Give the answers to question 1 now.": [
                _tools(("record_answers", _answers(item)))
            ],
        },
    )
    crops: list = []
    events = await _run(monkeypatch, script, [_page(5, crops=crops)])
    done = events[-1]
    assert crops == [(5, [90.0, 190.0, 510.0, 430.0])]
    assert done["report"]["figures"] == ["1"]
    assert done["questions"][0]["parts"][0]["blocks"][-1]["image"] == {
        "assetId": "figure:q1-1"
    }


async def test_a_failed_stream_is_tried_again_where_it_is(monkeypatch):
    """A round that fails costs that round: the thread's earlier replies stay and
    nothing else restarts."""
    one, two = _mcq("1", ["p", "q"], 1), _mcq("2", ["p", "q"], 1)
    ask = "Copy questions 1 to 2 now."
    script = Script(
        "\n".join([_row("1"), _row("2")]),
        {
            ask: [
                _tools(("record_question", _copy(one))),
                _tools(("record_question", _copy(two))),
            ],
            "Give the answers to questions 1 to 2 now.": [
                _tools(
                    ("record_answers", _answers(one)), ("record_answers", _answers(two))
                )
            ],
        },
        fail={ask: [TimeoutError("provider sent no first event within 15 s")]},
    )
    events = await _run(monkeypatch, script, [_page(5)])
    assert script.asks().count("map") == 1
    # The ask's rounds: the failed call, the same call again, and the two after it.
    rounds = [c for c in script.sent if c["ask"] == ask]
    assert len(rounds) == 4
    assert rounds[0]["messages"] == rounds[1]["messages"]
    assert events[-1]["report"]["recorded"] == ["1", "2"]


async def test_a_copy_batch_that_fails_ends_alone_and_its_questions_are_named(
    monkeypatch,
):
    items = {str(n): _mcq(str(n), ["p", "q"], 1) for n in range(1, 18)}
    ask = "Copy questions 1 to 16 now."
    down = extraction.elitellm.ProviderError("upstream error")
    script = Script(
        "\n".join(_row(label) for label in items),
        {
            "Copy question 17 now.": [_tools(("record_question", _copy(items["17"])))],
            "Give the answers to question 17 now.": [
                _tools(("record_answers", _answers(items["17"])))
            ],
        },
        fail={ask: [down] * 2},
    )
    monkeypatch.setattr(extraction, "COPY_REPAIR_PASSES", 0)
    events = await _run(monkeypatch, script, [_page(5)])
    report = events[-1]["report"]
    assert report["recorded"] == ["17"]
    assert report["missing"] == [str(n) for n in range(1, 17)]
    assert report["answersMissing"] == []


async def test_a_solve_call_that_fails_keeps_the_copies_and_names_what_is_missing(
    monkeypatch,
):
    """A failed solve call leaves its questions in the quiz as copied, named in the
    report, and keeps what a part has. Others are unaffected."""
    one, two, three = (
        _mcq("1", ["p", "q"], 1),
        _open("2", [("a", 2)]),
        _mcq("3", ["r", "s"], 1),
    )
    short = _mcq("4", ["x"], 0)
    short["parts"][0]["answer"] = {"type": "short", "accepted": ["7"], "unit": "cm"}
    ask = "Give the answers to questions 1 to 2 now."
    down = extraction.elitellm.ProviderError("upstream error")
    monkeypatch.setattr(extraction, "SOLVE_BATCH", 2)
    script = Script(
        "\n".join(_row(str(n)) for n in (1, 2, 3, 4)),
        {
            "Copy questions 1 to 4 now.": [
                _tools(
                    ("record_question", _copy(one)),
                    ("record_question", _copy(two)),
                    ("record_question", _copy(three)),
                    ("record_question", _copy(short)),
                )
            ],
            "Give the answers to questions 3 to 4 now.": [
                _tools(("record_answers", _answers(three)))
            ],
        },
        fail={ask: [down] * 4},
    )
    events = await _run(monkeypatch, script, [_page(5)])
    done = events[-1]
    report = done["report"]
    assert report["recorded"] == ["1", "2", "3", "4"]
    assert report["answersMissing"] == ["1", "2(a)", "4"]
    first, second, third, fourth = done["questions"]
    assert first["parts"][0]["answer"] == {
        "type": "mcq",
        "options": ["p", "q"],
        "correct": [],
    }
    assert first["parts"][0]["solution"] == []
    assert second["parts"][0]["answer"]["type"] == "open"
    assert second["parts"][0]["markscheme"] == []
    assert third["parts"][0]["answer"]["correct"] == [1]
    assert fourth["parts"][0]["answer"]["type"] == "short"
    assert fourth["parts"][0]["answer"]["accepted"] == []
    assert fourth["parts"][0]["answer"]["unit"] == "cm"


async def test_a_map_that_fails_twice_fails_the_run(monkeypatch):
    down = extraction.elitellm.ProviderError("upstream error")
    script = Script("", fail={"map": [down, down]})
    with pytest.raises(extraction.elitellm.ProviderError):
        await _run(monkeypatch, script, [_page(5)])
    assert script.asks() == ["map", "map"]


async def test_a_run_with_no_copies_after_a_failure_fails(monkeypatch):
    down = extraction.elitellm.ProviderError("upstream error")
    ask = "Copy question 1 now."
    script = Script(_row("1"), fail={ask: [down] * 6})
    with pytest.raises(extraction.elitellm.ProviderError):
        await _run(monkeypatch, script, [_page(5)])


async def test_a_map_with_no_questions_saves_nothing(monkeypatch):
    events = await _run(monkeypatch, Script("No questions here."), [_page(5)])
    assert events[-1]["questions"] == []
    assert events[-1]["report"]["expected"] == []


async def test_a_reply_cut_off_at_the_cap_is_asked_again(monkeypatch):
    item = _mcq("1", ["p", "q"], 1)
    ask = "Copy question 1 now."
    script = Script(
        _row("1"),
        {
            ask: [{"finish": "length", "tokens": 100}],
            extraction.prompts.CUT_OFF: [_tools(("record_question", _copy(item)))],
            "Give the answers to question 1 now.": [
                _tools(("record_answers", _answers(item)))
            ],
        },
    )
    events = await _run(monkeypatch, script, [_page(5)])
    assert extraction.prompts.CUT_OFF in script.asks()
    assert events[-1]["report"]["answersMissing"] == []


async def test_a_run_past_its_output_budget_stops_and_keeps_what_it_has(monkeypatch):
    """Output past 8,000 tokens a selected page ends the run as output_limit: what
    was copied is saved and the rest is named."""
    item = _mcq("1", ["p", "q"], 1)
    ask = "Copy questions 1 to 2 now."
    script = Script(
        "\n".join([_row("1"), _row("2")]),
        {
            ask: [
                _tools(("record_question", _copy(item))),
                {"finish": "length", "tokens": 24_000},
            ]
        },
    )
    events = await _run(monkeypatch, script, [_page(5, "1. ... 2. ...")])
    report = events[-1]["report"]
    assert report["stopped"] == "output_limit"
    assert report["recorded"] == ["1"] and report["missing"] == ["2"]
    assert report["answersMissing"] == ["1"]
    assert not any(a.startswith("Give the answers") for a in script.asks())


async def test_running_out_of_credits_stops_the_threads(monkeypatch):
    item = _mcq("1", ["p", "q"], 1)
    ask = "Copy question 1 now."
    state = SimpleNamespace(credits_exhausted=False)

    async def copy_then_out():
        state.credits_exhausted = True

    script = Script(
        _row("1"),
        {ask: [_tools(("record_question", _copy(item)))]},
        before={ask: copy_then_out},
    )
    monkeypatch.setattr(extraction.accounting, "current", lambda: state)
    events = await _run(monkeypatch, script, [_page(5)])
    report = events[-1]["report"]
    assert report["stopped"] == "credits"
    assert report["recorded"] == ["1"] and report["answersMissing"] == ["1"]
    assert not any(a.startswith("Give the answers") for a in script.asks())


async def test_closing_the_stream_stops_the_threads(monkeypatch):
    never = asyncio.Event()
    cancelled: list[bool] = []

    async def hang():
        try:
            await never.wait()
        except asyncio.CancelledError:
            cancelled.append(True)
            raise

    script = Script(
        "\n".join([_row(str(n)) for n in range(1, 18)]),
        {
            "Copy question 17 now.": [
                _tools(("record_question", _copy(_mcq("17", ["p", "q"]))))
            ]
        },
        before={"Copy questions 1 to 16 now.": hang},
    )
    monkeypatch.setattr(extraction, "ATTEMPT_WAIT_S", 0)
    monkeypatch.setattr(extraction.models, "complete_response", script)
    registry.bind_request_llm("mid")
    stream = extraction.run([_page(5)], [], model=MODEL, validate=_ok)
    first = await stream.__anext__()
    assert first["type"] == "questions"
    await stream.aclose()
    assert cancelled == [True]


def test_dollar_math_turns_backslash_math_into_dollars():
    assert extraction.dollar_math(r"Find \(x^2\) and \[y\].") == "Find $x^2$ and $y$."
    assert extraction.dollar_math(r"Two\( a \)lines\[ b\nc \]") == "Two$a$lines$b\\nc$"


@pytest.mark.parametrize(
    "text",
    [
        # Code stays code.
        r"Run `grep '\(a\)' file` now.",
        '```\nprintf("\\(x\\)")\n```',
        # Math already between $ signs, and a printed dollar beside new math.
        r"$\left\(x\right\)$",
        r"Costs $5 and \(x\) more.",
        # A pair holding a bare $, an escaped backslash, and half a pair.
        r"\(a $ b\)",
        r"a \\(b\\) c",
        r"Swift says \(name) here.",
        r"\(\)",
    ],
)
def test_dollar_math_leaves_literals_alone(text):
    assert extraction.dollar_math(text) == text


@pytest.mark.parametrize(
    ("text", "saved"),
    [
        ("**Fig. 1** shows", "Fig. 1 shows"),
        ("Use **the** graph **below**.", "Use the graph below."),
        ("(**a**) **$x^2$** is **5**", "(a) $x^2$ is 5"),
        ("**Find $a^{**}$ now**", "Find $a^{**}$ now"),
        ("这是**粗体**的字", "这是粗体的字"),
        ("x**2 and **bold**", "x**2 and bold"),
    ],
)
def test_strip_bold_removes_the_markers(text, saved):
    assert extraction.strip_bold(text) == saved


@pytest.mark.parametrize(
    "text",
    [
        # Powers, in every form that could pair up.
        "x**2 + y**2",
        "2 ** 3 ** 4",
        "(a+b)**2 = (c)**(d) + (e)**(f)",
        "α**β + γ**δ",
        "[x]**2 + [y]**2",
        # Math and code.
        "$a^{**} + b^{**}$",
        "`x**y and **z**`",
        "```\n**kept**\n```",
        # Grades, footnotes, arguments and markers on two lines.
        "A** and B**",
        "** significant; ** very",
        "f(**a, **b)",
        "a**\n**b",
        "only **one marker",
    ],
)
def test_strip_bold_leaves_what_is_not_bold(text):
    assert extraction.strip_bold(text) == text


async def test_saved_questions_show_no_bold_markers(monkeypatch):
    item = _open("2", [("a", 2)])
    item["stem"] = [
        {"type": "text", "text": "**Read** this."},
        {"type": "table", "header": True, "rows": [["**Head**", "x**2"]]},
    ]
    item["parts"][0]["blocks"] = _text("Find **y**.")
    item["parts"][0]["answer"]["points"] = [{"text": "**Method**", "marks": 2}]
    item["parts"][0]["answer"]["accepted"] = ["**7**"]
    item["parts"][0]["solution"] = "So **y=7**."
    mcq = _mcq("3", ["**a**", "b"], 1)
    script = Script(
        "\n".join([_row("2", parts="a"), _row("3")]),
        {
            "Copy questions 2 to 3 now.": [
                _tools(
                    ("record_question", _copy(item)), ("record_question", _copy(mcq))
                )
            ],
            "Give the answers to questions 2 to 3 now.": [
                _tools(
                    ("record_answers", _answers(item)),
                    ("record_answers", _answers(mcq)),
                )
            ],
        },
    )
    events = await _run(monkeypatch, script, [_page(5)])
    second, third = events[-1]["questions"]
    assert second["stem"][0]["text"] == "Read this."
    assert second["stem"][1]["rows"] == [["Head", "x**2"]]
    part = second["parts"][0]
    assert part["blocks"][0]["text"] == "Find y."
    assert part["markscheme"][0]["text"] == "Method"
    assert part["answer"]["accepted"] == ["7"]
    assert part["solution"][0]["text"] == "So y=7."
    assert third["parts"][0]["answer"]["options"] == ["a", "b"]


async def test_saved_questions_show_no_backslash_math_and_tables_stay(monkeypatch):
    item = _open("2", [("a", 2)])
    item["stem"] = [
        {"type": "text", "text": r"Let \(x\) be."},
        {"type": "table", "header": False, "rows": [[r"\(\d+\)", "b"]]},
    ]
    item["parts"][0]["blocks"] = _text(r"Find \[y\].")
    item["parts"][0]["answer"]["points"] = [{"text": r"Use \(x\)", "marks": 2}]
    item["parts"][0]["answer"]["accepted"] = [r"\(7\)"]
    item["parts"][0]["solution"] = r"So \(y=7\)."
    mcq = _mcq("3", [r"\(a\)", r"\(b\)"], 1)
    script = Script(
        "\n".join([_row("2", parts="a"), _row("3")]),
        {
            "Copy questions 2 to 3 now.": [
                _tools(
                    ("record_question", _copy(item)), ("record_question", _copy(mcq))
                )
            ],
            "Give the answers to questions 2 to 3 now.": [
                _tools(
                    ("record_answers", _answers(item)),
                    ("record_answers", _answers(mcq)),
                )
            ],
        },
    )
    events = await _run(monkeypatch, script, [_page(5)])
    second, third = events[-1]["questions"]
    assert second["stem"][0]["text"] == "Let $x$ be."
    assert second["stem"][1]["rows"] == [[r"\(\d+\)", "b"]]
    part = second["parts"][0]
    assert part["blocks"][0]["text"] == "Find $y$."
    assert part["markscheme"][0]["text"] == "Use $x$"
    assert part["answer"]["accepted"] == ["$7$"]
    assert part["solution"][0]["text"] == "So $y=7$."
    assert third["parts"][0]["answer"]["options"] == ["$a$", "$b$"]


def _pdf_page(text: str = "", *, hidden: bool = False, image: bool = False, box=None):
    """One PDF page, with text shown or in a hidden layer, and an image."""
    doc = pymupdf.open()
    page = doc.new_page()
    if text:
        page.insert_text((50, 50), text, render_mode=3 if hidden else 0)
    if image:
        jpeg = base64.b64decode(BLANK_PAGE.split(",", 1)[1])
        page.insert_image(box or page.rect, stream=jpeg)
    return doc, page


LINE = "A printed line of a question that is long enough to count. " * 2


@pytest.mark.parametrize(
    ("kwargs", "indexed", "layer"),
    [
        ({"text": LINE}, LINE, extraction.BORN_DIGITAL),
        # A figure on a printed page is no scan.
        (
            {"text": LINE, "image": True, "box": pymupdf.Rect(50, 100, 200, 200)},
            LINE,
            extraction.BORN_DIGITAL,
        ),
        # A scan under a hidden OCR layer, and one with no layer and a page read.
        ({"text": LINE, "hidden": True, "image": True}, LINE, extraction.SCAN),
        ({"image": True}, LINE, extraction.SCAN),
        # OCR text drawn under the page's image.
        ({"text": LINE, "image": True}, LINE, extraction.SCAN),
        # A hidden layer with no image, and text only a page read found.
        ({"text": LINE, "hidden": True}, LINE, extraction.SCAN),
        ({}, LINE, extraction.SCAN),
        # A blank page, with or without a footer.
        ({}, "", extraction.BLANK),
        ({"text": "BLANK PAGE"}, "BLANK PAGE", extraction.BLANK),
    ],
)
def test_page_layer_tells_scans_from_born_digital_pages(kwargs, indexed, layer):
    doc, page = _pdf_page(**kwargs)
    with doc:
        assert extraction.page_layer(page, indexed) == layer


def test_a_page_with_far_too_much_text_is_not_read_a_character_at_a_time(monkeypatch):
    monkeypatch.setattr(extraction, "PAGE_CHARS_MOST", len(LINE) - 1)
    doc, page = _pdf_page(LINE)
    with doc:
        assert extraction.page_layer(page, LINE) == extraction.SCAN


@pytest.mark.parametrize(
    ("layers", "sent"),
    [
        ((extraction.BORN_DIGITAL, extraction.BORN_DIGITAL), True),
        ((extraction.BORN_DIGITAL, extraction.BLANK), True),
        ((extraction.BORN_DIGITAL, extraction.SCAN), False),
        ((extraction.SCAN, extraction.BLANK), False),
        ((extraction.BLANK, extraction.BLANK), False),
    ],
)
def test_page_text_goes_only_when_no_page_is_a_scan(layers, sent):
    pages = [_page(5 + index, layer=layer) for index, layer in enumerate(layers)]
    assert extraction.sends_page_text(pages) is sent


async def test_a_scan_sends_no_page_text_on_any_call(monkeypatch):
    item = _open("8", [("a", 2)])
    script = Script(
        _row("8", 5, 6, "a"),
        {
            "Copy question 8 now.": [_tools(("record_question", _copy(item)))],
            "Give the answers to question 8 now.": [
                _tools(("record_answers", _answers(item)))
            ],
        },
    )
    events = await _run(
        monkeypatch,
        script,
        [_page(5, "Rough text."), _page(6, layer=extraction.BORN_DIGITAL)],
    )
    assert events[-1]["report"]["recorded"] == ["8"]
    first_paragraph = (
        "You copy the questions on the selected pages into a quiz, exactly as they "
        "appear. You see all the selected page images at once. After the question pages "
        "may come answer files: a mark scheme, an answer key or someone's own answers, "
        "in any layout."
    )
    assert {
        body["messages"][0]["content"].split("\n\n")[0] for body in script.sent
    } == {first_paragraph}
    content = script.sent[0]["messages"][1]["content"]
    assert content[0]["text"] == "Page image 1: page 5 of paper.pdf."
    assert content[2]["text"] == "Page image 2: page 6 of paper.pdf."
    assert "Rough text." not in json.dumps([body["messages"] for body in script.sent])


@pytest.mark.parametrize(
    ("layer", "page_part"),
    [
        (
            extraction.BORN_DIGITAL,
            (
                "Page image 1: page 5 of paper.pdf. Its indexed text:\n"
                "<source>\nPaper text.\n</source>"
            ),
        ),
        (extraction.SCAN, "Page image 1: page 5 of paper.pdf."),
    ],
)
async def test_only_the_papers_pages_decide_its_page_text(
    monkeypatch, layer, page_part
):
    """An answer file has no say over the paper's page text, and goes the same way
    whichever the paper is."""
    script, _ = await _one_question(
        monkeypatch,
        [_page(5, "Paper text.", layer=layer)],
        [extraction.AnswerFile("answers.pdf", "Scheme text.")],
    )
    content = script.sent[0]["messages"][1]["content"]
    assert content[0]["text"] == page_part
    assert "Scheme text." in content[3]["text"]


async def _prepared(monkeypatch, kind: str, path=None) -> list[extraction.Page]:
    async def source(workspace_id, file_id):
        return {"kind": kind}

    async def passages(workspace_id, file_id):
        return [{"text": LINE, "page_start": 1, "page_end": 1}]

    async def pdf_path(workspace_id, file_id):
        return path

    monkeypatch.setattr(extraction.store, "file_page_source", source)
    monkeypatch.setattr(extraction.store, "file_passages", passages)
    monkeypatch.setattr(extraction.capture, "pdf_path", pdf_path)
    paper = [{"fileId": "f", "name": "paper", "pages": [1]}]
    pages, _ = await extraction.prepare("w", paper, [])
    return pages


async def test_prepare_reads_each_page_from_the_stored_pdf(monkeypatch, tmp_path):
    doc, _ = _pdf_page(LINE)
    path = tmp_path / "paper.pdf"
    with doc:
        doc.save(path)
    pages = await _prepared(monkeypatch, "pdf", path)
    assert [page.layer for page in pages] == [extraction.BORN_DIGITAL]


async def test_prepare_treats_an_image_upload_as_a_scan(monkeypatch):
    pages = await _prepared(monkeypatch, "image")
    assert [(page.layer, page.text) for page in pages] == [(extraction.SCAN, LINE)]
    assert extraction.sends_page_text(pages) is False


async def _answer_files(monkeypatch, kind: str, path=None, text=LINE, pages=1):
    """The run's answer files for one file of ``kind``, beside ``pages`` selected pages."""

    async def source(workspace_id, file_id):
        return {"kind": kind}

    async def passages(workspace_id, file_id):
        return [{"text": text, "page_start": 1, "page_end": 1}] if text else []

    async def pdf_path(workspace_id, file_id):
        return path

    monkeypatch.setattr(extraction.store, "file_page_source", source)
    monkeypatch.setattr(extraction.store, "file_passages", passages)
    monkeypatch.setattr(extraction.capture, "pdf_path", pdf_path)
    # The paper is images, one a file, so it only counts pages.
    if kind != "image":

        async def image_source(workspace_id, file_id):
            return {"kind": "image" if file_id.startswith("p") else kind}

        monkeypatch.setattr(extraction.store, "file_page_source", image_source)
    paper = [{"fileId": f"p{n}", "name": "p", "pages": [1]} for n in range(pages)]
    answers = [{"fileId": "a", "name": "answers"}]
    _, files = await extraction.prepare("w", paper, answers)
    return files


async def test_a_born_digital_or_office_answer_file_goes_as_text(monkeypatch, tmp_path):
    doc, _ = _pdf_page(LINE)
    path = tmp_path / "answers.pdf"
    with doc:
        doc.save(path)
    [pdf] = await _answer_files(monkeypatch, "pdf", path)
    assert (pdf.text, pdf.images) == (LINE.strip(), ())
    [word] = await _answer_files(monkeypatch, "docx")
    assert (word.text, word.images) == (LINE.strip(), ())


async def test_a_scan_or_image_answer_file_goes_as_page_images(monkeypatch, tmp_path):
    """A scan needs no indexed text, and a blank page is left out."""
    doc = pymupdf.open()
    page = doc.new_page()
    picture = Image.new("L", (40, 40), 200)
    buffer = io.BytesIO()
    picture.save(buffer, "PNG")
    page.insert_image(page.rect, stream=buffer.getvalue())
    doc.new_page()
    path = tmp_path / "scan.pdf"
    with doc:
        doc.save(path)
    [scan] = await _answer_files(monkeypatch, "pdf", path, text="")
    assert (scan.text, [number for number, _ in scan.images]) == ("", [1])
    [photo] = await _answer_files(monkeypatch, "image", text="")
    assert [number for number, _ in photo.images] == [1]


async def test_a_run_refuses_more_page_images_than_it_reads(monkeypatch):
    """Paper and answer pages count together."""
    monkeypatch.setattr(extraction.limits, "EXTRACTION_PAGES_MAX", 2)
    assert len(await _answer_files(monkeypatch, "image", pages=1)) == 1
    with pytest.raises(extraction.ExtractionRefused) as refused:
        await _answer_files(monkeypatch, "image", pages=2)
    assert refused.value.code == "too_many_pages"


async def test_a_scan_past_the_page_images_left_goes_as_its_text(monkeypatch, tmp_path):
    """A long scheme with scanned pages goes as its indexed text, rather than being
    refused or sending more images than a run takes (a 71-page one stalled the provider)."""
    monkeypatch.setattr(extraction.limits, "EXTRACTION_PAGES_MAX", 1)
    doc = pymupdf.open()
    page = doc.new_page()
    buffer = io.BytesIO()
    Image.new("L", (40, 40), 200).save(buffer, "PNG")
    page.insert_image(page.rect, stream=buffer.getvalue())
    path = tmp_path / "scan.pdf"
    with doc:
        doc.save(path)
    [scan] = await _answer_files(monkeypatch, "pdf", path)
    assert (scan.text, scan.images) == (LINE.strip(), ())


@pytest.mark.parametrize(
    ("text", "code"),
    [
        ("", "no_indexed_text"),
        ("x" * (extraction.FILE_TEXT_CHARS + 1), "file_too_long"),
    ],
)
async def test_an_answer_file_with_no_usable_text_is_refused(monkeypatch, text, code):
    with pytest.raises(extraction.ExtractionRefused) as refused:
        await _answer_files(monkeypatch, "docx", text=text)
    assert refused.value.code == code


async def test_the_map_message_holds_each_page_and_all_the_boxes(monkeypatch):
    """Each page's text then its image, then every box as JSON, numbered once across
    the selection, then the ask. A split figure takes its boxes with the caption
    beside them and a 1% pad, and no box call runs. A number that is no box, or boxes
    on two pages, go back to the model."""
    first, second = _figure_regions()
    item = _open("8", [("a", 2), ("b", 2)])
    figures = [
        {"boxes": [1, 2], "part": "", "description": "Split figure"},
        {"boxes": [3], "part": "b", "description": "A chart"},
    ]
    ask = "Copy question 8 now."
    script = Script(
        _row("8", 5, 6, "a, b", "1, 2, 3"),
        {
            ask: [
                _tools(
                    (
                        "record_question",
                        _copy(
                            item,
                            5,
                            6,
                            figures=[{"boxes": [4], "part": "", "description": "None"}],
                        ),
                    ),
                    (
                        "record_question",
                        _copy(
                            item,
                            5,
                            6,
                            figures=[
                                {"boxes": [1, 3], "part": "", "description": "Two"}
                            ],
                        ),
                    ),
                    ("record_question", _copy(item, 5, 6, figures=figures)),
                )
            ],
            "Give the answers to question 8 now.": [
                _tools(("record_answers", _answers(item)))
            ],
        },
    )

    async def read_regions(images):
        return [first, second]

    monkeypatch.setattr(extraction.layout, "read_regions", read_regions)
    crops: list = []
    events = await _run(
        monkeypatch,
        script,
        [
            _page(5, "Text.", crops=crops, layer=extraction.BORN_DIGITAL),
            _page(6, crops=crops, layer=extraction.BORN_DIGITAL),
        ],
    )
    content = script.sent[0]["messages"][1]["content"]
    assert content[0]["text"] == (
        "Page image 1: page 5 of paper.pdf. Its indexed text:\n<source>\nText.\n</source>"
    )
    assert content[1]["image_url"]["url"] == BLANK_PAGE
    assert (
        content[2]["text"]
        == "Page image 2: page 6 of paper.pdf. It has no indexed text."
    )
    assert content[4]["text"] == (
        "Boxes on these pages, as JSON: "
        '[{"box": 1, "page": 5, "coordinates": [100, 200, 300, 400], "label": "image", "score": 0.97}, '
        '{"box": 2, "page": 5, "coordinates": [320, 210, 500, 390], "label": "image", "score": 0.9}, '
        '{"box": 3, "page": 6, "coordinates": [50, 61, 700, 800], "label": "chart", "score": 0.88}]'
    )
    assert content[5]["text"] == extraction.prompts.MAP_ASK
    copying = [c for c in script.sent if c["ask"] == ask][-1]["messages"]
    results = [m["content"] for m in copying if m["role"] == "tool"]
    assert results[0] == (
        "Question 8: figures[0].boxes: there is no box 4 on these pages; the boxes "
        "are 1, 2, 3. Fix it and record it again."
    )
    assert results[1] == (
        "Question 8: figures[0].boxes: a figure's boxes are on one page. Fix it and "
        "record it again."
    )
    assert crops == [(5, [90.0, 190.0, 510.0, 430.0]), (6, [40.4, 50.6, 710.0, 810.0])]
    done = events[-1]
    assert done["report"]["figures"] == ["8"]
    assert done["report"]["figuresLeftOut"] == []
    [question] = done["questions"]
    assert question["stem"][-1]["description"] == "Split figure"
    assert question["parts"][1]["blocks"][-1]["description"] == "A chart"


async def test_a_figure_with_no_box_takes_the_box_call_beside_one_that_has_a_box(
    monkeypatch,
):
    """Boxes [] with its page image sends that figure alone to the box call, whose box
    is grown to ink; a figure with a box is not asked about. A part the question lacks
    goes back to the model."""
    first, _ = _figure_regions()
    item = _open("8", [("a", 2)])
    figures = [
        {"boxes": [1], "part": "", "description": "Picked"},
        {"boxes": [], "image": 1, "part": "", "description": "No box on its page"},
        {"boxes": [], "image": 2, "part": "a", "description": "Layout failed"},
    ]
    ask = "Copy question 8 now."
    script = Script(
        _row("8", 5, 6, "a"),
        {
            ask: [
                _tools(
                    (
                        "record_question",
                        _copy(
                            item,
                            5,
                            6,
                            figures=[{"boxes": [1], "part": "z", "description": "x"}],
                        ),
                    ),
                    ("record_question", _copy(item, 5, 6, figures=figures)),
                )
            ],
            "Give the answers to question 8 now.": [
                _tools(("record_answers", _answers(item)))
            ],
        },
    )
    located: list[str] = []

    async def complete(messages, **kwargs):
        assert kwargs["call_purpose"] == "extraction_figures"
        located.append(messages[1]["content"][0]["text"])
        return SimpleNamespace(content='{"boxes": [[300, 300, 400, 400]]}')

    async def read_regions(images):
        return [first, ()]

    monkeypatch.setattr(extraction.layout, "read_regions", read_regions)
    crops: list = []
    events = await _run(
        monkeypatch,
        script,
        [_page(5, crops=crops), _page(6, crops=crops)],
        complete=complete,
    )
    copying = [c for c in script.sent if c["ask"] == ask][-1]["messages"]
    assert any(
        "figures[0].part: the question has no part z" in m["content"]
        for m in copying
        if m["role"] == "tool"
    )
    assert sorted(located) == [
        "The figures on this page:\n1. Question 8: Layout failed",
        "The figures on this page:\n1. Question 8: No box on its page",
    ]
    assert crops == [
        (5, [90.0, 190.0, 410.0, 430.0]),
        (5, [295.0, 295.0, 406.0, 406.0]),
        (6, [295.0, 295.0, 406.0, 406.0]),
    ]
    assert events[-1]["report"]["figuresLeftOut"] == []


async def test_a_page_whose_figure_boxes_fail_saves_its_questions_without_them(
    monkeypatch,
):
    """The box call for a page fails, and fails again on its one retry: the question
    is saved without that figure and the report names it, while a figure on another
    page is still placed (Epo 2026-11-04)."""
    item = _open("8", [("a", 2)])
    figures = [
        {"boxes": [], "image": 1, "part": "", "description": "Triangle"},
        {"boxes": [], "image": 2, "part": "a", "description": "Graph"},
    ]
    script = Script(
        _row("8", 5, 6, "a"),
        {
            "Copy question 8 now.": [
                _tools(("record_question", _copy(item, 5, 6, figures=figures)))
            ],
            "Give the answers to question 8 now.": [
                _tools(("record_answers", _answers(item)))
            ],
        },
    )
    attempts: list[str] = []

    async def complete(messages, **kwargs):
        listed = messages[1]["content"][0]["text"]
        attempts.append(listed)
        if "Triangle" in listed:
            raise extraction.elitellm.ProviderError("upstream error")
        return SimpleNamespace(content='{"boxes": [[100, 100, 500, 500]]}')

    events = await _run(monkeypatch, script, [_page(5), _page(6)], complete=complete)
    done = events[-1]
    assert sum("Triangle" in a for a in attempts) == 2
    [question] = done["questions"]
    assert [b["type"] for b in question["stem"]] == ["text"]
    assert question["parts"][0]["blocks"][-1]["image"] == {"assetId": "figure:q8-1"}
    assert done["report"]["figuresLeftOut"] == ["8"]
    assert done["report"]["figures"] == ["8"]


async def test_a_failed_layout_call_leaves_every_figure_to_the_box_call(monkeypatch):
    """The layout service refuses every page: the run still finishes, and its figure
    comes from the box call."""
    monkeypatch.setattr(extraction.layout.cfg, "layout_url", "http://10.77.0.2:8092")
    monkeypatch.setattr(extraction.layout.cfg, "layout_token", "t" * 40)
    client = extraction.layout.httpx.AsyncClient
    asked: list = []

    async def refused(request):
        asked.append(request)
        raise extraction.layout.httpx.ConnectError("refused")

    monkeypatch.setattr(
        extraction.layout.httpx,
        "AsyncClient",
        lambda **kwargs: client(
            transport=extraction.layout.httpx.MockTransport(refused), **kwargs
        ),
    )
    item = _open("8", [("a", 2)])
    figures = [{"boxes": [], "image": 1, "part": "", "description": "Graph"}]
    script = Script(
        _row("8", parts="a"),
        {
            "Copy question 8 now.": [
                _tools(("record_question", _copy(item, figures=figures)))
            ],
            "Give the answers to question 8 now.": [
                _tools(("record_answers", _answers(item)))
            ],
        },
    )

    async def complete(messages, **kwargs):
        return SimpleNamespace(content='{"boxes": [[300, 300, 400, 400]]}')

    crops: list = []
    events = await _run(monkeypatch, script, [_page(5, crops=crops)], complete=complete)
    assert len(asked) == 1
    assert (
        script.sent[0]["messages"][1]["content"][2]["text"]
        == "Boxes on these pages, as JSON: []"
    )
    assert crops == [(5, [295.0, 295.0, 406.0, 406.0])]
    assert events[-1]["report"]["figures"] == ["8"]


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

    async def run(pages, answers, *, model, validate):
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
