import pytest

from pipeline.retrieval.response_guard import ResponseGuard


@pytest.mark.parametrize(
    "marker",
    [
        "<｜｜DSML｜｜ calls>",
        "<｜DSML｜function_calls>",
        "<||DSML|| calls>",
        "<tool_call>",
        "<function_calls>",
        '<invoke name="search_workspace">',
        '{"tool_calls" \n: []}',
        "[TOOL_CALLS]",
    ],
)
def test_guard_holds_protocol_markers_across_every_split(marker):
    for split in range(len(marker) + 1):
        guard = ResponseGuard()
        emitted = guard.push("Safe prose. " + marker[:split])
        emitted += guard.push(marker[split:] + "unsafe arguments")
        emitted += guard.finish()
        assert guard.flagged
        assert emitted in ("Safe prose. ", "Safe prose. {", "")
        assert guard.push("more unsafe arguments") == ""


def test_guard_preserves_ordinary_markdown_and_program_text():
    text = (
        'root = Answer([Md("Use list_sources. x < y. The key is \\"tool_calls\\".")])\n'
    )
    guard = ResponseGuard()
    emitted = "".join(guard.push(character) for character in text) + guard.finish()
    assert emitted == text
    assert not guard.flagged
