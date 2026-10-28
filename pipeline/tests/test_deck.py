"""Deck tools: create_deck outlines, write_slide checks each slide alone with
ppt-master's checker, and the deck is exported and stored as a workspace file
once every slide is written. ppt-master itself is stubbed here; the playground's
--check runs the real checker and exporter."""

from __future__ import annotations

import re
import threading
from pathlib import Path

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
    return re.search(r"Deck (deck_\w+)", made.text()).group(1)


async def _write(ctx: ToolContext, rid: str, n: int, svg: str, call: str = ""):
    return await tools.run(
        "write_slide",
        {"deck_id": rid, "slide": n, "svg": svg, "_tool_call_id": call or f"c_{n}"},
        ctx,
    )


async def test_deck_tools_are_always_offered_and_need_the_deck_skill(monkeypatch):
    monkeypatch.setattr(tools, "_gateway_ready", lambda: True)
    ctx = ToolContext(workspace_id="ws", user_id="u", operations=_EDITOR)
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
    assert exports and len(threads) == 2
    assert all(name.startswith("capy-render") for name in threads)


async def test_the_deck_is_exported_and_stored_once_every_slide_is_written(decks):
    ctx, exports, posts = decks
    rid = await _outline(ctx)

    first = await _write(ctx, rid, 1, _slide())
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
