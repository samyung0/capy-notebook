"""The answer format's citation markers (retrieval/markdown_answer.py)."""

from __future__ import annotations

from pipeline.retrieval import markdown_answer


def test_markers_cite_shown_passages_in_first_seen_order():
    renderer = markdown_answer.MarkdownRenderer(lambda: 3)
    for delta in ["A [#3", "]. B [#1, 3]. C [#7] D [#2]"]:
        renderer.push(delta)
    assert renderer.order == [3, 1, 2]
    assert renderer.reading_order() == [3, 1, 2]
    assert renderer.text == "A [#3]. B [#1, 3]. C [#7] D [#2]"


def test_a_figures_passages_cite_in_reading_order():
    """A chart, plot or html-embed citing only through its passages still
    reaches the citation list; a code fence's text cites nothing."""
    text = (
        "Intro [#2].\n\n"
        '```chart\n{"kind": "bar", "passages": [3, 9]}\n```\n\n'
        '```html-embed title="Slider" passages=1,2\n<input>\n```\n\n'
        "```python\nprint('[#4]')\n```\n\n"
        '```plot\n{"kind": "line", "passages": [5]'
    )
    assert markdown_answer.cited(text, 5) == [2, 3, 1]
    assert markdown_answer.cited(text + "}\n```\n", 5) == [2, 3, 1, 5]
