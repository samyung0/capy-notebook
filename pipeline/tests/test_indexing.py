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

import secrets

import psycopg
import pytest

from pipeline import elitellm, registry
from pipeline.config import cfg
from pipeline.ingest import uat
from pipeline.retrieval import indexing, store
from pipeline.retrieval.chunking import Chunk, chunk_markdown, search_query_terms

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
        return "Photosynthesis in two stages."

    monkeypatch.setattr(indexing.models, "embed", embed)
    monkeypatch.setattr(indexing.models, "complete_text", complete_text)
    return seen


async def _attach(ws, file_id: str) -> str:
    """Published content to index into, as reindexing an existing file does
    (``index_file`` leaves publication to the worker)."""
    association = await store.attach_file_content(
        workspace_id=ws.id,
        file_id=file_id,
        content_hash=_SOURCE_HASH,
        claim_job_id="job_index",
    )
    await store.publish_file_content(
        workspace_id=ws.id,
        file_id=file_id,
        content_id=association["content_id"],
        claim_job_id="job_index",
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


async def test_the_summary_lands_under_the_chunk_fingerprint(workspace, fake_models):
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
        "SELECT fingerprint, descriptor, change_share "
        "FROM rag_content_summaries WHERE content_id = %s",
        (content_id,),
    ) == [
        (
            indexing.content_hash(chunks),
            "Photosynthesis in two stages.",
            0.0,
        )
    ]
    # Both stages receive complete semantic text, including changed headings.
    body = fake_models["summarized"][0][-1]["content"]
    assert "Carbon fixation builds sugar" in body
    assert "Calvin cycle" in body


async def test_content_with_no_passages_spends_nothing_and_writes_no_descriptor(
    workspace, fake_models
):
    """An empty parse reaches no provider and writes no chunks or descriptor,
    outside a text refresh (``allow_empty``). The worker refuses an empty parse
    before attaching it, so it never becomes ready, passage-less donor content
    (test_ingest_worker.py)."""
    file_id = workspace.add_file("blank.md")
    content_id = await _attach(workspace, file_id)

    assert await indexing.index_file(
        workspace_id=workspace.id,
        content_id=content_id,
        file_id=file_id,
        file_name="blank.md",
        chunks=[],
    ) == {"chunks": 0, "summary_error": None}

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


def _note(ws) -> str:
    material_id = f"mat_{secrets.token_hex(6)}"
    with psycopg.connect(ws.dsn, autocommit=True) as conn:
        conn.execute(
            "INSERT INTO materials (id, workspace_id, owner_user_id, created_by, kind, title) "
            "VALUES (%s, %s, %s, %s, 'note', %s)",
            (material_id, ws.id, ws.user_id, ws.user_id, material_id),
        )
    return material_id


async def _index_note(
    ws, material_id: str, lines: list[str], title: str = "Topics"
) -> tuple | None:
    """The note job's attach, index and publish; the published summary's
    descriptor and change share, or None without one."""
    chunks = chunk_markdown("\n\n".join(lines))
    job = f"job_{secrets.token_hex(4)}"
    association = await store.attach_material_content(
        workspace_id=ws.id,
        material_id=material_id,
        content_hash="note:" + indexing.content_hash(chunks),
        claim_job_id=job,
        blocks=[],
    )
    if not association["ready"]:
        await indexing.index_material(
            workspace_id=ws.id,
            material_id=material_id,
            title=title,
            content_id=association["content_id"],
            previous_content_id=association["previous_content_id"],
            chunks=chunks,
            claim_job_id=job,
            blocks=[],
        )
    rows = _rows(
        ws,
        "SELECT cs.descriptor, cs.change_share FROM rag_material_contents mc "
        "JOIN rag_content_summaries cs ON cs.content_id = mc.content_id "
        "WHERE mc.material_id = %s",
        (material_id,),
    )
    return rows[0] if rows else None


def _backdate_note_summary(ws, material_id: str, hours: int) -> None:
    with psycopg.connect(ws.dsn, autocommit=True) as conn:
        conn.execute(
            "UPDATE rag_content_summaries SET updated_at = now() - %s * interval '1 hour' "
            "WHERE content_id = (SELECT content_id FROM rag_material_contents "
            "WHERE material_id = %s)",
            (hours, material_id),
        )


