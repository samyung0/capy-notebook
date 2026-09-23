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

Taxonomy: subjects come from the committed fixture `lab/knowledge/subjects.json`,
loaded by `schema` and refreshed by every `publish`; each manifest book names
its `subject_id`. Topics come from the run (`<run>/topics.json`, written by the
builder's topics stage) or, for the pilot run, from the manifest's `topics`, and
are upserted under the book's subject; a topic whose id is a subject id is
refused. Topic ids are unique library-wide: a shared topic (another subject's,
marked `shared` in topics.json) is never upserted, and a publish that would move
a topic to another subject is refused. After a book's excerpts are written, and again when a version is
retired, topics no tagged excerpt of a current or retained version references
are dropped.

`schema` creates the schema and adds the nullable reviewed retrieval metadata
column and the figure label, credit and decorative columns to existing
libraries. It preserves published source data and versions. Run it once
against a library before publishing with a loader newer than its columns.

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

SUBJECTS = ROOT / "lab/knowledge/subjects.json"
MANIFEST = ROOT / "lab/knowledge/books.json"
# Section paths join their segments with this (retrieval/chunking._section_path).
SECTION_SEP = " › "
SUMMARY_MAX_CHARS = 1000


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


def corpus_identity(book_corpus: dict, pin: dict, tags: dict) -> str:
    """Everything that decides a book version's content, in one digest: the
    parse, the embedding pin and each excerpt's tag outcome (a retag or a
    topic rename changes the excerpt rows, so it is a new version).

    A book whose figures carry a book agent's notes (`apply_figure_notes` writes
    all four fields on every record; transcribe never writes `decorative`) also
    covers its figure notes and excluded flags, so a figure-only cleanup is a
    new version. Every other book keeps exactly the identity it had before.
    """
    from knowledge_base_pilot import FIGURE_NOTES

    identity = {
        "source_id": book_corpus["source_id"],
        "content_hash": book_corpus["content_hash"],
        "parser_fingerprint": book_corpus["parser_fingerprint"],
        "chunker_version": book_corpus["chunker_version"],
        "release_sha": book_corpus["release_sha"],
        "pin": pin,
        "tags": {e["id"]: tags["tags"].get(e["id"]) for e in book_corpus["excerpts"]},
    }
    if any("decorative" in f for f in book_corpus["figures"]):
        # get: a transcribe --redo pops label and description and keeps the rest
        identity["figures"] = {
            f["id"]: {k: f.get(k) for k in (*FIGURE_NOTES, "excluded")}
            for f in book_corpus["figures"]
        }
    return digest(identity)


def excerpt_rows(corpus: dict, tags: dict) -> list[dict]:
    """Excerpts joined with their tag outcome; a failed tag keeps its excerpt."""
    from pipeline.retrieval.knowledge_metadata import validate_metadata

    excerpt_ids = {e["id"] for e in corpus["excerpts"]}
    reviews = {}
    for item in tags["review_items"]:
        reviews.setdefault(item["excerpt_id"], []).append(item["reason"])
    rows = []
    for excerpt in corpus["excerpts"]:
        tag = tags["tags"].get(excerpt["id"])
        failed = excerpt["id"] in tags["failed_tags"]
        if tag is None and not failed:
            raise PilotError(f"Excerpt {excerpt['id']} has no tag outcome")
        metadata = tag.get("retrieval") if tag else None
        if metadata is not None:
            validate_metadata(metadata, excerpt["id"], excerpt_ids)
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
                "retrieval": metadata,
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
                # The builder's transcribe stage or a book agent's figures.json
                # writes these; pilot corpora have none.
                "description": figure.get("description", ""),
                "label": figure.get("label", ""),
                "credit": figure.get("credit", ""),
                "decorative": figure.get("decorative", False),
            }
        )
    return rows


FIGURE_COLUMNS = (
    "content_id,id,book_id,page,bbox,caption_bbox,space,geometry_kind,block_index,"
    "original_caption,original_footnote,section_path,excluded,exclusion_evidence,"
    "capture_path,capture_pixel_size,description,label,credit,decorative"
)


