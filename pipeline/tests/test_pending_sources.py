from __future__ import annotations

import pytest

from pipeline.retrieval import pending


def _sources(after="latest exact source"):
    return pending.PendingSources(
        [
            {
                "fileId": "f_1",
                "epoch": 1,
                "checkpoint": 3,
                "indexedCheckpoint": 1,
                "changes": [
                    {
                        "id": "c_1",
                        "kind": "text",
                        "operation": "replace",
                        "before": "old",
                        "after": after,
                    }
                ],
            }
        ]
    )


def test_a_read_passes_its_documents_changes_on_once():
    sources = _sources()
    sources.read_ids = set()
    assert "latest exact source" in sources.for_read("f_1")
    assert sources.read_ids == {"f_1"}
    assert sources.for_read("f_1") == ""  # once per turn
    assert sources.for_read("f_2") == ""  # no changes there
    large = _sources("exact" * 20_000)
    large.read_ids = set()
    assert large.for_read("f_1") == pending.READ_OMITTED
    assert large.event(True)["fileIds"] == ["f_1"]


def test_a_read_describes_the_current_text_and_search_names_unread_edits():
    """Epo 2026-10-20: a read's changes say what the document says now, not
    to apply them, and a search passage names its document's unread edits."""
    sources = _sources()
    sources.read_ids = set()
    assert sources.unindexed_counts() == {"f_1": 1}
    changes = sources.for_read("f_1")
    assert "Each after is what the document says now" in changes
    assert "do not redo or undo these edits unless the user asks" in changes
    assert "Apply replacements" not in changes
    # Some edits are a collaborator's or an earlier turn's (review S6).
    assert "user has edited" not in changes and "user's own" not in changes
    # Read this turn: its changes came with the read, so no search flag.
    assert sources.unindexed_counts() == {}


def test_a_reload_carries_what_the_turn_read_except_the_changed_document():
    """Review hints-r3 R3: after the turn changes a document, its other reads
    stay passed on and omitted; the changed one passes its changes on again."""
    previous = _sources()
    previous.read_ids = set()
    previous.for_read("f_1")
    previous.omitted_ids.add("f_big")
    reloaded = _sources()
    reloaded.carry(previous, "f_9")
    assert reloaded.for_read("f_1") == ""
    assert reloaded.omitted_ids == {"f_big"} and reloaded.read_ids == {"f_1"}
    again = _sources()
    again.carry(previous, "f_1")
    assert "latest exact source" in again.for_read("f_1")


def _png() -> bytes:
    import io

    from PIL import Image

    buffer = io.BytesIO()
    Image.new("RGB", (40, 20), "red").save(buffer, "PNG")
    return buffer.getvalue()


async def _resolve_image(monkeypatch, raw: bytes, sha256: str | None = None):
    """Run resolve_source_change on a pending image change whose gateway
    answers with ``raw`` (and ``sha256``, its own hash by default)."""
    import base64
    import hashlib

    from pipeline.retrieval import tools

    changes = _sources()
    changes.files[0]["changes"][0].update(
        kind="image", assetRef={"format": "docx", "kind": "image", "id": "image"}
    )
    calls = []

    class Response:
        def __init__(self):
            self.headers = {}

        def raise_for_status(self):
            pass

        def json(self):
            return {
                "bytes": base64.b64encode(raw).decode(),
                "sha256": sha256 or hashlib.sha256(raw).hexdigest(),
                "mimeType": "image/png",
            }

    def post(url, **kwargs):
        calls.append((url, kwargs["json"]))
        return Response()

    monkeypatch.setattr(pending.cfg, "gateway_url", "http://gateway")
    monkeypatch.setattr(pending.cfg, "pipeline_secret", "test")
    monkeypatch.setattr(pending.requests, "post", post)
    ctx = tools.ToolContext(
        workspace_id="ws", user_id="reader", pending_sources=changes
    )
    args = {"file_id": "f_1", "change_id": "c_1", "checkpoint": 3}
    result = await tools._resolve_source_change({**args, "_tool_call_id": "call"}, ctx)
    return result, ctx, calls


async def test_a_resolved_source_image_rides_in_the_next_request(monkeypatch):
    """An image added before publication is attached like a capture_page render."""
    import base64
    import io

    from PIL import Image

    from pipeline.retrieval import capture

    result, ctx, calls = await _resolve_image(monkeypatch, _png())

    assert not result.refused, result.text()
    assert calls == [
        (
            "http://gateway/api/internal/source-changes/resolve",
            {
                "workspaceId": "ws",
                "userId": "reader",
                "fileId": "f_1",
                "epoch": 1,
                "checkpoint": 3,
                "changeId": "c_1",
            },
        )
    ]
    step = [
        {"role": "assistant", "content": "", "tool_calls": [{"id": "call"}]},
        {"role": "tool", "tool_call_id": "call", "content": result.text()},
    ]
    attached = capture.inject_images(step, ctx.pending_images, "zai")[-1]["content"]
    url = attached[2]["image_url"]["url"]
    with Image.open(io.BytesIO(base64.b64decode(url.split(",", 1)[1]))) as image:
        assert image.size == (40, 20)
        red, green, blue = image.getpixel((20, 10))
    assert red > 240 and green < 20 and blue < 20
    assert capture.image_tokens(ctx.captures, ctx.pending_images) > 0


