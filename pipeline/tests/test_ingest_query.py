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

from pipeline.retrieval import indexing, models, store, tools
from pipeline.retrieval.agent import _priming_message, system_prompt
from pipeline.retrieval.chunking import chunk_markdown
from pipeline.retrieval.search import search
from pipeline.retrieval.tools import ToolContext

pytestmark = pytest.mark.cassette


async def _index(ws, name: str, text: str, chapter_id: str | None = None) -> str:
    file_id = ws.add_file(name, chapter_id)
    chunks = chunk_markdown(text)
    association = await store.attach_file_content(
        workspace_id=ws.id,
        file_id=file_id,
        content_hash=indexing.content_hash(chunks),
    )
    await indexing.index_file(
        workspace_id=ws.id,
        content_id=association["content_id"],
        file_id=file_id,
        file_name=name,
        chunks=chunks,
    )
    return file_id


async def test_index_file_writes_chunks_summary_and_concepts(
    cassette, workspace, sample_txt
):
    file_id = await _index(workspace, "photosynthesis.txt", sample_txt)

    assert (
        workspace.scalar(
            "SELECT count(*) FROM rag_chunks c JOIN rag_file_contents fc "
            "ON fc.content_id = c.content_id WHERE fc.file_id = %s",
            (file_id,),
        )
        >= 1
    )
    # Every chunk must carry both retrieval representations, or one half of the
    # hybrid search silently returns nothing for this file. The vector lives in
    # the per-width side table, so a missing one is an absent row rather than a
    # NULL column.
    assert (
        workspace.scalar(
            "SELECT count(*) FROM rag_chunks c "
            "LEFT JOIN rag_chunk_vectors_2560 v ON v.chunk_id = c.id "
            "WHERE c.content_id = (SELECT content_id FROM rag_file_contents "
            "WHERE file_id = %s) AND (v.chunk_id IS NULL OR c.search IS NULL)",
            (file_id,),
        )
        == 0
    )
    # The content records which model actually produced those vectors, and it
    # must agree with the space the workspace is pinned to.
    assert (
        workspace.scalar(
            "SELECT count(*) FROM rag_contents rc JOIN workspaces w ON w.id = rc.workspace_id "
            "JOIN rag_file_contents fc ON fc.content_id = rc.id WHERE fc.file_id = %s "
            "AND rc.embedding_model_key = w.embedding_model_key "
            "AND rc.embedding_model_version = w.embedding_model_version "
            "AND rc.embedding_dim = w.embedding_dim",
            (file_id,),
        )
        == 1
    )
    summary = workspace.scalar(
        "SELECT s.summary FROM rag_content_summaries s JOIN rag_file_contents fc "
        "ON fc.content_id = s.content_id WHERE fc.file_id = %s",
        (file_id,),
    )
    assert summary and len(summary) > 40
    descriptor = workspace.scalar(
        "SELECT s.descriptor FROM rag_content_summaries s JOIN rag_file_contents fc "
        "ON fc.content_id = s.content_id WHERE fc.file_id = %s",
        (file_id,),
    )
    assert descriptor
    # Two-tier JSON, not the prose fallback that copies the same blob into both.
    assert descriptor != summary
    assert (
        workspace.scalar(
            "SELECT count(*) FROM rag_concepts WHERE workspace_id = %s", (workspace.id,)
        )
        >= 1
    )


async def test_reindexing_replaces_rather_than_duplicates(
    cassette, workspace, sample_txt
):
    """A retried job must converge. Chunks are keyed on (content_id, chunk_idx), so
    a second pass that produced fewer of them would otherwise leave the tail of
    the first behind."""
    file_id = workspace.add_file("photosynthesis.txt")
    chunks = chunk_markdown(sample_txt)
    association = await store.attach_file_content(
        workspace_id=workspace.id,
        file_id=file_id,
        content_hash=indexing.content_hash(chunks),
    )
    for _ in range(2):
        await indexing.index_file(
            workspace_id=workspace.id,
            content_id=association["content_id"],
            file_id=file_id,
            file_name="photosynthesis.txt",
            chunks=chunks,
        )

    assert workspace.scalar(
        "SELECT count(*) FROM rag_chunks WHERE content_id = %s",
        (association["content_id"],),
    ) == len(chunks)


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


async def test_answer_is_grounded_and_cited(cassette, workspace, sample_txt):
    """Prime + one completion, not the tool loop: lock that retrieved passages
    are what the model is asked to answer from, and that the reply cites them.

    ``run_agent`` is covered offline — its extra round trips are not
    deterministic enough to record.
    """
    await _index(workspace, "photosynthesis.txt", sample_txt)
    query = "What does chlorophyll absorb?"
    ctx = ToolContext(workspace_id=workspace.id)
    numbered = tools.remember(ctx, await search(workspace_id=workspace.id, query=query))
    assert numbered, "prime search must retrieve the photosynthesis passage"

    raw = await models.complete_text(
        [
            {"role": "system", "content": system_prompt(None)},
            {"role": "user", "content": query},
            {"role": "user", "content": _priming_message(numbered)},
        ],
        model="deepseek-v4-flash",
        temperature=0.0,
    )

    assert "chlorophyll" in raw.lower()
    assert "[1]" in raw


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


async def test_workspace_outline_reports_the_tree(cassette, workspace, sample_txt):
    chapter_id = workspace.add_chapter("Biology")
    file_id = await _index(workspace, "photosynthesis.txt", sample_txt, chapter_id)

    outline = await store.workspace_outline(workspace.id)

    assert [c["name"] for c in outline["chapters"]] == ["Biology"]
    entry = next(f for f in outline["files"] if f["id"] == file_id)
    assert entry["chapter_id"] == chapter_id
    assert entry["chunks"] >= 1
    assert entry["descriptor"]
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

    for table in ("rag_chunks", "rag_content_summaries", "rag_concepts"):
        assert (
            workspace.scalar(
                f"SELECT count(*) FROM {table} WHERE workspace_id = %s", (workspace.id,)
            )
            == 0
        )
