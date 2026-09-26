"""Knowledge library reads: verified-tag filters, excerpt folding, browsing.

The library is a separate database in the test Postgres container, created
from ``LIBRARY_SCHEMA`` and seeded with one book at version 2 (four chunks,
three excerpts) plus its retained version 1, which no read may ever see.
Vectors are one-hot so distances are predictable, and search is given its
query vector directly, so no embedding call happens.
"""

from __future__ import annotations

import asyncio
import importlib.util
import secrets
import sys
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

import psycopg
import pytest

from pipeline.config import cfg
from pipeline.retrieval import library, store
from pipeline.retrieval.chunking import tokenize_for_search

CURRENT = "ahss_v2"
RETAINED = "ahss_v1"
PIN = ("deepinfra", "Qwen/Qwen3-Embedding-4B", 1, 2560)
OPS_SCHEMA_FIXTURE = (
    Path(__file__).resolve().parents[2]
    / "server/internal/ops/testdata/library_schema.sql"
)


def test_ops_schema_fixture_matches_the_owned_schema():
    """The ops Library section reads this schema; Python owns it."""
    assert OPS_SCHEMA_FIXTURE.read_bytes() == library.LIBRARY_SCHEMA.encode(), (
        f"regenerate {OPS_SCHEMA_FIXTURE} from LIBRARY_SCHEMA"
    )


def _unit_vector(axis: int) -> list[float]:
    vector = [0.0] * cfg.embedding_dim
    vector[axis % cfg.embedding_dim] = 1.0
    return vector


