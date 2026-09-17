"""Publish a completed local knowledge-base run into the shared library database.

The library database (deploy/docker-compose.library-db.yml) keeps the pilot's
production-shaped index tables so the production hybrid search SQL runs
unchanged, plus library_* tables that carry books, excerpts, tags, figures and
model-run receipts with the locators a reviewer needs to find the source and
reparse it.

One live library: the workspace is `library` and each book is one file.
Publishing a book loads its content under a new content id, records book
version n+1, marks the previous version retained and swaps the book's pointer
in one transaction. `rollback` points a book back at a retained version,
`retire` drops a retained version's content rows while keeping its receipts.

`schema` creates the schema as it is written. There is no migration path: a
changed `LIBRARY_SCHEMA` means dropping the library database and publishing
every book again, which costs a loader run and no model calls.

Run it in the pipeline's environment, which owns psycopg and boto3:
`uv run --project pipeline python bench/rag/scripts/knowledge_base_library.py
check` from the repository root. A bare interpreter fails on the imports.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

import psycopg
from dotenv import dotenv_values
from psycopg.types.json import Jsonb

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(ROOT / "pipeline"))
from knowledge_base_batch import PilotError, digest, read_json, save_json

LOCAL_ENV = dotenv_values(ROOT / ".env.local")
# The knowledge-base bucket credentials have to be in the environment before
# pipeline.config reads them (the import below).
for _key, _value in LOCAL_ENV.items():
    if _value and _key.startswith("KNOWLEDGE_BASE_B2_"):
        os.environ.setdefault(_key, _value)

from pipeline.retrieval.library import LIBRARY_SCHEMA as SCHEMA
from pipeline.retrieval.library import WORKSPACE


def library_url() -> str:
    url = os.environ.get("LIBRARY_DATABASE_URL") or LOCAL_ENV.get(
        "LIBRARY_DATABASE_URL"
    )
    if not url or "PASTE" in url:
        raise PilotError("Set LIBRARY_DATABASE_URL in the environment or .env.local")
    return url


def connect(autocommit: bool = True):
    return psycopg.connect(library_url(), autocommit=autocommit)


def object_key(sha256: str) -> str:
    """Library PDFs are content-addressed in the knowledge-base bucket."""
    return f"books/{sha256}.pdf"


def verify_object(sha256: str) -> str:
    """The object key, once the bucket confirms the book is actually there."""
    from pipeline.store import blobstore

    key = object_key(sha256)
    if blobstore.library_object_info(key) is None:
        raise PilotError(
            f"{key} is not in the knowledge-base bucket; upload the book before publishing"
        )
    return key


def versioned(identifier: str, version: int) -> str:
    """Chunk, excerpt and figure ids carry the book version.

    The builder derives them from the book identity alone, so a reparse of the
    same PDF would otherwise collide with the version it replaces.
    """
    return f"{identifier}_v{version}"


def corpus_identity(book_corpus: dict, pin: dict) -> str:
    """Everything that decides a book version's content, in one digest."""
    return digest(
        {
            "source_id": book_corpus["source_id"],
            "content_hash": book_corpus["content_hash"],
            "parser_fingerprint": book_corpus["parser_fingerprint"],
            "chunker_version": book_corpus["chunker_version"],
            "release_sha": book_corpus["release_sha"],
            "pin": pin,
        }
    )


