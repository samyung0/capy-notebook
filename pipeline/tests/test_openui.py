"""The OpenUI Lang answer: the subset parser, reading-order citations, the
streaming renderer whose output equals its input, and the text projection."""

from __future__ import annotations

import pytest

from pipeline.retrieval import openui

PROGRAM = """root = Answer([intro, tabs, cmp, chart, ask])
later = Md("Defined early, read late.", [3])
intro = Md("ACID names four guarantees.", [8, 1])
tabs = Tabs([t1])
t1 = Tab("Atomicity", [later])
cmp = Table(["A", "B"], [r1], [1], "cap")
r1 = Row(["x", "y"], [5])
chart = Chart("bar", "Balance", ["before", "after"], [s1], null, "USD", true)
s1 = Series("sender", [2, 3])
ask = AskUser("Which?", ["a", "b"])
"""


def _stream(text: str, known: int, chunk: int) -> tuple[str, openui.LangRenderer]:
    renderer = openui.LangRenderer(lambda: known)
    out = "".join(
        renderer.push(text[i : i + chunk]) for i in range(0, len(text), chunk)
    )
    out += renderer.finish()
    return out, renderer


def test_citations_follow_reading_order_not_statement_order():
    program = openui.parse(PROGRAM, strict=True)
    assert openui.validate(program) is None
    # Statement order sees `later` first; reading order starts at the root.
    assert openui.cited_in_statement_order(program, 9) == [3, 8, 1, 5]
    assert openui.cited_in_reading_order(program, 9) == [8, 1, 3, 5]
    # Unknown passage numbers are dropped; chart values are not passages.
    assert openui.cited_in_reading_order(program, 4) == [1, 3]


@pytest.mark.parametrize("chunk", [1, 5, 41, 1000])
def test_renderer_streams_the_program_unchanged(chunk):
    out, renderer = _stream(PROGRAM, 9, chunk)
    assert out == PROGRAM and renderer.text == PROGRAM
    assert renderer.answer_shaped and renderer.complete and not renderer.invalid
    assert renderer.order == [3, 8, 1, 5]
    assert renderer.reading_order() == [8, 1, 3, 5]


@pytest.mark.parametrize("chunk", [1, 3, 17])
def test_renderer_drops_a_wrapping_fence(chunk):
    fenced = "```openui-lang\n" + PROGRAM + "```"
    out, renderer = _stream(fenced, 9, chunk)
    assert out == PROGRAM and renderer.complete
    # An afterword after the closing fence is dropped, not repaired.
    out, renderer = _stream(fenced + "\nHope that helps!", 9, chunk)
    assert out == PROGRAM and renderer.complete
    plain, renderer = _stream("\n```\n" + PROGRAM + "\n```\n", 9, chunk)
    assert plain.strip() == PROGRAM.strip() and renderer.complete


@pytest.mark.parametrize("chunk", [1, 4, 1000])
@pytest.mark.parametrize("afterword", ["", "\nHope that helps!"])
def test_a_fence_inside_a_string_does_not_close_the_program(chunk, afterword):
    program = 'root = Answer([a])\na = Md("Example:\\n```\\nx = 1\\n```\\nDone", [1])\n'
    raw = program.replace("\\n```", "\n```").replace("```\\n", "```\n")
    out, renderer = _stream("```\n" + raw + "```" + afterword, 3, chunk)
    assert out == raw and renderer.complete and renderer.reading_order() == [1]


def test_prose_is_held_back_and_flagged():
    out, renderer = _stream("Carbon is fixed [2]. Light is absorbed [1].", 2, 7)
    assert out == "" and renderer.answer_shaped is False
    assert not renderer.complete and renderer.order == []


@pytest.mark.parametrize("chunk", [1, 4, 1000])
@pytest.mark.parametrize("fenced", [False, True])
def test_program_after_a_prose_preface_keeps_its_citations(chunk, fenced):
    program = 'root = Answer([Md("Grounded.", [2])])'
    if fenced:
        program = "```openui-lang\n" + program + "\n```\nHope that helps!"
    raw = "Here is the answer.\n\n" + program
    out, renderer = _stream(raw, 2, chunk)
    assert out == "" and renderer.answer_shaped is False
    assert renderer.reading_order() == [2]


@pytest.mark.parametrize(
    ("raw", "problem"),
    [
        ('root = Answer([a])\na = Md("cut off', "unterminated string"),
        ('root = Answer([a]\na = Md("x")\n', "unexpected"),
        ('root = Answer([a])\na = Nope("x")\n', "unknown component"),
        ('a = Md("x")\n', "no root"),
        ("root = Answer([a])\n", "unresolved"),
        ('root = Md("x")\n', "root is not"),
        ('root = Answer([a])\na = Md("x", ["2"])\n', "list of integers"),
        ('root = Answer([a])\na = Md("x", [2.0])\n', "list of integers"),
        ('root = Answer([a])\na = Md("x", 2)\n', "list of integers"),
    ],
)
def test_incomplete_or_invalid_programs_are_flagged(raw, problem):
    out, renderer = _stream(raw, 3, 4)
    assert out == raw and renderer.answer_shaped
    assert renderer.invalid and not renderer.complete
    try:
        found = openui.validate(openui.parse(raw, strict=True)) or ""
    except openui.ParseError as exc:
        found = str(exc)
    assert problem in found


def test_partial_program_keeps_the_citations_seen_so_far():
    raw = 'root = Answer([a, b])\na = Md("Carbon is fixed.", [2])\nb = Md("Cut'
    out, renderer = _stream(raw, 2, 6)
    assert out == raw and renderer.order == [2] and renderer.reading_order() == [2]


def test_text_projection_reads_strings_in_reading_order():
    text = openui.text_of(PROGRAM)
    assert "\nbar\n" not in text and "USD" in text
    assert text.splitlines()[:3] == [
        "ACID names four guarantees.",
        "Atomicity",
        "Defined early, read late.",
    ]
    assert "before · after" in text and "Which?" in text
    assert openui.text_of("Plain prose [1].") == "Plain prose [1]."
    assert (
        openui.text_of('root = Answer([a])\na = Md("cut')
        == 'root = Answer([a])\na = Md("cut'
    )


def test_is_lang_shaped():
    assert openui.is_lang_shaped("root = Answer([])")
    assert openui.is_lang_shaped("```\nroot = Answer([])")
    assert not openui.is_lang_shaped("The root = of the problem")
    assert not openui.is_lang_shaped("## Heading\nroot = x")


def test_chart_measurements_survive_the_checkpoint_projection():
    text = openui.text_of(
        'root = Answer([Chart("bar", "Balance", ["before", "after"], [s], [9], "USD"), '
        'ScatterChart("Latency", [Point(10, 12, "A")], "Count", "ms")])\n'
        's = Series("Alice", values)\nvalues = [250, 200]'
    )
    assert "[250, 200]" in text and "before · after" in text
    assert "x: 10" in text and "y: 12" in text
    assert "[9]" not in text
