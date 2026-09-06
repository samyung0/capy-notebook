"""A turn's captured changes must use the published baseline they describe."""

import json
import secrets

import pytest

from pipeline.registry import ModelConfig
from pipeline.retrieval import agent, pending, tools, workflows
from pipeline.retrieval.stream import AssembledResponse, ToolCall
from pipeline.retrieval.usage_extract import NormalizedUsage

pytestmark = pytest.mark.integration
A = "Color: red\nCount: one"
B = "Color: blue\nCount: one"
C = "Color: red\nCount: two"


def _model():
    return ModelConfig(
        version=1,
        provider_name="OpenAI",
        model_name="Test",
        provider_slug="openai",
        model_slug="test",
        context_window_tokens=20_000,
        thinking_levels=("instant",),
        default_thinking="instant",
    )


def _publish(workspace, file_id, text, checkpoint=None):
    content_id = "content_" + secrets.token_hex(8)
    with workspace._connect() as conn, conn.transaction():
        conn.execute(
            "INSERT INTO rag_contents(id,workspace_id,content_hash,status) VALUES(%s,%s,%s,'ready')",
            (content_id, workspace.id, content_id),
        )
        conn.execute(
            "INSERT INTO rag_chunks(id,workspace_id,content_id,chunk_idx,text,indexed_text,lang) VALUES(%s,%s,%s,0,%s,%s,'en')",
            (content_id + "chunk", workspace.id, content_id, text, text),
        )
        conn.execute(
            "INSERT INTO rag_file_contents(file_id,workspace_id,content_id) VALUES(%s,%s,%s) ON CONFLICT(file_id) DO UPDATE SET content_id=EXCLUDED.content_id",
            (file_id, workspace.id, content_id),
        )
        if checkpoint is not None:
            conn.execute(
                "UPDATE source_documents SET checkpoint=%s,indexed_checkpoint=%s,state=%s,indexed_state=%s,pending_effects='[]' WHERE file_id=%s",
                (checkpoint, checkpoint, text.encode(), text.encode(), file_id),
            )


def _seed(workspace):
    file_id = workspace.add_file("facts.txt")
    effect = {
        "id": "change",
        "kind": "text",
        "operation": "replace",
        "label": "Text at UTF-16 offset 7",
        "before": "red",
        "after": "blue",
    }
    with workspace._connect() as conn:
        conn.execute(
            "INSERT INTO source_documents(file_id,format,base_revision,base_blob_path,checkpoint,indexed_checkpoint,state,indexed_state,pending_effects) VALUES(%s,'text',1,%s,1,0,%s,%s,%s::jsonb)",
            (
                file_id,
                "sources/" + file_id,
                B.encode(),
                A.encode(),
                json.dumps([effect]),
            ),
        )
    _publish(workspace, file_id, A)
    return file_id


async def test_generation_rejects_new_index_paired_with_captured_changes(
    workspace, monkeypatch
):
    file_id = _seed(workspace)
    real_load = pending.load

    async def capture_then_publish(*args, **kwargs):
        captured = await real_load(*args, **kwargs)
        _publish(workspace, file_id, B, 1)
        _publish(workspace, file_id, C, 2)
        return captured

    async def forbidden(*_args, **_kwargs):
        pytest.fail("A mixed source baseline reached the provider")

    monkeypatch.setattr(pending, "load", capture_then_publish)
    monkeypatch.setattr(workflows.models, "complete_text", forbidden)
    context, passages, captured = await workflows.generation_context(
        workspace_id=workspace.id,
        file_ids=[file_id],
        instruction="Make cards",
        scope="facts",
        model=_model(),
        locale="en",
    )
    assert passages[0].text == C
    assert captured.files[0]["changes"][0]["after"] == "blue"
    with pytest.raises(pending.SourceChanged):
        await workflows.produce(
            instruction="Make cards",
            context=context,
            scope="facts",
            model=_model(),
            pending_sources=captured,
        )


async def test_chat_rejects_publication_after_tool_read_before_compaction_or_next_model(
    workspace, monkeypatch
):
    file_id = _seed(workspace)
    original_read = tools._read_document
    original_spec = tools.REGISTRY["read_document"]
    from dataclasses import replace

    async def read_then_publish(args, ctx):
        _publish(workspace, file_id, B, 1)
        _publish(workspace, file_id, C, 2)
        result = await original_read(args, ctx)
        assert result.passages[0].text == C
        return result

    calls = []

    async def stream(messages, **_kwargs):
        calls.append(messages)
        assert len(calls) == 1, "Mixed evidence reached the next model round"
        return AssembledResponse(
            text="",
            tool_calls=[
                ToolCall(
                    id="read",
                    name="read_document",
                    arguments=json.dumps({"file_id": file_id}),
                )
            ],
            usage=NormalizedUsage(),
            output_items=[],
        )

    compact_calls = []
    original_compact = agent.compact.compact_messages

    async def compact(*args, **kwargs):
        compact_calls.append(1)
        return await original_compact(*args, **kwargs)

    monkeypatch.setitem(
        tools.REGISTRY,
        "read_document",
        replace(original_spec, handler=read_then_publish),
    )
    monkeypatch.setattr(agent.models, "stream_agent_response", stream)
    monkeypatch.setattr(agent.compact, "compact_messages", compact)
    events = [
        event
        async for event in agent.run_agent(
            query="What changed?",
            ctx=tools.ToolContext(
                workspace_id=workspace.id, user_id=workspace.user_id, file_ids=[file_id]
            ),
            history=None,
            model=_model(),
        )
    ]
    assert len(calls) == len(compact_calls) == 1
    assert any(event.get("code") == "source_changed" for event in events)
    assert not any(event.get("type") == "done" for event in events)


