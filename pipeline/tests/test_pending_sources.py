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


async def test_exact_pending_evidence_survives_history_compaction_without_entering_summary(
    budget, monkeypatch
):
    sources = _sources()
    messages = [
        {"role": "system", "content": "system"},
        {"role": "assistant", "content": "old history " * 400},
        {"role": "user", "content": "question", "_kind": "query"},
    ]
    summarized = []

    async def summarize(**kwargs):
        summarized.extend(kwargs["turns"])
        return "Earlier history"

    monkeypatch.setattr(compact, "summarize_checkpoint", summarize)
    block, extra, omitted = pending.reserve(messages, sources, budget, None)
    compacted = await compact.compact_messages(messages, budget, extra=extra)
    request = pending.inject(compacted, block)
    assert not omitted
    assert "latest exact source" in json.dumps(request)
    assert "latest exact source" not in json.dumps(summarized)
    assert request[-1]["content"] == "question"
    assert all(message.get("_kind") != "pending_sources" for message in compacted)


def test_oversized_changes_are_omitted_explicitly_without_mutating_durable_evidence(
    budget,
):
    sources = _sources("exact" * 2000)
    original = json.dumps(sources.files)
    block, _extra, omitted = pending.reserve(
        [{"role": "user", "content": "q", "_kind": "query"}], sources, budget, None
    )
    assert omitted and "omitted" in block["content"]
    assert sources.event(omitted)["fileIds"] == ["f_1"]
    assert json.dumps(sources.files) == original


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
    with pytest.raises(workflows.PendingSourceContextTooLarge):
        await workflows.generation_context(**args)


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


async def test_resolved_caption_is_visible_only_after_gateway_admission(monkeypatch):
    import base64
    import hashlib

    import requests

    from pipeline.parse import caption_cache

    changes = _sources()
    effect = changes.files[0]["changes"][0]
    effect.update(
        kind="image", assetRef={"format": "docx", "kind": "image", "id": "image"}
    )
    raw = b"exact image bytes"
    digest = hashlib.sha256(raw).hexdigest()
    calls = []
    refused = True

    class Response:
        def __init__(self, save):
            self.save = save

        def raise_for_status(self):
            if self.save and refused:
                raise requests.HTTPError("quota exceeded")

        def json(self):
            return {
                "bytes": base64.b64encode(raw).decode(),
                "sha256": digest,
                "mimeType": "image/png",
            }

    def post(url, **kwargs):
        calls.append((url, kwargs["json"]))
        return Response(url.endswith("/caption"))

    async def caption(**kwargs):
        assert kwargs["published"] is False
        return "Visible image description", "cache", 10, False

    monkeypatch.setattr(pending.cfg, "gateway_url", "http://gateway")
    monkeypatch.setattr(pending.cfg, "pipeline_secret", "test")
    monkeypatch.setattr(pending.requests, "post", post)
    monkeypatch.setattr(caption_cache, "caption", caption)
    args = {
        "sources": changes,
        "workspace_id": "ws",
        "user_id": "reader",
        "file_id": "f_1",
        "change_id": "c_1",
        "checkpoint": 3,
    }
    with pytest.raises(requests.HTTPError):
        await pending.resolve(**args)
    assert "caption" not in effect
    refused = False
    assert await pending.resolve(**args) == "Visible image description"
    assert effect["caption"] == "Visible image description"
    assert calls[-1][1] == {
        "workspaceId": "ws",
        "userId": "reader",
        "fileId": "f_1",
        "epoch": 1,
        "checkpoint": 3,
        "changeId": "c_1",
        "caption": "Visible image description",
        "imageSHA256": digest,
    }
