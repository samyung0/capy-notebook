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

from marker_worker import _page_lines


class _FakeImage:
    size = (100, 80)


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
