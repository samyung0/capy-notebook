"""Legacy Office to OOXML in a parser image's LibreOffice sandbox, then both
sides to PDF (the parser's own conversion) to compare pages and words.

Runs inside the parser image (bench/parsers/README.md has the container): reads
/in/*.doc|xls|ppt, works in /work, keeps the converted files in /out and prints
a row a file. It builds the conversion command itself, so it also runs in an
image from before the parser had ``convert_legacy``."""

import json
import re
import tempfile
import time
import zipfile
from collections import Counter
from io import BytesIO
from pathlib import Path

import pymupdf
from odl import document

EXPORT = {
    ".doc": ("docx", "MS Word 2007 XML"),
    ".xls": ("xlsx", "Calc MS Excel 2007 XML"),
    ".ppt": ("pptx", "Impress MS PowerPoint 2007 XML"),
}
WORK, OUT = Path("/work"), Path("/out")


def to_ooxml(data: bytes, suffix: str) -> bytes:
    new, export = EXPORT[suffix]
    _, import_filter = document._IMPORTS[suffix]
    with tempfile.TemporaryDirectory(prefix="lo-", dir=WORK) as name:
        tmp = Path(name)
        source = tmp / f"source{suffix}"
        source.write_bytes(data)
        profile = tmp / "profile"
        (profile / "user").mkdir(parents=True)
        (profile / "user" / "registrymodifications.xcu").write_text(document._REGISTRY)
        command = [
            document.SOFFICE,
            f"-env:UserInstallation={profile.as_uri()}",
            f"-env:OSL_SOCKET_PATH={tmp}",
            "--headless", "--nologo", "--nodefault", "--nolockcheck", "--nofirststartwizard",
            f"--infilter={import_filter}",
            "--convert-to", f"{new}:{export}",
            "--outdir", str(tmp), str(source),
        ]
        done = document._convert(command, tmp, 180)
        if done.returncode == document._PROFILE_CREATED_EXIT:
            done = document._convert(command, tmp, 180)
        out = tmp / f"source.{new}"
        if done.returncode != 0 or not out.is_file():
            detail = (done.stderr or done.stdout or b"").decode(errors="replace")
            raise RuntimeError(f"exit {done.returncode}: {detail[:300]}")
        return out.read_bytes()


def words(pdf: bytes) -> tuple[int, Counter]:
    doc = pymupdf.open(stream=pdf, filetype="pdf")
    return doc.page_count, Counter(re.findall(r"\w+", " ".join(p.get_text() for p in doc)))


for path in sorted(Path("/in").iterdir()):
    suffix = path.suffix.lower()
    if suffix not in EXPORT:
        continue
    row = {"file": path.name, "bytes": path.stat().st_size}
    data = path.read_bytes()
    try:
        t = time.monotonic()
        old_pdf = document.normalize_document(data, path.name, WORK).data
        row["old_to_pdf_s"] = round(time.monotonic() - t, 1)
        t = time.monotonic()
        new = to_ooxml(data, suffix)
        row["convert_s"] = round(time.monotonic() - t, 1)
        new_name = f"{path.stem}.{EXPORT[suffix][0]}"
        (OUT / new_name).write_bytes(new)
        entries = zipfile.ZipFile(BytesIO(new)).namelist()
        row["new_bytes"] = len(new)
        row["media"] = sum("/media/" in e for e in entries)
        t = time.monotonic()
        new_pdf = document.normalize_document(new, new_name, WORK).data
        row["new_to_pdf_s"] = round(time.monotonic() - t, 1)
        (pa, wa), (pb, wb) = words(old_pdf), words(new_pdf)
        row["pages"] = [pa, pb]
        row["words"] = [sum(wa.values()), sum(wb.values())]
        row["words_shared"] = sum((wa & wb).values())
    except Exception as exc:  # the row says what failed
        row["error"] = f"{type(exc).__name__}: {exc}"[:400]
    print(json.dumps(row, ensure_ascii=False), flush=True)
