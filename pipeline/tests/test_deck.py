"""Deck tools: create_deck outlines, write_slide checks each slide alone with
ppt-master's checker, and the deck is exported and stored as a workspace file
once every slide is written. ppt-master itself is stubbed here; the playground's
--check runs the real checker and exporter."""

from __future__ import annotations

import re
import threading
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace

import pytest

from pipeline.retrieval import capture, deck, library, skills, tools
from pipeline.retrieval.tools import ToolContext

_EDITOR = frozenset(
    {"source.read", "material.read", "material.create", "document.edit"}
)


def _slide(
    body: str = '<text x="64" y="300">A tangent meets the radius.</text>',
) -> str:
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720" lang="en" '
        'data-pptx-page-role="content" font-family="Arial" font-size="20">'
        '<rect id="background" data-pptx-role="background" x="0" y="0" width="1280" height="720"/>'
        f'<g id="body" data-pptx-bounds="64 260 1152 60">{body}</g></svg>'
    )


def _figure(n: int) -> str:
    return _slide(
        f'<image href="../images/c{n}.jpg" x="64" y="260" width="40" height="30"/>'
    )


@pytest.fixture
def decks(monkeypatch, tmp_path):
    """A turn that can write decks, with the checker, the exporter and the
    gateway stubbed. A slide holding SPILL fails the checker."""
    monkeypatch.setattr(tools, "_gateway_ready", lambda: True)
    monkeypatch.setattr(deck, "available", lambda: True)

    def check(project: Path) -> dict[str, list[str]]:
        return {
            p.name: ["text exceeds the module bounds"]
            for p in (project / "svg_output").glob("*.svg")
            if "SPILL" in p.read_text()
        }

    exports: list[list[str]] = []

    def export(project: Path, pptx: Path) -> str:
        exports.append(sorted(p.name for p in (project / "svg_output").iterdir()))
        pptx.write_bytes(b"PK deck")
        return ""

    posts: list[dict] = []

    async def post(path, payload, op_id, ctx, *, failure, timeout=10):
        posts.append({"path": path, "payload": payload, "timeout": timeout})
        return tools._receipt_result(
            {
                "outcome": "succeeded",
                "effect": {
                    "operation": "created",
                    "resource": {
                        "kind": "source_file",
                        "id": "f_deck",
                        "title": payload["name"],
                    },
                },
            }
        )

    monkeypatch.setattr(deck, "check", check)
    monkeypatch.setattr(deck, "export", export)
    # ppt-master's text_measure: one line per credit (the playground's --check
    # wraps real credits).
    monkeypatch.setattr(deck, "wrap", lambda text, **_: [text])
    monkeypatch.setattr(tools, "_post_operation", post)
    ctx = ToolContext(
        workspace_id="ws",
        user_id="u",
        operations=_EDITOR,
        assistant_message_id="m_1",
        chapters=[{"id": "ch_1", "name": "Circles"}],
        skills_read={skills.EDITING, skills.DECK_BUILDING},
        deck_dir=str(tmp_path),
    )
    return ctx, exports, posts


async def _outline(ctx: ToolContext, slides: int = 2) -> str:
    made = await tools.run(
        "create_deck",
        {
            "title": "Tangents",
            "chapter_id": "ch_1",
            "sources": ["Lecture 3, 14 Oct", "f_1"],
            "slides": [
                {"title": f"Slide {n}", "brief": "b"} for n in range(1, slides + 1)
            ],
            "_tool_call_id": "c_outline",
        },
        ctx,
    )
    assert not made.refused, made.text()
    return re.search(r"PowerPoint (deck_\w+)", made.text()).group(1)


async def _write(ctx: ToolContext, rid: str, n: int, svg: str, call: str = ""):
    return await tools.run(
        "write_slide",
        {"deck_id": rid, "slide": n, "svg": svg, "_tool_call_id": call or f"c_{n}"},
        ctx,
    )


