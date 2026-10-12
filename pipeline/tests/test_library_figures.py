"""Figure notes in the knowledge library: label, credit and decorative.

`schema` adds the columns to a library created before them, an older loader's
positional figure insert keeps working against the migrated table, and the
read tool lists the figures a model may pick.
"""

from __future__ import annotations

import secrets
from urllib.parse import urlsplit, urlunsplit

import psycopg
import test_library
from psycopg.types.json import Jsonb
from test_library import CURRENT, RETAINED

from pipeline.retrieval import library, tools
from pipeline.retrieval.tools import ToolContext

# The seeded library and the loader module of test_library.py.
library_db = test_library.library_db
loader = test_library.loader

# The schema as libraries created before the note columns hold it.
OLD_SCHEMA = "\n".join(
    line
    for line in library.LIBRARY_SCHEMA.splitlines()
    if not line.startswith("ALTER TABLE library_figures")
)
# The loader's figure insert before the note columns: 17 positional values.
OLD_INSERT = "INSERT INTO library_figures VALUES(" + ",".join(["%s"] * 17) + ")"
OLD_ROW = (
    "c",
    "f_old",
    "b",
    3,
    [0, 0, 10, 10],
    None,
    "page-1000-topleft",
    "parser_image",
    0,
    Jsonb([]),
    Jsonb([]),
    "1 Intro",
    False,
    Jsonb([]),
    None,
    None,
    "a photo",
)


def _figure(i: int, **notes) -> dict:
    return {
        "id": f"f{i}",
        "block_index": i,
        "page": 3,
        "bbox": [0, 0, 10, 10],
        "caption_bbox": None,
        "out_of_page_bounds": False,
        "geometry_kind": "parser_image",
        "space": "page-1000-topleft",
        "original_caption": [],
        "original_footnote": [],
        "section_path": "1 Intro",
        "excluded": False,
        "exclusion_evidence": [],
        **notes,
    }


def _columns(conn) -> list[str]:
    return [
        row[0]
        for row in conn.execute(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_name='library_figures' ORDER BY ordinal_position"
        )
    ]


def test_schema_migrates_an_existing_library_and_old_inserts_still_work(
    _test_infra, library_db, loader
):
    name = f"library_{secrets.token_hex(4)}"
    with psycopg.connect(_test_infra, autocommit=True) as conn:
        conn.execute(f'CREATE DATABASE "{name}"')
    dsn = urlunsplit(urlsplit(_test_infra)._replace(path=f"/{name}"))
    corpus = {
        "book": {"id": "b"},
        "figures": [
            _figure(1),
            _figure(
                2,
                label="Figure 1.2",
                description="a line",
                credit="CC BY 4.0",
                decorative=True,
            ),
        ],
    }
    with psycopg.connect(dsn, autocommit=True) as conn:
        conn.execute(OLD_SCHEMA)
        conn.execute("INSERT INTO rag_contents VALUES('c','ready')")
        conn.execute(OLD_INSERT, OLD_ROW)
        conn.execute(library.LIBRARY_SCHEMA)
        conn.execute(library.LIBRARY_SCHEMA)  # a second run changes nothing
        migrated = _columns(conn)
        conn.execute(OLD_INSERT, ("c", "f_old2", *OLD_ROW[2:]))
        loader.insert_figures(
            conn, "c", 2, loader.figure_rows(corpus, {"captures": []})
        )
        rows = conn.execute(
            "SELECT id, description, label, credit, decorative FROM library_figures "
            "ORDER BY id"
        ).fetchall()
    with psycopg.connect(library_db) as conn:
        assert migrated == _columns(conn), "a fresh library has the same columns"
    assert migrated[-4:] == ["description", "label", "credit", "decorative"]
    assert rows == [
        ("f1_v2", "", "", "", False),
        ("f2_v2", "a line", "Figure 1.2", "CC BY 4.0", True),
        ("f_old", "a photo", "", "", False),
        ("f_old2", "a photo", "", "", False),
    ]


