"""What the pipeline image (pipeline/Dockerfile, built from the repository
root) carries."""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
WRITER = "bench/rag/scripts/knowledge_base_library.py"


def test_the_image_ships_the_retrieval_diagnostics_without_the_library_writer() -> None:
    """(security regression: CI hardening, the library writer in the image)
    The diagnostics come from bench/rag/scripts; the loader that publishes,
    rolls back and retires library versions stays out of the build context
    (Epo 2026-10-19, 6c)."""
    dockerfile = (ROOT / "pipeline/Dockerfile").read_text(encoding="utf-8")
    ignored = (ROOT / ".dockerignore").read_text(encoding="utf-8").splitlines()

    assert "COPY bench/rag/scripts ./bench/rag/scripts" in dockerfile
    assert WRITER in ignored
    assert not [
        line for line in ignored if line.startswith("!") and "bench/rag" in line
    ]
