"""Source normalisation: PDFs pass through, Office files become the exact
LibreOffice PDF that is both parsed and published as the citation preview."""

from __future__ import annotations

import os
import subprocess
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path

import capy_sandbox
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
# A PowerPoint file's PDF keeps its hidden slides, so page N of the parse and
# of the citation preview is slide N as the agent's reads number them (Epo
# 2026-10-24, Q276; files parsed before keep their pages). LibreOffice 7.4
# takes the export filter's options as JSON after its name.
_HIDDEN_SLIDES = (
    'pdf:impress_pdf_Export:{"ExportHiddenSlides":{"type":"boolean","value":"true"}}'
)
_PDF_EXPORT = {".pptx": _HIDDEN_SLIDES, ".ppt": _HIDDEN_SLIDES}
OFFICE_PREVIEW_MAX_BYTES = int(
    os.environ.get("CAPY_OFFICE_PREVIEW_MAX_BYTES", str(128 << 20))
)
OFFICE_CONVERT_TIMEOUT_S = max(
    30, int(os.environ.get("CAPY_OFFICE_CONVERT_TIMEOUT", "180"))
)
# LibreOffice itself, not its launcher scripts, so the conversion runs with
# process creation denied (capy_sandbox).
SOFFICE = "/usr/lib/libreoffice/program/soffice.bin"
# soffice.bin exits with this once it has set up a fresh profile (every job's
# is fresh); its launcher would start it again, so the conversion runs again.
_PROFILE_CREATED_EXIT = 81
# Each conversion's job folder in its parse child's slot folder; short, so its
# IPC pipe's path fits a Unix socket address (``check_pipe_path``).
_JOB_PREFIX = "lo-"
# A Unix socket path holds 107 bytes; LibreOffice names its pipe
# OSL_PIPE_<uid>_SingleOfficeIPC_<MD5 hex, at most 32 characters>.
_SOCKET_PATH_MAX = 107
# What LibreOffice reads besides its job folder: libraries, configuration,
# fonts and the random device.
READ = (
    "/usr",
    "/lib",
    "/lib64",
    "/etc",
    "/var/cache/fontconfig",
    "/dev/urandom",
    "/dev/random",
)
# Per conversion (bench/parsers S0 measurements: at most 47.5 s of CPU and 21
# descriptors per process); the address space is the parse child's soft
# 2 GiB, inherited.
_LIMITS = {"CPU": 180, "NOFILE": 256, "FSIZE": 256 << 20, "CORE": 0}

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


class OfficeConversionTimeout(RuntimeError):
    """LibreOffice ran past its timeout: final like the parse deadline (or an
    OOM kill, when the cgroup's ``oom_kill`` count rose meanwhile)."""


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

    # The profile, LibreOffice's own temporary files and its IPC pipe live in
    # the job directory, so they go with the job. LibreOffice puts the pipe in
    # /tmp or /var/tmp when it may write there (the image lets it write
    # neither), else in OSL_SOCKET_PATH (``check_pipe_path``).
    with tempfile.TemporaryDirectory(prefix=_JOB_PREFIX, dir=work_dir) as tmp_name:
        tmp = Path(tmp_name)
        source = tmp / f"source{suffix}"
        source.write_bytes(data)
        profile = tmp / "profile"
        (profile / "user").mkdir(parents=True)
        (profile / "user" / "registrymodifications.xcu").write_text(
            _REGISTRY, encoding="utf-8"
        )
        command = [
            SOFFICE,
            f"-env:UserInstallation={profile.as_uri()}",
            f"-env:OSL_SOCKET_PATH={tmp}",
            "--headless",
            "--nologo",
            "--nodefault",
            "--nolockcheck",
            "--nofirststartwizard",
            f"--infilter={import_filter}",
            "--convert-to",
            _PDF_EXPORT.get(suffix, "pdf"),
            "--outdir",
            str(tmp),
            str(source),
        ]
        deadline = time.monotonic() + OFFICE_CONVERT_TIMEOUT_S
        try:
            completed = _convert(command, tmp, OFFICE_CONVERT_TIMEOUT_S)
            if completed.returncode == _PROFILE_CREATED_EXIT:
                completed = _convert(command, tmp, deadline - time.monotonic())
        except subprocess.TimeoutExpired:
            raise OfficeConversionTimeout(
                f"LibreOffice conversion exceeded {OFFICE_CONVERT_TIMEOUT_S} seconds"
            ) from None
        rendered = tmp / "source.pdf"
        if completed.returncode != 0 or not rendered.is_file():
            detail = (
                (completed.stderr or completed.stdout or b"conversion failed")
                .decode(errors="replace")
                .strip()
            )
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


def check_pipe_path(work_dir: Path) -> None:
    """Refuse a work folder whose job folders cannot hold LibreOffice's IPC
    pipe. It goes there (OSL_SOCKET_PATH) only when LibreOffice may write
    neither /tmp nor /var/tmp, as in the parser image."""
    if os.access("/tmp", os.W_OK) or os.access("/var/tmp", os.W_OK):
        return
    uid = os.getuid() if hasattr(os, "getuid") else 0
    pipe = (
        work_dir
        / f"{_JOB_PREFIX}{'x' * 8}"
        / f"OSL_PIPE_{uid}_SingleOfficeIPC_{'0' * 32}"
    )
    excess = len(os.fsencode(pipe)) - _SOCKET_PATH_MAX
    if excess > 0:
        raise RuntimeError(
            f"CAPY_PARSE_WORK_DIR is {excess} bytes too long: LibreOffice's IPC "
            f"pipe in a job folder there would pass the {_SOCKET_PATH_MAX}-byte "
            "Unix socket path"
        )


def _convert(
    command: list[str], job: Path, timeout_s: float
) -> subprocess.CompletedProcess[bytes]:
    """One soffice.bin run under the sandbox: files only in its job folder,
    no network or new processes, and its own process group inside the parse
    child's session, killed whole at the timeout."""
    if timeout_s <= 0:
        raise subprocess.TimeoutExpired(command, OFFICE_CONVERT_TIMEOUT_S)
    environment = {
        key: os.environ[key] for key in ("PATH", "LANG") if key in os.environ
    }
    policy = capy_sandbox.Policy(
        limits=_LIMITS,
        blocked=frozenset({"setsid", "setpgid", "fork"}),
        read=(*READ, SOFFICE),
        write=(str(job), "/dev/null"),
        # Two malloc arenas: LibreOffice then fits the parse child's
        # address-space limit (2.18 GiB of address space for a 224k-cell
        # workbook, 0.52 GiB with two).
        env={
            **environment,
            "HOME": str(job),
            "TMPDIR": str(job),
            "MALLOC_ARENA_MAX": "2",
        },
        timeout_s=timeout_s,
    )
    return capy_sandbox.run(command, policy, max_output=None)


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