def _seed(dsn: str) -> None:
    chunks = [
        # id, content, excerpt, text, axis
        (CURRENT, "c_intro", "e_intro", "Regression introduces a fitted line", 0),
        (
            CURRENT,
            "c_worked_a",
            "e_worked",
            "Worked example: predict aid from family income",
            1,
        ),
        (
            CURRENT,
            "c_worked_b",
            "e_worked",
            "Worked example continued: extrapolation warning",
            2,
        ),
        (CURRENT, "c_shaky", "e_shaky", "Worked example nobody verified", 1),
        (RETAINED, "c_old", "e_old", "Worked example from the older parse", 1),
    ]
    excerpts = {
        # content, roles, topics, confidence, verified, chunk ids, figure ids
        "e_intro": (
            CURRENT,
            ["introduction"],
            ["linear-regression"],
            0.95,
            True,
            ["c_intro"],
            ["fig_1"],
        ),
        "e_worked": (
            CURRENT,
            ["worked_example"],
            ["linear-regression"],
            0.9,
            True,
            ["c_worked_a", "c_worked_b"],
            [],
        ),
        "e_shaky": (
            CURRENT,
            ["worked_example"],
            ["linear-regression"],
            0.4,
            False,
            ["c_shaky"],
            [],
        ),
        "e_old": (
            RETAINED,
            ["worked_example"],
            ["linear-regression"],
            0.95,
            True,
            ["c_old"],
            [],
        ),
    }
    with psycopg.connect(dsn, autocommit=True) as conn:
        conn.execute(library.LIBRARY_SCHEMA)
        conn.execute(
            "INSERT INTO workspaces VALUES(%s,%s,%s,%s,%s)", (library.WORKSPACE, *PIN)
        )
        conn.execute(
            "INSERT INTO files(id,name) VALUES('ahss','Advanced High School Statistics')"
        )
        conn.execute(
            "INSERT INTO rag_contents VALUES(%s,'ready'),(%s,'ready')",
            (RETAINED, CURRENT),
        )
        conn.execute(
            "INSERT INTO rag_file_contents VALUES('ahss',%s,%s)",
            (library.WORKSPACE, CURRENT),
        )
        conn.execute(
            "INSERT INTO library_books VALUES('ahss','Advanced High School Statistics','[]','4e','https://x','https://x','CC BY-SA','https://x','attr','sha',1024,10,1,%s,2,'[]','[]')",
            (CURRENT,),
        )
        conn.execute(
            "INSERT INTO library_book_versions"
            "(book_id,version,content_id,status,source_run,corpus_identity,parser_release,parser_fingerprint,chunker_version,descriptor,summary,object_key)"
            " VALUES('ahss',1,%s,'retained','run','id1','sha','fp','v10','old desc','old summary','books/old.pdf'),"
            "('ahss',2,%s,'current','run','id2','sha','fp','v10','desc','summary','books/sha.pdf')",
            (RETAINED, CURRENT),
        )
        conn.execute(
            "INSERT INTO library_figures VALUES(%s,'fig_1','ahss',7,'{0,0,10,10}',NULL,'page-1000-topleft','parser_image',0,'[]','[]','Ch 8',false,'[]',NULL,NULL)",
            (CURRENT,),
        )
        conn.execute(
            "INSERT INTO library_subjects VALUES('statistics','mathematics','Statistics','[\"stats\"]'),"
            "('algebra','mathematics','Algebra','[]')"
        )
        # An algebra topic no excerpt carries: the loader's drop rule removes it.
        conn.execute(
            "INSERT INTO library_topics VALUES('linear-regression','statistics','Linear regression','[\"least squares\"]','Fitting lines','AHSS 8'),"
            "('factoring','algebra','Factoring','[]','Factoring polynomials','')"
        )
        for i, (content_id, chunk_id, excerpt_id, text, axis) in enumerate(chunks):
            conn.execute(
                "INSERT INTO library_chunks VALUES(%s,%s,%s,%s,'Ch 8',%s,%s,%s,%s,'[]','en',0.9,'{}',to_tsvector('english',%s),true,'ahss',%s,false)",
                (
                    chunk_id,
                    library.WORKSPACE,
                    content_id,
                    i,
                    text,
                    text,
                    i + 1,
                    i + 1,
                    tokenize_for_search(text),
                    excerpt_id,
                ),
            )
            conn.execute(
                "INSERT INTO rag_chunk_vectors_2560 VALUES(%s,%s,%s::halfvec)",
                (chunk_id, library.WORKSPACE, store.vector_literal(_unit_vector(axis))),
            )
        for excerpt_id, (
            content_id,
            roles,
            topics,
            confidence,
            verified,
            chunk_ids,
            figure_ids,
        ) in excerpts.items():
            conn.execute(
                "INSERT INTO library_excerpts VALUES(%s,%s,'ahss','Ch 8',%s,'{1}','[]',%s,'text','tagged',%s,%s,%s,'quote',%s,'synopsis',NULL,'{}')",
                (
                    content_id,
                    excerpt_id,
                    chunk_ids,
                    figure_ids,
                    roles,
                    topics,
                    confidence,
                    verified,
                ),
            )


@pytest.fixture
async def library_db(_test_infra, monkeypatch):
    """A fresh live library beside the app database."""
    parts = urlsplit(_test_infra)
    name = f"library_{secrets.token_hex(4)}"
    with psycopg.connect(_test_infra, autocommit=True) as conn:
        conn.execute(f'CREATE DATABASE "{name}"')
    dsn = urlunsplit(parts._replace(path=f"/{name}"))
    _seed(dsn)
    monkeypatch.setattr(cfg, "library_dsn", dsn)
    monkeypatch.setattr(cfg, "library_tag_min_confidence", 0.8)
    yield dsn
    await library.close_pool()


async def test_search_folds_chunks_into_excerpts_and_honours_role_filter(library_db):
    result = await library.search(
        "worked example", roles=["worked_example"], vector=_unit_vector(1)
    )
    assert [e.id for e in result.excerpts] == ["e_worked"], (
        "the unverified excerpt and the retained version share the query axis "
        "and must never appear"
    )
    hit = result.excerpts[0]
    assert hit.hit_chunk_id == "c_worked_a" and hit.chunk_ids == [
        "c_worked_a",
        "c_worked_b",
    ]
    assert hit.book_title == "Advanced High School Statistics" and hit.roles == [
        "worked_example"
    ]


async def test_search_without_facets_still_requires_verified_tags(library_db):
    result = await library.search("regression", vector=_unit_vector(0))
    assert [e.id for e in result.excerpts] == ["e_intro", "e_worked"]
    assert result.available_roles is None