async def test_deck_tools_are_always_offered_and_need_the_deck_skill(monkeypatch):
    monkeypatch.setattr(tools, "_gateway_ready", lambda: True)
    ctx = ToolContext(
        workspace_id="ws", user_id="u", operations=_EDITOR, edit_tools=True
    )
    # Offered without ppt-master too (Epo 2026-10-14); a deck then fails loudly.
    monkeypatch.setattr(deck, "available", lambda: False)
    schemas = {s["function"]["name"]: s for s in tools.schemas_for(ctx)}
    assert {"create_deck", "write_slide"} <= set(schemas)
    assert "- deck_building:" in schemas["read_skill"]["function"]["description"]
    with pytest.raises(RuntimeError, match="ppt-master is not installed"):
        deck.check(Path("."))
    monkeypatch.setattr(deck, "available", lambda: True)

    refused = await tools.run("create_deck", {"title": "t", "slides": []}, ctx)
    assert refused.refused and "arguments invalid" in refused.text()
    ctx.skills_read = {skills.EDITING}
    unread = await tools.run(
        "create_deck", {"title": "t", "slides": [{"title": "a", "brief": "b"}]}, ctx
    )
    assert unread.error == skills.refusal([skills.DECK_BUILDING], write=True)
    assert "# Skill:" not in unread.text()


async def test_checker_refusal_reaches_the_model_and_keeps_the_slide_unwritten(decks):
    ctx, exports, posts = decks
    rid = await _outline(ctx, slides=1)

    spilled = await tools.run(
        "write_slide",
        {
            "deck_id": rid,
            "slide": 1,
            "svg": _slide("<text>SPILL</text>"),
            "_tool_call_id": "c_1",
        },
        ctx,
    )
    assert spilled.refused
    assert "refused by the checker" in spilled.text()
    assert "text exceeds the module bounds" in spilled.text()
    assert ctx.decks[rid]["deck"]["slides"][0]["svg"] is None
    assert not exports and not posts


async def test_deck_scripts_run_on_the_render_pool(decks, monkeypatch):
    """(security regression: rate-limit audit M13) ppt-master's checker and
    exporter run on the bounded render pool, never on the default executor
    every model call's admission uses."""
    ctx, exports, _posts = decks
    threads: list[str] = []
    check, export = deck.check, deck.export

    def checked(project: Path) -> dict[str, list[str]]:
        threads.append(threading.current_thread().name)
        return check(project)

    def exported(project: Path, pptx: Path) -> str:
        threads.append(threading.current_thread().name)
        return export(project, pptx)

    monkeypatch.setattr(deck, "check", checked)
    monkeypatch.setattr(deck, "export", exported)
    rid = await _outline(ctx, slides=1)
    written = await _write(ctx, rid, 1, _slide())

    assert not written.refused, written.text()
    # The slide's own check, the deck's final check, the export.
    assert exports and len(threads) == 3
    assert all(name.startswith("capy-render") for name in threads)


async def test_the_deck_is_exported_and_stored_once_every_slide_is_written(decks):
    ctx, exports, posts = decks
    rid = await _outline(ctx)

    first = await _write(ctx, rid, 1, _slide())
    # The result says which slide it answers before the outline (2026-10-30).
    assert first.text().startswith("Slide 1 is written and kept.\nPowerPoint ")
    assert (
        "1. Slide 1 (written)" in first.text()
        and "2. Slide 2 (to write)" in first.text()
    )
    assert not exports and not posts

    ctx._scope_outline = {"chapters": [], "files": []}
    last = await _write(ctx, rid, 2, _slide())
    assert not last.refused, last.text()
    # A same-turn read finds the stored deck (Q536).
    assert ctx._scope_outline is None
    assert exports == [["01_slide_1.svg", "02_slide_2.svg"]], (
        "no Sources slide without books"
    )
    [post] = posts
    assert post["path"] == "/api/internal/files" and post["timeout"] > 10
    payload = post["payload"]
    assert payload["name"] == "Tangents.pptx" and payload["chapterId"] == "ch_1"
    assert payload["toolCallId"] == "c_2" and "provenance" not in payload
    # The deck's made-from line goes to Go as written (Epo 2026-10-21).
    assert payload["sources"] == ["Lecture 3, 14 Oct", "f_1"]
    assert last.effects[0]["resource"] == {
        "kind": "source_file",
        "id": "f_deck",
        "title": "Tangents.pptx",
    }
    assert "f_deck" in last.text()

    # The stored PPTX is the document now.
    again = await _write(ctx, rid, 1, _slide(), call="c_again")
    assert again.refused and "edit_office_document" in again.text()
    assert len(posts) == 1


