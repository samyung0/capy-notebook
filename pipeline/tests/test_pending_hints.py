"""Unindexed edits stay findable (Epo 2026-10-20): hints on the user message,
uncitable search hits, compaction dropping hints never followed by a read."""

from __future__ import annotations

import pytest

from pipeline.retrieval import compact, evidence, pending, pending_hints, tools


def _change(operation, *, before=None, after=None, cid="c", **extra):
    change = {"id": cid, "kind": "text", "operation": operation, "label": "", **extra}
    if before is not None:
        change["before"] = before
    if after is not None:
        change["after"] = after
    return change


def _sources(*file_changes, notes=()):
    return pending.PendingSources(
        [
            {
                "fileId": "f_1",
                "name": "bio.pdf",
                "epoch": 1,
                "checkpoint": 2,
                "indexedCheckpoint": 1,
                "changes": list(file_changes),
            }
        ],
        notes=list(notes),
    )


def test_hints_say_added_changed_or_removed_with_the_right_text():
    sources = _sources(
        _change("add", after="new mitosis paragraph", cid="a"),
        _change("replace", before="cells", after="nuclei divide", cid="r"),
        _change("remove", before="old meiosis note", cid="d"),
        _change("move", cid="m"),
        notes=[
            {
                "materialId": "m_1",
                "title": "Lecture",
                "revision": 2,
                "changes": [
                    {
                        "id": "n",
                        "kind": "data",
                        "operation": "replace",
                        "label": 'chart "Rain": 40 of 104 cells changed',
                        "blockId": "ch",
                    }
                ],
            }
        ],
    )
    lines = [
        hint.line(pending_hints.snippet(hint, "x"))
        for hint in pending_hints.candidates(sources)
    ]
    assert lines == [
        '- bio.pdf (file_id=f_1): added: "new mitosis paragraph"',
        '- bio.pdf (file_id=f_1): changed: "nuclei divide"',
        '- bio.pdf (file_id=f_1): removed: "old meiosis note"',
        '- Lecture (material_id=m_1, block ch): changed: "chart \\"Rain\\": 40 of 104 cells changed"',
    ]
    assert [h.doc_id for h in pending_hints.candidates(sources, exclude={"f_1"})] == [
        "m_1"
    ]


def test_hints_are_bounded():
    many = [_change("add", after=f"edit {i}", cid=str(i)) for i in range(3000)]
    assert (
        len(pending_hints.candidates(_sources(*many))) == pending_hints.CANDIDATES_MAX
    )

    long = "filler " * 100 + "photosynthesis happens here " + "filler " * 100
    [hint] = pending_hints.candidates(_sources(_change("add", after=long)))
    text = pending_hints.snippet(hint, "photosynthesis")
    assert len(text) <= pending_hints.HINT_CHARS and "photosynthesis" in text
    assert text.startswith("…") and text.endswith("…")

    wide = [(hint, "x" * pending_hints.HINT_CHARS)] * 10
    block = pending_hints.render(wide, pending_hints.MESSAGE_HEADING)
    assert pending_hints.estimate_tokens(block) <= pending_hints.HINT_TOKENS
    assert 0 < block.count("\n- ") < 10


async def test_a_message_is_hinted_once_and_read_documents_are_not(monkeypatch):
    async def match(_query, pool, limit=pending_hints.HINT_LIMIT):
        return pool[:limit]

    monkeypatch.setattr(pending_hints, "match", match)
    sources = _sources(
        _change("add", after="mitosis", cid="a"),
        _change("add", after="meiosis", cid="b"),
    )
    sources.read_ids = set()
    first = await pending_hints.for_message("cell division", sources, hinted=set())
    assert [hint.change_id for hint, _ in first] == ["a", "b"]
    again = await pending_hints.for_message(
        "cell division", sources, hinted={first[0][0].key}
    )
    assert [hint.change_id for hint, _ in again] == ["b"]
    sources.read("f_1")
    assert await pending_hints.for_message("cell division", sources, hinted=set()) == []