def insert_figures(target, content_id: str, version: int, figures: list[dict]) -> None:
    target.cursor().executemany(
        f"INSERT INTO library_figures ({FIGURE_COLUMNS}) VALUES({','.join(['%s'] * 20)})",
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
                f["description"],
                f["label"],
                f["credit"],
                f["decorative"],
            )
            for f in figures
        ],
    )


def model_run_rows(run: Path) -> list[dict]:
    """One receipt per model stage in the run, plus the embedding usage.

    The pilot's priced `usage-summary.json` is used when present. A builder run
    has only each stage's state (the `realtime/` one when the stage ran through
    the normal API), which carries the same counts unpriced, and the embedding
    log the index stage appends to.
    """
    priced = run / "usage-summary.json"
    usage = read_json(priced) if priced.exists() else {"stages": {}}
    rows = []
    models = run / "models"
    stages = (
        sorted(d for d in models.iterdir() if d.is_dir()) if models.exists() else []
    )
    for directory in stages:
        state = read_json(directory / "state.json")
        summary = usage["stages"].get(directory.name)
        if summary is None:
            realtime = directory / "realtime/state.json"
            done = read_json(realtime) if realtime.exists() else state
            summary = {
                "attempts": done.get("normal_requests", 0),
                "collection": done.get("collection", {}),
                "usage": done.get("usage", {}),
            }
        rows.append(
            {
                "stage": directory.name,
                "transport": state.get("transport", "normal"),
                "model": state.get("model", ""),
                "attempts": summary["attempts"],
                "collection": summary["collection"],
                "usage": summary["usage"],
                "approximate_cost_usd": summary.get("approximate_cost_usd"),
                "request_start_utc": summary.get("request_start_utc"),
                "request_end_utc": summary.get("request_end_utc"),
                "results_path": relative_path(str(directory)),
            }
        )
    log = run / "embedding-usage.jsonl"
    embeddings = usage.get("embeddings")
    if embeddings is None and log.exists():
        lines = [
            json.loads(line)
            for line in log.read_text("utf-8").splitlines()
            if line.strip()
        ]
        embeddings = {
            "new_calls": sum(line["usage"]["calls"] for line in lines),
            "new_texts": sum(line["inputs"] for line in lines),
            "tokens": sum(line["usage"]["embedTokens"] for line in lines),
        }
    if embeddings is not None:
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
                "results_path": relative_path(str(log)),
            }
        )
    return rows


def load_subjects() -> dict[str, dict]:
    return {s["id"]: s for s in read_json(SUBJECTS)["subjects"]}


def sync_subjects(conn, subjects: dict[str, dict]) -> None:
    """Upsert the fixture; a subject it dropped goes only when no topic uses it."""
    for subject in subjects.values():
        conn.execute(
            "INSERT INTO library_subjects VALUES(%s,%s,%s,%s) ON CONFLICT (id) DO UPDATE SET "
            "area=EXCLUDED.area, label=EXCLUDED.label, aliases=EXCLUDED.aliases",
            (
                subject["id"],
                subject["area"],
                subject["label"],
                Jsonb(subject["aliases"]),
            ),
        )
    ids = list(subjects)
    conn.execute(
        "DELETE FROM library_subjects s WHERE s.id <> ALL(%s) "
        "AND NOT EXISTS (SELECT 1 FROM library_topics t WHERE t.subject_id = s.id)",
        (ids,),
    )
    stuck = [
        row[0]
        for row in conn.execute(
            "SELECT id FROM library_subjects WHERE id <> ALL(%s) ORDER BY id", (ids,)
        )
    ]
    if stuck:
        raise PilotError(
            f"Subjects {stuck} are gone from {SUBJECTS.name} but still hold topics"
        )


def drop_unreferenced_topics(conn) -> int:
    """Drop topics no tagged excerpt carries.

    Excerpt rows exist for current and retained versions only (`retire`
    deletes a version's), so a retained version keeps its topics until it is
    retired and a rollback never lands on excerpts whose topics are gone.
    """
    return conn.execute(
        "DELETE FROM library_topics t WHERE NOT EXISTS ("
        " SELECT 1 FROM library_excerpts e"
        " WHERE e.tag_status = 'tagged' AND e.topic_ids @> ARRAY[t.id])"
    ).rowcount


