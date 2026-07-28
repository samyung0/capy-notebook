"""Offline unit tests for the custom Modal parser engine (no network).

Covers the bits we own around LightRAG's MinerU IR builder: registry wiring,
the raw-bundle cache signature, image-path rewriting, and the bundle -> IR
conversion. The Modal HTTP call itself is exercised in the cassette suite.
"""

from __future__ import annotations

import base64
import json
import zipfile
from pathlib import Path

import pytest

from pipeline.rag import factory  # noqa: F401 — importing registers the engine
from pipeline.rag.modal_parser import (
    PARSER_ENGINE_MODAL,
    ModalParser,
    _bundle_signature,
    register_modal_parser,
)

# 1x1 transparent PNG.
_PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
)


def _write_bundle(raw_dir: Path) -> None:
    (raw_dir / "images").mkdir(parents=True)
    (raw_dir / "images" / "fig1.png").write_bytes(_PNG)
    content = [
        {"type": "text", "text": "Introduction", "text_level": 1, "page_idx": 0},
        {"type": "text", "text": "Body paragraph one.", "page_idx": 0},
        {
            "type": "table",
            "table_body": "<table><tr><td>a</td><td>b</td></tr></table>",
            "table_caption": ["Table 1"],
            "page_idx": 1,
        },
        {
            "type": "equation",
            "text": "$$e=mc^2$$",
            "text_format": "block",
            "page_idx": 1,
        },
        {
            "type": "image",
            "img_path": "images/fig1.png",
            "img_caption": ["Fig 1"],
            "page_idx": 2,
        },
    ]
    (raw_dir / "content_list.json").write_text(json.dumps(content), encoding="utf-8")


def test_engine_is_registered():
    from lightrag.parser.registry import get_parser, supported_parser_engines

    register_modal_parser()
    assert PARSER_ENGINE_MODAL in supported_parser_engines()
    parser = get_parser(PARSER_ENGINE_MODAL)
    assert isinstance(parser, ModalParser)
    assert parser.engine_name == "modal"


def test_build_ir_from_bundle(tmp_path: Path):
    raw = tmp_path / "doc.modal_raw"
    _write_bundle(raw)

    ir = ModalParser().build_ir(raw, "doc.pdf")

    # Single heading block ("Introduction") absorbs the body + all multimodal items.
    assert len(ir.blocks) == 1
    block = ir.blocks[0]
    assert block.heading == "Introduction"
    assert len(block.tables) == 1
    assert len(block.equations) == 1
    assert len(block.drawings) == 1
    # The image asset was discovered on disk.
    assert len(ir.assets) == 1


def test_bundle_signature_detects_change(tmp_path: Path):
    src = tmp_path / "src.pdf"
    src.write_bytes(b"hello world")
    sig1 = _bundle_signature(src)

    src.write_bytes(b"hello world, extended")
    sig2 = _bundle_signature(src)

    # Size (and mtime) change -> different signature -> cache miss -> re-parse.
    assert sig1 != sig2
    assert set(sig1) == {"source_size", "source_mtime_ns", "parse_method", "url"}


def test_is_bundle_valid_roundtrip(tmp_path: Path):
    raw = tmp_path / "doc.modal_raw"
    _write_bundle(raw)
    src = tmp_path / "doc.pdf"
    src.write_bytes(b"pdf-bytes")

    parser = ModalParser()
    # No signature file yet -> invalid.
    assert parser.is_bundle_valid(raw, src) is False

    # Write a matching signature -> valid; mutate the source -> invalid.
    (raw / "evo_modal_signature.json").write_text(json.dumps(_bundle_signature(src)))
    assert parser.is_bundle_valid(raw, src) is True

    src.write_bytes(b"pdf-bytes-changed")
    assert parser.is_bundle_valid(raw, src) is False


def test_fetch_bundle_rewrites_image_paths(tmp_path: Path, monkeypatch):
    """The Modal response's ``img_path`` is rewritten to the bundle-relative
    ``images/<name>`` location so MinerUIRBuilder finds the asset bytes."""
    from pipeline.rag import modal_parser

    payload = {
        "content_list": [
            {"type": "image", "img_path": "/tmp/whatever/fig1.png", "page_idx": 0}
        ],
        "images": {"fig1.png": base64.b64encode(_PNG).decode()},
        "md": "",
    }

    class _Resp:
        status_code = 200

        def json(self):
            return payload

    monkeypatch.setattr(modal_parser.requests, "post", lambda *a, **k: _Resp())

    src = tmp_path / "doc.pdf"
    src.write_bytes(b"pdf")
    raw = tmp_path / "doc.modal_raw"
    raw.mkdir()
    monkeypatch.setattr(
        modal_parser.cfg, "modal_parse_url", "https://modal.test/file_parse"
    )

    modal_parser._fetch_bundle_sync(src, "doc.pdf", raw)

    written = json.loads((raw / "content_list.json").read_text(encoding="utf-8"))
    assert written[0]["img_path"] == "images/fig1.png"
    assert (raw / "images" / "fig1.png").is_file()


def test_fetch_bundle_raises_on_http_error(tmp_path: Path, monkeypatch):
    from pipeline.rag import modal_parser

    class _Resp:
        status_code = 500
        text = "boom"

    monkeypatch.setattr(modal_parser.requests, "post", lambda *a, **k: _Resp())
    monkeypatch.setattr(
        modal_parser.cfg, "modal_parse_url", "https://modal.test/file_parse"
    )

    src = tmp_path / "doc.pdf"
    src.write_bytes(b"pdf")
    raw = tmp_path / "doc.modal_raw"
    raw.mkdir()

    with pytest.raises(modal_parser.ModalParseError):
        modal_parser._fetch_bundle_sync(src, "doc.pdf", raw)


def test_remote_descriptor_has_stable_versioned_artifact(tmp_path: Path):
    from pipeline.rag import modal_parser

    src = tmp_path / "doc.pdf"
    descriptor = modal_parser.source_descriptor(
        blob_path="sources/blob_1.pdf",
        file_id="f_1",
        source_etag="etag-1",
        source_size=123,
    )
    src.write_text(json.dumps(descriptor), encoding="utf-8")

    key1, fingerprint1 = modal_parser.artifact_identity(descriptor)
    key2, fingerprint2 = modal_parser.artifact_identity(descriptor)
    assert key1 == key2
    assert fingerprint1 == fingerprint2
    assert key1.startswith(f"parsed/f_1/{modal_parser.PARSER_VERSION}/")
    assert _bundle_signature(src)["source_fingerprint"] == fingerprint1


def test_extract_artifact_rejects_path_traversal(tmp_path: Path, monkeypatch):
    from pipeline.rag import modal_parser

    archive_path = tmp_path / "malicious.zip"
    with zipfile.ZipFile(archive_path, "w") as archive:
        archive.writestr(
            "manifest.json",
            json.dumps(
                {
                    "schema": modal_parser.ARTIFACT_SCHEMA,
                    "parser_version": modal_parser.PARSER_VERSION,
                }
            ),
        )
        archive.writestr("content_list.json", "[]")
        archive.writestr("../outside.txt", "owned")

    def fake_download(_key: str, destination: Path):
        destination.write_bytes(archive_path.read_bytes())

    monkeypatch.setattr(modal_parser.blobstore, "download_to", fake_download)
    raw = tmp_path / "raw"
    raw.mkdir()
    with pytest.raises(modal_parser.ModalParseError, match="unsafe path"):
        modal_parser._extract_artifact("parsed/test.zip", raw)
    assert not (tmp_path / "outside.txt").exists()
