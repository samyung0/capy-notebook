"""Cassette-backed integration tests for the in-house retrieval stack.

Each test drives the real code — chunking, batched embedding, summarization,
concept extraction, hybrid search and the grounded answer — against a live
Postgres carrying the gateway's own schema, while every model HTTP call is
served from a recorded cassette.

Record once:  EVO_TEST_RECORD=once  (real provider keys exported)
Replay:       (default, no env)     free, offline w.r.t. model APIs
"""

from __future__ import annotations

import pytest

from pipeline.retrieval import indexing, store
from pipeline.retrieval.agent import answer_once
from pipeline.retrieval.chunking import chunk_markdown
from pipeline.retrieval.search import search
from pipeline.retrieval.tools import ToolContext

pytestmark = pytest.mark.cassette


async def _index(ws, name: str, text: str, chapter_id: str | None = None) -> str:
    file_id = ws.add_file(name, chapter_id)
    await indexing.index_file(
        workspace_id=ws.id,
        file_id=file_id,
        file_name=name,
        chunks=chunk_markdown(text),
    )
    return file_id


async def test_index_file_writes_chunks_summary_and_concepts(
    cassette, workspace, sample_txt
):
    file_id = await _index(workspace, "photosynthesis.txt", sample_txt)

    assert (
        workspace.scalar(
            "SELECT count(*) FROM rag_chunks WHERE file_id = %s", (file_id,)
        )
        >= 1
    )
    # Every chunk must carry both retrieval representations, or one half of the
    # hybrid search silently returns nothing for this file.
    assert (
        workspace.scalar(
            "SELECT count(*) FROM rag_chunks "
            "WHERE file_id = %s AND (embedding IS NULL OR search IS NULL)",
            (file_id,),
        )
        == 0
    )
    summary = workspace.scalar(
        "SELECT summary FROM rag_file_summaries WHERE file_id = %s", (file_id,)
    )
    assert summary and len(summary) > 40
    assert (
        workspace.scalar(
            "SELECT count(*) FROM rag_concepts WHERE workspace_id = %s", (workspace.id,)
        )
        >= 1
    )
    # Content changed, so the summary tree above this file is stale and a
    # rollup is queued for the worker.
    assert workspace.scalar(
        "SELECT dirty FROM rag_workspace_summaries WHERE workspace_id = %s",
        (workspace.id,),
    )


async def test_reindexing_replaces_rather_than_duplicates(
    cassette, workspace, sample_txt
):
    """A retried job must converge. Chunks are keyed on (file_id, chunk_idx), so
    a second pass that produced fewer of them would otherwise leave the tail of
    the first behind."""
    file_id = workspace.add_file("photosynthesis.txt")
    for _ in range(2):
        await indexing.index_file(
            workspace_id=workspace.id,
            file_id=file_id,
            file_name="photosynthesis.txt",
            chunks=chunk_markdown(sample_txt),
        )

    assert workspace.scalar(
        "SELECT count(*) FROM rag_chunks WHERE file_id = %s", (file_id,)
    ) == len(chunk_markdown(sample_txt))


async def test_hybrid_search_returns_a_citable_passage(cassette, workspace, sample_txt):
    file_id = await _index(workspace, "photosynthesis.txt", sample_txt)

    passages = await search(
        workspace_id=workspace.id, query="What does chlorophyll absorb?"
    )

    assert passages
    top = passages[0]
    assert top.file_id == file_id
    assert top.file_name == "photosynthesis.txt"
    assert "chlorophyll" in top.text.lower()
    # A plain-text source has no page model, so a citation must not invent one.
    citation = top.as_citation()
    assert citation["fileId"] == file_id
    assert "pageStart" not in citation


async def test_search_is_confined_to_the_requested_files(
    cassette, workspace, sample_txt
):
    """Scope is the user's, not the model's: a file filter must exclude content
    that would otherwise rank first."""
    await _index(workspace, "photosynthesis.txt", sample_txt)
    cells_id = await _index(
        workspace,
        "cells.txt",
        (
            "Mitochondria oxidise glucose and transfer the released energy into "
            "ATP through oxidative phosphorylation, which powers most of the work "
            "a cell does."
        ),
    )

    passages = await search(
        workspace_id=workspace.id, query="chlorophyll and light", file_ids=[cells_id]
    )

    assert {p.file_id for p in passages} == {cells_id}


async def test_related_concepts_bridges_two_documents(cassette, workspace, sample_txt):
    """The relation-free substitute for a graph edge: two documents that never
    reference each other are connected by a concept they both mention."""
    from pathlib import Path

    cells = (Path(__file__).parent / "fixtures" / "sample_cells.txt").read_text(
        encoding="utf-8"
    )
    await _index(workspace, "photosynthesis.txt", sample_txt)
    await _index(workspace, "cells.txt", cells)

    rows = await store.related_concepts(workspace_id=workspace.id, name="ATP")

    assert rows, "ATP should be indexed as a concept in both documents"
    files = {name for row in rows for name in row["files"]}
    assert {"photosynthesis.txt", "cells.txt"} & files


async def test_answer_is_grounded_and_cited(cassette, workspace, sample_txt):
    file_id = await _index(workspace, "photosynthesis.txt", sample_txt)
    ctx = ToolContext(workspace_id=workspace.id, user_id="u_1")

    answer, citations = await answer_once(
        query="What does chlorophyll absorb?",
        ctx=ctx,
        model="deepseek-v4-pro",
    )

    assert answer.strip()
    assert "red" in answer.lower() or "blue" in answer.lower()
    assert citations and citations[0]["fileId"] == file_id


async def test_workspace_outline_reports_the_tree(cassette, workspace, sample_txt):
    chapter_id = workspace.add_chapter("Biology")
    file_id = await _index(workspace, "photosynthesis.txt", sample_txt, chapter_id)

    outline = await store.workspace_outline(workspace.id)

    assert [c["name"] for c in outline["chapters"]] == ["Biology"]
    entry = next(f for f in outline["files"] if f["id"] == file_id)
    assert entry["chapter_id"] == chapter_id
    assert entry["chunks"] >= 1
    assert entry["summary"]


async def test_deleting_a_workspace_takes_the_index_with_it(
    cassette, workspace, sample_txt
):
    """The retrieval index is owned by the gateway's schema now, so teardown is
    a foreign key rather than a job the pipeline has to remember to run."""
    await _index(workspace, "photosynthesis.txt", sample_txt)
    workspace.scalar(
        "DELETE FROM workspaces WHERE id = %s RETURNING id", (workspace.id,)
    )

    for table in ("rag_chunks", "rag_file_summaries", "rag_concepts"):
        assert (
            workspace.scalar(
                f"SELECT count(*) FROM {table} WHERE workspace_id = %s", (workspace.id,)
            )
            == 0
        )