@pytest.mark.parametrize(
    "change",
    ["first_index", "no_pending_index", "deleted", "replacement", "workspace_added"],
)
async def test_baseline_includes_files_without_pending_or_published_content(
    workspace, change
):
    file_id = workspace.add_file("quiet.txt")
    if change == "no_pending_index":
        _publish(workspace, file_id, A)
    captured = await pending.load(workspace.id)
    assert not captured.files
    if change in {"first_index", "no_pending_index"}:
        _publish(workspace, file_id, B)
    elif change == "workspace_added":
        workspace.add_file("new.txt")
    else:
        with workspace._connect() as conn:
            if change == "deleted":
                conn.execute("DELETE FROM files WHERE id=%s", (file_id,))
            else:
                conn.execute("UPDATE files SET revision=2 WHERE id=%s", (file_id,))
    with pytest.raises(pending.SourceChanged):
        await captured.validate()


async def test_new_authored_edits_and_unselected_files_preserve_captured_turn(
    workspace, monkeypatch
):
    file_id = _seed(workspace)
    captured = await pending.load(workspace.id, [file_id])
    original = captured.message()
    with workspace._connect() as conn:
        conn.execute(
            "UPDATE source_documents SET checkpoint=2,state='later',pending_effects='[]' WHERE file_id=%s",
            (file_id,),
        )
    workspace.add_file("outside-selection.txt")
    await captured.validate()
    sent = []

    async def complete(messages, **_kwargs):
        sent.extend(messages)
        return "captured answer"

    monkeypatch.setattr(workflows.models, "complete_text", complete)
    assert (
        await workflows.produce(
            instruction="Make cards",
            context=A,
            scope="facts",
            model=_model(),
            pending_sources=captured,
        )
        == "captured answer"
    )
    assert [
        message for message in sent if message.get("_kind") == "pending_sources"
    ] == [original]
    assert all("content_id" not in message.get("content", "") for message in sent)


async def test_first_authored_edit_preserves_existing_published_baseline(workspace):
    file_id = workspace.add_file("opened-later.txt")
    _publish(workspace, file_id, A)
    captured = await pending.load(workspace.id, [file_id])
    with workspace._connect() as conn:
        conn.execute(
            "INSERT INTO source_documents(file_id,format,base_revision,base_blob_path,checkpoint,state,indexed_state) VALUES(%s,'text',1,%s,1,%s,%s)",
            (file_id, "sources/" + file_id, B.encode(), A.encode()),
        )
    await captured.validate()


async def test_source_image_tool_rejects_published_baseline_before_caption(
    workspace, monkeypatch
):
    import base64
    import hashlib

    from pipeline.parse import caption_cache

    file_id = _seed(workspace)
    effect = {"id": "image", "assetRef": {"id": "picture"}}
    with workspace._connect() as conn:
        conn.execute(
            "UPDATE source_documents SET pending_effects=%s::jsonb WHERE file_id=%s",
            (json.dumps([effect]), file_id),
        )
    captured = await pending.load(workspace.id, [file_id])
    raw = b"image"

    class Response:
        def raise_for_status(self):
            pass

        def json(self):
            return {
                "bytes": base64.b64encode(raw).decode(),
                "sha256": hashlib.sha256(raw).hexdigest(),
                "mimeType": "image/png",
            }

    def resolve(*_args, **_kwargs):
        _publish(workspace, file_id, B, 1)
        return Response()

    async def forbidden(**_kwargs):
        pytest.fail("The image model ran after its baseline changed")

    monkeypatch.setattr(pending.cfg, "gateway_url", "http://synthetic-gateway")
    monkeypatch.setattr(pending.cfg, "pipeline_secret", "synthetic")
    monkeypatch.setattr(pending.requests, "post", resolve)
    monkeypatch.setattr(caption_cache, "caption", forbidden)
    with pytest.raises(pending.SourceChanged):
        await tools.run(
            "resolve_source_change",
            {"file_id": file_id, "change_id": "image", "checkpoint": 1},
            tools.ToolContext(
                workspace_id=workspace.id,
                user_id=workspace.user_id,
                file_ids=[file_id],
                pending_sources=captured,
            ),
        )