def excerpt_rows(corpus: dict, tags: dict) -> list[dict]:
    """Excerpts joined with their tag outcome; a failed tag keeps its excerpt."""
    reviews = {}
    for item in tags["review_items"]:
        reviews.setdefault(item["excerpt_id"], []).append(item["reason"])
    rows = []
    for excerpt in corpus["excerpts"]:
        tag = tags["tags"].get(excerpt["id"])
        failed = excerpt["id"] in tags["failed_tags"]
        if tag is None and not failed:
            raise PilotError(f"Excerpt {excerpt['id']} has no tag outcome")
        rows.append(
            {
                "id": excerpt["id"],
                "book_id": corpus["book"]["id"],
                "section_path": excerpt["section_path"],
                "chunk_ids": excerpt["chunk_ids"],
                "pages": excerpt["pages"],
                "regions": excerpt["regions"],
                "figure_ids": excerpt["figure_ids"],
                "text": excerpt["text"],
                "tag_status": "failed" if failed else "tagged",
                "roles": tag["roles"] if tag else [],
                "topic_ids": tag["topic_ids"] if tag else [],
                "confidence": tag["confidence"] if tag else None,
                "evidence": tag["evidence"] if tag else "",
                "evidence_verified": bool(tag and tag["evidence_verified"]),
                "synopsis": tag["synopsis"] if tag else "",
                "proposed_topic": tag.get("proposed_topic") if tag else None,
                "review_reasons": sorted(set(reviews.get(excerpt["id"], []))),
            }
        )
    return rows


def relative_path(path: str) -> str:
    """Repository-relative when the capture lives under the checkout, else as given."""
    try:
        return Path(path).resolve().relative_to(ROOT).as_posix()
    except ValueError:
        return path


def figure_rows(corpus: dict, captures: dict) -> list[dict]:
    captured = {
        (c["book_id"], c["figure"]["id"]): c
        for c in captures["captures"]
        if c["book_id"] == corpus["book"]["id"]
    }
    rows = []
    for figure in corpus["figures"]:
        capture = captured.get((corpus["book"]["id"], figure["id"]))
        rows.append(
            {
                **{k: figure[k] for k in figure if k != "out_of_page_bounds"},
                "book_id": corpus["book"]["id"],
                "capture_path": relative_path(capture["path"]) if capture else None,
                "capture_pixel_size": capture["pixel_size"] if capture else None,
            }
        )
    return rows


def model_run_rows(run: Path, usage: dict) -> list[dict]:
    rows = []
    for stage, summary in usage["stages"].items():
        state = read_json(run / "models" / stage / "state.json")
        rows.append(
            {
                "stage": stage,
                "transport": state.get("transport", "normal"),
                "model": state.get("model", ""),
                "attempts": summary["attempts"],
                "collection": summary["collection"],
                "usage": summary["usage"],
                "approximate_cost_usd": summary.get("approximate_cost_usd"),
                "request_start_utc": summary.get("request_start_utc"),
                "request_end_utc": summary.get("request_end_utc"),
                "results_path": (run / "models" / stage).relative_to(ROOT).as_posix(),
            }
        )
    embeddings = usage["embeddings"]
    rows.append(
        {
            "stage": "embeddings",
            "transport": "normal",
            "model": "deepinfra/Qwen/Qwen3-Embedding-4B",
            "attempts": embeddings["new_calls"],
            "collection": {"new_texts": embeddings["new_texts"]},
            "usage": {"tokens": embeddings["tokens"]},
            "approximate_cost_usd": embeddings.get("approximate_cost_usd"),
            "request_start_utc": None,
            "request_end_utc": None,
            "results_path": (run / "embedding-usage.jsonl")
            .relative_to(ROOT)
            .as_posix(),
        }
    )
    return rows


def apply_schema() -> dict:
    """Create the library schema exactly as `LIBRARY_SCHEMA` writes it.

    Every statement is CREATE ... IF NOT EXISTS, so this is a no-op against a
    live library. Changing the schema means dropping the database and
    republishing every book; the loader carries no migration path.
    """
    with connect() as conn:
        conn.execute(SCHEMA)
    return status()


def ensure_pin(conn, pin: tuple) -> None:
    """The library keeps one fixed embedding pin; a run with another is refused."""
    current = conn.execute(
        "SELECT embedding_provider_slug, embedding_model_slug, embedding_model_version, embedding_dim "
        "FROM workspaces WHERE id=%s",
        (WORKSPACE,),
    ).fetchone()
    if current is None:
        conn.execute("INSERT INTO workspaces VALUES(%s,%s,%s,%s,%s)", (WORKSPACE, *pin))
    elif tuple(current) != pin:
        raise PilotError(
            f"The library is pinned to {tuple(current)}; this run embeds with {pin}"
        )


