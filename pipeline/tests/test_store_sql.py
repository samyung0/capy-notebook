"""Integration tests for the retrieval SQL, against the gateway's real schema.

Docker but no cassette: embeddings are synthetic unit vectors, so every query
below is a pure test of the statements in ``retrieval/store.py`` and of the
schema they assume. That separation matters because a column rename in
``0001_init.sql`` breaks these silently at runtime and nowhere at import time.
"""

from __future__ import annotations

import hashlib

import pytest

from pipeline.config import cfg
from pipeline.retrieval import store
from pipeline.retrieval.chunking import tokenize_for_search

pytestmark = pytest.mark.integration


def _unit_vector(axis: int) -> list[float]:
    """A one-hot vector, so cosine distance between two of them is predictable."""
    vector = [0.0] * cfg.embedding_dim
    vector[axis % cfg.embedding_dim] = 1.0
    return vector


async def _write(ws, file_id: str, texts: list[str], *, axis_base: int = 0) -> None:
    content_hash = hashlib.sha256("\x00".join(texts).encode()).hexdigest()
    association = await store.attach_file_content(
        workspace_id=ws.id, file_id=file_id, content_hash=content_hash
    )
    rows = [
        {
            "id": f"{file_id}_c{i}",
            "chunk_idx": i,
            "section_path": "Ch 1 › Section",
            "text": text,
            "indexed_text": text,
            "token_count": len(text) // 4,
            "page_start": i + 1,
            "page_end": i + 1,
            "regions": [
                {"page": i + 1, "bbox": [1, 2, 3, 4], "space": "mineru-1000-lefttop"}
            ],
            "search_text": tokenize_for_search(text),
            "embedding": store.vector_literal(_unit_vector(axis_base + i)),
        }
        for i, text in enumerate(texts)
    ]
    await store.replace_content_chunks(
        workspace_id=ws.id, content_id=association["content_id"], rows=rows
    )
    await store.mark_content_ready(association["content_id"])


# ------------------------------------------------------------------- search


async def test_lexical_half_matches_without_a_useful_vector(workspace):
    file_id = workspace.add_file("bio.txt")
    await _write(
        workspace, file_id, ["Chlorophyll absorbs red light", "Unrelated text"]
    )

    rows = await store.hybrid_search(
        workspace_id=workspace.id,
        vector=_unit_vector(999),
        terms="chlorophyll or absorbs",
        file_ids=None,
        candidates=10,
    )

    assert rows[0]["text"] == "Chlorophyll absorbs red light"
    assert rows[0]["file_name"] == "bio.txt"


async def test_vector_half_matches_without_shared_vocabulary(workspace):
    file_id = workspace.add_file("bio.txt")
    await _write(workspace, file_id, ["alpha", "beta"])

    rows = await store.hybrid_search(
        workspace_id=workspace.id,
        vector=_unit_vector(1),
        terms="nothing matches this",
        file_ids=None,
        candidates=10,
    )

    assert rows[0]["text"] == "beta"


async def test_cjk_is_retrievable_through_the_bigram_tokenizer(workspace):
    """Postgres' built-in configurations make one token of a Chinese sentence;
    the application-side bigrams are what make this query possible at all."""
    file_id = workspace.add_file("zh.txt")
    await _write(workspace, file_id, ["光合作用把光能转化为化学能", "无关内容"])

    rows = await store.hybrid_search(
        workspace_id=workspace.id,
        vector=_unit_vector(999),
        terms="光合 or 合作 or 作用",
        file_ids=None,
        candidates=10,
    )

    assert rows and rows[0]["text"].startswith("光合作用")


async def test_search_is_scoped_to_the_workspace_and_the_file_filter(workspace):
    keep = workspace.add_file("keep.txt")
    drop = workspace.add_file("drop.txt")
    await _write(workspace, keep, ["Chlorophyll absorbs red light"])
    await _write(workspace, drop, ["Chlorophyll absorbs blue light"], axis_base=10)

    rows = await store.hybrid_search(
        workspace_id=workspace.id,
        vector=_unit_vector(0),
        terms="chlorophyll",
        file_ids=[keep],
        candidates=10,
    )

    assert {row["file_id"] for row in rows} == {keep}


async def test_chunks_carry_the_provenance_a_citation_needs(workspace):
    file_id = workspace.add_file("bio.txt")
    await _write(workspace, file_id, ["Chlorophyll absorbs red light"])

    rows = await store.hybrid_search(
        workspace_id=workspace.id,
        vector=_unit_vector(0),
        terms="chlorophyll",
        file_ids=None,
        candidates=10,
    )

    row = rows[0]
    assert (row["page_start"], row["page_end"]) == (1, 1)
    assert store.decode_regions(row["regions"])[0]["space"] == "mineru-1000-lefttop"
    assert row["section_path"] == "Ch 1 › Section"