_TOPICS = [f"Topic {i} covers its own idea in a few plain words." for i in range(40)]


async def test_a_note_gets_a_summary_only_from_200_tokens(workspace, fake_models):
    short = _note(workspace)
    assert await _index_note(workspace, short, _TOPICS[:10]) is None
    assert fake_models["summarized"] == []

    note = _note(workspace)
    summary = await _index_note(workspace, note, _TOPICS)
    assert summary == ("Photosynthesis in two stages.", 0)
    assert len(fake_models["summarized"]) == 1
    # list_sources reads it from the outline (review note-summaries S2).
    outline = await store.workspace_outline(workspace.id)
    descriptors = {f["id"]: f["descriptor"] for f in outline["files"]}
    assert descriptors[note] == "Photosynthesis in two stages."
    assert descriptors[short] == ""

    # Shrunk below 200 tokens, the note loses its summary.
    assert await _index_note(workspace, note, _TOPICS[20:30]) is None


async def test_a_note_summary_is_rewritten_at_10_percent_and_24_hours(
    workspace, fake_models
):
    note = _note(workspace)
    lines = list(_TOPICS)
    await _index_note(workspace, note, lines)
    written = workspace.scalar(
        "SELECT cs.updated_at FROM rag_material_contents mc JOIN rag_content_summaries cs "
        "ON cs.content_id = mc.content_id WHERE mc.material_id = %s",
        (note,),
    )

    # A small edit carries the summary forward with when it was written.
    lines[5] = lines[5].replace("plain", "simple")
    _, share = await _index_note(workspace, note, lines)
    assert 0 < share < indexing.NOTE_SUMMARY_SHARE
    assert (
        workspace.scalar(
            "SELECT cs.updated_at FROM rag_material_contents mc JOIN rag_content_summaries cs "
            "ON cs.content_id = mc.content_id WHERE mc.material_id = %s",
            (note,),
        )
        == written
    )

    # A day old, the summary still stays while the change is under 10%
    # (review note-summaries S1: between the file share and the note share).
    _backdate_note_summary(workspace, note, 25)
    lines[8] = "Rewritten passage says something quite new here."
    _, kept = await _index_note(workspace, note, lines)
    assert indexing.SUMMARY_REUSE_SHARE < kept < indexing.NOTE_SUMMARY_SHARE
    assert kept > share
    assert len(fake_models["summarized"]) == 1

    # Past 10% and a day old: rewritten from the whole note.
    lines[10:16] = [f"Rewritten passage {i} says something new." for i in range(6)]
    assert (await _index_note(workspace, note, lines))[1] == 0
    assert len(fake_models["summarized"]) == 2
    assert "Rewritten passage 5" in fake_models["summarized"][-1][-1]["content"]

    # Past 10% again, but the summary is new: kept, the share growing.
    lines[20:26] = [f"Another passage {i} replaces the old one." for i in range(6)]
    _, share = await _index_note(workspace, note, lines)
    assert share >= indexing.NOTE_SUMMARY_SHARE
    assert len(fake_models["summarized"]) == 2


async def test_the_uat_failure_marker_in_a_note_title_fails_its_summary(
    workspace, fake_models, monkeypatch
):
    """Review note-summaries N2: a UAT journey forces the note summary failure
    through the title, without a provider call."""
    monkeypatch.setattr(uat.cfg, "uat_fail_parts", True)
    note = _note(workspace)
    title = f"Topics {uat.FAIL_SUMMARY}"
    assert await _index_note(workspace, note, _TOPICS, title=title) is None
    assert fake_models["summarized"] == []


async def test_a_busy_provider_publishes_the_note_without_a_summary(
    workspace, fake_models, monkeypatch
):
    """Review note-summaries N5: a busy provider is no summary this time, not
    a failed job (which would abandon the chunks)."""

    async def busy(*_args, **_kwargs):
        raise elitellm.ProviderBusy("busy", status_code=429)

    monkeypatch.setattr(indexing.models, "complete_text", busy)
    note = _note(workspace)
    assert await _index_note(workspace, note, _TOPICS) is None
    assert workspace.scalar(
        "SELECT count(*) FROM rag_material_contents mc JOIN rag_chunks c "
        "ON c.content_id = mc.content_id WHERE mc.material_id = %s",
        (note,),
    ) == len(chunk_markdown("\n\n".join(_TOPICS)))


