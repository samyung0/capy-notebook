"""Cassette-backed integration tests for the full LightRAG pipeline.

Each test drives the REAL migrated code — the per-workspace factory, the model
adapters (embedding / LLM / VLM), the custom Modal parser engine, and LightRAG's
ingest + query pipelines — while every model/Modal HTTP call is served from a
recorded cassette. Postgres stays live (a unique workspace per test, purged on
teardown).

Record once:  EVO_TEST_RECORD=once  (real keys + MODAL_PARSE_URL exported)
Replay:       (default, no env)     free, offline w.r.t. model APIs
"""

from __future__ import annotations

import shutil

import pytest
from lightrag.base import DocStatus
from lightrag.utils import compute_mdhash_id
from lightrag.utils_pipeline import doc_status_field, input_dir_path

from pipeline.rag.factory import build_ingest_rag, build_query_rag

pytestmark = pytest.mark.cassette


async def _status(rag, doc_id: str) -> str:
    doc = await rag.doc_status.get_by_id(doc_id)
    return str(doc_status_field(doc, "status", "")) if doc else ""


async def test_ingest_text_and_query(cassette, workspace, sample_txt):
    """RAW-text ingest (ainsert) builds a KG; a query answers from it."""
    ingest = await build_ingest_rag(workspace)
    try:
        doc_id = compute_mdhash_id("sample.txt", prefix="doc-")
        await ingest.ainsert(input=sample_txt, ids=doc_id, file_paths="sample.txt")
        assert await _status(ingest, doc_id) == DocStatus.PROCESSED.value
    finally:
        await ingest.finalize_storages()

    query = await build_query_rag(workspace)
    try:
        from lightrag import QueryParam

        answer = await query.aquery(
            "What does chlorophyll absorb?", param=QueryParam(mode="mix")
        )
    finally:
        await query.finalize_storages()

    assert isinstance(answer, str) and answer.strip()
    assert "chlorophyll" in answer.lower() or "light" in answer.lower()


async def test_ingest_pdf_via_modal_and_query(cassette, workspace, sample_pdf):
    """pending_parse ingest routed through the custom ``modal`` engine parses on
    Modal, builds a KG, and the content becomes queryable."""
    ingest = await build_ingest_rag(workspace)
    try:
        # Mirror the worker: stage the source under INPUT_DIR/<workspace>/ so the
        # parser's source resolver finds it.
        canonical = "sample.pdf"
        staged_dir = input_dir_path() / workspace
        staged_dir.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(sample_pdf, staged_dir / canonical)

        doc_id = compute_mdhash_id(canonical, prefix="doc-")
        await ingest.apipeline_enqueue_documents(
            input="",
            file_paths=canonical,
            docs_format="pending_parse",
            parse_engine="modal",
            process_options="ite",
        )
        await ingest.apipeline_process_enqueue_documents()

        assert await _status(ingest, doc_id) == DocStatus.PROCESSED.value
        # The KG actually got built from the parsed content.
        doc = await ingest.doc_status.get_by_id(doc_id)
        assert (doc_status_field(doc, "chunks_count", 0) or 0) >= 1
    finally:
        await ingest.finalize_storages()

    query = await build_query_rag(workspace)
    try:
        from lightrag import QueryParam

        answer = await query.aquery(
            "What is the role of mitochondria?", param=QueryParam(mode="mix")
        )
    finally:
        await query.finalize_storages()

    assert isinstance(answer, str) and answer.strip()


async def test_generate_flashcards_json(cassette, workspace, sample_txt):
    """A generate-style prompt returns JSON the service layer can parse."""
    import pipeline.retrieve.service as svc

    ingest = await build_ingest_rag(workspace)
    try:
        doc_id = compute_mdhash_id("sample.txt", prefix="doc-")
        await ingest.ainsert(input=sample_txt, ids=doc_id, file_paths="sample.txt")
    finally:
        await ingest.finalize_storages()

    query = await build_query_rag(workspace)
    try:
        from lightrag import QueryParam

        raw = await query.aquery(
            "Create 3 study flashcards from this scope. Return ONLY a JSON array "
            'of objects {"front": "...", "back": "..."}.',
            param=QueryParam(mode="mix"),
        )
    finally:
        await query.finalize_storages()

    data = svc._extract_json(raw)
    assert isinstance(data, list) and len(data) >= 1
    assert all(isinstance(card, dict) for card in data)
