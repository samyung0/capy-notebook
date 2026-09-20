"""A page-tree failure gets one isolated rewrite within the Java deadline."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pymupdf
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "parser"))
from odl import java, refine


@pytest.mark.parametrize(
    ("output", "expected"),
    [
        ("SEVERE: unknown type of page tree node", java.JavaPageTreeError),
        ("Incorrect xref section", RuntimeError),
        ("OutOfMemoryError", RuntimeError),
    ],
)
def test_java_classifies_only_the_demonstrated_reader_failure(
    tmp_path, monkeypatch, output, expected
):
    monkeypatch.setattr(java, "jar_path", lambda: tmp_path / "parser.jar")
    monkeypatch.setattr(
        java.subprocess,
        "run",
        lambda *args, **kwargs: subprocess.CompletedProcess([], 1, output),
    )
    with pytest.raises(expected) as caught:
        java.run(tmp_path / "document.pdf", tmp_path, timeout_s=60)
    assert type(caught.value) is expected


@pytest.fixture
def source(monkeypatch):
    monkeypatch.setattr(refine.fonts, "repair_fonts", lambda data: (data, 0))
    with pymupdf.open() as document:
        page = document.new_page()
        page.insert_text(
            (50, 100),
            "The original source has enough native prose to need no page OCR.",
        )
        document.set_toc([[1, "Source chapter", 1]])
        return (
            document.tobytes(
                encryption=pymupdf.PDF_ENCRYPT_RC4_128,
                owner_pw="test-owner",
                user_pw="",
                permissions=pymupdf.PDF_PERM_PRINT,
            )
            + b"\n% trailing source comment\n"
        )


def test_reader_retry_preserves_source_encryption_and_uses_only_retry_assets(
    tmp_path, monkeypatch, source
):
    clock = [0.0]
    calls = []
    monkeypatch.setattr(refine.time, "perf_counter", lambda: clock[0])

    def run(pdf, out_dir, *, timeout_s):
        calls.append((pdf.read_bytes(), out_dir.name, timeout_s))
        if len(calls) == 1:
            clock[0] = 2.0
            (out_dir / "document.md").write_text("partial failed output")
            raise java.JavaPageTreeError("unknown type of page tree node")
        (out_dir / "document.md").write_text("successful retry output")
        return {"number of pages": 1, "kids": []}

    monkeypatch.setattr(java, "run", run)
    result = refine.parse_pdf(source, tmp_path, java_timeout_s=60)
    assert [(name, timeout) for _, name, timeout in calls] == [
        ("native", 60),
        ("native-retry", 58),
    ]
    assert calls[0][0] == source
    assert result.parsed_pdf == calls[1][0]
    assert result.markdown == "successful retry output"
    assert "java_structure_retry" in result.phases
    with (
        pymupdf.open(stream=source, filetype="pdf") as original,
        pymupdf.open(stream=result.parsed_pdf, filetype="pdf") as repaired,
    ):
        assert repaired.permissions == original.permissions
        assert repaired.metadata["encryption"] == original.metadata["encryption"]
        assert repaired.get_toc() == original.get_toc()
        assert repaired[0].get_text() == original[0].get_text()
        assert repaired[0].get_pixmap().samples == original[0].get_pixmap().samples


@pytest.mark.parametrize(
    "outcome", ["success", "other-error", "timeout", "retry-error", "budget"]
)
def test_reader_retry_is_bounded_and_leaves_other_outcomes_alone(
    tmp_path, monkeypatch, source, outcome
):
    clock = [0.0]
    calls = []
    monkeypatch.setattr(refine.time, "perf_counter", lambda: clock[0])

    def run(pdf, out_dir, *, timeout_s):
        calls.append(out_dir.name)
        if outcome == "success":
            return {"number of pages": 1, "kids": []}
        if outcome == "other-error":
            raise RuntimeError("unrelated parser failure")
        if outcome == "timeout":
            raise java.JavaTimeout("original timeout")
        if outcome == "budget":
            clock[0] = 61.0
        raise java.JavaPageTreeError("unknown type of page tree node")

    monkeypatch.setattr(java, "run", run)
    if outcome == "success":
        result = refine.parse_pdf(source, tmp_path, java_timeout_s=60)
        assert result.parsed_pdf is None
        assert "java_structure_retry" not in result.phases
    else:
        expected = (
            java.JavaTimeout if outcome in {"timeout", "budget"} else RuntimeError
        )
        with pytest.raises(expected):
            refine.parse_pdf(source, tmp_path, java_timeout_s=60)
    assert calls == (
        ["native", "native-retry"] if outcome == "retry-error" else ["native"]
    )
