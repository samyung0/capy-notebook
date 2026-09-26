"""Opt-in local HTTP parser → Postgres retrieval → capture/citation check.

Set CAPY_ODL_LOCAL_URL, CAPY_ODL_LOCAL_SPOOL and CAPY_ODL_LOCAL_RELEASE for an
already running localhost parser. The normal workspace fixture owns disposable
Postgres/Redis. CAPY_ODL_LOCAL_REPORT_DIR optionally retains the evidence.
The native page reuses the September 9 French development source, not a holdout.
Embeddings, summaries and object downloads are deterministic local substitutes.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import io
import json
import os
import shutil
import uuid
import zipfile
from dataclasses import asdict
from pathlib import Path
from urllib.parse import urlsplit

import pymupdf
import pytest
import requests
from PIL import Image

from pipeline.config import cfg
from pipeline.ingest.worker import _page_chunks
from pipeline.parse import parser_client
from pipeline.retrieval import (
    agent,
    capture,
    contract,
    indexing,
    models,
    openui,
    store,
    tools,
)
from pipeline.retrieval.confidence import OCR_REASON, OCR_SCORE, ocr_pages
from pipeline.retrieval.search import search

NATIVE_SOURCE = (
    Path(__file__).resolve().parents[2]
    / "bench/rag/fixtures/local/2026-09-09-odl-agentic/pdfs/rag__fr__camembert-taln.pdf"
)
NATIVE_SHA256 = "5499969bf0f52657722c22220ee8f6f7fe763629d438a9a67d376b05e115dff3"
REQUIRED_ENV = (
    "CAPY_ODL_LOCAL_URL",
    "CAPY_ODL_LOCAL_SPOOL",
    "CAPY_ODL_LOCAL_RELEASE",
)
pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(
        not all(os.getenv(key) for key in REQUIRED_ENV) or not NATIVE_SOURCE.is_file(),
        reason="explicit local parser configuration and the reviewed French PDF required",
    ),
]


def _write_json(path: Path, value) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, default=str))


def _source_pdf(path: Path, request_id: str) -> None:
    """Freeze one reviewed native page plus new image-only text before parsing."""
    assert hashlib.sha256(NATIVE_SOURCE.read_bytes()).hexdigest() == NATIVE_SHA256
    with pymupdf.open(NATIVE_SOURCE) as native, pymupdf.open() as scan:
        page = scan.new_page(width=600, height=800)
        page.insert_text(
            (45, 90),
            "ORBIT SCIENCE FIELD NOTES\n\n"
            "The violet observatory records the planet every night.\n"
            "A copper telescope measures distant orbital motion.\n"
            "Students compare three images before writing results.\n"
            "The final notebook preserves the original observations.",
            fontsize=17,
            lineheight=1.6,
        )
        raster = page.get_pixmap(matrix=pymupdf.Matrix(2, 2)).tobytes("png")
        with pymupdf.open() as output:
            output.insert_pdf(native, from_page=5, to_page=5)
            image_page = output.new_page(width=600, height=800)
            image_page.insert_image(image_page.rect, stream=raster)
            # A unique source identity exercises publication on every explicit run.
            output.set_metadata({"title": request_id})
            output.save(path)
    with pymupdf.open(path) as check:
        assert len(check) == 2 and not check[1].get_text().strip()


async def test_local_parser_index_capture_citations(workspace, monkeypatch, tmp_path):
    base_url = os.environ["CAPY_ODL_LOCAL_URL"].rstrip("/")
    parsed_url = urlsplit(base_url)
    assert parsed_url.scheme == "http" and parsed_url.hostname in {
        "127.0.0.1",
        "localhost",
        "::1",
    }
    assert not parsed_url.username and not parsed_url.password and not parsed_url.path
    assert os.getenv("CAPY_TEST_RECORD", "none") == "none"
    spool = Path(os.environ["CAPY_ODL_LOCAL_SPOOL"]).resolve()
    assert spool.is_dir()
    evidence = Path(os.environ.get("CAPY_ODL_LOCAL_REPORT_DIR", str(tmp_path)))
    evidence.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(cfg, "parser_url", base_url + "/file_parse")
    monkeypatch.setattr(cfg, "parse_shared_dir", str(spool))
    monkeypatch.setattr(cfg, "release_sha", os.environ["CAPY_ODL_LOCAL_RELEASE"])
    monkeypatch.setattr(cfg, "parser_token", "")
    monkeypatch.setattr(cfg, "parser_timeout", 180)
    monkeypatch.setattr(cfg, "b2_bucket", "")
    monkeypatch.setattr(cfg, "capture_cache_dir", str(evidence / "capture-cache"))
    monkeypatch.setattr(cfg, "capture_max_edge", 800)
    health_response = await asyncio.to_thread(
        requests.get, base_url + "/healthz", timeout=10
    )
    health_response.raise_for_status()
    health = health_response.json()
    _write_json(evidence / "health-before.json", health)
    assert health["ok"] and health["state"] == "ready"
    assert health["parser_version"] == parser_client.parser_version(
        parser_client.ROUTE_FAST
    )

    request_id = "local-integration-" + uuid.uuid4().hex
    source = evidence / "source.pdf"
    _source_pdf(source, request_id)
    digest = hashlib.sha256(source.read_bytes()).hexdigest()
    source_key = f"sources/{request_id}.pdf"
    staged = spool / source_key
    staged.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, staged)
    descriptor = parser_client.source_descriptor(
        source_key=source_key, source_sha256=digest, route=parser_client.ROUTE_FAST
    )
    _write_json(
        evidence / "source-provenance.json",
        {
            "original_pdf": str(NATIVE_SOURCE),
            "original_sha256": NATIVE_SHA256,
            "original_page": 6,
            "output_native_page": 1,
            "generated_ocr_page": 2,
            "source_sha256": digest,
            "descriptor": descriptor,
        },
    )

    measurements = []
    monkeypatch.setattr(
        parser_client.obs, "record_parse_usage", lambda **kw: measurements.append(kw)
    )
    artifact = await asyncio.to_thread(
        parser_client._request_artifact, descriptor, "integration.pdf", request_id
    )
    assert not artifact.get("cached")
    artifact["version"] = parser_client.parser_version(parser_client.ROUTE_FAST)
    raw = evidence / "bundle"
    content = parser_client.extract_artifact(
        artifact, raw, route=parser_client.ROUTE_FAST, office=False
    )
    bundle = spool / artifact["key"]
    shutil.copyfile(bundle, evidence / "artifact.zip")
    with zipfile.ZipFile(bundle) as archive:
        manifest = json.loads(archive.read("manifest.json"))
    _write_json(evidence / "manifest.json", manifest)
    assert manifest["parse_receipt"]["request_id"] == request_id
    assert measurements[-1]["pages"] == 2 and measurements[-1]["ocr_pages"] == 1
    assert measurements[-1]["receipt_id"] == artifact["fingerprint"]
    assert len(measurements) == 1

    # Both the client spool hit and the HTTP server hit preserve creator ownership.
    for identity, expected_receipts in ((request_id, 2), (request_id + "-other", 2)):
        cached, key, fingerprint = await asyncio.to_thread(
            parser_client.parse_to_bundle,
            descriptor,
            "integration.pdf",
            evidence / ("owner-cache" if identity == request_id else "other-cache"),
            request_id=identity,
        )
        assert cached == content and key == artifact["key"]
        assert fingerprint == artifact["fingerprint"]
        assert len(measurements) == expected_receipts
    server_cache = await asyncio.to_thread(
        requests.post,
        cfg.parser_url,
        timeout=20,
        json={
            **descriptor,
            "output_key": artifact["key"],
            "filename": "integration.pdf",
            "artifact_schema": parser_client.ARTIFACT_SCHEMA,
            "parser_version": artifact["version"],
            "source_fingerprint": artifact["fingerprint"],
            "request_id": request_id + "-other",
        },
    )
    server_cache.raise_for_status()
    assert set(server_cache.json()) == {"artifact"}
    assert server_cache.json()["artifact"]["cached"]
    _write_json(evidence / "measurements.json", measurements)

    tables = [block for block in content if block.get("type") == "table"]
    table = next(block for block in tables if "CCNET" in block["table_body"])
    assert "GSD / UPOS" in table["table_body"] and "NLI / ACC." in table["table_body"]
    assert "TABLE 3" in " ".join(table["table_caption"])
    assert "moyenne de 10" in " ".join(table["table_caption"])
    assert {"row": 1, "column": 14, "styles": ["bold"]} in table["_table_source_styles"]
    assert len(table["_table_source_styles"]) == 24
    assert ocr_pages(content) == {2}
    chunks = await asyncio.to_thread(_page_chunks, content, raw, source)
    _write_json(evidence / "chunks.json", [asdict(chunk) for chunk in chunks])
    table_chunk = next(
        chunk for chunk in chunks if "82.06 [bold in source]" in chunk.text
    )
    assert "Fine-tuning" in table_chunk.text and "CCNET" in table_chunk.text
    assert "TABLE 3" in table_chunk.text and "NLI / ACC." in table_chunk.text
    ocr_chunks = [
        chunk
        for chunk in chunks
        if chunk.page_start is not None
        and chunk.page_start <= 2 <= (chunk.page_end or chunk.page_start)
    ]
    assert ocr_chunks and any(
        "violet observatory" in chunk.text.lower() for chunk in ocr_chunks
    )
    assert all(
        chunk.confidence == OCR_SCORE and OCR_REASON in chunk.confidence_reasons
        for chunk in ocr_chunks
    )

    embed_calls = []

    async def embed(texts, *, spec):
        embed_calls.append(len(texts))
        return [[1.0] + [0.0] * (cfg.embedding_dim - 1) for _ in texts]

    async def summarize(name, parsed_chunks):
        assert name == "integration.pdf" and parsed_chunks == chunks
        return "French language model scores and orbital observations."

    monkeypatch.setattr(models, "embed", embed)
    monkeypatch.setattr(indexing, "summarize_file", summarize)
    file_id = workspace.add_file("integration.pdf")
    blob_key = f"sources/{file_id}"
    with workspace._connect() as connection:
        connection.execute(
            "UPDATE files SET kind='pdf', size_bytes=%s, parse_mode='fast' WHERE id=%s",
            (source.stat().st_size, file_id),
        )
    association = await store.attach_file_content(
        workspace_id=workspace.id,
        file_id=file_id,
        content_hash=indexing.content_hash(chunks),
        source_sha256=digest,
    )
    indexed = await indexing.index_file(
        workspace_id=workspace.id,
        content_id=association["content_id"],
        file_id=file_id,
        file_name="integration.pdf",
        chunks=chunks,
    )
    assert indexed["chunks"] == len(chunks)
    rows = await store.load_content_chunks(association["content_id"])
    _write_json(evidence / "stored-chunks.json", rows)
    assert len(rows) == len(chunks)
    for row, chunk in zip(rows, chunks, strict=True):
        assert row["text"] == chunk.text
        assert (
            row["page_start"] == chunk.page_start and row["page_end"] == chunk.page_end
        )
        assert store.decode_regions(row["regions"]) == [
            region.as_dict() for region in chunk.regions
        ]
        assert row["confidence"] == pytest.approx(chunk.confidence)
        assert row["confidence_reasons"] == list(chunk.confidence_reasons)
    assert all(row["regions"] for row in rows)
    table_hits = await search(
        workspace_id=workspace.id, query="CCNET 82.06", file_ids=[file_id]
    )
    scan_hits = await search(
        workspace_id=workspace.id, query="violet observatory", file_ids=[file_id]
    )
    table_hit = next(hit for hit in table_hits if "82.06 [bold in source]" in hit.text)
    scan_hit = next(
        hit for hit in scan_hits if "violet observatory" in hit.text.lower()
    )
    assert table_hit.lex_rank is not None and scan_hit.lex_rank is not None
    assert table_hit.vec_rank is not None and scan_hit.vec_rank is not None
    assert scan_hit.confidence == OCR_SCORE and OCR_REASON in scan_hit.location()
    assert "extraction confidence 0.50" in scan_hit.as_context(2)
    _write_json(
        evidence / "retrieval.json",
        {"table": asdict(table_hit), "scan": asdict(scan_hit)},
    )

    downloads = []

    def download(key, target, max_bytes):
        assert key == blob_key and source.stat().st_size <= max_bytes
        shutil.copyfile(source, target)
        downloads.append(key)
        return source.stat().st_size, digest

    monkeypatch.setattr(capture.blobstore, "download_file", download)
    ctx = tools.ToolContext(
        workspace_id=workspace.id, file_ids=[file_id], operations=contract.OPERATIONS
    )
    tools.assign_citations(ctx, [table_hit])
    refused = await tools.run("capture_page", {"file_id": file_id, "page": 2}, ctx)
    assert refused.refused and not downloads and not ctx.pending_images
    assert "Retrieve a passage" in refused.text()
    tools.assign_citations(ctx, [scan_hit])
    missing = await tools.run(
        "capture_page", {"file_id": "missing-file", "page": 1}, ctx
    )
    assert missing.refused and not downloads
    capture_result = await tools.run(
        "capture_page",
        {"file_id": file_id, "page": 2, "_tool_call_id": "scan-capture"},
        ctx,
    )
    assert not capture_result.refused and not capture_result.passages
    assert len(ctx.citations) == 2 and len(downloads) == 1
    assert "already in the evidence as [2]" in capture_result.text()
    image_url = ctx.pending_images["scan-capture"][1]
    jpeg = base64.b64decode(image_url.split(",", 1)[1], validate=True)
    (evidence / "capture.jpg").write_bytes(jpeg)
    with Image.open(io.BytesIO(jpeg)) as image:
        assert image.format == "JPEG" and max(image.size) == 800
    messages = capture.inject_images(
        [
            {
                "role": "tool",
                "tool_call_id": "scan-capture",
                "content": capture_result.text(),
            }
        ],
        ctx.pending_images,
    )
    assert messages[-1]["content"][-1]["image_url"]["url"] == image_url
    raw_answer = (
        "root = Answer([a])\n"
        'a = Md("The violet observatory records the planet every night.", [2])\n'
    )
    stream = openui.LangRenderer(lambda: len(ctx.citations))
    streamed = (
        "".join(
            stream.push(raw_answer[i : i + 7]) for i in range(0, len(raw_answer), 7)
        )
        + stream.finish()
    )
    order = stream.reading_order()
    answer = stream.text
    assert streamed == raw_answer == answer and stream.complete and order == [2]
    citations = agent._ordered_citations(ctx, order)
    assert citations == [{**scan_hit.as_citation(), "n": 2}]
    assert citations[0]["pageStart"] <= 2 <= citations[0]["pageEnd"]
    assert any(region["page"] == 2 for region in citations[0]["regions"])
    assert citations[0]["regions"] == scan_hit.regions
    _write_json(
        evidence / "result.json",
        {
            "passed": True,
            "parser_version": artifact["version"],
            "source_sha256": digest,
            "chunks": len(chunks),
            "ocr_chunks": len(ocr_chunks),
            "source_style_cells": 24,
            "receipt_owner_replayed": True,
            "other_request_receipt_absent": True,
            "index": indexed,
            "embedding_calls": embed_calls,
            "answer": answer,
            "citations": citations,
            "captures": ctx.captures,
        },
    )
