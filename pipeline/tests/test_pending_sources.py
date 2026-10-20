from __future__ import annotations

import json

import pytest

from pipeline.registry import ModelConfig
from pipeline.retrieval import accounting, compact, pending


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


@pytest.fixture
def budget(monkeypatch):
    monkeypatch.setattr(compact, "usable_input_limit", lambda _spec, **_kwargs: 1000)

    def measure(messages, _spec, **_kwargs):
        return accounting.ContextComposition(
            conversation_tokens=len(json.dumps(messages, ensure_ascii=False)) // 4
        )

    monkeypatch.setattr(compact, "request_context", measure)
    return ModelConfig(
        version=1,
        provider_name="Test",
        model_name="Test",
        provider_slug="test",
        model_slug="test",
        context_window_tokens=20000,
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


async def test_generation_accepts_pending_only_sources_and_refuses_oversized_evidence(
    budget, monkeypatch
):
    from pipeline.retrieval import workflows

    changes = _sources()

    async def load(*_args):
        return changes

    async def gather(**_kwargs):
        return "", []

    monkeypatch.setattr(pending, "load", load)
    monkeypatch.setattr(workflows, "gather_context", gather)
    args = {
        "workspace_id": "ws",
        "file_ids": ["f_1"],
        "instruction": "make cards",
        "scope": "source",
        "model": budget,
        "locale": "en",
    }
    assert (await workflows.generation_context(**args))[2] is changes
    changes.files = _sources("exact" * 2000).files
    with pytest.raises(workflows.PendingSourceContextTooLarge) as raised:
        await workflows.generation_context(**args)
    assert raised.value.file_ids == ["f_1"]


@pytest.mark.parametrize("with_pending", [False, True])
async def test_generation_fits_full_provider_request_without_trimming_pending(
    monkeypatch, with_pending
):
    from pipeline.prompts import generate as generate_prompts
    from pipeline.retrieval import workflows

    spec = ModelConfig(
        version=1,
        provider_name="OpenAI",
        model_name="Test",
        provider_slug="openai",
        model_slug="test",
        context_window_tokens=20_000,
        thinking_levels=("instant",),
        default_thinking="instant",
    )
    changes = (
        _sources("Exact current facts. " * 50)
        if with_pending
        else pending.PendingSources()
    )
    expected_changes = changes.message()
    read_rows = []
    sent = []

    async def load(*_args):
        return changes

    async def outline(_workspace_id):
        return {
            "chapters": [],
            "files": [{"id": "f_1", "name": "Source", "chunks": 100}],
        }

    async def read(**kwargs):
        read_rows.extend(
            {
                "id": str(i),
                "file_id": "f_1",
                "file_name": "Source",
                "chunk_idx": i,
                "section_path": [],
                "text": "Ordinary source passage. " * 60,
                "page_start": None,
                "page_end": None,
                "regions": [],
            }
            for i in range(kwargs["count"])
        )
        return read_rows

    async def complete(messages, **_kwargs):
        sent.extend(messages)
        return "Generated cards"

    monkeypatch.setattr(pending, "load", load)
    monkeypatch.setattr(workflows.store, "workspace_outline", outline)
    monkeypatch.setattr(workflows.store, "read_file_range", read)
    monkeypatch.setattr(workflows.models, "complete_text", complete)
    context, passages, captured = await workflows.generation_context(
        workspace_id="ws",
        file_ids=None,
        instruction="Make cards",
        scope="",
        model=spec,
        locale="en",
    )
    assert 0 < len(passages) < len(read_rows)
    assert (
        await workflows.produce(
            instruction="Make cards",
            context=context,
            scope="",
            model=spec,
            locale="en",
            pending_sources=captured,
        )
        == "Generated cards"
    )
    assert compact.fits_request(sent, spec)
    assert [
        message for message in sent if message.get("_kind") == "pending_sources"
    ] == ([expected_changes] if with_pending else [])
    next_passage = workflows.Passage.from_row(read_rows[len(passages)])
    larger = context + "\n\n" + next_passage.as_context(len(passages) + 1)
    assert not compact.fits_request(
        pending.inject(
            generate_prompts.generate_messages(
                instruction="Make cards", context=larger, scope="", locale="en"
            ),
            expected_changes,
        ),
        spec,
    )


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
    assert capture.image_tokens(ctx.captures, step) > 0


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
    state = {"notes": [_note_change()], "posts": [], "identities": [("m_1", "rgc_a")]}

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
            return Response(state["notes"])
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
    message = sources.message()
    assert sources.pending and '"blockId":"p2"' in message["content"]
    assert "nuclei" in message["content"] and pending.NOTICE not in message["content"]
    await sources.validate()
    gateway["identities"] = [("m_1", "rgc_b")]
    with pytest.raises(pending.SourceChanged):
        await sources.validate()


async def test_an_unreadable_note_change_says_sources_may_be_outdated(gateway):
    gateway["notes"] = pending.requests.HTTPError("502")
    sources = await pending.load("ws")
    assert sources.notes_unread and not sources.notes
    assert sources.message()["content"] == pending.NOTICE


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
    assert sources.message() is None and not sources.pending

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
    assert "latest exact source" in sources.message()["content"]
    sources.read("f_2")  # read, but no changes passed on: not checked
    await sources.validate()
    published["f_1"] = "rgc_b"
    with pytest.raises(pending.SourceChanged):
        await sources.validate()
