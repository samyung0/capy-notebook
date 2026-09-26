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
def test_linked_image_is_not_fetched() -> None:
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
            _linked_image(f"http://127.0.0.1:{port}/linked.png"), "linked.docx"
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
        (tmp_path / "include.doc").read_bytes(), "include.doc"
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


@pytest.mark.skipif(sys.platform != "linux", reason="needs process groups and /proc")
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

    with pytest.raises(subprocess.TimeoutExpired):
        document.normalize_document(b"office", "slow.docx")

    helper = int(helper_pid.read_text())
    deadline = time.monotonic() + 5
    while _running(helper) and time.monotonic() < deadline:
        time.sleep(0.05)
    assert not _running(helper)