async def test_neighbours_come_back_in_document_order(workspace):
    file_id = workspace.add_file("bio.txt")
    await _write(workspace, file_id, ["one", "two", "three", "four"])

    rows = await store.neighbor_chunks(file_id=file_id, chunk_idx=2)

    assert [row["text"] for row in rows] == ["two", "three", "four"]


async def test_reindexing_removes_the_tail_of_the_previous_run(workspace):
    file_id = workspace.add_file("bio.txt")
    await _write(workspace, file_id, ["one", "two", "three"])
    await _write(workspace, file_id, ["one"])

    assert (
        workspace.scalar(
            "SELECT count(*) FROM rag_chunks c JOIN rag_file_contents fc "
            "ON fc.content_id = c.content_id WHERE fc.file_id = %s",
            (file_id,),
        )
        == 1
    )


# ------------------------------------------------------------------ concepts


async def _concepts(ws, file_id: str, names_to_chunks: dict[str, list[str]]) -> None:
    content_id = ws.scalar(
        "SELECT content_id FROM rag_file_contents WHERE file_id = %s", (file_id,)
    )
    await store.replace_content_concepts(
        workspace_id=ws.id,
        content_id=content_id,
        concepts=[
            {
                "id": f"cpt_{file_id}_{i}",
                "name": name,
                "norm": store.normalize_concept(name),
                "chunk_ids": chunk_ids,
            }
            for i, (name, chunk_ids) in enumerate(names_to_chunks.items())
        ],
    )


async def test_a_concept_named_by_two_files_is_one_row(workspace):
    """Co-mention is the whole point of the index, so the same idea in two
    documents must not become two concepts."""
    a = workspace.add_file("a.txt")
    b = workspace.add_file("b.txt")
    await _write(workspace, a, ["alpha"])
    await _write(workspace, b, ["beta"], axis_base=10)
    await _concepts(workspace, a, {"ATP": [f"{a}_c0"]})
    await _concepts(workspace, b, {"  atp  ": [f"{b}_c0"]})

    assert (
        workspace.scalar(
            "SELECT count(*) FROM rag_concepts WHERE workspace_id = %s", (workspace.id,)
        )
        == 1
    )
    assert (
        workspace.scalar(
            "SELECT count(*) FROM rag_concept_mentions m JOIN rag_concepts c "
            "ON c.id = m.concept_id WHERE c.workspace_id = %s",
            (workspace.id,),
        )
        == 2
    )


async def test_related_concepts_reports_co_mention_and_where(workspace):
    a = workspace.add_file("a.txt")
    b = workspace.add_file("b.txt")
    await _write(workspace, a, ["alpha"])
    await _write(workspace, b, ["beta"], axis_base=10)
    await _concepts(workspace, a, {"ATP": [f"{a}_c0"], "Calvin cycle": [f"{a}_c0"]})
    await _concepts(workspace, b, {"ATP": [f"{b}_c0"], "Mitochondria": [f"{b}_c0"]})

    rows = await store.related_concepts(workspace_id=workspace.id, name="atp")

    assert {row["name"] for row in rows} == {"Calvin cycle", "Mitochondria"}
    assert all(row["mentions"] >= 1 for row in rows)


async def test_a_concept_loses_its_row_when_its_last_mention_goes(workspace):
    file_id = workspace.add_file("a.txt")
    await _write(workspace, file_id, ["alpha"])
    await _concepts(workspace, file_id, {"Ephemeral": [f"{file_id}_c0"]})
    await _concepts(workspace, file_id, {})

    assert (
        workspace.scalar(
            "SELECT count(*) FROM rag_concepts WHERE workspace_id = %s", (workspace.id,)
        )
        == 0
    )


# --------------------------------------------------------- structure & tree


async def test_workspace_outline_groups_files_under_chapters(workspace):
    chapter = workspace.add_chapter("Biology")
    filed = workspace.add_file("filed.txt", chapter)
    unfiled = workspace.add_file("unfiled.txt")
    await _write(workspace, filed, ["alpha"])
    content_id = workspace.scalar(
        "SELECT content_id FROM rag_file_contents WHERE file_id = %s", (filed,)
    )
    await store.upsert_content_summary(
        workspace_id=workspace.id,
        content_id=content_id,
        fingerprint="fp",
        summary="A summary.",
        outline=[{"title": "Ch 1", "pageStart": 1}],
    )

    outline = await store.workspace_outline(workspace.id)

    assert [c["name"] for c in outline["chapters"]] == ["Biology"]
    by_id = {f["id"]: f for f in outline["files"]}
    assert by_id[filed]["chapter_id"] == chapter and by_id[filed]["chunks"] == 1
    assert by_id[filed]["summary"] == "A summary."
    assert by_id[unfiled]["chapter_id"] is None and by_id[unfiled]["chunks"] == 0


