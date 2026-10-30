"""The Markdown answer format's markers and its figures skill
(retrieval/markdown_answer.py)."""

from __future__ import annotations

from pipeline.retrieval import markdown_answer, skills, tools
from pipeline.retrieval.tools import ToolContext


def test_markers_cite_shown_passages_in_first_seen_order():
    renderer = markdown_answer.MarkdownRenderer(lambda: 3)
    for delta in ["A [#3", "]. B [#1, 3]. C [#7] D [#2]"]:
        renderer.push(delta)
    assert renderer.order == [3, 1, 2]
    assert renderer.reading_order() == [3, 1, 2]
    assert renderer.text == "A [#3]. B [#1, 3]. C [#7] D [#2]"


async def test_figures_skill_is_offered_only_with_the_markdown_format():
    assert skills.FIGURES not in skills.offered(markdown_answer.OPENUI)
    assert skills.FIGURES in skills.offered(markdown_answer.MARKDOWN)
    refused = await tools._read_skill(
        {"name": "figures"}, ToolContext(workspace_id="ws_1")
    )
    assert "No skill named figures" in refused.text()
    read = await tools._read_skill(
        {"name": "figures"},
        ToolContext(workspace_id="ws_1", answer_format=markdown_answer.MARKDOWN),
    )
    assert "```chart" in read.text()
