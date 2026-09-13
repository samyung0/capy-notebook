"""The structured final answer: parse, render, and the streaming renderer
whose concatenated output must equal the batch rendering."""

from __future__ import annotations

import json
import random

import pytest

from pipeline.retrieval.structured import (
    StreamRenderer,
    parse_structured,
    render_structured,
)


def _stream(raw: str, known: int, chunk: int) -> StreamRenderer:
    r = StreamRenderer(lambda: known)
    out = ""
    for i in range(0, len(raw), chunk):
        out += r.push(raw[i : i + chunk])
    out += r.finish()
    assert out == r.text
    return r


def test_render_renumbers_in_first_appearance_order():
    items = [
        {"text": "Chlorophyll absorbs red and blue.", "passages": [4, 2]},
        {"text": "Green is reflected.", "passages": [2, 7]},
        {"text": "Unsupported aside.", "passages": []},
    ]
    text, order = render_structured(items, known=5)
    assert text == (
        "Chlorophyll absorbs red and blue. [1][2]\n\n"
        "Green is reflected. [2]\n\n"
        "Unsupported aside."
    )
    # 7 is not a shown passage and is dropped; order maps k -> original number.
    assert order == [4, 2]


def test_stray_markers_inside_text_use_the_same_map():
    text, order = render_structured(
        [{"text": "See [3] and [9].", "passages": [1]}], known=3
    )
    assert text == "See [1] and [9]. [2]"
    assert order == [3, 1]


@pytest.mark.parametrize(
    "raw",
    [
        "not json",
        '{"answer": []}',
        '{"answer": [{"passages": [1]}]}',
        '{"answer": [{"text": "x", "passages": ["x"]}]}',
        '{"answer": [{"text": "x", "passages": [1.0]}]}',
        '{"answer": [{"text": "x", "passages": [true]}]}',
        '["x"]',
    ],
)
def test_parse_rejects_wrong_shapes(raw):
    assert parse_structured(raw) is None


def test_parse_accepts_a_fenced_object():
    raw = '```json\n{"answer": [{"text": "x", "passages": [1]}]}\n```'
    assert parse_structured(raw) == [{"text": "x", "passages": [1]}]


@pytest.mark.parametrize("chunk", [1, 3, 7, 1000])
def test_stream_renderer_matches_the_batch_rendering(chunk):
    items = [
        {"text": '  Chlorophyll \\u00e9 "quoted" absorbs [2].  ', "passages": [4, 2]},
        {"text": "Line one\\nLine two", "passages": []},
        {"text": "", "passages": [1]},
        {"text": "Tail claim", "passages": [4]},
    ]
    raw = json.dumps({"answer": items}, ensure_ascii=False)
    expected, order = render_structured(json.loads(raw)["answer"], known=4)
    r = _stream(raw, known=4, chunk=chunk)
    assert r.json_shaped is True and r.complete is True
    assert r.text == expected
    assert r.order == order


def test_stream_renderer_handles_fences_and_prose():
    fenced = _stream('```json\n{"answer":[{"text":"a","passages":[1]}]}\n```', 1, 5)
    assert fenced.json_shaped is True and fenced.text == "a [1]"
    prose = _stream("Plain prose answer [1].", 1, 4)
    assert prose.json_shaped is False and prose.text == ""


def test_stream_renderer_emits_claims_as_they_arrive():
    r = StreamRenderer(lambda: 3)
    assert r.push('{"answer":[{"text":"Hel') == "Hel"
    assert r.push("lo world ") == "lo world"
    # Marks wait for the passages array to close, then follow the claim text.
    assert r.push('","passages":[3,') == ""
    assert r.push('1]},{"text":"Next') == " [1][2]\n\nNext"
    assert r.push('","passages":[]}]}') == ""
    assert r.complete and r.order == [3, 1]


def test_stream_renderer_keeps_prose_for_an_unfinished_object():
    r = _stream('{"answer":[{"text":"Partial claim","passages":[2]}', known=2, chunk=6)
    assert r.json_shaped is True and r.complete is False
    assert r.text == "Partial claim [1]"


def test_stream_renderer_random_chunking_property():
    rng = random.Random(7)
    alphabet = ["a", " ", "\\n", "[", "]", "1", ",", '\\"', "é", "x"]
    for _ in range(300):
        items = []
        for _ in range(rng.randint(1, 4)):
            text = "".join(rng.choice(alphabet) for _ in range(rng.randint(0, 12)))
            passages = [rng.randint(0, 6) for _ in range(rng.randint(0, 3))]
            items.append({"text": text, "passages": passages})
        raw = json.dumps({"answer": items}, ensure_ascii=rng.random() < 0.5)
        expected, order = render_structured(json.loads(raw)["answer"], known=5)
        r = _stream(raw, known=5, chunk=rng.randint(1, 9))
        assert r.text == expected, raw
        assert r.order == order


@pytest.mark.parametrize(
    "raw",
    [
        '{"answer": "just a string"}',
        '{"answer": {"text": "x", "passages": [1]}}',
        '{"answer": []}',
    ],
)
def test_wrong_shape_objects_render_nothing_and_do_not_parse(raw):
    r = _stream(raw, known=1, chunk=5)
    assert r.json_shaped is True and r.complete is True and r.text == ""
    assert parse_structured(raw) is None


@pytest.mark.parametrize(
    ("passages", "valid", "marks"),
    [
        ('["2"]', True, " [1]"),
        ("[2.0]", False, ""),
        ("[true]", False, ""),
        ('["x"]', False, ""),
        ("[1,]", False, ""),
    ],
)
def test_renderer_and_parser_agree_on_passage_entries(passages, valid, marks):
    """A quoted digit counts as its number in both; any other non-integer entry
    fails parsing and flags the renderer, so the agent repairs instead of
    streaming an answer with silently dropped citations."""
    raw = '{"answer":[{"text":"Carbon is fixed.","passages":' + passages + "}]}"
    r = _stream(raw, known=3, chunk=3)
    items = parse_structured(raw)
    assert (items is not None) is valid
    assert r.invalid is (not valid)
    if valid:
        assert items == [{"text": "Carbon is fixed.", "passages": [2]}]
        assert r.text == "Carbon is fixed." + marks and r.complete
    else:
        # Nothing is emitted after the bad entry; the caller replaces the text.
        assert r.text == "Carbon is fixed." and not r.complete


@pytest.mark.parametrize("passages", [None, "2", 2, {}, {"id": 2}])
@pytest.mark.parametrize("chunk", [1, 7, 1000])
def test_complete_answers_reject_non_array_passages(passages, chunk):
    raw = json.dumps({"answer": [{"text": "Carbon is fixed.", "passages": passages}]})
    r = _stream(raw, known=3, chunk=chunk)
    assert parse_structured(raw) is None
    assert r.complete and r.invalid