def publish_book(
    source,
    target,
    *,
    run: Path,
    book: dict,
    book_corpus: dict,
    summary: dict,
    topics: list[dict],
    tags: dict,
    captures: dict,
    model_runs: list[dict],
    identity: str,
    note: str,
) -> dict:
    """Load one book as its next version and swap the book's pointer."""
    book_id = book["id"]
    # Numbering follows the highest version ever published (a rollback leaves a
    # higher one behind); the refusal compares the live one.
    highest = target.execute(
        "SELECT coalesce(max(version), 0) FROM library_book_versions WHERE book_id=%s",
        (book_id,),
    ).fetchone()[0]
    live = target.execute(
        "SELECT version, corpus_identity FROM library_book_versions "
        "WHERE book_id=%s AND status='current'",
        (book_id,),
    ).fetchone()
    if live and live[1] == identity:
        raise PilotError(
            f"{book_id} version {live[0]} already holds this corpus identity; nothing changed"
        )
    version = highest + 1
    content_id = f"{book_id}_v{version}"
    key = verify_object(book["sha256"])
    rows = source.execute(
        "SELECT c.id,c.chunk_idx,c.section_path,c.text,c.indexed_text,c.page_start,c.page_end,c.regions,c.lang,c.confidence,c.confidence_reasons,c.search::text,c.searchable,v.embedding::text "
        "FROM pilot_chunks c JOIN rag_chunk_vectors_2560 v ON v.chunk_id=c.id WHERE c.content_id=%s ORDER BY c.chunk_idx",
        (book_corpus["source_id"],),
    ).fetchall()
    meta = {c["id"]: (c["excerpt_id"], c["reference"]) for c in book_corpus["chunks"]}
    if {r[0] for r in rows} != set(meta):
        raise PilotError(f"Pilot database chunks differ from corpus.json for {book_id}")
    with target.transaction():
        target.execute(
            "INSERT INTO files(id,name) VALUES(%s,%s) ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name",
            (book_id, book["title"]),
        )
        target.execute("INSERT INTO rag_contents VALUES(%s,'ready')", (content_id,))
        chunk_params, vector_params = [], []
        for row in rows:
            excerpt_id, reference = meta[row[0]]
            chunk_params.append(
                (
                    versioned(row[0], version),
                    WORKSPACE,
                    content_id,
                    *row[1:7],
                    Jsonb(row[7]),
                    *row[8:13],
                    book_id,
                    versioned(excerpt_id, version),
                    reference,
                )
            )
            vector_params.append((versioned(row[0], version), WORKSPACE, row[13]))
        # executemany runs in pipeline mode: one round trip per batch, not per row.
        target.cursor().executemany(
            "INSERT INTO library_chunks VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s::tsvector,%s,%s,%s,%s)",
            chunk_params,
        )
        target.cursor().executemany(
            "INSERT INTO rag_chunk_vectors_2560 VALUES(%s,%s,%s::halfvec)",
            vector_params,
        )
        excerpts = excerpt_rows(book_corpus, tags)
        target.cursor().executemany(
            "INSERT INTO library_excerpts VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
            [
                (
                    content_id,
                    versioned(e["id"], version),
                    e["book_id"],
                    e["section_path"],
                    [versioned(c, version) for c in e["chunk_ids"]],
                    e["pages"],
                    Jsonb(e["regions"]),
                    [versioned(f, version) for f in e["figure_ids"]],
                    e["text"],
                    e["tag_status"],
                    e["roles"],
                    e["topic_ids"],
                    e["confidence"],
                    e["evidence"],
                    e["evidence_verified"],
                    e["synopsis"],
                    e["proposed_topic"],
                    e["review_reasons"],
                )
                for e in excerpts
            ],
        )
        figures = figure_rows(book_corpus, captures)
        target.cursor().executemany(
            "INSERT INTO library_figures VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
            [
                (
                    content_id,
                    versioned(f["id"], version),
                    f["book_id"],
                    f["page"],
                    f["bbox"],
                    f["caption_bbox"],
                    f["space"],
                    f["geometry_kind"],
                    f["block_index"],
                    Jsonb(f["original_caption"]),
                    Jsonb(f["original_footnote"]),
                    f["section_path"],
                    f["excluded"],
                    Jsonb(f["exclusion_evidence"]),
                    f["capture_path"],
                    f["capture_pixel_size"],
                )
                for f in figures
            ],
        )
        for topic in topics:
            target.execute(
                "INSERT INTO library_topics VALUES(%s,%s,%s,%s,%s) ON CONFLICT (id) DO UPDATE SET "
                "label=EXCLUDED.label, aliases=EXCLUDED.aliases, scope=EXCLUDED.scope, source_sections=EXCLUDED.source_sections",
                (
                    topic["id"],
                    topic["label"],
                    Jsonb(topic["aliases"]),
                    topic["scope"],
                    topic.get("source_sections", ""),
                ),
            )
        for r in model_runs:
            target.execute(
                "INSERT INTO library_model_runs VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                (
                    book_id,
                    content_id,
                    r["stage"],
                    r["transport"],
                    r["model"],
                    r["attempts"],
                    Jsonb(r["collection"]),
                    Jsonb(r["usage"]),
                    r["approximate_cost_usd"],
                    r["request_start_utc"],
                    r["request_end_utc"],
                    r["results_path"],
                ),
            )
        target.execute(
            "INSERT INTO library_books VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) "
            "ON CONFLICT (id) DO UPDATE SET title=EXCLUDED.title, authors=EXCLUDED.authors, "
            "edition=EXCLUDED.edition, source_url=EXCLUDED.source_url, download_url=EXCLUDED.download_url, "
            "license=EXCLUDED.license, license_url=EXCLUDED.license_url, attribution=EXCLUDED.attribution, "
            "sha256=EXCLUDED.sha256, bytes=EXCLUDED.bytes, pages=EXCLUDED.pages, "
            "first_content_page=EXCLUDED.first_content_page, content_id=EXCLUDED.content_id, "
            "version=EXCLUDED.version, rights_notes=EXCLUDED.rights_notes, "
            "figure_exclusions=EXCLUDED.figure_exclusions",
            (
                book_id,
                book["title"],
                Jsonb(book["authors"]),
                book["edition"],
                book["source_url"],
                book["download_url"],
                book["license"],
                book["license_url"],
                book["attribution"],
                book["sha256"],
                book["bytes"],
                book["pages"],
                book["first_content_page"],
                content_id,
                version,
                Jsonb(book.get("rights_notes", [])),
                Jsonb(book.get("figure_exclusions", [])),
            ),
        )
        target.execute(
            "UPDATE library_book_versions SET status='retained' WHERE book_id=%s AND status='current'",
            (book_id,),
        )
        target.execute(
            "INSERT INTO library_book_versions"
            "(book_id,version,content_id,status,source_run,corpus_identity,parser_release,parser_fingerprint,chunker_version,descriptor,summary,object_key,note)"
            " VALUES(%s,%s,%s,'current',%s,%s,%s,%s,%s,%s,%s,%s,%s)",
            (
                book_id,
                version,
                content_id,
                run.relative_to(ROOT).as_posix(),
                identity,
                book_corpus["release_sha"],
                book_corpus["parser_fingerprint"],
                book_corpus["chunker_version"],
                summary["descriptor"],
                summary["summary"],
                key,
                note,
            ),
        )
        target.execute(
            "INSERT INTO rag_file_contents VALUES(%s,%s,%s) ON CONFLICT (file_id) DO UPDATE SET content_id=EXCLUDED.content_id",
            (book_id, WORKSPACE, content_id),
        )
        searchable = target.execute(
            "SELECT count(*) FROM rag_chunks WHERE content_id=%s", (content_id,)
        ).fetchone()[0]
        if searchable != sum(1 for r in rows if r[12]):
            raise PilotError(
                f"{book_id}: searchable chunks differ from the run; nothing committed"
            )
    return {
        "book": book_id,
        "version": version,
        "content_id": content_id,
        "object_key": key,
        "corpus_identity": identity,
        "counts": {
            "chunks": len(chunk_params),
            "searchable_chunks": searchable,
            "excerpts": len(excerpts),
            "figures": len(figures),
            "topics": len(topics),
        },
    }


