"""Integration tests for ``index_file``: the chunk → embed → describe → write wiring.

Docker but no model. The embedder and the summarizer are deterministic fakes, so
what is under test is how ``index_file`` connects the stages — that the
breadcrumb form is what gets embedded, that every chunk keeps the vector
produced for it, that the descriptor is stored against the chunk fingerprint
rather than the content hash the file was attached under, and that a refresh
reuses the published descriptor below the change share. Each stage's own
behaviour belongs to ``test_chunking.py``, ``test_store_sql.py`` and
``test_retrieval_helpers.py``; nothing there covers them in sequence.
"""

from __future__ import annotations

import json

import psycopg
import pytest

from pipeline import registry
from pipeline.config import cfg
from pipeline.prompts.ingest import SUMMARY_VERSION
from pipeline.retrieval import indexing, store
from pipeline.retrieval.chunking import chunk_markdown

pytestmark = pytest.mark.integration

# The hash the file is attached under. Deliberately not the chunk fingerprint:
# the descriptor must carry the latter, and identical values would hide a swap.
_SOURCE_HASH = "content-hash-of-the-source-bytes"

_DOC = """# Photosynthesis

Chloroplasts convert light into chemical energy.

## Light reactions

Chlorophyll absorbs red and blue light, splits water and releases oxygen.

## Calvin cycle

Carbon fixation builds sugar from carbon dioxide in the stroma.
"""


def _one_hot(axis: int) -> list[float]:
    vector = [0.0] * cfg.embedding_dim
    vector[axis % cfg.embedding_dim] = 1.0
    return vector


def _rows(ws, sql: str, params: tuple = ()) -> list[tuple]:
    with psycopg.connect(ws.dsn, autocommit=True) as conn:
        return conn.execute(sql, params).fetchall()


@pytest.fixture
def fake_models(monkeypatch):
    """Stand in for the only two provider calls ``index_file`` makes."""
    seen: dict[str, list] = {"embedded": [], "summarized": []}

    async def embed(texts, *, spec):
        seen["embedded"].append(list(texts))
        return [_one_hot(i) for i in range(len(texts))]

    async def complete_text(messages, **_kwargs):
        seen["summarized"].append(messages)
        return json.dumps({"descriptor": "Photosynthesis in two stages."})

    monkeypatch.setattr(indexing.models, "embed", embed)
    monkeypatch.setattr(indexing.models, "complete_text", complete_text)
    return seen


async def _attach(ws, file_id: str) -> str:
    association = await store.attach_file_content(
        workspace_id=ws.id, file_id=file_id, content_hash=_SOURCE_HASH
    )
    return association["content_id"]


async def test_every_chunk_is_stored_with_the_vector_embedded_for_it(
    workspace, fake_models
):
    file_id = workspace.add_file("photosynthesis.md")
    content_id = await _attach(workspace, file_id)
    chunks = chunk_markdown(_DOC)
    assert len(chunks) > 1, "the document must chunk, or this proves nothing"
    progress: list[int] = []

    result = await indexing.index_file(
        workspace_id=workspace.id,
        content_id=content_id,
        file_id=file_id,
        file_name="photosynthesis.md",
        chunks=chunks,
        on_progress=progress.append,
    )

    assert result["chunks"] == len(chunks)
    # One batch, carrying the heading breadcrumb rather than the bare passage:
    # what search compares against has to be what was written.
    assert fake_models["embedded"] == [[chunk.indexed_text() for chunk in chunks]]
    assert _rows(
        workspace,
        "SELECT chunk_idx, text FROM rag_chunks WHERE content_id = %s ORDER BY chunk_idx",
        (content_id,),
    ) == list(enumerate(chunk.text for chunk in chunks))

    # The zip over (chunks, texts, vectors) is what pairs a passage with its
    # embedding. Transposed vectors would leave every row present and every
    # search wrong, so match each stored vector back to the input it came from.
    spec = registry.embedding_spec()
    table = store.vector_table(spec.provider_slug, spec.model_slug, spec.version)
    for position in range(len(chunks)):
        assert _rows(
            workspace,
            f"SELECT c.chunk_idx FROM {table} v JOIN rag_chunks c ON c.id = v.chunk_id "
            "WHERE c.content_id = %s AND v.embedding <=> %s::halfvec < 1e-6",
            (content_id, store.vector_literal(_one_hot(position))),
        ) == [(position,)]

    assert progress == [70, 85, 95]


