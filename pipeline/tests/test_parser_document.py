"""LibreOffice conversion hardening in ``parser/odl/document.py``.

The LibreOffice cases need the parser image (LibreOffice 7.4 at
``/usr/bin/soffice``) and skip elsewhere. Run them there against the working
tree:

    docker build -f parser/Dockerfile --build-arg RELEASE_SHA=$(git rev-parse HEAD) \
      -t capy-parser:test .
    docker run --rm -v "$PWD:/repo:ro" -w /repo capy-parser:test sh -c \
      'pip install --user -q pytest && python -m pytest --noconftest \
       -p no:cacheprovider -q pipeline/tests/test_parser_document.py'
"""

from __future__ import annotations

import http.server
import io
import subprocess
import sys
import threading
import time
import zipfile
from pathlib import Path

import pymupdf
import pytest

PARSER_DIR = Path(__file__).resolve().parents[2] / "parser"
if str(PARSER_DIR) not in sys.path:
    sys.path.insert(0, str(PARSER_DIR))

from odl import document

needs_soffice = pytest.mark.skipif(
    not Path(document.SOFFICE).is_file(), reason="needs LibreOffice (parser image)"
)
needs_linux = pytest.mark.skipif(
    sys.platform != "linux", reason="needs process groups and /proc"
)
ZIP = b"PK\x03\x04"
OLE = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"

_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
_NAMESPACES = (
    'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" '
    f'xmlns:r="{_REL}" '
    'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" '
    'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
    'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"'
)


def _docx(body: str, rels: str = "") -> bytes:
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w") as package:
        package.writestr(
            "[Content_Types].xml",
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Default Extension="rels" '
            'ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            '<Default Extension="xml" ContentType="application/xml"/>'
            '<Override PartName="/word/document.xml" ContentType="application/'
            'vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
            "</Types>",
        )
        package.writestr(
            "_rels/.rels",
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            f'<Relationship Id="rId1" Type="{_REL}/officeDocument" '
            'Target="word/document.xml"/></Relationships>',
        )
        package.writestr(
            "word/_rels/document.xml.rels",
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            f"{rels}</Relationships>",
        )
        package.writestr(
            "word/document.xml",
            f"<w:document {_NAMESPACES}><w:body>{body}</w:body></w:document>",
        )
    return out.getvalue()


def _linked_image(url: str) -> bytes:
    body = (
        "<w:p><w:r><w:drawing><wp:inline>"
        '<wp:extent cx="952500" cy="952500"/><wp:docPr id="1" name="Picture 1"/>'
        "<a:graphic>"
        '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">'
        '<pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="linked.png"/><pic:cNvPicPr/>'
        '</pic:nvPicPr><pic:blipFill><a:blip r:link="rIdImage"/></pic:blipFill>'
        '<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="952500" cy="952500"/>'
        '</a:xfrm><a:prstGeom prst="rect"/></pic:spPr></pic:pic>'
        "</a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>"
    )
    rels = (
        f'<Relationship Id="rIdImage" Type="{_REL}/image" Target="{url}" '
        'TargetMode="External"/>'
    )
    return _docx(body, rels)


def _pdf_text(pdf: bytes) -> str:
    with pymupdf.open(stream=pdf, filetype="pdf") as opened:
        return "".join(page.get_text() for page in opened)


