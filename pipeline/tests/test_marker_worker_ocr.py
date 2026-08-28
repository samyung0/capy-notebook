"""Lazy RapidOCR wiring (no ONNX)."""

from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
MODAL_DIR = REPO_ROOT / "modal"
if str(MODAL_DIR) not in sys.path:
    sys.path.insert(0, str(MODAL_DIR))

from marker_worker import (
    ALL_RAPIDOCR,
    MARKER_ONLY,
    SELECTIVE_RAPIDOCR,
    _ocr_page_indices,
    _page_lines,
    normalize_document,
    normalize_parse_method,
)


class _FakeImage:
    size = (100, 80)


def test_parse_modes_are_explicit_with_legacy_aliases() -> None:
    assert normalize_parse_method("txt") == MARKER_ONLY
    assert normalize_parse_method("ocr") == SELECTIVE_RAPIDOCR
    assert normalize_parse_method(ALL_RAPIDOCR) == ALL_RAPIDOCR
    with pytest.raises(ValueError, match="unsupported parse method"):
        normalize_parse_method("surprise")


def test_all_page_ocr_selects_every_normalized_page() -> None:
    probes = [
        SimpleNamespace(page_idx=0, needs_ocr=False),
        SimpleNamespace(page_idx=1, needs_ocr=True),
    ]
    assert _ocr_page_indices(probes, MARKER_ONLY) == []
    assert _ocr_page_indices(probes, SELECTIVE_RAPIDOCR) == [1]
    assert _ocr_page_indices(probes, ALL_RAPIDOCR) == [0, 1]


def test_office_is_normalized_to_one_paginated_pdf(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def _convert(command, **_kwargs):
        outdir = Path(command[command.index("--outdir") + 1])
        (outdir / "source.pdf").write_bytes(b"%PDF-converted")
        return SimpleNamespace(returncode=0, stderr="", stdout="")

    monkeypatch.setattr("marker_worker.subprocess.run", _convert)

    data, name, source_format = normalize_document(b"office", "lesson.pptx")

    assert data == b"%PDF-converted"
    assert name == "lesson.pdf"
    assert source_format == "pptx"


def test_legacy_office_formats_are_rejected() -> None:
    with pytest.raises(ValueError, match="supported formats"):
        normalize_document(b"legacy", "lesson.ppt")


def test_page_lines_lazy_loads_local_engine(monkeypatch: pytest.MonkeyPatch) -> None:
    loaded: list[str] = []

    def _engine() -> object:
        loaded.append("engine")
        return object()

    monkeypatch.setattr("marker_worker._rapidocr_engine", _engine)
    monkeypatch.setattr(
        "marker_worker._rapid_lines",
        lambda engine, image: [{"text": "local", "bbox": None}],
    )
    import marker_worker as mw

    monkeypatch.setattr(mw, "_OCR", None)
    assert _page_lines(_FakeImage()) == [{"text": "local", "bbox": None}]
    assert loaded == ["engine"]
    assert _page_lines(_FakeImage()) == [{"text": "local", "bbox": None}]
    assert loaded == ["engine"]


def test_parse_document_returns_child_cpu_and_page_measurements(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import marker_worker as mw
    import scan_pages

    probes = [
        SimpleNamespace(page_idx=0, needs_ocr=False),
        SimpleNamespace(page_idx=1, needs_ocr=True),
    ]
    monkeypatch.setattr(scan_pages, "probe_pages", lambda _data: probes)
    monkeypatch.setattr(mw, "_MODELS", {})
    monkeypatch.setattr(mw, "_marker_converter", lambda *_a, **_k: object())
    monkeypatch.setattr(
        mw,
        "parse_fast",
        lambda *_a, **_k: {"content_list": [], "images": {}, "md": ""},
    )

    result = mw.parse_document(b"pdf", "notes.pdf", "ocr")

    assert result["_page_count"] == 2
    assert result["_ocr_pages"] == [1]
    assert isinstance(result["_worker_cpu_ms"], int)
    assert result["_worker_cpu_ms"] >= 0


def test_parse_document_preserves_measurements_on_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import marker_worker as mw
    import scan_pages

    monkeypatch.setattr(
        scan_pages,
        "probe_pages",
        lambda _data: [SimpleNamespace(page_idx=0, needs_ocr=True)],
    )
    monkeypatch.setattr(mw, "_MODELS", {})
    monkeypatch.setattr(mw, "_marker_converter", lambda *_a, **_k: object())

    def fail(*_args, **_kwargs):
        raise RuntimeError("marker crashed")

    monkeypatch.setattr(mw, "parse_fast", fail)

    result = mw.parse_document(b"pdf", "notes.pdf", "ocr")

    assert "marker crashed" in result["_worker_error"]
    assert result["_page_count"] == 1
    assert result["_ocr_pages"] == [0]
    assert result["_worker_cpu_ms"] >= 0


def test_parse_document_does_not_invent_a_page_when_probing_fails(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import marker_worker as mw
    import scan_pages

    def fail(_data: bytes):
        raise RuntimeError("page probing crashed")

    monkeypatch.setattr(scan_pages, "probe_pages", fail)

    result = mw.parse_document(b"not-a-pdf", "broken.pdf", "ocr")

    assert "page probing crashed" in result["_worker_error"]
    assert result["_page_count"] == 0
    assert result["_ocr_pages"] == []
    assert result["_worker_cpu_ms"] >= 0