async def test_moving_a_file_between_chapters_marks_both_dirty(workspace):
    """Reorganization invalidates summaries through a trigger rather than a
    handler, because the paths that reorganize files are many."""
    source = workspace.add_chapter("From")
    target = workspace.add_chapter("To")
    file_id = workspace.add_file("a.txt", source)
    await store.set_chapter_summary(source, "clean")
    await store.set_chapter_summary(target, "clean")

    workspace.scalar(
        "UPDATE files SET chapter_id = %s WHERE id = %s RETURNING id", (target, file_id)
    )

    dirty = {row["chapter_id"] for row in await store.dirty_chapters(workspace.id)}
    assert dirty == {source, target}
    assert (
        workspace.scalar(
            "SELECT count(*) FROM jobs WHERE type = 'summaries_rollup' "
            "AND payload->>'workspaceId' = %s",
            (workspace.id,),
        )
        >= 1
    )


async def test_content_ingest_marks_only_its_chapter_dirty(workspace):
    changed = workspace.add_chapter("Changed")
    untouched = workspace.add_chapter("Untouched")
    file_id = workspace.add_file("a.txt", changed)
    workspace.add_file("b.txt", untouched)
    await store.set_chapter_summary(changed, "clean")
    await store.set_chapter_summary(untouched, "clean")

    await store.mark_workspace_dirty(workspace.id, file_id)

    dirty = {row["chapter_id"] for row in await store.dirty_chapters(workspace.id)}
    assert dirty == {changed}


async def test_deleting_a_chapter_does_not_break_its_files(workspace):
    """The chapter FK is ON DELETE SET NULL, so the trigger fires for a chapter
    that no longer exists — it must not try to mark it dirty."""
    chapter = workspace.add_chapter("Doomed")
    file_id = workspace.add_file("a.txt", chapter)

    workspace.scalar("DELETE FROM chapters WHERE id = %s RETURNING id", (chapter,))

    assert (
        workspace.scalar("SELECT chapter_id FROM files WHERE id = %s", (file_id,))
        is None
    )


async def test_duplicate_alias_survives_deleting_first_file(workspace):
    first = workspace.add_file("a.txt")
    second = workspace.add_file("b.txt")
    await _write(workspace, first, ["Chlorophyll absorbs red light"])
    content_id = workspace.scalar(
        "SELECT content_id FROM rag_file_contents WHERE file_id = %s", (first,)
    )
    content_hash = workspace.scalar(
        "SELECT content_hash FROM rag_contents WHERE id = %s", (content_id,)
    )
    duplicate = await store.attach_file_content(
        workspace_id=workspace.id, file_id=second, content_hash=content_hash
    )

    assert duplicate["ready"]
    workspace.scalar("DELETE FROM files WHERE id = %s RETURNING id", (first,))

    rows = await store.hybrid_search(
        workspace_id=workspace.id,
        vector=_unit_vector(0),
        terms="chlorophyll",
        file_ids=[second],
        candidates=10,
    )
    read = await store.read_file_range(file_id=second, start=0, count=1)

    assert rows and rows[0]["file_id"] == second and rows[0]["file_name"] == "b.txt"
    assert read and read[0]["file_id"] == second
    assert (
        workspace.scalar(
            "SELECT count(*) FROM rag_contents WHERE id = %s", (content_id,)
        )
        == 1
    )


async def test_deleting_a_file_takes_its_index_with_it(workspace):
    file_id = workspace.add_file("a.txt")
    await _write(workspace, file_id, ["alpha"])
    await _concepts(workspace, file_id, {"ATP": [f"{file_id}_c0"]})
    content_id = workspace.scalar(
        "SELECT content_id FROM rag_file_contents WHERE file_id = %s", (file_id,)
    )

    workspace.scalar("DELETE FROM files WHERE id = %s RETURNING id", (file_id,))

    assert (
        workspace.scalar(
            "SELECT count(*) FROM rag_chunks WHERE content_id = %s", (content_id,)
        )
        == 0
    )
    assert (
        workspace.scalar(
            "SELECT count(*) FROM rag_concept_mentions m JOIN rag_chunks c "
            "ON c.id = m.chunk_id WHERE c.content_id = %s",
            (content_id,),
        )
        == 0
    )
    assert (
        workspace.scalar(
            "SELECT count(*) FROM rag_concepts WHERE workspace_id = %s", (workspace.id,)
        )
        == 0
    )