async def test_decorative_and_excluded_figures_never_reach_a_model(library_db):
    insert = (
        "INSERT INTO library_figures (content_id,id,book_id,page,bbox,space,"
        "geometry_kind,block_index,original_caption,original_footnote,section_path,"
        "excluded,exclusion_evidence,description,label,credit,decorative) "
        "VALUES(%s,%s,'ahss',%s,'{0,0,10,10}','page-1000-topleft','parser_image',"
        "%s,'[]','[]','Ch 8',%s,'[]',%s,%s,%s,%s)"
    )
    with psycopg.connect(library_db, autocommit=True) as conn:
        for params in [
            (
                CURRENT,
                "fig_2",
                5,
                0,
                False,
                "Points and a line.",
                "Figure 8.2",
                "CC BY 4.0",
                False,
            ),
            (CURRENT, "fig_band", 5, 1, False, "", "", "", True),
            (
                CURRENT,
                "fig_nc",
                6,
                0,
                True,
                "A chart.",
                "Figure 8.3",
                "CC BY-NC",
                False,
            ),
            (RETAINED, "fig_2", 5, 0, False, "older", "older", "", False),
        ]:
            conn.execute(insert, params)
        conn.execute(
            "UPDATE library_excerpts SET figure_ids='{fig_1,fig_2,fig_band,fig_nc}' "
            "WHERE id='e_intro'"
        )
    read = await library.read_excerpt("e_intro")
    assert read.figures == [
        {
            "id": "fig_2",
            "label": "Figure 8.2",
            "description": "Points and a line.",
            "credit": "CC BY 4.0",
        },
        # published before the cleanup: no notes yet
        {"id": "fig_1", "label": "", "description": "", "credit": ""},
    ]
    assert (await library.read_excerpt("e_worked")).figures == []

    # No decorative or excluded id anywhere a model reads: read, browse, search.
    ctx = ToolContext(
        workspace_id="ws", operations=frozenset({"library.read"}), library=True
    )
    outputs = [
        (await tools._read_knowledge({"excerpt_id": "e_intro"}, ctx)).text(),
        (await tools._browse_knowledge({"topic": "linear-regression"}, ctx)).text(),
    ]
    assert "figures: fig_1, fig_2" in outputs[0] and "- fig_2: Figure 8.2" in outputs[0]
    for text in outputs:
        assert "fig_band" not in text and "fig_nc" not in text
    found = await library.search("regression", vector=test_library._unit_vector(0))
    assert found.excerpts[0].figure_ids == ["fig_1", "fig_2"]


async def test_read_knowledge_lists_figures_after_the_text(monkeypatch):
    ctx = ToolContext(
        workspace_id="ws", operations=frozenset({"library.read"}), library=True
    )
    figures = [
        {
            "id": "fig_2",
            "label": "Figure 8.2",
            "description": "A line.",
            "credit": "CC BY 4.0",
        },
        {"id": "fig_3", "label": "Figure 8.3", "description": "", "credit": ""},
        {"id": "fig_1", "label": "", "description": "", "credit": ""},
    ]

    async def _read(excerpt_id, *, start=0, **_kwargs):
        excerpt = library.Excerpt(
            id=excerpt_id,
            book_id="ahss",
            book_title="AHSS",
            section_path="8.1",
            roles=["introduction"],
            topic_ids=["linear-regression"],
            confidence=0.9,
            synopsis="notes",
            pages=[5],
            figure_ids=["fig_1", "fig_2", "fig_3"],
            chunk_ids=["c_1"],
        )
        return library.ExcerptRead(
            excerpt=excerpt,
            start=start,
            chunks=[{"chunk_idx": 0, "text": "Residuals."}],
            next_start=None,
            first=0,
            last=0,
            figures=figures if excerpt_id == "e_1" else [],
        )

    monkeypatch.setattr(tools.library, "read_excerpt", _read)
    text = (await tools._read_knowledge({"excerpt_id": "e_1"}, ctx)).text()
    assert text.endswith(
        "(chunk 0) Residuals.\n\nFigures:\n"
        "- fig_2: Figure 8.2 — A line. (credit: CC BY 4.0)\n"
        "- fig_3: Figure 8.3\n"
        "- fig_1\n\n(end of excerpt)"
    )
    bare = (await tools._read_knowledge({"excerpt_id": "e_2"}, ctx)).text()
    assert "Figures:" not in bare and bare.endswith("Residuals.\n\n(end of excerpt)")


# ------------------------------------------------------------ figures in notes


async def test_figures_say_whether_the_library_shows_them(library_db):
    found = await library.figures(["fig_1", "fig_missing"])
    assert list(found) == ["fig_1"]
    figure = found["fig_1"]
    assert (figure.page, figure.object_key, figure.excerpt_ids) == (
        7,
        "books/sha.pdf",
        ["e_intro"],
    ), "the current version's figure, with the excerpt that lists it"
    assert not (figure.withheld or figure.excluded or figure.decorative)
    with psycopg.connect(library_db, autocommit=True) as conn:
        conn.execute(
            "UPDATE library_books SET withheld_pages = '{7}' WHERE id = 'ahss'"
        )
    assert (await library.figures(["fig_1"]))["fig_1"].withheld


