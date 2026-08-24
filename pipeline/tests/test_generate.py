"""Cassette-backed tests for the deterministic /generate workflows.

Material generation is a fixed pipeline rather than an agent loop, so what
matters here is that the scope is covered evenly and the model's reply survives
the trip into the shape the gateway persists.
"""

from __future__ import annotations

import pytest

from pipeline.retrieval import indexing, store, workflows
from pipeline.retrieval.chunking import chunk_markdown

pytestmark = pytest.mark.cassette


async def _index(ws, name: str, text: str) -> str:
    file_id = ws.add_file(name)
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


async def test_gather_context_covers_every_document_in_scope(
    cassette, workspace, sample_txt
):
    first = await _index(workspace, "photosynthesis.txt", sample_txt)
    second = await _index(
        workspace,
        "cells.txt",
        "Mitochondria oxidise glucose and transfer the energy into ATP.",
    )

    context, passages = await workflows.gather_context(
        workspace_id=workspace.id, file_ids=None
    )

    assert {p.file_id for p in passages} == {first, second}
    # Numbered so the model can cite them and the caller can map them back.
    assert context.startswith("[1] ")


async def test_gather_context_honours_the_file_filter(cassette, workspace, sample_txt):
    await _index(workspace, "photosynthesis.txt", sample_txt)
    cells = await _index(
        workspace, "cells.txt", "Mitochondria oxidise glucose to make ATP."
    )

    _context, passages = await workflows.gather_context(
        workspace_id=workspace.id, file_ids=[cells]
    )

    assert {p.file_id for p in passages} == {cells}


async def test_generate_flashcards_returns_parseable_json(
    cassette, workspace, sample_txt
):
    await _index(workspace, "photosynthesis.txt", sample_txt)
    context, _passages = await workflows.gather_context(
        workspace_id=workspace.id, file_ids=None
    )

    raw = await workflows.produce(
        instruction=(
            "Create 3 study flashcards. Return ONLY a JSON array of objects "
            '{"front": "...", "back": "..."}.'
        ),
        context=context,
        scope="documents photosynthesis.txt",
        model="deepseek-v4-flash",
    )
    cards = workflows.extract_json(raw)

    assert isinstance(cards, list) and cards
    assert all({"front", "back"} <= set(card) for card in cards)


async def test_generate_quiz_normalizes_into_the_runner_shape(
    cassette, workspace, sample_txt
):
    await _index(workspace, "photosynthesis.txt", sample_txt)
    context, _passages = await workflows.gather_context(
        workspace_id=workspace.id, file_ids=None
    )

    raw = await workflows.produce(
        instruction=(
            "Create 2 multiple-choice questions. Return ONLY a JSON array of "
            'objects {"type": "mcq", "prompt": "...", "options": ["..."], '
            '"answer": "...", "level": "recall"}.'
        ),
        context=context,
        scope="documents photosynthesis.txt",
        model="deepseek-v4-flash",
    )
    questions = workflows.normalize_questions(workflows.extract_json(raw))

    assert questions
    assert all(q["id"] and q["level"] for q in questions)
    assert all(
        isinstance(option, dict)
        for q in questions
        if q.get("type") == "mcq"
        for option in q["options"]
    )