async def test_saved_hints_replay_on_their_message_and_compaction_drops_unread_ones(
    monkeypatch,
):
    note = {
        "materialId": "m_1",
        "title": "Lecture",
        "revision": 2,
        "changes": [_change("add", after="nucleus text", cid="n", blockId="p1")],
    }
    hints = pending_hints.candidates(
        _sources(_change("add", after="mitosis text", cid="a"), notes=[note])
    )
    packed = pending_hints.pack([(hint, hint.text) for hint in hints])
    history = [
        {"id": "u1", "role": "user", "content": "what about division?"},
        {
            "id": "a1",
            "role": "assistant",
            "content": "Answer one.",
            "toolEvidence": {"pendingHints": packed},
        },
        {"id": "u2", "role": "user", "content": "and the lecture?"},
        {
            "id": "a2",
            "role": "assistant",
            "content": "Answer two.",
            "toolEvidence": {"readDocuments": ["m_1"]},
        },
    ]
    replayed = await evidence.history_turns(
        history, tools.ToolContext(workspace_id="ws")
    )
    hinted = replayed[0]
    assert hinted["content"].startswith("what about division?\n\n")
    assert "mitosis text" in hinted["content"] and "nucleus text" in hinted["content"]
    assert {hint.key for hint, _ in hinted["_hints"]} == {("f_1", "a"), ("m_1", "n")}

    folded = []

    async def summarize(**kwargs):
        folded.extend(kwargs["turns"])
        return "memory"

    monkeypatch.setattr(compact, "_summarize_batch", summarize)
    await compact.summarize_checkpoint(
        prior_summary="",
        turns=replayed,
        current_user_message="next",
        spec=compact_spec(),
    )
    # The note was read in a later turn; the file never was.
    assert "nucleus text" in folded[0]["content"]
    assert "mitosis text" not in folded[0]["content"]
    assert folded[0]["content"].startswith("what about division?")


def compact_spec():
    from pipeline.registry import ModelConfig

    return ModelConfig(
        version=1,
        provider_name="Test",
        model_name="Test",
        provider_slug="test",
        model_slug="test",
        context_window_tokens=100_000,
        thinking_levels=("high",),
        default_thinking="high",
    )


async def test_search_lists_matching_unindexed_edits_after_its_passages(monkeypatch):
    from pipeline.retrieval.search import Passage

    async def search(**_kwargs):
        return [
            Passage(
                chunk_id="c1",
                file_id="f_2",
                file_name="chem.pdf",
                chunk_idx=0,
                section_path="",
                text="Indexed passage.",
                hit_text="Indexed passage.",
            )
        ]

    async def match(_query, pool, limit=pending_hints.HINT_LIMIT):
        return pool[:limit]

    monkeypatch.setattr(tools, "search", search)
    monkeypatch.setattr(pending_hints, "match", match)
    ctx = tools.ToolContext(
        workspace_id="ws",
        pending_sources=_sources(_change("remove", before="old enzyme text", cid="d")),
    )
    ctx.pending_sources.read_ids = set()
    ctx._scope_outline = {
        "chapters": [],
        "files": [
            {"id": "f_1", "name": "bio.pdf", "chapter_id": None, "chunks": 3},
            {"id": "f_2", "name": "chem.pdf", "chapter_id": None, "chunks": 3},
        ],
    }
    result = await tools._search_workspace({"query": "enzyme"}, ctx)
    numbered = tools.assign_citations(ctx, result.passages)
    text = tools.render_result(result, numbered)
    assert [p.chunk_id for p in result.passages] == ["c1"]
    assert text.index("Indexed passage.") < text.index(pending_hints.SEARCH_HEADING)
    assert '- bio.pdf (file_id=f_1): removed: "old enzyme text"' in text
    assert "[2]" not in text


@pytest.mark.integration
async def test_matching_folds_like_search_and_stems_per_language(workspace):
    del workspace  # the migrated database the pipeline pool reaches
    sources = _sources(
        _change("add", after="We ﬁnd the eﬄuent here.", cid="lig"),
        _change("add", after="Water is H₂O at room temperature.", cid="sub"),
        _change("add", after="细胞分裂的过程", cid="cjk"),
        _change(
            "add",
            after="During mitosis the cells were dividing quickly and the "
            "chromosomes separated into two nuclei.",
            cid="stem",
        ),
        _change("add", after="Unrelated sentence about rocks.", cid="none"),
    )
    pool = pending_hints.candidates(sources)

    async def ids(query):
        return {hint.change_id for hint in await pending_hints.match(query, pool)}

    assert await ids("find effluent") == {"lig"}
    assert await ids("H2O") == {"sub"}
    assert await ids("细胞分裂") == {"cjk"}
    # Stemmed in the edit's language (English here; a short edit detects as
    # undetermined and is matched unstemmed, as a short chunk is).
    assert await ids("divides") == {"stem"}
    assert await ids("volcano") == set()