def _figure_writes(monkeypatch):
    """A Library-on context whose renders and gateway posts are recorded."""
    from test_agent import _created, _gateway_receipt, _library_ctx

    ctx = _library_ctx(monkeypatch)
    rendered: list[tuple] = []

    async def _render(object_key, size, page, bbox, max_edge):
        rendered.append((object_key, page, bbox))
        return b"\xff\xd8\xffjpeg", bbox, (1, 1)

    monkeypatch.setattr(tools.capture, "render_knowledge", _render)
    sent = _gateway_receipt(monkeypatch, _created("mat_1", "Fit"))
    return ctx, rendered, sent


async def test_a_note_shows_a_figure_it_read_with_the_printed_credit(
    library_db, monkeypatch
):
    with psycopg.connect(library_db, autocommit=True) as conn:
        conn.execute(
            "UPDATE library_figures SET label = 'Figure 1: [Scatter] plot', "
            "credit = 'CC BY-SA, OpenIntro' WHERE id = 'fig_1'"
        )
    ctx, rendered, sent = _figure_writes(monkeypatch)
    note = {
        "kind": "note",
        "content": "# Fit\n\n![](figure:fig_1)\n\n![a cell](https://e.com/c.png)",
        "_tool_call_id": "c1",
    }

    unread = await tools._create_material(note, ctx)
    assert unread.refused and "e_intro" in unread.text() and not sent

    ctx.ledger.note_read("e_intro", 0, "8.1")
    result = await tools._create_material(note, ctx)
    assert not result.refused, result.text()
    body = sent[0]
    assert body["content"] == (
        "# Fit\n\n![Figure 1: \\[Scatter\\] plot (CC BY-SA, OpenIntro)](figure:fig_1)"
        "\n\n![a cell](https://e.com/c.png)"
    ), "the caption is the printed label and credit"
    assert body["figures"] == [{"id": "fig_1", "image": "/9j/anBlZw=="}]
    assert rendered == [("books/sha.pdf", 7, [0.0, 0.0, 10.0, 10.0])]
    assert body["provenance"]["books"][0]["excerptIds"] == ["e_intro"], (
        "the figure's excerpt is credited without being named"
    )
    assert "1 image(s) with a web URL became links" in result.text()


async def test_figures_the_library_does_not_show_or_box_refuse_the_write(
    library_db, monkeypatch
):
    ctx, rendered, sent = _figure_writes(monkeypatch)
    ctx.ledger.note_read("e_intro", 0, "8.1")
    edit = {
        "target": {"kind": "material", "id": "mat_1"},
        "commands": [
            {
                "type": "insert_markdown",
                "after_block_id": None,
                "markdown": "![x](figure:fig_1)",
            }
        ],
        "excerpt_ids": ["e_intro"],
        "_tool_call_id": "c2",
    }

    def figure(*sql: str) -> None:
        with psycopg.connect(library_db, autocommit=True) as conn:
            for statement in sql:
                conn.execute(statement)

    for change, reason in (
        ("UPDATE library_figures SET excluded = true", "is not shown by the library"),
        ("UPDATE library_figures SET decorative = true", "is not shown by the library"),
        ("UPDATE library_excerpts SET figure_ids = '{}'", "is listed by no excerpt"),
        (
            "UPDATE library_books SET withheld_pages = '{7}'",
            "is on a page the library withholds",
        ),
        (
            "UPDATE library_figures SET bbox = '{0,0,1000,1000}'",
            "has no box of its own",
        ),
    ):
        figure(change)
        result = await tools._edit_document(edit, ctx)
        assert result.refused and f"fig_1 {reason}" in result.text(), change
        figure(
            "UPDATE library_figures SET excluded = false, decorative = false",
            "UPDATE library_excerpts SET figure_ids = '{fig_1}' WHERE id = 'e_intro'",
            "UPDATE library_books SET withheld_pages = '{}'",
            "UPDATE library_figures SET bbox = '{0,0,10,10}'",
        )
    assert not rendered and not sent

    placed = await tools._edit_document(edit, ctx)
    assert not placed.refused, placed.text()
    assert sent[0]["figures"][0]["id"] == "fig_1"
    assert sent[0]["commands"][0]["markdown"] == "![x](figure:fig_1)"
