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

_ZIP = b"PK\x03\x04"
_OLE = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"
# Each Office suffix converts only from its own container, through its own
# LibreOffice import filter rather than LibreOffice's type detection.
_IMPORTS = {
    ".docx": (_ZIP, "MS Word 2007 XML"),
    ".xlsx": (_ZIP, "Calc MS Excel 2007 XML"),
    ".pptx": (_ZIP, "Impress MS PowerPoint 2007 XML"),
    ".doc": (_OLE, "MS Word 97"),
    ".xls": (_OLE, "MS Excel 97"),
    ".ppt": (_OLE, "MS PowerPoint 97"),
}
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


class SourceUnreadable(ValueError):
    """The source fails on every attempt: corrupt, password-protected,
    unsupported, or refused by LibreOffice. The parse answers it at once
    instead of spending the job's retry."""


class OfficeFormatMismatch(ValueError):
    """The bytes are not the container the file's suffix names."""


class OfficeConversionFailed(SourceUnreadable):
    """LibreOffice ended without a PDF (the parse supervisor counts it as an OOM
    kill when the cgroup's ``oom_kill`` count rose meanwhile)."""


@dataclass(frozen=True)
class NormalizedDocument:
    data: bytes
    name: str
    source_format: str
    preview_pdf: bytes | None = None


def normalize_document(data: bytes, name: str, work_dir: Path) -> NormalizedDocument:
    """Return the PDF bytes the parser reads and the exact Office citation PDF.

    The conversion's job directory sits in ``work_dir`` (the parse child's slot
    directory, on disk), so a killed conversion's files go with the slot.
    """
    suffix = Path(name).suffix.lower()
    if not suffix and data.lstrip().startswith(b"%PDF"):
        suffix = ".pdf"
    if suffix == ".pdf":
        return NormalizedDocument(data, name or "document.pdf", "pdf")
    if suffix not in _IMPORTS:
        raise SourceUnreadable("document parsing supports PDF and Office files")
    magic, import_filter = _IMPORTS[suffix]
    if not data.startswith(magic):
        detail = f"the file's contents are not a {suffix} document"
        if magic == _ZIP and data.startswith(_OLE):
            detail += " (password-protected files can't be read)"
        raise OfficeFormatMismatch(detail)

    # The profile and LibreOffice's own temporary files live in the job
    # directory, so they go with the job.
    with tempfile.TemporaryDirectory(prefix="capy_office_", dir=work_dir) as tmp_name:
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
                f"--infilter={import_filter}",
                "--convert-to",
                "pdf",
                "--outdir",
                str(tmp),
                str(source),
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env={**os.environ, "TMPDIR": tmp_name},
            # Its own group for the timeout kill below, inside the parse
            # child's session so ending a parse child ends LibreOffice too.
            process_group=0,
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
            raise OfficeConversionFailed(
                f"LibreOffice could not convert {suffix}: {detail[:500]}"
            )
        if rendered.stat().st_size > OFFICE_PREVIEW_MAX_BYTES:
            raise SourceUnreadable(
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
    """Pages of a PDF the parse can read. An owner-password-only PDF opens and
    counts; one that needs a password to open does not."""
    try:
        document = pymupdf.open(stream=data, filetype="pdf")
    except Exception as exc:  # MuPDF raises several types for broken bytes
        raise SourceUnreadable(f"the file is not a readable PDF: {exc}") from exc
    with document:
        if document.needs_pass:
            raise SourceUnreadable("the PDF is password-protected")
        if not len(document):
            raise SourceUnreadable("the PDF has no pages")
        return len(document)