def publish(run: Path, manifest_path: Path, book_ids: list[str], note: str) -> dict:
    import knowledge_base_pilot as pilot

    manifest = pilot.load_manifest(manifest_path)
    corpus = pilot.corpora(manifest, run)
    unknown = sorted(set(book_ids) - {c["book"]["id"] for c in corpus})
    if unknown:
        raise PilotError(f"The run holds no book {unknown}")
    selected = [c for c in corpus if not book_ids or c["book"]["id"] in book_ids]
    tags = read_json(run / "tags.json")
    captures = read_json(run / "captures.json")
    summaries = {
        s["book_id"]: s for s in read_json(run / "summaries.json")["summaries"]
    }
    index = read_json(run / "index.json")
    usage = read_json(run / "usage-summary.json")
    pilot_url = read_json(run.parent / "config.json")["database_url"]
    books = {b["id"]: b for b in manifest["books"]}
    model_runs = model_run_rows(run, usage)
    started = time.time()
    receipts = []
    with psycopg.connect(pilot_url) as source, connect() as target:
        ensure_pin(target, tuple(index["pin"][key] for key in pilot.PIN))
        for book_corpus in selected:
            book = books[book_corpus["book"]["id"]]
            receipt = publish_book(
                source,
                target,
                run=run,
                book=book,
                book_corpus=book_corpus,
                summary=summaries[book["id"]],
                topics=manifest["topics"],
                tags=tags,
                captures=captures,
                model_runs=model_runs,
                identity=corpus_identity(book_corpus, index["pin"]),
                note=note,
            )
            save_json(
                run / f"library-publish-{book['id']}-v{receipt['version']}.json",
                receipt,
            )
            receipts.append(receipt)
        target.execute("ANALYZE")
    return {
        "library_url_host": library_url().split("@")[-1].split("/")[0],
        "published": receipts,
        "seconds": round(time.time() - started, 1),
    }