async def test_a_source_image_with_another_hash_or_no_render_is_refused(monkeypatch):
    """Nothing is attached for bytes that do not match their hash, or for a
    format Pillow cannot render (an SVG or EMF from a DOCX/PPTX)."""
    svg = b'<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>'
    for raw, sha256, code, reason in (
        (_png(), "0" * 64, "invalid_input", "identity changed"),
        (svg, None, "unsupported_format", "cannot be rendered"),
    ):
        result, ctx, _ = await _resolve_image(monkeypatch, raw, sha256)
        assert result.refused and result.error_code == code
        assert reason in result.text()
        assert not ctx.pending_images and not ctx.captures


def _note_change(kind="text", block="p2"):
    change = {"id": "n_1", "kind": kind, "operation": "replace", "blockId": block}
    if kind == "data":
        change["label"] = 'chart "Rain": 40 of 104 cells changed'
    else:
        change.update(label="", before="cells", after="nuclei")
    return {"materialId": "m_1", "title": "Lecture", "revision": 4, "changes": [change]}


@pytest.fixture
def gateway(monkeypatch):
    """Go's note-changes endpoint and the notes' published index identities."""
    state = {
        "notes": [_note_change()],
        "live": {"notes": [], "live": False},
        "posts": [],
        "identities": [("m_1", "rgc_a")],
    }

    class Response:
        def __init__(self, body):
            self.headers = {}
            self.body = body

        def raise_for_status(self):
            if isinstance(self.body, Exception):
                raise self.body

        def json(self):
            return self.body

    def post(url, **kwargs):
        state["posts"].append((url, kwargs["json"]))
        if url.endswith("/note-changes"):
            return Response(
                state["live"] if kwargs["json"].get("live") else state["notes"]
            )
        return Response({"before": "| r1 | 1 |", "after": "| r1 | 9 |"})

    async def snapshot(*_args, **_kwargs):
        return []

    async def identities(_workspace_id, ids):
        rows = state["identities"]
        return [row for row in rows if ids is None or row[0] in ids]

    monkeypatch.setattr(pending.cfg, "gateway_url", "http://gateway")
    monkeypatch.setattr(pending.cfg, "pipeline_secret", "test")
    monkeypatch.setattr(pending.requests, "post", post)
    monkeypatch.setattr(pending, "_snapshot", snapshot)
    monkeypatch.setattr(pending, "_note_identities", identities)
    return state


async def test_note_changes_ride_with_the_turn_and_a_new_note_index_invalidates_them(
    gateway,
):
    gateway["notes"] = {"notes": [_note_change()]}
    sources = await pending.load("ws", ["m_1"])
    assert gateway["posts"] == [
        (
            "http://gateway/api/internal/note-changes",
            {"workspaceId": "ws", "materialIds": ["m_1"]},
        )
    ]
    shown = sources.for_read("m_1")
    assert sources.pending and '"blockId":"p2"' in shown
    assert "nuclei" in shown and pending.NOTICE not in shown
    await sources.validate()
    gateway["identities"] = [("m_1", "rgc_b")]
    with pytest.raises(pending.SourceChanged):
        await sources.validate()


async def test_a_detailed_note_read_takes_unsaved_typing_from_its_open_room(gateway):
    """Q417 (Epo 2026-10-27): the turn reads stored changes and asks no room;
    inspecting a note asks for that one note's open room, which answers its
    unsaved typing, or none when it holds no unsaved edit (the stored changes
    stand)."""
    gateway["notes"] = {"notes": [_note_change()]}
    clean = await pending.load("ws", ["m_1"])
    clean.read_ids = set()
    shown = await clean.read_note("m_1")
    assert gateway["posts"][-1] == (
        "http://gateway/api/internal/note-changes",
        {"workspaceId": "ws", "materialIds": ["m_1"], "live": True},
    )
    assert '"after":"nuclei"' in shown

    typed = _note_change()
    typed["changes"][0]["after"] = "nuclei divide"
    gateway["live"] = {"notes": [typed], "live": True}
    sources = await pending.load("ws", ["m_1"])
    sources.read_ids = set()
    assert "live" not in gateway["posts"][-1][1]
    shown = await sources.read_note("m_1")
    assert '"after":"nuclei divide"' in shown
    await sources.validate()


async def test_an_unreadable_note_change_says_sources_may_be_outdated(gateway):
    gateway["notes"] = pending.requests.HTTPError("502")
    sources = await pending.load("ws")
    assert sources.notes_unread and not sources.notes
    assert sources.for_read("m_1") == pending.NOTICE