async def test_topics_only_filter_returns_that_topic_hits(library_db):
    result = await library.search(
        "regression", topics=["linear-regression"], vector=_unit_vector(0)
    )
    assert [e.id for e in result.excerpts] == ["e_intro", "e_worked"]
    assert result.topics == ["linear-regression"] and result.roles == []

    absent = await library.search(
        "regression", topics=["calculus"], vector=_unit_vector(0)
    )
    assert absent.excerpts == []
    assert absent.available_roles is None, "no role filter to relax"


async def test_top_k_folds_the_hits_into_that_many_excerpts(library_db):
    """Two chunks of one excerpt are one result, so top_k counts excerpts."""
    one = await library.search("worked example", top_k=1, vector=_unit_vector(1))
    assert [e.id for e in one.excerpts] == ["e_worked"]
    assert one.excerpts[0].chunk_ids == ["c_worked_a", "c_worked_b"]

    two = await library.search("worked example", top_k=2, vector=_unit_vector(1))
    assert [e.id for e in two.excerpts] == ["e_worked", "e_intro"]


async def test_reranked_chunks_fold_into_excerpts(library_db, monkeypatch):
    """The reranker's best chunk leads, and becomes its excerpt's hit."""
    from pipeline.retrieval import models, search

    async def rerank(query, documents, *, spec):
        return [1.0 if "extrapolation" in text else 0.0 for text in documents]

    monkeypatch.setattr(search, "_rerank_spec", lambda: "rerank-spec")
    monkeypatch.setattr(models, "rerank", rerank)

    result = await library.search("regression", vector=_unit_vector(0))
    assert [(e.id, e.hit_chunk_id) for e in result.excerpts] == [
        ("e_worked", "c_worked_b"),
        ("e_intro", "c_intro"),
    ]


async def test_empty_role_filter_reports_what_the_topic_holds(library_db):
    result = await library.search(
        "exercises",
        topics=["linear-regression"],
        roles=["exercise"],
        vector=_unit_vector(0),
    )
    assert result.excerpts == []
    assert result.available_roles == {"introduction": 1, "worked_example": 1}


async def test_duplicate_hit_does_not_hide_a_later_distinct_hit_of_its_excerpt(
    library_db,
):
    with psycopg.connect(library_db, autocommit=True) as conn:
        conn.execute(
            "UPDATE library_chunks SET text=(SELECT text FROM library_chunks WHERE id='c_intro') WHERE id='c_worked_a'"
        )
        conn.execute(
            "UPDATE library_excerpts SET roles='{worked_example,worked_example}' WHERE id='e_worked'"
        )
    result = await library.search("regression", vector=_unit_vector(0), top_k=2)
    assert [(e.id, e.hit_chunk_id) for e in result.excerpts] == [
        ("e_intro", "c_intro"),
        ("e_worked", "c_worked_b"),
    ]
    assert (await library.browse("linear-regression")).by_role["worked_example"] == 1


async def test_a_role_filter_without_topics_counts_nothing(library_db):
    """The whole library's role counts say nothing about the query."""
    result = await library.search(
        "exercises", roles=["exercise"], vector=_unit_vector(0)
    )
    assert result.excerpts == [] and result.available_roles is None


async def test_catalog_lists_subjects_that_hold_tagged_excerpts(library_db):
    """Algebra is in the fixture with a topic but no excerpt, so it is absent;
    the statistics count is tagged excerpts of the current version only."""
    db = await library.pool()
    async with db.connection() as conn:
        subjects = await library.catalog(conn)
    assert subjects == [
        {
            "id": "statistics",
            "label": "Statistics",
            "aliases": ["stats"],
            "area": "mathematics",
            "excerpts": 2,
        }
    ]


async def test_browse_subject_lists_its_topics_with_tagged_excerpt_counts(library_db):
    listing = await library.browse_subject("statistics")
    assert listing["subject"]["label"] == "Statistics"
    topics = listing["topics"]
    assert [(t["id"], t["excerpts"]) for t in topics] == [("linear-regression", 2)]
    assert topics[0]["scope"] == "Fitting lines"
    assert (await library.browse_subject("algebra"))["topics"] == [
        {
            "id": "factoring",
            "label": "Factoring",
            "aliases": [],
            "scope": "Factoring polynomials",
            "excerpts": 0,
        }
    ]
    assert await library.known_topics(["factoring", "calculus"]) == {"factoring"}