async def test_a_final_check_refusal_names_the_slide_and_lands_no_write(
    decks, monkeypatch
):
    """The final check's refusal names the model's slide by number and title,
    never a ppt-master file, and is an errored write: a deck that cannot
    export must not count as progress (2026-10-30 loop trace)."""
    ctx, exports, posts = decks
    monkeypatch.setattr(
        deck,
        "check",
        lambda project: (
            {"02_slide_2.svg": ["modules overlap"]}
            if len(list((project / "svg_output").glob("*.svg"))) > 1
            else {}
        ),
    )
    rid = await _outline(ctx)
    await _write(ctx, rid, 1, _slide())
    last = await _write(ctx, rid, 2, _slide())

    assert last.refused and last.outcome == "refused"
    assert "- slide 2 (Slide 2): modules overlap" in last.text()
    assert ".svg" not in last.text()
    assert "2. Slide 2 (written)" in last.text(), "the slide itself is kept"
    assert not exports and not posts


async def test_our_sources_slide_failing_is_not_the_models_to_fix(decks, monkeypatch):
    """The Sources slide is made from the credits: when it fails, the result
    says so and that writing slides again cannot help, as a failed write."""
    ctx, exports, posts = decks
    book = {"id": "b", "title": "Book", "license": "CC BY 4.0", "excerptIds": ["exc_1"]}
    monkeypatch.setattr(
        deck,
        "check",
        lambda project: (
            {"02_sources.svg": ["text exceeds the root viewBox"]}
            if (project / "svg_output" / "02_sources.svg").exists()
            else {}
        ),
    )
    rid = await _outline(ctx, slides=1)
    deck.add_books(ctx.decks[rid], [book])
    written = await _write(ctx, rid, 1, _slide())

    assert written.outcome == "failed"
    text = written.text()
    assert "Sources slide" in text and "not written by you" in text
    assert "text exceeds the root viewBox" in text and deck.NOT_YOURS.strip() in text
    assert "sources.svg" not in text
    assert not exports and not posts

    # Credits that do not fit the module's height are said the same way.
    monkeypatch.setattr(deck, "wrap", lambda text, **_: [text] * 20)
    again = await _write(ctx, rid, 1, _slide(), call="c_again")
    assert again.outcome == "failed" and "cannot hold them all" in again.text()


def test_the_sources_slide_wraps_each_credit_as_tspans(monkeypatch):
    monkeypatch.setattr(
        deck,
        "wrap",
        lambda text, **_: [text[:10], text[10:]] if len(text) > 10 else [text],
    )
    svg = deck.sources_svg("editorial", ["A long credit line", "Short"], 3, "en")
    assert (
        '<text x="64" y="210">A long cre<tspan x="64" dy="26">dit line</tspan></text>'
        in svg
    )
    # The next credit starts below the last line of the one before.
    assert '<text x="64" y="276">Short</text>' in svg
    # 18 lines fill the module's 480 px; a 19th does not fit.
    monkeypatch.setattr(deck, "wrap", lambda text, **_: ["line"] * 18)
    assert deck.sources_svg("editorial", ["many lines"], 3, "en") is not None
    monkeypatch.setattr(deck, "wrap", lambda text, **_: ["line"] * 19)
    assert deck.sources_svg("editorial", ["many lines"], 3, "en") is None