async def _index_text(ws, file_id: str, lines: list[str]) -> tuple | None:
    """A text file's attach, index and publish, as the worker's text refresh
    runs them (``note_rule``, Q457): new content per text, or identical
    content already ready, which only fills a missing descriptor. The
    published descriptor and change share, or None without a row."""
    chunks = chunk_markdown("\n\n".join(lines)) if lines else []
    job = f"job_{secrets.token_hex(4)}"
    association = await store.attach_file_content(
        workspace_id=ws.id,
        file_id=file_id,
        content_hash=indexing.content_hash(chunks),
        claim_job_id=job,
    )
    if association["ready"]:
        await indexing.fill_descriptor(
            workspace_id=ws.id,
            content_id=association["content_id"],
            file_name="notes.txt",
            note_rule=True,
        )
    else:
        await indexing.index_file(
            workspace_id=ws.id,
            content_id=association["content_id"],
            file_id=file_id,
            file_name="notes.txt",
            chunks=chunks,
            claim_job_id=job,
            allow_empty=True,
            note_rule=True,
        )
        await store.publish_file_content(
            workspace_id=ws.id,
            file_id=file_id,
            content_id=association["content_id"],
            claim_job_id=job,
        )
    rows = _rows(
        ws,
        "SELECT cs.descriptor, cs.change_share FROM rag_file_contents fc "
        "JOIN rag_content_summaries cs ON cs.content_id = fc.content_id "
        "WHERE fc.file_id = %s",
        (file_id,),
    )
    return rows[0] if rows else None


def _text_summary_written(ws, file_id: str):
    return ws.scalar(
        "SELECT cs.updated_at FROM rag_file_contents fc JOIN rag_content_summaries cs "
        "ON cs.content_id = fc.content_id WHERE fc.file_id = %s",
        (file_id,),
    )


async def test_a_blank_text_file_gets_no_summary_from_one_typed_character(
    workspace, fake_models
):
    """Q457: a text file takes the note rule. Blank, then one typed character,
    it keeps a blank descriptor (ready, no summary) with no provider call,
    where the 2% gate summarized it; from 200 tokens one is written, and
    shrunk below 200 it is dropped."""
    file_id = workspace.add_file("notes.txt")
    assert await _index_text(workspace, file_id, []) == ("", 0)
    assert await _index_text(workspace, file_id, ["a"]) == ("", 0)
    assert fake_models["summarized"] == []

    assert await _index_text(workspace, file_id, _TOPICS) == (
        "Photosynthesis in two stages.",
        0,
    )
    assert len(fake_models["summarized"]) == 1
    assert await _index_text(workspace, file_id, _TOPICS[:10]) == ("", 0)
    assert len(fake_models["summarized"]) == 1


async def test_a_text_file_summary_is_rewritten_at_10_percent_and_24_hours(
    workspace, fake_models
):
    """Q457: over 200 tokens, a text file's summary stays under 10% change
    (where the 2% gate rewrote it) and while it is under 24 hours old, and is
    rewritten past both. A file with identical content shares the content
    row and its summary; the other file's refreshes never write that row."""
    file_id = workspace.add_file("notes.txt")
    twin = workspace.add_file("twin.txt")
    lines = list(_TOPICS)
    await _index_text(workspace, file_id, lines)
    assert await _index_text(workspace, twin, lines) == (
        "Photosynthesis in two stages.",
        0,
    )
    assert len(fake_models["summarized"]) == 1
    with psycopg.connect(workspace.dsn, autocommit=True) as conn:
        conn.execute(
            "UPDATE rag_content_summaries SET updated_at = now() - interval '25 hours' "
            "WHERE content_id = (SELECT content_id FROM rag_file_contents WHERE file_id = %s)",
            (file_id,),
        )
    written = _text_summary_written(workspace, file_id)

    # A day old and between 2% and 10%: kept, with when it was written.
    lines[5] = lines[5].replace("plain", "simple")
    lines[8] = "Rewritten passage says something quite new here."
    _, kept = await _index_text(workspace, file_id, lines)
    assert indexing.SUMMARY_REUSE_SHARE < kept < indexing.NOTE_SUMMARY_SHARE
    assert _text_summary_written(workspace, file_id) == written
    assert len(fake_models["summarized"]) == 1

    # Past 10% and a day old: rewritten from the whole file.
    lines[10:16] = [f"Rewritten passage {i} says something new." for i in range(6)]
    assert (await _index_text(workspace, file_id, lines))[1] == 0
    assert len(fake_models["summarized"]) == 2
    assert "Rewritten passage 5" in fake_models["summarized"][-1][-1]["content"]

    # Past 10% again, but the summary is new: kept, the share growing.
    lines[20:26] = [f"Another passage {i} replaces the old one." for i in range(6)]
    _, share = await _index_text(workspace, file_id, lines)
    assert share >= indexing.NOTE_SUMMARY_SHARE
    assert len(fake_models["summarized"]) == 2

    # The twin still serves the first content and its summary row as it was.
    assert _rows(
        workspace,
        "SELECT cs.descriptor, cs.change_share FROM rag_file_contents fc "
        "JOIN rag_content_summaries cs ON cs.content_id = fc.content_id "
        "WHERE fc.file_id = %s",
        (twin,),
    ) == [("Photosynthesis in two stages.", 0)]
    assert _text_summary_written(workspace, twin) == written