async def test_browse_reads_the_catalog_its_argument_names(library_db):
    """A topic and a subject may share an id; each function reads its own
    catalog, so the caller's intent decides, never lookup order."""
    with psycopg.connect(library_db, autocommit=True) as conn:
        conn.execute(
            "INSERT INTO library_subjects VALUES('linear-regression','mathematics','Linear Regression (course)','[]')"
        )
    topic = await library.browse("linear-regression")
    assert isinstance(topic, library.BrowseResult) and topic.total == 2
    subject = await library.browse_subject("linear-regression")
    assert subject["subject"]["label"] == "Linear Regression (course)"
    assert subject["topics"] == []


async def test_unknown_role_and_ids_are_refused_naming_the_catalog(library_db):
    with pytest.raises(ValueError):
        await library.search("x", roles=["lecture"], vector=_unit_vector(0))
    with pytest.raises(ValueError, match="unknown topic id 'statistics'"):
        await library.browse("statistics")
    with pytest.raises(ValueError, match="unknown subject id 'linear-regression'"):
        await library.browse_subject("linear-regression")


async def test_browse_counts_verified_excerpts_by_role_and_book(library_db):
    result = await library.browse("linear-regression")
    assert result.topic["label"] == "Linear regression"
    assert result.by_role == {"introduction": 1, "worked_example": 1}
    assert result.by_book == {"ahss": 2} and result.total == 2
    assert [e.id for e in result.items] == ["e_intro", "e_worked"]
    assert result.items[0].synopsis == "synopsis" and result.items[0].hit_chunk_id == ""


async def test_reviewed_scope_and_teaching_eligibility_agree_across_search_and_counts(
    library_db,
):
    from psycopg.types.json import Jsonb

    metadata = {
        "summary": "A fitted line",
        "scope": "One predictor; independent of software.",
        "context_excerpt_ids": ["e_worked"],
    }
    with psycopg.connect(library_db, autocommit=True) as conn:
        conn.execute(
            "UPDATE library_excerpts SET retrieval=%s WHERE id='e_intro'",
            (Jsonb(metadata),),
        )
        conn.execute(
            "UPDATE library_excerpts SET roles='{non_teaching}' WHERE id='e_worked'"
        )
    found = await library.search("regression", vector=_unit_vector(1))
    assert [e.id for e in found.excerpts] == ["e_intro"]
    assert found.excerpts[0].retrieval == metadata
    assert (await library.read_excerpt("e_intro")).excerpt.synopsis == "synopsis"
    assert (await library.browse_subject("statistics"))["topics"][0]["excerpts"] == 1
    assert (await library.browse("linear-regression")).total == 1
    with psycopg.connect(library_db, autocommit=True) as conn:
        conn.execute("UPDATE library_chunks SET searchable=false WHERE id='c_intro'")
    assert (await library.search("regression", vector=_unit_vector(1))).excerpts == []
    assert (await library.browse("linear-regression")).total == 0
    db = await library.pool()
    async with db.connection() as conn:
        assert await library.catalog(conn) == []


async def test_browse_pages_within_bounds_and_refuses_bad_ones(library_db):
    first = await library.browse("linear-regression", page=1, page_size=1)
    assert [e.id for e in first.items] == ["e_intro"]
    assert first.total == 2, "the total is the topic's, not the page's"

    second = await library.browse("linear-regression", page=2, page_size=1)
    assert [e.id for e in second.items] == ["e_worked"]

    past = await library.browse("linear-regression", page=9, page_size=1)
    assert past.items == [] and past.total == 2

    for bad in ({"page": 0}, {"page_size": 0}, {"page_size": 51}):
        with pytest.raises(ValueError):
            await library.browse("linear-regression", **bad)


