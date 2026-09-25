"""Source normalisation: PDFs pass through, Office files become the exact
LibreOffice PDF that is both parsed and published as the citation preview."""

from __future__ import annotations

import os
import signal
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path

import pymupdf

OFFICE_SUFFIXES = frozenset({".doc", ".docx", ".ppt", ".pptx", ".xls", ".xlsx"})
OFFICE_PREVIEW_MAX_BYTES = int(
    os.environ.get("CAPY_OFFICE_PREVIEW_MAX_BYTES", str(128 << 20))
)
OFFICE_CONVERT_TIMEOUT_S = max(
    30, int(os.environ.get("CAPY_OFFICE_CONVERT_TIMEOUT", "180"))
)
SOFFICE = "/usr/bin/soffice"

# Each job's fresh LibreOffice profile (7.4 schema): no link loads from
# documents outside trusted locations (there are none), macros off at the
# highest security level, link updates never. Writer's code reads 0 as never
# (sw/inc/linkenum.hxx) whatever its schema text says; Calc's never is 1.
_PROFILE_SETTINGS = (
    ("Common/Security/Scripting", "BlockUntrustedRefererLinks", "true"),
    ("Common/Security/Scripting", "DisableMacrosExecution", "true"),
    ("Common/Security/Scripting", "MacroSecurityLevel", "3"),
    ("Writer/Content/Update", "Link", "0"),
    ("Calc/Content/Update", "Link", "1"),
)
_REGISTRY = (
    '<?xml version="1.0" encoding="UTF-8"?>\n'
    '<oor:items xmlns:oor="http://openoffice.org/2001/registry">\n'
    + "".join(
        f'<item oor:path="/org.openoffice.Office.{path}"><prop oor:name="{name}" '
        f'oor:op="fuse"><value>{value}</value></prop></item>\n'
        for path, name, value in _PROFILE_SETTINGS
    )
    + "</oor:items>\n"
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

    # The profile lives in the job directory, so it goes with the job.
    with tempfile.TemporaryDirectory(prefix="capy_office_") as tmp_name:
        tmp = Path(tmp_name)
        source = tmp / f"source{suffix}"
        source.write_bytes(data)
        profile = tmp / "profile"
        (profile / "user").mkdir(parents=True)
        (profile / "user" / "registrymodifications.xcu").write_text(
            _REGISTRY, encoding="utf-8"
        )
        process = subprocess.Popen(
            [
                SOFFICE,
                f"-env:UserInstallation={profile.as_uri()}",
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
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            start_new_session=True,
        )
        try:
            stdout, stderr = process.communicate(timeout=OFFICE_CONVERT_TIMEOUT_S)
        except subprocess.TimeoutExpired:
            # soffice.bin outlives its killed launcher; end the whole group.
            os.killpg(process.pid, signal.SIGKILL)
            process.communicate()
            raise
        rendered = tmp / "source.pdf"
        if process.returncode != 0 or not rendered.is_file():
            detail = (stderr or stdout or "conversion failed").strip()
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
