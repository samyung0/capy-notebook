"""Turn a parsed textbook's document.md into clean HTML for a Word-like DOCX.

"# Chapter N" + "## Title" becomes h1, numbered sections h2/h3 by depth,
"Exercises" h4; running heads, bare folios, the front matter and images are
dropped; lists become <ul>; well-formed tables pass through. Writes book.html
(chapters 1..end) and chapter.html (chapter 2 only) for a mid-size case.
"""

import html
import re
import sys
from pathlib import Path

src = Path(sys.argv[1])
out = Path(sys.argv[2])
lines = src.read_text(encoding="utf-8").splitlines()

RUNNING = [
    re.compile(
        r"^#+\s+\d+\s+(CHAPTER\s+\d+\.|APPENDIX\s+[A-Z]\.|TABLE OF CONTENTS|INDEX)"
    ),
    re.compile(r"^#+\s+\d+(\.\d+)*\.\s+[^a-z]+\s+\d+\s*$"),
    re.compile(r"^#+\s+\d+\s*$"),
]
SECTION = re.compile(r"^#+\s+(\d+\.\d+(?:\.\d+)?)\s+(.+?)\s*$")
CHAPTER = re.compile(r"^#\s+Chapter\s+(\d+)\s*$")
FOLIO = re.compile(r"^\d{1,4}$")

body: list[str] = []
chapter_starts: list[int] = []
in_table = False
table: list[str] = []
list_open = False
started = False
pending_chapter = None


def close_list():
    global list_open
    if list_open:
        body.append("</ul>")
        list_open = False


for raw in lines:
    line = raw.rstrip()
    m = CHAPTER.match(line)
    if m:
        started = True
        close_list()
        pending_chapter = m.group(1)
        continue
    if not started:
        continue
    if pending_chapter is not None and line.startswith("## "):
        chapter_starts.append(len(body))
        body.append(
            f'<h1 style="page-break-before: always">Chapter {pending_chapter}: {html.escape(line[3:].strip())}</h1>'
        )
        pending_chapter = None
        continue
    if in_table:
        table.append(line)
        if "</table>" in line:
            in_table = False
            block = "\n".join(table)
            if "&lt;td&gt;" not in block and "<td" in block:
                body.append(block)
            table = []
        continue
    if line.lstrip().startswith("<table"):
        close_list()
        in_table = True
        table = [line]
        if "</table>" in line:
            in_table = False
            if "&lt;td&gt;" not in line and "<td" in line:
                body.append(line)
            table = []
        continue
    if not line.strip() or line.startswith("![") or FOLIO.match(line.strip()):
        continue
    if any(p.match(line) for p in RUNNING):
        continue
    m = SECTION.match(line)
    if m and len(m.group(2).split()) > 10:
        m = None
        close_list()
        body.append(f"<p>{html.escape(line.lstrip('#').strip())}</p>")
        continue
    if m:
        close_list()
        depth = 2 if m.group(1).count(".") == 1 else 3
        body.append(
            f"<h{depth}>{html.escape(m.group(1) + ' ' + m.group(2))}</h{depth}>"
        )
        continue
    if line.startswith("#"):
        close_list()
        title = line.lstrip("#").strip()
        if title.lower() in {"exercises", "chapter exercises", "review exercises"}:
            body.append(f"<h4>{html.escape(title)}</h4>")
        else:
            body.append(f"<p><b>{html.escape(title)}</b></p>")
        continue
    if line.lstrip().startswith("- "):
        if not list_open:
            body.append("<ul>")
            list_open = True
        body.append(f"<li>{html.escape(line.lstrip()[2:])}</li>")
        continue
    close_list()
    body.append(f"<p>{html.escape(line)}</p>")
close_list()

head = (
    '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Book</title></head><body>'
)
tail = "</body></html>"
out.mkdir(parents=True, exist_ok=True)
(out / "book.html").write_text(head + "\n".join(body) + tail, encoding="utf-8")
if len(chapter_starts) >= 3:
    a, b = chapter_starts[1], chapter_starts[2]
    (out / "chapter.html").write_text(
        head + "\n".join(body[a:b]) + tail, encoding="utf-8"
    )
words = sum(len(re.sub(r"<[^>]+>", " ", x).split()) for x in body)
print("blocks", len(body), "chapters", len(chapter_starts), "words", words)