def book_topics(run: Path, manifest: dict, book: dict, subjects: dict) -> list[dict]:
    """The book's topics: its own under the book's subject, shared ones under theirs.

    A builder run writes `<run>/topics.json` from its topics stage; the pilot
    run has none and its manifest carries the hand-written catalog. A topic
    whose id is a subject id is refused: `browse_knowledge` tells the two
    catalogs apart by argument, and the ids stay distinct at the source.
    """
    path = run / "topics.json"
    if path.exists():
        data = read_json(path)
        if data["subject_id"] != book["subject_id"]:
            raise PilotError(
                f"{path.name} is for subject {data['subject_id']!r}; "
                f"{book['id']} is {book['subject_id']!r}"
            )
        topics = data["topics"]
    else:
        topics = manifest.get("topics")
        if not topics:
            raise PilotError(
                f"{book['id']}: no {path.name} in the run and the manifest has no topics"
            )
    for topic in topics:
        if topic["id"] in subjects:
            raise PilotError(
                f"{book['id']}: topic {topic['id']!r} ({topic['label']}) shares its id "
                f"with subject {topic['id']!r} ({subjects[topic['id']]['label']}); "
                "rename the topic"
            )
    # A shared topic belongs to another subject and keeps it (topics.merge).
    return [
        t if t.get("shared") else t | {"subject_id": book["subject_id"]} for t in topics
    ]


def topic_subjects(conn, topics: list[dict]) -> dict[str, str]:
    """The live subject of each of these topic ids that exists."""
    return dict(
        conn.execute(
            "SELECT id, subject_id FROM library_topics WHERE id = ANY(%s)",
            ([t["id"] for t in topics],),
        ).fetchall()
    )


def topic_upserts(topics: list[dict], live: dict[str, str]) -> list[dict]:
    """The topics a publish may upsert, given the live subject of each id.

    Topic ids are unique library-wide (decision 2026-09-23). A shared topic is
    another subject's and must be live there; it is never upserted. No upsert
    moves an existing topic to another subject: the clash fails loudly.
    """
    for topic in topics:
        subject = live.get(topic["id"])
        if topic.get("shared") and (
            not topic.get("subject_id") or subject != topic["subject_id"]
        ):
            raise PilotError(
                f"shared topic {topic['id']!r} is not live under subject "
                f"{topic.get('subject_id')!r} (found {subject!r}); a shared entry "
                "keeps its subject_id from the merge"
            )
        if not topic.get("shared") and subject not in (None, topic["subject_id"]):
            raise PilotError(
                f"topic {topic['id']!r} belongs to subject {subject!r}; publishing it "
                f"under {topic['subject_id']!r} would move it. Share it or rename it"
            )
    return [t for t in topics if not t.get("shared")]


def section_summary(corpus: dict) -> str:
    """The book's top-level section titles, in order, as its version summary."""
    titles = dict.fromkeys(
        e["section_path"].split(SECTION_SEP)[0].strip() for e in corpus["excerpts"]
    )
    return " · ".join(t for t in titles if t)[:SUMMARY_MAX_CHARS]


