"""Visible text of an Office file per story, and the text diff of two files.

  python ootext.py text <file>            JSON {story: [paragraph text, ...]}
  python ootext.py diff <before> <after>  JSON [{story, op, index, before, after}]
  python ootext.py same <a> <b>           JSON {same: bool, stories: [differing story]}

Stories: DOCX `body`, `header1.xml`, `footnotes`, `comments`, ... (tables are
paragraphs of their story; tracked deletions are left out, as a reader sees
them); PPTX `slide:<n>` in presentation order plus `notes:<n>`; XLSX
`sheet:<name>` with one "A1=value" line per non-empty cell (formulas as
`A1==SUM(...)` before their cached value).
"""

import difflib
import json
import posixpath
import re
import sys
import zipfile
from xml.etree import ElementTree as ET

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
A = "{http://schemas.openxmlformats.org/drawingml/2006/main}"
P = "{http://schemas.openxmlformats.org/presentationml/2006/main}"
R = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
PR = "{http://schemas.openxmlformats.org/package/2006/relationships}"
X = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"


def docx_paragraph(p):
    out = []
    for node in p.iter():
        tag = node.tag
        if tag == W + "t":
            out.append(node.text or "")
        elif tag == W + "tab":
            out.append("\t")
        elif tag in (W + "br", W + "cr"):
            out.append("\n")
        elif tag == W + "noBreakHyphen":
            out.append("-")
    return "".join(out)


def docx_stories(z):
    names = z.namelist()
    parts = {"body": "word/document.xml"}
    for name in names:
        m = re.match(r"word/((header|footer)\d*\.xml)$", name)
        if m:
            parts[m.group(1)] = name
    for story in ("footnotes", "endnotes", "comments"):
        if f"word/{story}.xml" in names:
            parts[story] = f"word/{story}.xml"
    stories = {}
    for story, part in parts.items():
        root = ET.fromstring(z.read(part))
        # Text inside deletions is not visible text.
        for parent in list(root.iter()):
            for child in list(parent):
                if child.tag in (W + "del", W + "moveFrom"):
                    parent.remove(child)
        stories[story] = [docx_paragraph(p) for p in root.iter(W + "p")]
    return stories


def rels(z, part):
    folder, name = posixpath.split(part)
    path = posixpath.join(folder, "_rels", name + ".rels")
    if path not in z.namelist():
        return {}
    root = ET.fromstring(z.read(path))
    out = {}
    for r in root.iter(PR + "Relationship"):
        target = r.get("Target") or ""
        if r.get("TargetMode") == "External":
            continue
        out[r.get("Id")] = (
            target.lstrip("/") if target.startswith("/") else posixpath.normpath(posixpath.join(folder, target))
        )
    return out


def drawing_paragraphs(root):
    return ["".join(t.text or "" for t in p.iter(A + "t")) for p in root.iter(A + "p")]


def pptx_stories(z):
    pres = ET.fromstring(z.read("ppt/presentation.xml"))
    pres_rels = rels(z, "ppt/presentation.xml")
    stories = {}
    for n, sld in enumerate(pres.iter(P + "sldId"), 1):
        part = pres_rels[sld.get(R + "id")]
        stories[f"slide:{n}"] = drawing_paragraphs(ET.fromstring(z.read(part)))
        for target in rels(z, part).values():
            if "notesSlide" in target and target in z.namelist():
                notes = ET.fromstring(z.read(target))
                body = []
                for sp in notes.iter(P + "sp"):
                    ph = sp.find(f"{P}nvSpPr/{P}nvPr/{P}ph")
                    if ph is not None and ph.get("type") == "body":
                        body += drawing_paragraphs(sp)
                stories[f"notes:{n}"] = body
    return stories


def xlsx_stories(z):
    names = z.namelist()
    shared = []
    if "xl/sharedStrings.xml" in names:
        for si in ET.fromstring(z.read("xl/sharedStrings.xml")).iter(X + "si"):
            shared.append("".join(t.text or "" for t in si.iter(X + "t")))
    book = ET.fromstring(z.read("xl/workbook.xml"))
    book_rels = rels(z, "xl/workbook.xml")
    stories = {}
    for sheet in book.iter(X + "sheet"):
        part = book_rels[sheet.get(R + "id")]
        lines = []
        for c in ET.fromstring(z.read(part)).iter(X + "c"):
            ref, kind = c.get("r"), c.get("t")
            f, v = c.find(X + "f"), c.find(X + "v")
            value = v.text if v is not None and v.text is not None else ""
            if kind == "s" and value:
                value = shared[int(value)]
            elif kind == "inlineStr":
                value = "".join(t.text or "" for t in c.iter(X + "t"))
            formula = f.text if f is not None and f.text else ""
            if value or formula:
                lines.append(f"{ref}=" + (f"={formula} -> " if formula else "") + value)
        stories[f"sheet:{sheet.get('name')}"] = lines
    return stories


def stories(path):
    with zipfile.ZipFile(path) as z:
        names = z.namelist()
        if "word/document.xml" in names:
            return docx_stories(z)
        if "ppt/presentation.xml" in names:
            return pptx_stories(z)
        return xlsx_stories(z)


def diff(before, after):
    out = []
    for story in list(before) + [s for s in after if s not in before]:
        a, b = before.get(story, []), after.get(story, [])
        if a == b:
            continue
        if story not in before or story not in after:
            out.append({"story": story, "op": "insert" if story not in before else "delete",
                        "before": a or None, "after": b or None})
            continue
        for tag, i1, i2, j1, j2 in difflib.SequenceMatcher(None, a, b, autojunk=False).get_opcodes():
            if tag == "equal":
                continue
            if tag == "replace" and i2 - i1 == j2 - j1:
                for k in range(i2 - i1):
                    out.append({"story": story, "op": "update", "index": i1 + k,
                                "before": a[i1 + k], "after": b[j1 + k]})
                continue
            out.append({"story": story, "op": {"insert": "insert", "delete": "delete"}.get(tag, "replace"),
                        "index": i1, "before": a[i1:i2] or None, "after": b[j1:j2] or None})
    return out


def main():
    command, *args = sys.argv[1:]
    if command == "text":
        result = stories(args[0])
    elif command == "diff":
        result = diff(stories(args[0]), stories(args[1]))
    elif command == "same":
        a, b = stories(args[0]), stories(args[1])
        differing = sorted(s for s in set(a) | set(b) if a.get(s) != b.get(s))
        result = {"same": not differing, "stories": differing}
    else:
        raise SystemExit(__doc__)
    sys.stdout.write(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
