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
        workspace_id="ws", operations=frozenset({"library.read"}), curate=True
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
        workspace_id="ws", operations=frozenset({"library.read"}), curate=True
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
