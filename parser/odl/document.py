"""Source normalisation: PDFs pass through, Office files become the exact
LibreOffice PDF that is both parsed and published as the citation preview."""

from __future__ import annotations

import os
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path

import pymupdf

OFFICE_SUFFIXES = frozenset({".doc", ".docx", ".ppt", ".pptx", ".xls", ".xlsx"})
OFFICE_PREVIEW_MAX_BYTES = int(
    os.environ.get("CAPY_OFFICE_PREVIEW_MAX_BYTES", str(128 << 20))
)


@dataclass(frozen=True)
class NormalizedDocument:
    data: bytes
    name: str
    source_format: str
    preview_pdf: bytes | None = None


def normalize_document(data: bytes, name: str) -> NormalizedDocument:
    """Return the PDF bytes the parser reads and the exact Office citation PDF."""
    suffix = Path(name).suffix.lower()
    if not suffix and data.lstrip().startswith(b"%PDF"):
        suffix = ".pdf"
    if suffix == ".pdf":
        return NormalizedDocument(data, name or "document.pdf", "pdf")
    if suffix not in OFFICE_SUFFIXES:
        raise ValueError("document parsing supports PDF and Office files")

    timeout = max(30, int(os.environ.get("CAPY_OFFICE_CONVERT_TIMEOUT", "180")))
    with tempfile.TemporaryDirectory(prefix="capy_office_") as tmp_name:
        tmp = Path(tmp_name)
        source = tmp / f"source{suffix}"
        source.write_bytes(data)
        completed = subprocess.run(
            [
                "/usr/bin/soffice",
                "--headless",
                "--nologo",
                "--nodefault",
                "--nolockcheck",
                "--nofirststartwizard",
                "--convert-to",
                "pdf",
                "--outdir",
                str(tmp),
                str(source),
            ],
            check=False,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        rendered = tmp / "source.pdf"
        if completed.returncode != 0 or not rendered.is_file():
            detail = (
                completed.stderr or completed.stdout or "conversion failed"
            ).strip()
            raise RuntimeError(
                f"LibreOffice could not convert {suffix}: {detail[:500]}"
            )
        if rendered.stat().st_size > OFFICE_PREVIEW_MAX_BYTES:
            raise RuntimeError(
                "LibreOffice PDF exceeds the "
                f"{OFFICE_PREVIEW_MAX_BYTES}-byte preview limit"
            )
        pdf = rendered.read_bytes()
    return NormalizedDocument(
        pdf,
        f"{Path(name).stem or 'document'}.pdf",
        suffix.lstrip("."),
        preview_pdf=pdf,
    )


def pdf_page_count(data: bytes) -> int:
    with pymupdf.open(stream=data, filetype="pdf") as document:
        return len(document)
