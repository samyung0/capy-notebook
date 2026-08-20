"""Lazy RapidOCR wiring (no ONNX)."""

from __future__ import annotations

import sys
from pathlib import Path

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