async def test_the_summary_lands_under_the_chunk_fingerprint_and_marks_content_ready(
    workspace, fake_models
):
    file_id = workspace.add_file("photosynthesis.md")
    content_id = await _attach(workspace, file_id)
    chunks = chunk_markdown(_DOC)

    await indexing.index_file(
        workspace_id=workspace.id,
        content_id=content_id,
        file_id=file_id,
        file_name="photosynthesis.md",
        chunks=chunks,
    )

    assert _rows(
        workspace,
        "SELECT fingerprint, descriptor, change_share, summary_version "
        "FROM rag_content_summaries WHERE content_id = %s",
        (content_id,),
    ) == [
        (
            indexing.content_hash(chunks),
            "Photosynthesis in two stages.",
            0.0,
            SUMMARY_VERSION,
        )
    ]
    # Both stages receive complete semantic text, including changed headings.
    body = fake_models["summarized"][0][-1]["content"]
    assert "Carbon fixation builds sugar" in body
    assert "Calvin cycle" in body
    assert (
        workspace.scalar("SELECT status FROM rag_contents WHERE id = %s", (content_id,))
        == "ready"
    )


async def test_content_with_no_passages_spends_nothing_and_stays_unready(
    workspace, fake_models
):
    """An empty parse must not reach a provider, and must not look indexed.

    Ready content is what donor reuse copies. Marking an empty parse ready would
    hand every later upload of the same bytes a document with no passages.
    """
    file_id = workspace.add_file("blank.md")
    content_id = await _attach(workspace, file_id)

    assert await indexing.index_file(
        workspace_id=workspace.id,
        content_id=content_id,
        file_id=file_id,
        file_name="blank.md",
        chunks=[],
    ) == {"chunks": 0}

    assert fake_models == {"embedded": [], "summarized": []}
    assert (
        _rows(
            workspace, "SELECT 1 FROM rag_chunks WHERE content_id = %s", (content_id,)
        )
        == []
    )
    assert (
        _rows(
            workspace,
            "SELECT 1 FROM rag_content_summaries WHERE content_id = %s",
            (content_id,),
        )
        == []
    )
    assert (
        workspace.scalar("SELECT status FROM rag_contents WHERE id = %s", (content_id,))
        == "processing"
    )


async def test_reindex_reuses_only_exact_embedding_inputs(workspace, fake_models):
    from dataclasses import replace

    file_id = workspace.add_file("source.md")
    content_id = await _attach(workspace, file_id)
    chunks = chunk_markdown(_DOC)
    await indexing.index_file(
        workspace_id=workspace.id,
        content_id=content_id,
        file_id=file_id,
        file_name="source.md",
        chunks=chunks,
    )
    changed = [replace(chunks[0], section_path="Changed heading"), *chunks[1:]]
    assert indexing.content_hash(changed) != indexing.content_hash(chunks)
    await indexing.index_file(
        workspace_id=workspace.id,
        content_id=content_id,
        file_id=file_id,
        file_name="source.md",
        chunks=changed,
    )
    assert fake_models["embedded"][-1] == [changed[0].indexed_text()]


async def test_a_refresh_reuses_the_descriptor_until_the_change_reaches_the_share(
    workspace, fake_models
):
    file_id = workspace.add_file("topics.md")
    content_id = await _attach(workspace, file_id)
    lines = [f"Topic {i} covers its own idea in a few plain words." for i in range(100)]

    async def index() -> float:
        await indexing.index_file(
            workspace_id=workspace.id,
            content_id=content_id,
            file_id=file_id,
            file_name="topics.md",
            chunks=chunk_markdown("\n\n".join(lines)),
        )
        return workspace.scalar(
            "SELECT change_share FROM rag_content_summaries WHERE content_id = %s",
            (content_id,),
        )

    assert await index() == 0  # first descriptor
    lines[40] = lines[40].replace("plain", "simple")
    share = await index()
    assert 0 < share < indexing.SUMMARY_REUSE_SHARE
    assert len(fake_models["summarized"]) == 1
    # Four rewritten topics push the running share past 2%: regenerate in full.
    lines[60:64] = [f"Rewritten passage {i} says something new." for i in range(4)]
    assert await index() == 0
    assert len(fake_models["summarized"]) == 2
    assert "Rewritten passage 3" in fake_models["summarized"][-1][-1]["content"]