def _pages(pages: list[int]) -> list[Chunk]:
    return [
        Chunk(
            text=f"Page {p} explains osmosis across membranes, passage {p}.",
            page_start=p,
            page_end=p,
        )
        for p in pages
    ]


async def _reingest(ws, file_id: str, chunks: list[Chunk], job: str) -> str:
    """The worker's attach, index and publish for one non-refresh ingest."""
    association = await store.attach_file_content(
        workspace_id=ws.id,
        file_id=file_id,
        content_hash=indexing.content_hash(chunks),
        claim_job_id=job,
    )
    await indexing.index_file(
        workspace_id=ws.id,
        content_id=association["content_id"],
        file_id=file_id,
        file_name="scan.pdf",
        chunks=chunks,
        claim_job_id=job,
    )
    await store.publish_file_content(
        workspace_id=ws.id,
        file_id=file_id,
        content_id=association["content_id"],
        claim_job_id=job,
    )
    return association["content_id"]


async def _searchable(ws, file_id: str) -> str:
    """The content search serves for the file (scoped by its alias)."""
    hits = await store.hybrid_search(
        workspace_id=ws.id,
        vector=_one_hot(0),
        terms=search_query_terms("osmosis"),
        file_ids=[file_id],
        candidates=10,
    )
    return _rows(
        ws, "SELECT content_id FROM rag_chunks WHERE id = %s", (hits[0]["id"],)
    )[0][0]


async def test_reingest_keeps_the_previous_index_until_publish(workspace, fake_models):
    """A re-ingest (Retry processing that read a missing page) leaves the old
    index searchable while it runs, lends it its vectors, and replaces it only
    at publish; a failed one leaves it in place (parts design R5)."""
    file_id = workspace.add_file("scan.pdf")
    first = await _reingest(workspace, file_id, _pages([1, 3]), "job_first")
    fake_models["embedded"].clear()

    retry = _pages([1, 2, 3])
    association = await store.attach_file_content(
        workspace_id=workspace.id,
        file_id=file_id,
        content_hash=indexing.content_hash(retry),
        claim_job_id="job_retry",
    )
    await indexing.index_file(
        workspace_id=workspace.id,
        content_id=association["content_id"],
        file_id=file_id,
        file_name="scan.pdf",
        chunks=retry,
        claim_job_id="job_retry",
    )
    assert await _searchable(workspace, file_id) == first
    assert fake_models["embedded"] == [[retry[1].indexed_text()]]
    await store.publish_file_content(
        workspace_id=workspace.id,
        file_id=file_id,
        content_id=association["content_id"],
        claim_job_id="job_retry",
    )
    assert await _searchable(workspace, file_id) == association["content_id"]
    assert _rows(workspace, "SELECT 1 FROM rag_contents WHERE id = %s", (first,)) == []

    failed = _pages([1, 2, 3, 4])
    claim = await store.attach_file_content(
        workspace_id=workspace.id,
        file_id=file_id,
        content_hash=indexing.content_hash(failed),
        claim_job_id="job_failed",
    )
    await store.abandon_content(claim["content_id"])
    assert await _searchable(workspace, file_id) == association["content_id"]