async def test_figures_are_this_turns_bbox_captures_and_credit_their_book(
    decks, monkeypatch
):
    ctx, exports, posts = decks

    async def provenance(excerpt_ids):
        return [
            {
                "id": "b_circles",
                "title": "Circles",
                "authors": ["A. Author"],
                "license": "CC BY 4.0",
                "excerptIds": list(excerpt_ids),
                "version": 1,
            }
        ]

    monkeypatch.setattr(library, "provenance", provenance)
    jpeg = b"\xff\xd8 figure"
    for call, page, box, excerpt in (
        ("cap_12", 12, [0, 0, 1000, 1000], "exc_1"),
        ("cap_14", 14, [100, 200, 600, 700], "exc_1"),
    ):
        ctx.captures.append(
            capture.record(
                call_id=call,
                file_id=excerpt,
                page=page,
                box=box,
                jpeg=jpeg,
                size=(40, 30),
                started=0,
            )
            | {"excerptId": excerpt}
        )
        ctx.pending_images[call] = ("label", capture.data_url(jpeg))
    rid = await _outline(ctx, slides=1)

    # A figure names its capture by number: page 12 is capture 1, page 14 is 2.
    whole = await _write(ctx, rid, 1, _figure(1))
    assert whole.refused and "capture 1 is a whole page" in whole.text()
    missing = await _write(ctx, rid, 1, _figure(3))
    assert missing.refused and "capture 3 was not made this turn" in missing.text()

    done = await _write(ctx, rid, 1, _figure(2))
    assert not done.refused, done.text()
    assert (Path(ctx.deck_dir) / rid / "images" / "c2.jpg").read_bytes() == jpeg
    # The crop's book is credited on the Sources slide and in the file's provenance.
    assert exports == [["01_slide_1.svg", "02_sources.svg"]]
    books = posts[0]["payload"]["provenance"]["books"]
    assert [(b["id"], b["excerptIds"]) for b in books] == [("b_circles", ["exc_1"])]


async def test_a_library_figure_goes_on_a_slide_by_id(decks, monkeypatch):
    """D3 (Epo 2026-10-30): a slide places a figure read_library or
    search_images listed as figure:<id>, checked as a note's are; its rendered
    box is the image and its book is credited."""
    ctx, exports, posts = decks
    figure = object()

    async def library_figures(_ctx, refs):
        if refs != ["fig_1"]:
            return tools._refused(
                f"Not applied: figure {refs[0]} is not a library figure."
            )
        return {"fig_1": figure}, ["exc_1"]

    async def render_figure(found):
        assert found is figure
        return b"\xff\xd8 fig", (40, 30)

    async def provenance(excerpt_ids):
        return [
            {"id": "b_circles", "title": "Circles", "excerptIds": list(excerpt_ids)}
        ]

    monkeypatch.setattr(tools, "library_figures", library_figures)
    monkeypatch.setattr(tools, "render_figure", render_figure)
    monkeypatch.setattr(library, "provenance", provenance)
    rid = await _outline(ctx, slides=1)

    def placed(ref: str) -> str:
        return _slide(
            f'<image href="figure:{ref}" x="64" y="260" width="40" height="30"/>'
        )

    unknown = await _write(ctx, rid, 1, placed("fig_9"))
    assert unknown.refused and "fig_9 is not a library figure" in unknown.text()
    done = await _write(ctx, rid, 1, placed("fig_1"))
    assert not done.refused, done.text()
    assert (Path(ctx.deck_dir) / rid / "images" / "fig_1.jpg").read_bytes() == (
        b"\xff\xd8 fig"
    )
    assert exports == [["01_slide_1.svg", "02_sources.svg"]]
    books = posts[0]["payload"]["provenance"]["books"]
    assert [(b["id"], b["excerptIds"]) for b in books] == [("b_circles", ["exc_1"])]


@pytest.fixture
def kept(monkeypatch, tmp_path):
    monkeypatch.setattr(deck, "KEPT_ROOT", tmp_path / "kept")
    monkeypatch.setattr(deck, "_kept", {})
    monkeypatch.setattr(deck, "_root_cleared", True)