def rollback(book_id: str, version: int) -> dict:
    """Point a book back at one of its retained versions."""
    with connect() as conn, conn.transaction():
        row = conn.execute(
            "SELECT content_id, status FROM library_book_versions WHERE book_id=%s AND version=%s",
            (book_id, version),
        ).fetchone()
        if row is None:
            raise PilotError(f"No version {version} of {book_id}")
        if row[1] != "retained":
            raise PilotError(f"{book_id} version {version} is {row[1]}, not retained")
        conn.execute(
            "UPDATE library_book_versions SET status='retained' WHERE book_id=%s AND status='current'",
            (book_id,),
        )
        conn.execute(
            "UPDATE library_book_versions SET status='current' WHERE book_id=%s AND version=%s",
            (book_id, version),
        )
        conn.execute(
            "UPDATE library_books SET content_id=%s, version=%s WHERE id=%s",
            (row[0], version, book_id),
        )
        conn.execute(
            "UPDATE rag_file_contents SET content_id=%s WHERE file_id=%s",
            (row[0], book_id),
        )
    return status()


def retire(book_id: str, version: int) -> dict:
    """Drop a retained version's content rows.

    Its receipts stay: the version row and its `library_model_runs` are what a
    reviewer needs to see which model wrote that version's tags and prose, and
    they are small.
    """
    with connect() as conn, conn.transaction():
        row = conn.execute(
            "SELECT content_id, status FROM library_book_versions WHERE book_id=%s AND version=%s",
            (book_id, version),
        ).fetchone()
        if row is None:
            raise PilotError(f"No version {version} of {book_id}")
        if row[1] != "retained":
            raise PilotError(f"{book_id} version {version} is {row[1]}, not retained")
        content_id = row[0]
        conn.execute(
            "DELETE FROM rag_chunk_vectors_2560 WHERE chunk_id IN "
            "(SELECT id FROM library_chunks WHERE content_id=%s)",
            (content_id,),
        )
        for table in ("library_chunks", "library_excerpts", "library_figures"):
            conn.execute(f"DELETE FROM {table} WHERE content_id=%s", (content_id,))
        conn.execute(
            "UPDATE library_book_versions SET status='retired' WHERE book_id=%s AND version=%s",
            (book_id, version),
        )
    return status()


