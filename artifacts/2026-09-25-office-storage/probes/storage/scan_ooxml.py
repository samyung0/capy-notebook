"""List package parts and count opaque DOCX run objects in Office files.

Usage: python scan_ooxml.py file1 [file2 ...]
Prints part sizes grouped by folder and, for DOCX, the byte size of every
w:drawing / mc:AlternateContent / w:pict / w:object element in the main
document part plus headers/footers/footnotes.
"""

import re
import sys
import zipfile
from collections import defaultdict

OPAQUE = {
    "mc:AlternateContent": re.compile(
        rb"<mc:AlternateContent\b.*?</mc:AlternateContent>", re.DOTALL
    ),
    "w:pict": re.compile(rb"<w:pict\b.*?</w:pict>", re.DOTALL),
    "w:object": re.compile(rb"<w:object\b.*?</w:object>", re.DOTALL),
    "w:drawing": re.compile(rb"<w:drawing\b.*?</w:drawing>", re.DOTALL),
}


def classify_drawing(xml: bytes) -> str:
    if b"<c:chart" in xml or b"drawingml/2006/chart" in xml:
        return "chart"
    if b"<pic:pic" in xml:
        return "picture"
    if b"<wps:wsp" in xml:
        return "shape"
    if b"<wpg:wgp" in xml:
        return "group"
    if b"<wpc:wpc" in xml:
        return "canvas"
    if b"<dgm:" in xml or b"drawingml/2006/diagram" in xml:
        return "smartart"
    return "other"


def scan(path: str) -> None:
    z = zipfile.ZipFile(path)
    total = sum(i.file_size for i in z.infolist())
    print(
        f"== {path}  zip={sum(i.compress_size for i in z.infolist())} expanded={total}"
    )
    groups = defaultdict(lambda: [0, 0, 0])
    for info in z.infolist():
        folder = info.filename.rsplit("/", 1)[0] if "/" in info.filename else "."
        g = groups[folder]
        g[0] += 1
        g[1] += info.file_size
        g[2] += info.compress_size
    for folder, (n, size, comp) in sorted(groups.items()):
        print(f"   {folder:40s} parts={n:4d} expanded={size:10d} compressed={comp:10d}")
    if not path.lower().endswith(".docx"):
        return
    stories = [
        n
        for n in z.namelist()
        if re.match(
            r"word/(document|header\d*|footer\d*|footnotes|endnotes|comments)\.xml$", n
        )
    ]
    for name in stories:
        xml = z.read(name)
        found = []
        # AlternateContent wraps drawings; count it first and blank it so the
        # inner w:drawing is not double counted.
        rest = xml
        for tag in ("mc:AlternateContent", "w:object", "w:pict"):
            for m in OPAQUE[tag].finditer(rest):
                found.append((tag, len(m.group(0)), classify_drawing(m.group(0))))
            rest = OPAQUE[tag].sub(b"", rest)
        for m in OPAQUE["w:drawing"].finditer(rest):
            found.append(("w:drawing", len(m.group(0)), classify_drawing(m.group(0))))
        if not found:
            continue
        summary = defaultdict(lambda: [0, 0])
        for tag, size, kind in found:
            summary[(tag, kind)][0] += 1
            summary[(tag, kind)][1] += size
        for (tag, kind), (n, size) in sorted(summary.items()):
            print(f"   {name}: {tag}[{kind}] count={n} xml_bytes={size}")


if __name__ == "__main__":
    for p in sys.argv[1:]:
        scan(p)