async def test_an_unfinished_deck_is_finished_in_a_later_message(decks, kept, tmp_path):
    """Kept past its turn (Epo 2026-10-30): a later message of the same user in
    the same chat scope finishes it; its crops are renamed apart from that
    turn's capture numbers. Anyone else's write finds nothing."""
    ctx, exports, _posts = decks
    jpeg = b"\xff\xd8 crop"
    ctx.captures.append(
        capture.record(
            call_id="cap",
            file_id="f_1",
            page=2,
            box=[100, 100, 600, 600],
            jpeg=jpeg,
            size=(40, 30),
            started=0,
        )
    )
    ctx.pending_images["cap"] = ("label", capture.data_url(jpeg))
    rid = await _outline(ctx)
    first = await _write(ctx, rid, 1, _figure(1))
    assert not first.refused, first.text()
    deck.keep(ctx.decks[rid], Path(ctx.deck_dir) / rid, tools.deck_owner(ctx))

    later = replace(
        ctx, decks={}, deck_dir=str(tmp_path / "later"), captures=[], pending_images={}
    )
    other = replace(later, user_id="u_2")
    gone = await _write(other, rid, 2, _slide())
    assert gone.refused
    assert (
        gone.text() == f"write_slide: PowerPoint {rid} not found or has been removed."
    )
    done = await _write(later, rid, 2, _slide())
    assert not done.refused, done.text()
    images = Path(later.deck_dir) / rid / "images"
    [name] = [p.name for p in images.iterdir()]
    assert name.endswith("_c1.jpg") and (images / name).read_bytes() == jpeg
    assert f"../images/{name}" in later.decks[rid]["deck"]["slides"][0]["svg"]
    assert exports == [["01_slide_1.svg", "02_slide_2.svg"]]


def test_kept_decks_last_a_day_and_three_per_owner(kept, monkeypatch, tmp_path):
    now = SimpleNamespace(value=1000.0)
    monkeypatch.setattr(deck, "time", SimpleNamespace(time=lambda: now.value))
    for n in range(4):
        outline = {"title": f"D{n}", "slides": [{"title": "s", "brief": "b"}]}
        deck.keep(deck.create(outline, f"deck_{n}"), None, "owner")
    # The fourth dropped the oldest.
    assert deck.take("deck_0", "owner", tmp_path / "p0") is None
    assert deck.take("deck_1", "owner", tmp_path / "p1")["id"] == "deck_1"
    now.value += deck.KEPT_FOR
    assert deck.take("deck_2", "owner", tmp_path / "p2") is None
    assert not (deck.KEPT_ROOT / "deck_2").exists()


def test_an_office_picture_is_a_figure_as_it_is():
    """An Office picture inspect_office_document attached is a deck figure
    whole (Q278); a whole-page capture still is not."""
    jpeg = b"\xff\xd8 picture"
    whole = [0, 0, 1000, 1000]
    captures = [
        capture.record(
            call_id="cap",
            file_id="f_1",
            page=3,
            box=whole,
            jpeg=jpeg,
            size=(40, 30),
            started=0,
        ),
        capture.record(
            call_id=capture.picture_id("c", 1),
            file_id="f_2",
            page=None,
            box=whole,
            jpeg=jpeg,
            size=(40, 30),
            started=0,
        )
        | {"picture": "slide:0:256:shape:2"},
    ]
    images = {r["callId"]: ("label", capture.data_url(jpeg)) for r in captures}
    problems, figures, _ = deck.turn_figures(captures, images)
    assert "capture 1 is a whole page" in problems[1] and problems[2] == ""
    assert figures == {2: jpeg}


def test_the_image_pins_the_commit_and_hashes_the_dependencies_the_module_names():
    """(security regression: CI hardening, ppt-master's virtualenv unpinned)"""
    pipeline = Path(__file__).resolve().parents[1]
    dockerfile = (pipeline / "Dockerfile").read_text()
    assert f"ARG PPT_MASTER_COMMIT={deck.PPT_MASTER_COMMIT}" in dockerfile
    assert "--require-hashes" in dockerfile
    assert "-r /tmp/ppt-master-requirements.txt" in dockerfile
    requirements = (pipeline / "ppt-master-requirements.txt").read_text()
    # Every requirement is an exact pin followed by its hashes.
    pinned = re.findall(
        r"^([a-z0-9-]+)==\S+ \\\n(?:    --hash=sha256:[0-9a-f]{64}(?: \\)?\n)+",
        requirements,
        re.MULTILINE,
    )
    lines = [
        line for line in requirements.splitlines() if line[:1] not in ("", "#", " ")
    ]
    assert len(pinned) == len(lines)
    assert set(deck.PPT_MASTER_DEPS) <= set(pinned)