async def test_a_note_data_placeholder_resolves_to_its_block_text(gateway, monkeypatch):
    from pipeline.retrieval import tools

    gateway["notes"] = {"notes": [_note_change("data", "ch")]}
    sources = await pending.load("ws")
    ctx = tools.ToolContext(
        workspace_id="ws",
        user_id="reader",
        pending_sources=sources,
        operations=frozenset({"source.read", "material.read"}),
    )
    monkeypatch.setattr(tools, "_gateway_ready", lambda: True)
    assert tools._offered(tools.REGISTRY["resolve_source_change"], ctx)

    refused = await tools._resolve_source_change(
        {"material_id": "m_1", "block_id": "p9"}, ctx
    )
    assert refused.refused and len(gateway["posts"]) == 1
    result = await tools._resolve_source_change(
        {"material_id": "m_1", "block_id": "ch"}, ctx
    )
    assert not result.refused and "| r1 | 9 |" in result.text()
    assert gateway["posts"][-1] == (
        "http://gateway/api/internal/note-changes/resolve",
        {"workspaceId": "ws", "userId": "reader", "materialId": "m_1", "blockId": "ch"},
    )


async def test_office_changes_are_read_on_demand_and_a_failed_read_says_so(
    monkeypatch,
):
    """Q405: an Office file with unprocessed edits gets its changes from the
    collaboration service, not the stored row; one it could not read says
    sources may be outdated. Text keeps its stored changes."""
    change = {"id": "c", "kind": "text", "operation": "replace", "after": "nuclei"}
    posts = []

    class Response:
        def __init__(self, body):
            self.headers = {}
            self.body = body

        def raise_for_status(self):
            pass

        def json(self):
            return self.body

    def post(url, **kwargs):
        posts.append((url, kwargs["json"]))
        if url.endswith("/source-changes"):
            return Response(
                {
                    "files": [
                        {
                            "fileId": "f_doc",
                            "epoch": 2,
                            "checkpoint": 6,
                            "changes": [change],
                        }
                    ],
                    "failed": ["f_sheet"],
                }
            )
        return Response({"notes": []})

    def row(file_id, kind, checkpoint, indexed, tokens, changes):
        return {
            "fileId": file_id,
            "revision": 1,
            "content_id": "rgc",
            "epoch": 2,
            "indexedCheckpoint": indexed,
            "name": file_id,
            "format": kind,
            "checkpoint": checkpoint,
            "netTokens": tokens,
            "changes": changes,
        }

    async def snapshot(*_args, **_kwargs):
        stale = [{"id": "old", "kind": "text", "operation": "add", "after": "stale"}]
        return [
            row("f_clean", "pptx", 3, 3, 0, []),
            row("f_doc", "docx", 5, 3, 12, stale),
            row("f_sheet", "xlsx", 2, 1, 4, []),
            row("f_text", "text", 2, 1, 1, [change]),
        ]

    async def identities(_workspace_id, _ids):
        return []

    monkeypatch.setattr(pending.cfg, "gateway_url", "http://gateway")
    monkeypatch.setattr(pending.cfg, "pipeline_secret", "test")
    monkeypatch.setattr(pending.requests, "post", post)
    monkeypatch.setattr(pending, "_snapshot", snapshot)
    monkeypatch.setattr(pending, "_note_identities", identities)
    sources = await pending.load("ws")
    assert posts[0] == (
        "http://gateway/api/internal/source-changes",
        {"workspaceId": "ws", "fileIds": ["f_doc", "f_sheet"]},
    )
    assert [(f["fileId"], f["checkpoint"]) for f in sources.files] == [
        ("f_doc", 6),
        ("f_text", 2),
    ]
    sources.read_ids = set()
    read = sources.for_read("f_doc")
    assert "nuclei" in read and "stale" not in read and pending.NOTICE not in read
    assert sources.for_read("f_sheet") == pending.NOTICE


async def test_only_documents_read_are_validated_and_resolvable(monkeypatch):
    """Epo 2026-10-20: changes pass on only for documents read this turn, so
    only those must still pair with their published index."""
    published = {"f_1": "rgc_a", "f_2": "rgc_a"}

    async def snapshot(_workspace_id, file_ids, *, evidence=True):
        assert not evidence
        return [
            {
                "fileId": f,
                "revision": 1,
                "content_id": published[f],
                "epoch": 1,
                "indexedCheckpoint": 1,
            }
            for f in sorted(published)
            if file_ids is None or f in file_ids
        ]

    monkeypatch.setattr(pending, "_snapshot", snapshot)
    sources = _sources()
    sources._workspace_id = "ws"
    sources._baseline = pending._identities(await snapshot("ws", None, evidence=False))
    sources.notes = [_note_change("data", "ch")]
    sources.read_ids = set()
    assert not sources.pending

    published["f_2"] = "rgc_b"  # never read: not checked
    await sources.validate()
    with pytest.raises(ValueError, match="unavailable"):
        await pending.resolve_note(
            sources=sources,
            workspace_id="ws",
            user_id="u",
            material_id="m_1",
            block_id="ch",
        )
    sources.read("f_1")
    await sources.validate()
    assert [f["fileId"] for f in sources.shown_files] == ["f_1"]
    sources.read("f_2")  # read, but no changes passed on: not checked
    await sources.validate()
    published["f_1"] = "rgc_b"
    with pytest.raises(pending.SourceChanged):
        await sources.validate()