def apply_schema() -> dict:
    """Create the library schema exactly as `LIBRARY_SCHEMA` writes it and load
    the subjects fixture.

    The additive retrieval metadata and figure note columns preserve existing
    book versions.
    """
    with connect() as conn:
        conn.execute(SCHEMA)
        sync_subjects(conn, load_subjects())
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
    topics: list[dict],
    tags: dict,
    captures: dict,
    model_runs: list[dict],
    identity: str,
    note: str,
) -> dict:
    """Load one book as its next version and swap the book's pointer.

    The version's descriptor is the manifest attribution line and its summary
    the book's top-level section titles (decision 2026-09-19: no summary
    stage). Topics are upserted under the book's subject before the excerpts,
    and topics no tagged excerpt in the library references are dropped after.
    """
    book_id = book["id"]
    if not book.get("authors") and (
        book.get("attribution_reviewed") is not True or not book.get("attribution")
    ):
        raise PilotError(f"Book {book_id} needs attribution review before publication")
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
    from pipeline.retrieval.knowledge_metadata import indexed_text

    expected_text = {
        c["id"]: indexed_text(
            c["indexed_text"], tags["tags"].get(c["excerpt_id"], {}).get("retrieval")
        )
        for c in book_corpus["chunks"]
    }
    if any(row[4] != expected_text[row[0]] for row in rows):
        raise PilotError(
            f"Index is stale for {book_id}; run index after changing reviewed metadata"
        )
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
            "INSERT INTO library_excerpts VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
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
                    Jsonb(
                        {
                            **e["retrieval"],
                            "context_excerpt_ids": [
                                versioned(i, version)
                                for i in e["retrieval"]["context_excerpt_ids"]
                            ],
                        }
                    )
                    if e["retrieval"] is not None
                    else None,
                )
                for e in excerpts
            ],
        )
        figures = figure_rows(book_corpus, captures)
        insert_figures(target, content_id, version, figures)
        for topic in topic_upserts(topics, topic_subjects(target, topics)):
            # The WHERE also holds against a concurrent publish that claimed the id
            # after the lookup: a row of another subject is left alone and refused.
            upserted = target.execute(
                "INSERT INTO library_topics VALUES(%s,%s,%s,%s,%s,%s) ON CONFLICT (id) DO UPDATE SET "
                "label=EXCLUDED.label, aliases=EXCLUDED.aliases, "
                "scope=EXCLUDED.scope, source_sections=EXCLUDED.source_sections "
                "WHERE library_topics.subject_id = EXCLUDED.subject_id RETURNING id",
                (
                    topic["id"],
                    topic["subject_id"],
                    topic["label"],
                    Jsonb(topic["aliases"]),
                    topic["scope"],
                    topic.get("source_sections", ""),
                ),
            ).fetchone()
            if upserted is None:
                raise PilotError(
                    f"topic {topic['id']!r} is held by another subject; "
                    f"publishing it under {topic['subject_id']!r} would move it"
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
                book["attribution"],
                section_summary(book_corpus),
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
        dropped = drop_unreferenced_topics(target)
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
            "topics_dropped": dropped,
        },
    }


def select_books(manifest: dict, run: Path, book_ids: list[str]) -> list[dict]:
    """Manifest books to publish: the named ones, else every book the run holds."""
    books = {b["id"]: b for b in manifest["books"]}
    unknown = sorted(set(book_ids) - set(books))
    if unknown:
        raise PilotError(f"The manifest holds no book {unknown}")
    selected = [
        book
        for book in books.values()
        if (book["id"] in book_ids)
        or (not book_ids and (run / "books" / book["id"] / "corpus.json").exists())
    ]
    if not selected:
        raise PilotError(f"{run} holds no corpus for any manifest book")
    return selected