async def test_read_excerpt_pages_by_chunk_index(library_db):
    """`start` is a chunk index of the book, the unit read_document pages in."""
    first = await library.read_excerpt("e_worked", count=1)
    assert [c["id"] for c in first.chunks] == ["c_worked_a"]
    assert (first.first, first.last) == (1, 2), "the excerpt's own chunk range"
    assert first.next_start == 2, "the last chunk shown plus one"
    assert first.excerpt.section_path == "Ch 8"

    rest = await library.read_excerpt("e_worked", start=first.next_start, count=1)
    assert [c["id"] for c in rest.chunks] == ["c_worked_b"]
    assert rest.next_start is None, "the last page must not invite another read"

    with pytest.raises(ValueError):
        await library.read_excerpt("e_missing")
    with pytest.raises(ValueError, match="count"):
        await library.read_excerpt("e_worked", count=99)


async def test_a_retained_book_version_is_invisible(library_db):
    """Only the content rag_file_contents points at is the library."""
    with pytest.raises(ValueError):
        await library.read_excerpt("e_old")
    with pytest.raises(ValueError):
        await library.provenance(["e_old"])


async def test_provenance_groups_excerpts_by_book_with_its_version(library_db):
    books = await library.provenance(["e_worked", "e_intro", "e_worked"])
    assert len(books) == 1
    book = books[0]
    assert book["id"] == "ahss" and book["license"] == "CC BY-SA"
    assert book["sourceUrl"] == "https://x" and book["edition"] == "4e"
    assert book["version"] == 2, (
        "a material records the book version it was written from"
    )
    assert sorted(book["excerptIds"]) == ["e_intro", "e_worked"]

    with pytest.raises(ValueError):
        await library.provenance(["e_intro", "e_nope"])


async def test_capture_target_covers_the_excerpt_and_its_figure_pages(library_db):
    target = await library.capture_target("e_intro")
    assert target.object_key == "books/sha.pdf" and target.bytes == 1024
    assert target.book_title == "Advanced High School Statistics"
    assert target.pages == [1, 7], "the excerpt's own page plus its figure's page"
    assert (await library.capture_target("e_worked")).pages == [1]

    with pytest.raises(ValueError):
        await library.capture_target("e_missing")


async def test_capture_target_drops_the_book_withheld_pages(library_db):
    with psycopg.connect(library_db, autocommit=True) as conn:
        conn.execute(
            "UPDATE library_books SET withheld_pages = '{7}' WHERE id = 'ahss'"
        )
    target = await library.capture_target("e_intro")
    assert target.pages == [1], "the figure's withheld page is dropped too"
    assert target.withheld_pages == [7]


# ------------------------------------------------------------------- loader
#
# The loader owns this schema, so the version moves it makes are checked
# against the same seeded library the reader is. Publishing needs the pilot's
# own database and run directory, which this fixture has no equivalent of.

LOADER = (
    Path(__file__).resolve().parents[2] / "bench/rag/scripts/knowledge_base_library.py"
)


