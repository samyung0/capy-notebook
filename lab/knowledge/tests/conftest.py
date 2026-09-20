import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
REPO = ROOT.parents[1]
for path in (ROOT, REPO / "bench/rag/scripts", REPO / "lab/playground/scripts"):
    sys.path.insert(0, str(path))

import store


@pytest.fixture(autouse=True)
def data_dir(tmp_path, monkeypatch):
    """Every test gets its own data directory and SQLite file."""
    monkeypatch.setattr(store, "DATA", tmp_path)
    monkeypatch.setattr(store, "DB", tmp_path / "builder.sqlite")
    monkeypatch.setattr(store, "SOURCES", tmp_path / "sources")
    monkeypatch.setattr(store, "RUNS", tmp_path / "runs")
    monkeypatch.setattr(store, "LOGS", tmp_path / "logs")
    store.init()
    return tmp_path
