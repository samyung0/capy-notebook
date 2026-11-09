"""Write COVERAGE.md: books, excerpts and figures per area and subject, from the
live library, plus what the builder holds unadmitted. Rerun after publishing.

  python lab/knowledge/coverage.py   (needs the library tunnel on 15433)

A book is counted once, under the subject most of its tagged excerpts carry.
Figures exclude decorative records and rights exclusions.
"""

from __future__ import annotations

import collections
import datetime
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT / "bench/rag/scripts"), str(ROOT / "lab/knowledge")]
import knowledge_base_library as library  # noqa: E402
import store  # noqa: E402

BOOKS = """
SELECT b.id, b.title, b.pages,
  (SELECT count(*) FROM library_excerpts e WHERE e.content_id = b.content_id AND e.tag_status = 'tagged'),
  (SELECT count(*) FROM library_figures f WHERE f.content_id = b.content_id
     AND NOT coalesce(f.decorative, false) AND NOT coalesce(f.excluded, false))
FROM library_books b
"""
SUBJECT_OF_BOOK = """
WITH tagged AS (
  SELECT e.book_id, t.subject_id, count(DISTINCT e.id) AS n
  FROM library_excerpts e
  JOIN library_books b ON b.content_id = e.content_id
  CROSS JOIN unnest(e.topic_ids) AS x(topic_id)
  JOIN library_topics t ON t.id = x.topic_id
  WHERE e.tag_status = 'tagged'
  GROUP BY 1, 2)
SELECT DISTINCT ON (book_id) book_id, subject_id FROM tagged ORDER BY book_id, n DESC
"""


def main() -> None:
    with library.connect() as conn:
        books = conn.execute(BOOKS).fetchall()
        subject_of = dict(conn.execute(SUBJECT_OF_BOOK).fetchall())
        subjects = conn.execute("SELECT id, area, label FROM library_subjects").fetchall()
    held = collections.defaultdict(list)
    for book in books:
        held[subject_of.get(book[0])].append(book)
    sums = lambda rows: [len(rows), *(sum(r[i] or 0 for r in rows) for i in (2, 3, 4))]  # noqa: E731
    label = {s[0]: s[2] for s in subjects}
    areas = collections.defaultdict(list)
    for sid, area, _ in subjects:
        areas[area].append(sid)
    total = sums(books)
    lines = [
        "# Knowledge library coverage",
        "",
        f"Generated {datetime.date.today()} by `lab/knowledge/coverage.py` from the live library.",
        "",
        f"**{total[0]} books, {total[1]:,} pages, {total[2]:,} tagged excerpts, {total[3]:,} figures.** "
        "A book counts once, under the subject most of its excerpts carry. "
        "Figures leave out decorative records and rights exclusions.",
        "",
        "| Area | Books | Excerpts | Figures | Figures per page | Empty subjects |",
        "| --- | ---: | ---: | ---: | ---: | ---: |",
    ]
    for area in sorted(areas):
        rows = [b for s in areas[area] for b in held.get(s, [])]
        n, pages, excerpts, figures = sums(rows)
        empty = sum(1 for s in areas[area] if not held.get(s))
        lines.append(f"| {area} | {n} | {excerpts:,} | {figures:,} | {figures / pages if pages else 0:.2f} | {empty} |")
    for area in sorted(areas):
        lines += ["", f"## {area}", "", "| Subject | Books | Excerpts | Figures |", "| --- | ---: | ---: | ---: |"]
        ordered = sorted(areas[area], key=lambda s: (-sums(held.get(s, []))[2], label[s]))
        for sid in ordered:
            if held.get(sid):
                n, _, excerpts, figures = sums(held[sid])
                lines.append(f"| {label[sid]} | {n} | {excerpts:,} | {figures:,} |")
        empty = [label[s] for s in ordered if not held.get(s)]
        if empty:
            lines += ["", "No books yet: " + ", ".join(sorted(empty)) + "."]
        for sid in ordered:
            if held.get(sid):
                lines += ["", f"**{label[sid]}**", ""]
                lines += [
                    f"- {b[1]}: {b[2]:,} pages, {b[3]:,} excerpts, {b[4]:,} figures"
                    for b in sorted(held[sid], key=lambda b: b[1].lower())
                ]
    db = sqlite3.connect(f"file:{store.DB.as_posix()}?immutable=1", uri=True)
    queued = db.execute(
        "SELECT subject_id, title, pages FROM downloads WHERE status = 'downloaded' "
        "AND sha256 NOT IN (SELECT sha256 FROM books) ORDER BY subject_id, title"
    ).fetchall()
    running = db.execute(
        "SELECT json_extract(manifest, '$.title'), status, stage FROM books WHERE status != 'published'"
    ).fetchall()
    lines += ["", f"## Waiting in the builder ({len(queued)} downloaded, not admitted)", ""]
    lines += [f"- {label.get(s, s)}: {t} ({p or 0:,} pages)" for s, t, p in queued]
    if running:
        lines += ["", "## In the builder", ""]
        lines += [f"- {t}: {status}, {stage or '-'}" for t, status, stage in running]
    out = Path(__file__).with_name("COVERAGE.md")
    out.write_text("\n".join(lines) + "\n", encoding="utf-8", newline="\n")
    print(out, len(lines), "lines")


if __name__ == "__main__":
    main()