def status() -> dict:
    with connect() as conn:
        books = conn.execute(
            "SELECT b.id, b.title, b.version, b.content_id, "
            "(SELECT count(*) FROM rag_chunks c WHERE c.content_id=b.content_id), "
            "(SELECT count(*) FROM library_excerpts e WHERE e.content_id=b.content_id) "
            "FROM library_books b ORDER BY b.id"
        ).fetchall()
        versions = conn.execute(
            "SELECT book_id, version, status, published_at::text, source_run, parser_release, "
            "chunker_version, object_key, corpus_identity, note FROM library_book_versions "
            "ORDER BY book_id, version"
        ).fetchall()
        topics = conn.execute("SELECT count(*) FROM library_topics").fetchone()[0]
    history: dict[str, list[dict]] = {}
    for row in versions:
        history.setdefault(row[0], []).append(
            dict(
                zip(
                    (
                        "version",
                        "status",
                        "published_at",
                        "source_run",
                        "parser_release",
                        "chunker_version",
                        "object_key",
                        "corpus_identity",
                        "note",
                    ),
                    row[1:],
                )
            )
        )
    return {
        "books": [
            dict(
                zip(
                    ("id", "title", "version", "content_id", "searchable_chunks", "excerpts"),
                    book,
                )
            )
            | {"versions": history.get(book[0], [])}
            for book in books
        ],
        "topics": topics,
    }