@needs_soffice
def test_linked_image_is_not_fetched(tmp_path: Path) -> None:
    connections: list[tuple[str, int]] = []

    class Listener(http.server.ThreadingHTTPServer):
        def verify_request(self, request, client_address) -> bool:
            connections.append(client_address)
            return True

    server = Listener(("127.0.0.1", 0), http.server.BaseHTTPRequestHandler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        port = server.server_address[1]
        document.normalize_document(
            _linked_image(f"http://127.0.0.1:{port}/linked.png"),
            "linked.docx",
            tmp_path,
        )
    finally:
        server.shutdown()
        server.server_close()
    assert connections == []


@needs_soffice
def test_includetext_does_not_read_a_local_file(tmp_path: Path) -> None:
    target = tmp_path / "target.txt"
    source = tmp_path / "include.docx"
    source.write_bytes(
        _docx(
            '<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r>'
            f'<w:r><w:instrText xml:space="preserve"> INCLUDETEXT "{target.as_uri()}" '
            '</w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>'
            "<w:r><w:t>STORED-RESULT</w:t></w:r>"
            '<w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>'
        )
    )
    # The DOCX importer keeps INCLUDETEXT as its stored result; the .doc
    # importer turns it into a section linked to the file, so save it as .doc.
    subprocess.run(
        [
            document.SOFFICE,
            f"-env:UserInstallation={(tmp_path / 'profile').as_uri()}",
            "--headless",
            "--convert-to",
            "doc",
            "--outdir",
            str(tmp_path),
            str(source),
        ],
        check=True,
        capture_output=True,
        timeout=120,
    )
    target.write_text("SECRET-FILE-TEXT")

    converted = document.normalize_document(
        (tmp_path / "include.doc").read_bytes(), "include.doc", tmp_path
    )

    text = _pdf_text(converted.data)
    assert "STORED-RESULT" in text
    assert "SECRET-FILE-TEXT" not in text


def _running(pid: int) -> bool:
    try:
        stat = Path(f"/proc/{pid}/stat").read_text()
    except FileNotFoundError:
        return False
    return stat.rsplit(")", 1)[1].split()[0] != "Z"


@pytest.mark.parametrize(
    ("name", "data", "detail"),
    [
        ("notes.docx", b"{\\rtf1\\ansi text}", r"not a \.docx document$"),
        # Encrypted OOXML is an OLE2 container.
        ("notes.docx", OLE + bytes(8), "password-protected"),
        ("sheet.xls", ZIP + bytes(8), r"not a \.xls document$"),
    ],
)
def test_bytes_of_another_format_are_refused_before_libreoffice(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    name: str,
    data: bytes,
    detail: str,
) -> None:
    def started(*_args, **_kwargs):
        raise AssertionError("LibreOffice started")

    monkeypatch.setattr(document.subprocess, "Popen", started)
    with pytest.raises(document.OfficeFormatMismatch, match=detail):
        document.normalize_document(data, name, tmp_path)


@needs_linux
@pytest.mark.parametrize(
    ("name", "data", "infilter"),
    [
        ("notes.docx", ZIP, "MS Word 2007 XML"),
        ("sheet.xlsx", ZIP, "Calc MS Excel 2007 XML"),
        ("deck.pptx", ZIP, "Impress MS PowerPoint 2007 XML"),
        ("notes.doc", OLE, "MS Word 97"),
        ("sheet.xls", OLE, "MS Excel 97"),
        ("deck.ppt", OLE, "MS PowerPoint 97"),
    ],
)
def test_libreoffice_imports_through_the_suffix_filter_inside_the_work_dir(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    name: str,
    data: bytes,
    infilter: str,
) -> None:
    seen = tmp_path / "seen"
    launcher = tmp_path / "soffice"
    launcher.write_text(
        f'#!/bin/sh\nprintf "%s\\n" "$MALLOC_ARENA_MAX" "$TMPDIR" "$@" > {seen}\nexit 1\n'
    )
    launcher.chmod(0o755)
    monkeypatch.setattr(document, "SOFFICE", str(launcher))
    work = tmp_path / "work"
    work.mkdir()

    with pytest.raises(document.OfficeConversionFailed):
        document.normalize_document(data, name, work)

    arenas, tmpdir, *argv = seen.read_text().splitlines()
    assert f"--infilter={infilter}" in argv
    # Two malloc arenas, so it fits the parse child's address-space limit.
    assert arenas == "2"
    # LibreOffice's temporary files and output share the job directory in the
    # work dir, which goes with the job.
    job = Path(tmpdir)
    assert job.parent == work and job.name.startswith("capy_office_")
    assert argv[argv.index("--outdir") + 1] == tmpdir
    assert not job.exists()


@needs_linux
def test_timeout_kills_the_whole_process_group(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # A launcher whose child outlives it, as soffice.bin outlives soffice.
    helper_pid = tmp_path / "helper.pid"
    launcher = tmp_path / "soffice"
    launcher.write_text(
        "#!/bin/sh\n"
        "sleep 600 </dev/null >/dev/null 2>&1 &\n"
        f"echo $! > {helper_pid}\n"
        "wait\n"
    )
    launcher.chmod(0o755)
    monkeypatch.setattr(document, "SOFFICE", str(launcher))
    monkeypatch.setattr(document, "OFFICE_CONVERT_TIMEOUT_S", 1)

    with pytest.raises(document.OfficeConversionTimeout, match="exceeded 1 seconds"):
        document.normalize_document(ZIP + b"office", "slow.docx", tmp_path)

    helper = int(helper_pid.read_text())
    deadline = time.monotonic() + 5
    while _running(helper) and time.monotonic() < deadline:
        time.sleep(0.05)
    assert not _running(helper)


def test_unreadable_pdfs_are_refused_and_owner_locked_ones_open() -> None:
    with pymupdf.open() as blank:
        blank.new_page()
        plain = blank.tobytes()
        locked = blank.tobytes(
            encryption=pymupdf.PDF_ENCRYPT_AES_256, user_pw="open", owner_pw="own"
        )
        owner_only = blank.tobytes(
            encryption=pymupdf.PDF_ENCRYPT_AES_256, owner_pw="own"
        )

    assert document.pdf_page_count(plain) == 1
    assert document.pdf_page_count(owner_only) == 1
    with pytest.raises(document.SourceUnreadable, match="password"):
        document.pdf_page_count(locked)
    with pytest.raises(document.SourceUnreadable, match="not a readable PDF"):
        document.pdf_page_count(b"%PDF-1.7 truncated")
