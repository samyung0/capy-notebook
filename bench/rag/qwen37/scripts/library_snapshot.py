"""Freeze a read-only snapshot of the library subset before any retrieval run.

Reads (SELECT only, session forced read-only) the eligible chunks of the books
in fixtures/library-subset.json, their stored Qwen3-Embedding-4B halfvec
vectors, excerpts, books and file mappings. Everything downstream reads this
snapshot, so concurrent book publishing cannot move the corpus mid-run.

Output: data/qwen37-embedding/library/{chunks.jsonl.gz, q4_stored.npy,
excerpts.jsonl.gz, books.json, snapshot.json}
"""

from __future__ import annotations

import gzip
import hashlib
import json
import time

import numpy as np
from common import DATA, ELIGIBLE_SQL, FIXTURES, library_conn, write_json

OUT = DATA / "library"


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    subset = json.loads((FIXTURES / "library-subset.json").read_text(encoding="utf-8"))
    group_of = {b: g for g, spec in subset["groups"].items() for b in spec["books"]}
    books = sorted(group_of)
    with library_conn() as conn:
        with conn.transaction():  # one read-only snapshot across all statements
            conn.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
            found = {r[0] for r in conn.execute("SELECT id FROM library_books WHERE id = ANY(%s)", (books,))}
            assert found == set(books), sorted(set(books) - found)
            cur = conn.cursor(binary=True)
            cur.execute(
                f"""
                SELECT c.id, c.book_id, c.content_id, c.excerpt_id, c.chunk_idx, c.section_path,
                       c.text, c.indexed_text, c.page_start, c.page_end, c.regions::text, c.lang,
                       c.confidence, c.confidence_reasons, c.search::text, c.reference, v.embedding
                {ELIGIBLE_SQL.replace("WHERE", "JOIN rag_chunk_vectors_2560 v ON v.chunk_id = c.id WHERE", 1)}
                  AND c.book_id = ANY(%s)
                ORDER BY c.book_id, c.chunk_idx, c.id
                """,
                (books,),
            )
            rows = cur.fetchall()
            eligible_total = conn.execute(f"SELECT count(*) {ELIGIBLE_SQL}").fetchone()[0]
            excerpt_rows = conn.execute(
                """
                SELECT e.content_id, e.id, e.book_id, e.section_path, e.chunk_ids, e.pages, e.regions::text,
                       e.figure_ids, e.text, e.tag_status, e.roles, e.topic_ids, e.confidence, e.evidence,
                       e.evidence_verified, e.synopsis, e.proposed_topic, e.review_reasons, e.retrieval::text
                FROM library_excerpts e
                JOIN rag_file_contents fc ON fc.content_id = e.content_id AND fc.workspace_id = 'library'
                WHERE e.book_id = ANY(%s)
                """,
                (books,),
            ).fetchall()
            book_rows = conn.execute(
                """
                SELECT b.id, b.title, b.content_id, b.version, fc.file_id, f.name, f.added_at::text
                FROM library_books b
                JOIN rag_file_contents fc ON fc.content_id = b.content_id AND fc.workspace_id = 'library'
                JOIN files f ON f.id = fc.file_id
                WHERE b.id = ANY(%s) ORDER BY b.id
                """,
                (books,),
            ).fetchall()
    vectors = np.empty((len(rows), 2560), dtype=np.float16)
    with gzip.open(OUT / "chunks.jsonl.gz", "wt", encoding="utf-8") as out:
        for i, r in enumerate(rows):
            blob = bytes(r[16])
            assert int.from_bytes(blob[:2], "big") == 2560
            vectors[i] = np.frombuffer(blob[4:], dtype=">f2")
            out.write(
                json.dumps(
                    {
                        "id": r[0],
                        "book_id": r[1],
                        "group": group_of[r[1]],
                        "content_id": r[2],
                        "excerpt_id": r[3],
                        "chunk_idx": r[4],
                        "section_path": r[5],
                        "text": r[6],
                        "indexed_text": r[7],
                        "page_start": r[8],
                        "page_end": r[9],
                        "regions": r[10],
                        "lang": r[11],
                        "confidence": r[12],
                        "confidence_reasons": r[13],
                        "search": r[14],
                        "reference": r[15],
                    },
                    ensure_ascii=False,
                )
                + "\n"
            )
    np.save(OUT / "q4_stored.npy", vectors)
    with gzip.open(OUT / "excerpts.jsonl.gz", "wt", encoding="utf-8") as out:
        keys = (
            "content_id id book_id section_path chunk_ids pages regions figure_ids text tag_status roles "
            "topic_ids confidence evidence evidence_verified synopsis proposed_topic review_reasons retrieval"
        ).split()
        for r in excerpt_rows:
            out.write(json.dumps(dict(zip(keys, r)), ensure_ascii=False) + "\n")
    write_json(
        OUT / "books.json",
        [
            dict(zip(("id", "title", "content_id", "version", "file_id", "file_name", "added_at"), r), group=group_of[r[0]])
            for r in book_rows
        ],
    )
    per_book = {}
    for r in rows:
        per_book[r[1]] = per_book.get(r[1], 0) + 1
    write_json(
        OUT / "snapshot.json",
        {
            "taken_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "books": len(books),
            "eligible_chunks_subset": len(rows),
            "eligible_chunks_library": eligible_total,
            "chars_indexed_text": sum(len(r[7]) for r in rows),
            "excerpts": len(excerpt_rows),
            "per_book": per_book,
            "book_versions": {r[0]: [r[2], r[3]] for r in book_rows},
            "sha256": {p.name: sha(p) for p in (OUT / "chunks.jsonl.gz", OUT / "q4_stored.npy", OUT / "excerpts.jsonl.gz")},
        },
    )
    print(len(rows), "chunks of", eligible_total, "eligible;", len(excerpt_rows), "excerpts")


if __name__ == "__main__":
    main()