@pytest.fixture
def loader(library_db, monkeypatch):
    monkeypatch.setenv("LIBRARY_DATABASE_URL", library_db)
    sys.path.insert(0, str(LOADER.parent))
    spec = importlib.util.spec_from_file_location("knowledge_base_library", LOADER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


async def test_loader_rollback_points_the_book_at_a_retained_version(
    loader, library_db
):
    out = loader.rollback("ahss", 1)

    versions = {v["version"]: v["status"] for v in out["books"][0]["versions"]}
    assert versions == {1: "current", 2: "retained"}
    assert out["books"][0]["version"] == 1
    # The reader follows rag_file_contents, so the swap is what it sees.
    assert (await library.read_excerpt("e_old")).excerpt.book_id == "ahss"
    with pytest.raises(ValueError):
        await library.read_excerpt("e_intro")

    with pytest.raises(loader.PilotError):
        loader.rollback("ahss", 1)  # already current
    with pytest.raises(loader.PilotError):
        loader.rollback("ahss", 9)


async def test_loader_retire_drops_content_rows_and_keeps_the_receipts(
    loader, library_db
):
    with psycopg.connect(library_db, autocommit=True) as conn:
        conn.execute(
            "INSERT INTO library_model_runs VALUES('ahss',%s,'tagging','normal','m',1,'{}','{}',NULL,NULL,NULL,'p')",
            (RETAINED,),
        )

    with pytest.raises(loader.PilotError):
        loader.retire("ahss", 2)  # the current version is not retirable

    out = loader.retire("ahss", 1)

    versions = {v["version"]: v["status"] for v in out["books"][0]["versions"]}
    assert versions == {1: "retired", 2: "current"}
    with psycopg.connect(library_db, autocommit=True) as conn:
        counts = {
            table: conn.execute(
                f"SELECT count(*) FROM {table} WHERE content_id=%s", (RETAINED,)
            ).fetchone()[0]
            for table in ("library_chunks", "library_excerpts", "library_model_runs")
        }
        vectors = conn.execute(
            "SELECT count(*) FROM rag_chunk_vectors_2560 WHERE chunk_id='c_old'"
        ).fetchone()[0]
    assert counts == {
        "library_chunks": 0,
        "library_excerpts": 0,
        "library_model_runs": 1,
    }
    assert vectors == 0
    assert out["books"][0]["searchable_chunks"] == 4, "the live version is untouched"


async def test_loader_drops_a_topic_only_when_no_kept_version_carries_it(
    loader, library_db
):
    """A retained version's excerpts keep their topics, so a rollback never
    points at excerpts whose topics are gone; retiring the version drops them."""
    with psycopg.connect(library_db, autocommit=True) as conn:
        conn.execute(
            "UPDATE library_excerpts SET topic_ids='{factoring}' WHERE content_id=%s",
            (RETAINED,),
        )
        assert loader.drop_unreferenced_topics(conn) == 0
    loader.rollback("ahss", 1)
    assert (await library.browse("factoring")).total == 1

    loader.rollback("ahss", 2)
    out = loader.retire("ahss", 1)
    assert out["topics_dropped"] == 1
    with psycopg.connect(library_db, autocommit=True) as conn:
        left = [r[0] for r in conn.execute("SELECT id FROM library_topics")]
    assert left == ["linear-regression"]


def test_loader_remove_deletes_every_row_of_the_book(loader, library_db):
    """Both versions and their receipts go with the book; a topic only it
    carried is dropped and one another book carries stays."""
    with psycopg.connect(library_db, autocommit=True) as conn:
        conn.execute(
            "INSERT INTO library_model_runs VALUES('ahss',%s,'tagging','normal','m',1,'{}','{}',NULL,NULL,NULL,'p')",
            (RETAINED,),
        )
        conn.execute(
            "UPDATE library_excerpts SET topic_ids='{factoring}' WHERE content_id=%s",
            (RETAINED,),
        )
        conn.execute("INSERT INTO files(id,name) VALUES('os','OpenIntro Statistics')")
        conn.execute("INSERT INTO rag_contents VALUES('os_v1','ready')")
        conn.execute(
            "INSERT INTO rag_file_contents VALUES('os',%s,'os_v1')",
            (library.WORKSPACE,),
        )
        conn.execute(
            "INSERT INTO library_books VALUES('os','OpenIntro Statistics','[]','4e','https://x','https://x','CC BY-SA','https://x','attr','sha2',1024,10,1,'os_v1',1,'[]','[]')"
        )
        conn.execute(
            "INSERT INTO library_book_versions"
            "(book_id,version,content_id,status,source_run,corpus_identity,parser_release,parser_fingerprint,chunker_version,descriptor,summary,object_key)"
            " VALUES('os',1,'os_v1','current','run','id','sha','fp','v10','desc','summary','books/sha2.pdf')"
        )
        conn.execute(
            "INSERT INTO library_excerpts VALUES('os_v1','e_os','os','Ch 1','{}','{1}','[]','{}','text','tagged','{introduction}','{linear-regression}',0.9,'quote',true,'synopsis',NULL,'{}')"
        )

    with pytest.raises(loader.PilotError):
        loader.remove("missing")

    out = loader.remove("ahss")

    assert [(b["id"], b["excerpts"]) for b in out["books"]] == [("os", 1)]
    assert out["deleted"]["library_book_versions"] == 2
    assert out["deleted"]["rag_chunk_vectors_2560"] == 5
    assert out["topics_dropped"] == 1
    with psycopg.connect(library_db, autocommit=True) as conn:
        left = {
            table: conn.execute(
                f"SELECT count(*) FROM {table} WHERE {column}='ahss'"
            ).fetchone()[0]
            for table, column in (
                ("library_books", "id"),
                ("library_book_versions", "book_id"),
                ("files", "id"),
                ("rag_file_contents", "file_id"),
                ("library_chunks", "book_id"),
                ("library_excerpts", "book_id"),
                ("library_figures", "book_id"),
                ("library_model_runs", "book_id"),
            )
        }
        left["rag_contents"] = conn.execute(
            "SELECT count(*) FROM rag_contents WHERE id = ANY(%s)",
            ([CURRENT, RETAINED],),
        ).fetchone()[0]
        left["rag_chunk_vectors_2560"] = conn.execute(
            "SELECT count(*) FROM rag_chunk_vectors_2560"
        ).fetchone()[0]
        topics = [r[0] for r in conn.execute("SELECT id FROM library_topics")]
    assert set(left.values()) == {0}, left
    assert topics == ["linear-regression"]


def test_loader_refuses_to_drop_a_subject_that_still_holds_topics(loader, library_db):
    fixture = {
        "statistics": {
            "id": "statistics",
            "area": "mathematics",
            "label": "Stats",
            "aliases": [],
        }
    }
    with psycopg.connect(library_db, autocommit=True) as conn:
        conn.execute("INSERT INTO library_subjects VALUES('idle','arts','Idle','[]')")
        with pytest.raises(loader.PilotError, match=r"\['algebra'\]"):
            loader.sync_subjects(conn, fixture)
        rows = conn.execute(
            "SELECT id, label FROM library_subjects ORDER BY id"
        ).fetchall()
    # The fixture's entries were refreshed and the topic-less one dropped
    # before the refusal; the referenced one stays.
    assert rows == [("algebra", "Algebra"), ("statistics", "Stats")]


def test_loader_status_counts_topics_and_excerpts_per_subject(loader, library_db):
    assert loader.status()["subjects"] == [
        {"id": "algebra", "label": "Algebra", "topics": 1, "excerpts": 0},
        {"id": "statistics", "label": "Statistics", "topics": 1, "excerpts": 3},
    ]


def test_loader_summary_is_the_top_level_section_titles(loader):
    sep = loader.SECTION_SEP
    corpus = {
        "excerpts": [
            {"section_path": f"Preface{sep}Overview"},
            {"section_path": f"Chapter 1{sep}1.1 Data"},
            {"section_path": ""},
            {"section_path": f"Chapter 1{sep}1.2 Cases"},
            {"section_path": "Chapter 2"},
        ]
    }
    assert loader.section_summary(corpus) == "Preface · Chapter 1 · Chapter 2"


def test_knowledge_bucket_settings_are_all_or_none():
    from pipeline.config import require_all_or_none

    require_all_or_none("KNOWLEDGE_BASE_B2_*", {"ENDPOINT": "", "BUCKET": ""})
    require_all_or_none("KNOWLEDGE_BASE_B2_*", {"ENDPOINT": "https://x", "BUCKET": "b"})
    with pytest.raises(ValueError, match="KNOWLEDGE_BASE_B2_ENDPOINT"):
        require_all_or_none(
            "KNOWLEDGE_BASE_B2_*",
            {"KNOWLEDGE_BASE_B2_ENDPOINT": "", "KNOWLEDGE_BASE_B2_BUCKET": "b"},
        )


async def test_an_unconfigured_library_is_terminal(monkeypatch):
    from pipeline.jobs import TerminalError

    monkeypatch.setattr(cfg, "library_dsn", "")
    with pytest.raises(TerminalError):
        await library.pool()


async def test_two_turns_starting_together_share_one_pool(library_db):
    """Without the lock each would open its own and one would leak unclosed."""
    first, second = await asyncio.gather(library.pool(), library.pool())
    assert first is second