def check() -> None:
    corpus = {
        "book": {"id": "b"},
        "excerpts": [
            {
                "id": "e1",
                "section_path": "A",
                "chunk_ids": ["c1"],
                "pages": [1],
                "regions": [],
                "figure_ids": ["f1"],
                "text": "t",
            },
            {
                "id": "e2",
                "section_path": "B",
                "chunk_ids": ["c2"],
                "pages": [2],
                "regions": [],
                "figure_ids": [],
                "text": "u",
            },
        ],
        "figures": [
            {
                "id": "f1",
                "block_index": 0,
                "page": 1,
                "bbox": [0, 0, 10, 10],
                "caption_bbox": None,
                "out_of_page_bounds": False,
                "geometry_kind": "parser_image",
                "space": "page-1000-topleft",
                "original_caption": ["c"],
                "original_footnote": [],
                "section_path": "A",
                "excluded": False,
                "exclusion_evidence": [],
            }
        ],
    }
    tags = {
        "tags": {
            "e1": {
                "roles": ["formal"],
                "topic_ids": [],
                "confidence": 0.5,
                "evidence": "x",
                "evidence_verified": False,
                "synopsis": "s",
                "proposed_topic": None,
            }
        },
        "failed_tags": {"e2": {"error": {"kind": "invalid_schema"}}},
        "review_items": [
            {"excerpt_id": "e1", "reason": "evidence/confidence/topic review"}
        ],
    }
    rows = excerpt_rows(corpus, tags)
    assert rows[0]["tag_status"] == "tagged" and rows[0]["review_reasons"] == [
        "evidence/confidence/topic review"
    ]
    assert (
        rows[1]["tag_status"] == "failed"
        and rows[1]["roles"] == []
        and rows[1]["confidence"] is None
    )
    tags["failed_tags"] = {}
    try:
        excerpt_rows(corpus, tags)
        raise AssertionError("an excerpt without any tag outcome must be refused")
    except PilotError:
        pass
    captures = {
        "captures": [
            {
                "book_id": "b",
                "figure": {"id": "f1"},
                "path": str(ROOT / "captures/f1.jpg"),
                "pixel_size": [10, 10],
            }
        ]
    }
    figures = figure_rows(corpus, captures)
    assert (
        figures[0]["capture_path"] == "captures/f1.jpg"
        and "out_of_page_bounds" not in figures[0]
    )
    assert digest({"a": 1}) == digest({"a": 1})

    # Two versions of one book must not share chunk ids: the builder derives
    # them from the book identity, which a reparse does not change.
    assert versioned("chk_a_1", 2) == "chk_a_1_v2" != versioned("chk_a_1", 1)
    pin = {"embedding_model_slug": "Qwen"}
    base = {
        "source_id": "s",
        "content_hash": "h",
        "parser_fingerprint": "fp",
        "chunker_version": "v10",
        "release_sha": "sha",
    }
    assert corpus_identity(base, pin) == corpus_identity(dict(base), pin), (
        "an unchanged corpus must keep its identity so a republish is refused"
    )
    assert corpus_identity(base, pin) != corpus_identity(base | {"parser_fingerprint": "fp2"}, pin)

    # A missing object refuses the publish rather than recording a key that
    # would fail at capture time; a present one becomes books/<sha256>.pdf.
    from pipeline.store import blobstore

    present = {"books/" + "a" * 64 + ".pdf"}
    original = blobstore.library_object_info
    blobstore.library_object_info = lambda key: (
        {"size": 1} if key in present else None
    )
    try:
        assert verify_object("a" * 64) == "books/" + "a" * 64 + ".pdf"
        try:
            verify_object("b" * 64)
            raise AssertionError("a missing bucket object must refuse")
        except PilotError:
            pass
    finally:
        blobstore.library_object_info = original
    print("Library excerpt/figure assembly, id versioning and object checks passed")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("schema", help="create the library schema (no migration path)")
    p = sub.add_parser("publish", help="load a run's books as their next version")
    p.add_argument("--run", type=Path, required=True)
    p.add_argument(
        "--manifest",
        type=Path,
        default=ROOT / "bench/rag/fixtures/knowledge-base-pilot-books.json",
    )
    p.add_argument(
        "--book",
        action="append",
        default=[],
        help="repeatable; every book in the run by default",
    )
    p.add_argument("--note", default="")
    p = sub.add_parser("rollback", help="point a book back at a retained version")
    p.add_argument("--book", required=True)
    p.add_argument("--version", type=int, required=True)
    p = sub.add_parser("retire", help="drop a retained version's content rows")
    p.add_argument("--book", required=True)
    p.add_argument("--version", type=int, required=True)
    sub.add_parser("status")
    sub.add_parser("check")
    args = parser.parse_args()
    if args.command == "check":
        check()
    elif args.command == "schema":
        print(json.dumps(apply_schema(), indent=1))
    elif args.command == "publish":
        print(
            json.dumps(
                publish(args.run.resolve(), args.manifest, args.book, args.note)
            )
        )
    elif args.command == "rollback":
        print(json.dumps(rollback(args.book, args.version), indent=1))
    elif args.command == "retire":
        print(json.dumps(retire(args.book, args.version), indent=1))
    else:
        print(json.dumps(status(), indent=1))


if __name__ == "__main__":
    try:
        main()
    except PilotError as exc:
        print(str(exc), file=sys.stderr)
        raise SystemExit(2) from None