def publish(
    run: Path,
    manifest_path: Path,
    book_ids: list[str],
    note: str,
    config_path: Path | None = None,
) -> dict:
    import knowledge_base_pilot as pilot

    manifest = read_json(manifest_path)
    subjects = load_subjects()
    selected = select_books(manifest, run, book_ids)
    topics = {}
    for book in selected:
        if book.get("subject_id") not in subjects:
            raise PilotError(
                f"{book['id']}: subject {book.get('subject_id')!r} is not in {SUBJECTS.name}"
            )
        topics[book["id"]] = book_topics(run, manifest, book, subjects)
    corpora = {}
    for book in selected:
        corpus = read_json(run / "books" / book["id"] / "corpus.json")
        if corpus["source_id"] != pilot.book_identity(book):
            raise PilotError(
                f"{book['id']}: manifest edition/source identity differs from the parsed corpus"
            )
        corpora[book["id"]] = corpus
    tags = read_json(run / "tags.json")
    captures_path = run / "captures.json"
    captures = read_json(captures_path) if captures_path.exists() else {"captures": []}
    index = read_json(run / "index.json")
    pilot_url = read_json(config_path or run.parent / "config.json")["database_url"]
    model_runs = model_run_rows(run)
    started = time.time()
    receipts = []
    with psycopg.connect(pilot_url) as source, connect() as target:
        ensure_pin(target, tuple(index["pin"][key] for key in pilot.PIN))
        sync_subjects(target, subjects)
        for book in selected:
            book_corpus = corpora[book["id"]]
            receipt = publish_book(
                source,
                target,
                run=run,
                book=book,
                book_corpus=book_corpus,
                topics=topics[book["id"]],
                tags=tags,
                captures=captures,
                model_runs=model_runs,
                identity=corpus_identity(book_corpus, index["pin"], tags),
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
    """Drop a retained version's content rows, then the topics only it kept.

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
        dropped = drop_unreferenced_topics(conn)
    return status() | {"topics_dropped": dropped}


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
        subjects = conn.execute(
            "SELECT s.id, s.label, "
            "(SELECT count(*) FROM library_topics t WHERE t.subject_id = s.id) AS topics, "
            "(SELECT count(*) FROM library_excerpts e"
            " JOIN rag_file_contents fc ON fc.content_id = e.content_id AND fc.workspace_id = %s"
            " WHERE e.tag_status = 'tagged' AND e.topic_ids && ARRAY("
            "  SELECT id FROM library_topics t WHERE t.subject_id = s.id)) AS excerpts "
            "FROM library_subjects s "
            "WHERE EXISTS (SELECT 1 FROM library_topics t WHERE t.subject_id = s.id) "
            "ORDER BY s.id",
            (WORKSPACE,),
        ).fetchall()
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
                    (
                        "id",
                        "title",
                        "version",
                        "content_id",
                        "searchable_chunks",
                        "excerpts",
                    ),
                    book,
                )
            )
            | {"versions": history.get(book[0], [])}
            for book in books
        ],
        "topics": topics,
        "subjects": [
            dict(zip(("id", "label", "topics", "excerpts"), row)) for row in subjects
        ],
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
    assert figure_rows(corpus, {"captures": []})[0]["capture_path"] is None
    assert figures[0]["description"] == ""  # a pilot corpus: no transcribe stage
    corpus["figures"][0]["description"] = "a line from (0, 0) to (70, 140)"
    assert figure_rows(corpus, captures)[0]["description"].startswith("a line")
    assert digest({"a": 1}) == digest({"a": 1})

    # The version summary is the book's top-level section titles, once each, in
    # order, with empty paths skipped and the whole clipped.
    corpus["excerpts"][0]["section_path"] = f"Chapter 1{SECTION_SEP}1.1 Data"
    corpus["excerpts"][1]["section_path"] = ""
    corpus["excerpts"].append({"section_path": f"Chapter 1{SECTION_SEP}1.2 Cases"})
    corpus["excerpts"].append({"section_path": "Chapter 2"})
    assert section_summary(corpus) == "Chapter 1 · Chapter 2"
    assert len(section_summary({"excerpts": [{"section_path": "x" * 2000}]})) == 1000

    # Topics come from the run when its topics stage wrote them, else from the
    # manifest (the pilot), always carry the book's subject, and never share an
    # id with a subject.
    import tempfile

    book = {"id": "b", "subject_id": "statistics"}
    subjects = {
        "statistics": {"label": "Statistics"},
        "probability": {"label": "Probability"},
    }
    catalog = [{"id": "t1", "label": "T", "aliases": [], "scope": "s"}]
    with tempfile.TemporaryDirectory() as tmp:
        run = Path(tmp)
        assert (
            book_topics(run, {"topics": catalog}, book, subjects)[0]["subject_id"]
            == "statistics"
        )
        try:
            book_topics(run, {}, book, subjects)
            raise AssertionError("a run without topics.json needs manifest topics")
        except PilotError:
            pass
        colliding = {"topics": [{"id": "probability", "label": "Probability rules"}]}
        try:
            book_topics(run, colliding, book, subjects)
            raise AssertionError("a topic with a subject's id must be refused")
        except PilotError as exc:
            assert "topic 'probability' (Probability rules)" in str(exc)
            assert "subject 'probability' (Probability)" in str(exc)
        save_json(run / "topics.json", {"subject_id": "statistics", "topics": catalog})
        assert book_topics(run, {}, book, subjects) == [
            catalog[0] | {"subject_id": "statistics"}
        ]
        try:
            book_topics(run, {}, book | {"subject_id": "algebra"}, subjects)
            raise AssertionError("topics.json for another subject must be refused")
        except PilotError:
            pass
        # Books to publish: named ones must be in the manifest; unnamed means
        # every manifest book whose corpus the run holds.
        manifest = {"books": [{"id": "b"}, {"id": "c"}]}
        (run / "books/b").mkdir(parents=True)
        save_json(run / "books/b/corpus.json", {})
        assert [b["id"] for b in select_books(manifest, run, [])] == ["b"]
        assert [b["id"] for b in select_books(manifest, run, ["c"])] == ["c"]
        try:
            select_books(manifest, run, ["d"])
            raise AssertionError("a book the manifest lacks must be refused")
        except PilotError:
            pass
        # Receipts without the pilot's priced summary come from the stage state.
        (run / "models/tags/realtime").mkdir(parents=True)
        save_json(
            run / "models/tags/state.json", {"model": "m", "transport": "normal-api"}
        )
        save_json(
            run / "models/tags/realtime/state.json",
            {
                "normal_requests": 3,
                "collection": {"success": 3},
                "usage": {"prompt_tokens": 9},
            },
        )
        (run / "embedding-usage.jsonl").write_text(
            '{"stage":"b","inputs":2,"usage":{"embedTokens":50,"calls":1}}\n', "utf-8"
        )
        rows = {r["stage"]: r for r in model_run_rows(run)}
        assert rows["tags"]["attempts"] == 3 and rows["tags"]["usage"] == {
            "prompt_tokens": 9
        }
        assert (
            rows["tags"]["model"] == "m"
            and rows["tags"]["approximate_cost_usd"] is None
        )
        assert (
            rows["embeddings"]["usage"] == {"tokens": 50}
            and rows["embeddings"]["attempts"] == 1
        )
    assert "statistics" in load_subjects(), "the pilot books name this subject"

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
        "excerpts": [{"id": "e1"}, {"id": "e2"}],
        "figures": [],
    }
    tagged = {
        "tags": {"e1": {"roles": ["formal"], "topic_ids": ["t1"]}},
        "failed_tags": {"e2": {}},
    }
    assert corpus_identity(base, pin, tagged) == corpus_identity(
        dict(base), pin, dict(tagged)
    ), "an unchanged corpus must keep its identity so a republish is refused"
    assert corpus_identity(base, pin, tagged) != corpus_identity(
        base | {"parser_fingerprint": "fp2"}, pin, tagged
    )
    retagged = {
        "tags": {"e1": {"roles": ["formal"], "topic_ids": ["t2"]}},
        "failed_tags": {},
    }
    assert corpus_identity(base, pin, tagged) != corpus_identity(base, pin, retagged), (
        "a retag or topic rename changes the excerpt rows, so it is a new version"
    )

    # A missing object refuses the publish rather than recording a key that
    # would fail at capture time; a present one becomes books/<sha256>.pdf.
    from pipeline.store import blobstore

    present = {"books/" + "a" * 64 + ".pdf"}
    original = blobstore.library_object_info
    blobstore.library_object_info = lambda key: {"size": 1} if key in present else None
    try:
        assert verify_object("a" * 64) == "books/" + "a" * 64 + ".pdf"
        try:
            verify_object("b" * 64)
            raise AssertionError("a missing bucket object must refuse")
        except PilotError:
            pass
    finally:
        blobstore.library_object_info = original
    print(
        "Library excerpt/figure assembly, summary, topics, receipts, identity, id versioning and object checks passed"
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("schema", help="create or update the library-owned schema")
    p = sub.add_parser("publish", help="load a run's books as their next version")
    p.add_argument("--run", type=Path, required=True)
    p.add_argument(
        "--manifest",
        type=Path,
        default=MANIFEST,
        help="books with their subject_id; the pilot fixture also carries the topics its run has no topics.json for",
    )
    p.add_argument(
        "--config",
        type=Path,
        help="pilot config with the source database url; default <run>/../config.json",
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
    p = sub.add_parser(
        "retire",
        help="drop a retained version's content rows and the topics only it kept",
    )
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
                publish(
                    args.run.resolve(),
                    args.manifest,
                    args.book,
                    args.note,
                    args.config,
                )
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
