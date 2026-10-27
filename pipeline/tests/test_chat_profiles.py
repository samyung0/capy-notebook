"""Chat profiles (todo-account-chat.md): workspace chat shows the model what it
did before account chat, byte for byte; account chat offers its own tools,
prompt and turn context, checks access through Go before reading, and
creates into No workspace unless a workspace is named."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

import pytest

from pipeline.prompts import chat as chat_prompts
from pipeline.registry import ModelConfig
from pipeline.retrieval import (
    accounting,
    contract,
    profiles,
    search,
    skills,
    tools,
    turn_context,
)
from pipeline.retrieval.scope import AccountScope
from pipeline.retrieval.search import Passage
from pipeline.retrieval.tools import ToolContext
from pipeline.retrieval.usage_extract import NormalizedUsage

# Hashes of what workspace chat sent the model before account chat: written
# by running the snapshot below against commit 79209a759's pipeline with the
# v42 contract (agent_tools.json before account scopes). Never regenerate it
# from the current code to make this pass.
GOLDEN = Path(__file__).parent / "fixtures" / "workspace_chat_golden.json"

OWNER = frozenset(
    {
        "source.read",
        "material.read",
        "material.create",
        "document.edit",
        "resource.trash",
        "trash.read",
        "trash.restore",
        "library.read",
    }
)
VIEWER = frozenset({"source.read", "material.read", "library.read"})
ACCOUNT = frozenset(
    {"source.read", "material.read", "material.create", "document.edit", "library.read"}
)
CATALOG = [{"id": "biology", "name": "Biology", "excerpts": 12}]


@pytest.fixture(autouse=True)
def ready(monkeypatch):
    monkeypatch.setattr(tools.cfg, "gateway_url", "http://gateway")
    monkeypatch.setattr(tools.cfg, "pipeline_secret", "secret")
    monkeypatch.setattr(tools.cfg, "library_dsn", "postgresql://library")
    monkeypatch.setattr(tools.cfg, "knowledge_base_b2_bucket", "kb")


def _ctx(**kw: Any) -> ToolContext:
    return ToolContext(
        **{"workspace_id": "ws_1", "user_id": "u_1", "operations": OWNER, **kw}
    )


def _account(**kw: Any) -> ToolContext:
    return ToolContext(
        **{
            "workspace_id": "",
            "scope": AccountScope("u_1", ("ws_1", "ws_2")),
            "user_id": "u_1",
            "operations": ACCOUNT,
            "assistant_message_id": "m_1",
            **kw,
        }
    )


def _hashed(snapshot: dict[str, Any]) -> dict[str, str]:
    out: dict[str, str] = {}

    def flat(prefix: str, value: Any) -> None:
        if isinstance(value, dict) and prefix.count("/") < 1:
            for key, inner in value.items():
                flat(f"{prefix}/{key}" if prefix else key, inner)
        else:
            out[prefix] = hashlib.sha256(
                json.dumps(value, ensure_ascii=False, sort_keys=True).encode()
            ).hexdigest()

    flat("", snapshot)
    return out


def test_the_workspace_profile_shows_the_model_what_it_did_before():
    profile = profiles.workspace.PROFILE
    contexts = {
        "owner": _ctx(library_catalog=CATALOG),
        "owner_office_progress": _ctx(
            library_catalog=CATALOG, office_tools=True, study_progress=True
        ),
        "owner_no_library": _ctx(),
        "viewer": _ctx(operations=VIEWER, role="viewer", library_catalog=CATALOG),
    }
    open_ctx = _ctx(
        role="editor",
        open_resource={
            "id": "f_1",
            "kind": "file",
            "title": "Cells",
            "chapter_id": "ch_1",
        },
        chapters=[{"id": "ch_1", "name": "Biology"}],
    )
    snapshot = {
        "schemas": {k: profile.schemas(c) for k, c in contexts.items()},
        "messages": {
            f"writes={w},only={o}": profile.messages(
                locale="en",
                checkpoint=None,
                history=[],
                query="What is ATP?",
                workspace_only=o,
                mode_shown=None,
                writes=w,
            )
            for w in (True, False)
            for o in (True, False)
        },
        "turn_context": {
            "open": turn_context.message(open_ctx, allowance="\nleft: 3"),
            "nothing_open_final": turn_context.message(contexts["owner"], final=True),
            "final_answer": turn_context.message(
                contexts["viewer"], final=True, writing=False
            ),
        },
        "skills": {name: skills.text(name) for name in skills.SKILLS},
        "mode_note": chat_prompts.with_mode_note(
            {"role": "user", "content": "q", "_workspace_only": True}
        ),
        "send_back": [
            profile.send_back[(True, False)],
            profile.send_back[(True, True)],
            profile.send_back[(False, False)],
            profile.send_back[(False, True)],
        ],
        "not_available": tools.NOT_AVAILABLE,
    }

    assert _hashed(snapshot) == json.loads(GOLDEN.read_text())


def test_the_account_profile_offers_the_account_tools():
    schemas = profiles.account.PROFILE.schemas(_account(library_catalog=CATALOG))
    by_name = {s["function"]["name"]: s["function"] for s in schemas}

    assert set(by_name) == {
        "search_files",
        "list_files",
        "read_document",
        "capture_page",
        "search_knowledge",
        "read_knowledge",
        "capture_knowledge_page",
        "search_web",
        "read_skill",
        "create_material",
        "add_questions",
        "add_question_media",
        "create_deck",
        "write_slide",
        "inspect_document",
        "edit_document",
    }
    for name in ("create_material", "create_deck"):
        assert "workspace_id" in by_name[name]["parameters"]["properties"]
        # Go's definition stays as it is.
        assert (
            "workspace_id"
            not in contract.DEFINITIONS[name]["inputSchema"]["properties"]
        )
    assert "workspace_id" not in by_name["add_questions"]["parameters"]["properties"]


def test_the_account_prompt_turn_context_and_skills_name_the_users_files():
    ctx = _account()
    profile = profiles.of(ctx)
    messages = profile.messages(
        locale="en", checkpoint=None, history=[], query="q", workspace_only=True
    )

    assert profile is profiles.account.PROFILE
    assert (
        "lands in No workspace unless the learner names a workspace"
        in messages[0]["content"]
    )
    assert "search_workspace" not in messages[0]["content"]
    assert messages[-1]["content"].startswith("[Your files only: on.")
    # Live compaction puts the account line back, not the workspace one.
    folded = chat_prompts.with_mode_note({**messages[-1], "content": "q"})
    assert folded["content"].startswith("[Your files only: on.")
    context = turn_context.message(ctx)["content"]
    assert "Open:" not in context and "workspace" not in context
    editing = skills.text(skills.EDITING, account=True)
    assert "list_sources" not in editing and "No workspace" in editing
    assert "No workspace" in skills.text(skills.DECK_BUILDING, account=True)


class _Gateway:
    """The gateway's internal endpoints as the pipeline posts to them."""

    def __init__(self, access: list[dict[str, Any]] | None = None) -> None:
        self.access = access or []
        self.posts: list[tuple[str, dict[str, Any]]] = []

    async def read(self, path: str, payload: dict[str, Any], _failure: str):
        self.posts.append((path, payload))
        if path.endswith("/documents/access"):
            rows = {(r["kind"], r["id"]): r for r in self.access}
            return {
                "items": [
                    rows.get(
                        (i["kind"], i["id"]),
                        {
                            **i,
                            "workspaceId": "",
                            "workspaceName": "",
                            "canRead": False,
                            "canEdit": False,
                        },
                    )
                    for i in payload["items"]
                ]
            }
        raise AssertionError(path)


def _row(
    kind: str, rid: str, ws: str = "ws_2", name: str = "Biology", edit: bool = False
):
    return {
        "kind": kind,
        "id": rid,
        "workspaceId": ws,
        "workspaceName": name,
        "canRead": True,
        "canEdit": edit,
    }


async def test_read_document_checks_access_and_returns_where_the_file_lives(
    monkeypatch,
):
    gateway = _Gateway([_row("source_file", "f_1")])
    monkeypatch.setattr(tools, "_gateway_read", gateway.read)
    reads = []

    async def read_file_range(**kwargs):
        reads.append(kwargs)
        return [
            {
                "id": "c_1",
                "file_id": "f_1",
                "file_name": "cells.pdf",
                "chunk_idx": 0,
                "text": "ATP",
            }
        ]

    monkeypatch.setattr(tools.store, "read_file_range", read_file_range)
    ctx = _account()

    refused = await tools._read_document({"file_id": "f_other"}, ctx)
    read = await tools._read_document({"file_id": "f_1"}, ctx)

    assert (
        refused.refused
        and 'No file you can read has the id "f_other"' in refused.text()
    )
    assert [r["file_id"] for r in reads] == ["f_1"] and reads[0][
        "workspace_id"
    ] == "ws_2"
    assert read.passages[0].as_citation()["workspaceName"] == "Biology"
    assert read.passages[0].location().startswith("Biology › cells.pdf")
    assert (
        'Access: {"workspaceId": "ws_2", "workspaceName": "Biology", "canEdit": false}'
        in read.text()
    )


async def test_search_files_labels_passages_and_drops_unreadable_ones(monkeypatch):
    gateway = _Gateway([_row("source_file", "f_1", ws="", name="")])
    monkeypatch.setattr(tools, "_gateway_read", gateway.read)
    found = [
        Passage(
            chunk_id=f"c_{f}",
            file_id=f,
            file_name=f"{f}.pdf",
            chunk_idx=0,
            section_path="",
            text="t",
        )
        for f in ("f_1", "f_gone")
    ]
    seen = {}

    async def search_account(**kwargs):
        seen.update(kwargs)
        return found

    monkeypatch.setattr(tools, "search_account", search_account)

    result = await tools._search_files({"query": "atp"}, _account())

    assert (seen["user_id"], seen["workspace_ids"]) == ("u_1", ["ws_1", "ws_2"])
    assert [p.file_id for p in result.passages] == ["f_1"]
    citation = result.passages[0].as_citation()
    assert (citation["workspaceId"], citation["workspaceName"]) == ("", "")
    assert result.passages[0].location().startswith("No workspace › f_1.pdf")


@pytest.mark.parametrize("named", ["ws_2", None])
async def test_an_account_create_lands_where_the_user_named(monkeypatch, named):
    sent = {}

    class _Resp:
        status_code = 200

        def json(self):
            return {
                "operationId": "op_1",
                "outcome": "succeeded",
                "effect": {
                    "operation": "created",
                    "operationId": "op_1",
                    "resource": {
                        "kind": "material",
                        "id": "mat_1",
                        "title": "Cards",
                        "materialKind": "flashcards",
                    },
                },
            }

    def post(url, **kwargs):
        sent.update(json.loads(kwargs["data"]), url=url)
        return _Resp()

    monkeypatch.setattr(tools.requests, "post", post)
    ctx = _account(skills_read={skills.EDITING})
    args = {
        "kind": "flashcards",
        "title": "Cards",
        "cards": [{"front": "a", "back": "b"}],
        "_tool_call_id": "call_1",
    }

    result = await tools.run("create_material", {**args, "workspace_id": named}, ctx)

    assert not result.refused, result.text()
    assert sent["url"].endswith("/api/internal/materials")
    assert sent["scope"] == "account"
    assert sent.get("workspaceId") == named
    assert "workspaceId" in sent if named else "workspaceId" not in sent


async def test_search_account_embeds_once_per_pin_and_merges_by_rank(monkeypatch):
    pins = [
        {
            "embedding_provider_slug": "p",
            "embedding_model_slug": m,
            "embedding_model_version": 1,
            "embedding_dim": 4,
        }
        for m in ("a", "b")
    ]

    async def spaces(user_id, workspace_ids):
        return [
            {"pin": pins[0], "workspace_ids": ["ws_1"], "standalone": True},
            {"pin": pins[1], "workspace_ids": ["ws_2"], "standalone": False},
        ]

    embedded, searched = [], []

    async def embed(texts, *, spec):
        embedded.append(spec)
        return [[1.0]]

    def row(rid: str) -> dict[str, Any]:
        return {
            "id": rid,
            "file_id": rid,
            "file_name": rid,
            "chunk_idx": 0,
            "text": rid,
            "indexed_text": rid,
            "score": 1.0,
            "flat_score": 1.0,
        }

    async def hybrid_search(**kwargs):
        searched.append(
            (
                kwargs.get("workspace_ids"),
                kwargs.get("owner_user_id"),
                kwargs["pin"]["embedding_model_slug"],
            )
        )
        target = kwargs.get("workspace_ids") or ["mine"]
        return [row(f"{target[0]}_{i}") for i in range(2)]

    monkeypatch.setattr(search.store, "account_search_spaces", spaces)
    monkeypatch.setattr(search.store, "hybrid_search", hybrid_search)
    monkeypatch.setattr(search.models, "embed", embed)
    monkeypatch.setattr(search.models, "format_query", lambda query, _spec: query)
    monkeypatch.setattr(
        search.registry, "resolve_pinned", lambda *pin_and_slot: pin_and_slot[1]
    )

    found = await search.search_account(
        user_id="u_1", workspace_ids=["ws_1", "ws_2"], query="q"
    )

    assert embedded == ["a", "b"]
    assert sorted(searched, key=str) == sorted(
        [(["ws_1"], None, "a"), (None, "u_1", "a"), (["ws_2"], None, "b")], key=str
    )
    # Each target's first rows lead, before any target's second.
    assert {p.chunk_id for p in found[:3]} == {"ws_1_0", "mine_0", "ws_2_0"}


async def test_an_account_sessions_embedding_receipt_names_its_pin(monkeypatch):
    monkeypatch.setattr(accounting.cfg, "gateway_url", "http://gateway")
    monkeypatch.setattr(accounting.cfg, "pipeline_secret", "secret")
    sent: list[dict[str, Any]] = []

    async def post_settlement(payload):
        sent.append(payload)
        return {}

    monkeypatch.setattr(accounting, "_post_settlement", post_settlement)
    spec = ModelConfig(
        version=1,
        provider_name="DeepInfra",
        model_name="Qwen",
        provider_slug="deepinfra",
        model_slug="Qwen/Qwen3-Embedding-4B",
        thinking_levels=(),
        default_thinking="",
        context_window_tokens=8192,
    )
    for account in (False, True):
        token = accounting.bind("cr_1")
        if account:
            accounting.unpin_embeddings()
        try:
            await accounting.settle(
                call_id="pc_1",
                kind=accounting.KIND_EMBEDDING,
                purpose=accounting.KIND_EMBEDDING,
                thinking="",
                spec=spec,
                usage=NormalizedUsage(input_tokens=5),
            )
        finally:
            accounting.reset(token)

    assert "modelVersion" not in sent[0]
    assert sent[1]["modelVersion"] == 1


def test_a_chat_request_reads_its_scope():
    from pydantic import ValidationError

    from pipeline.retrieve import service

    base = {
        "userId": "u_1",
        "thinking": "high",
        "query": "q",
        "contractVersion": contract.VERSION,
        "operations": [],
        "spendSessionId": "cr_1",
    }
    account = service.ChatStreamReq(
        **base, scope={"kind": "account", "workspaceIds": ["ws_1"], "userId": "u_1"}
    )
    workspace = service.ChatStreamReq(
        **base, scope={"kind": "workspace", "workspaceId": "ws_1"}, role="viewer"
    )
    # A gateway from before the scope field still names its workspace.
    older = service.ChatStreamReq(**base, workspaceId="ws_1", role="owner")

    assert account.account and account.workspaceId is None
    assert (workspace.workspaceId, older.workspaceId) == ("ws_1", "ws_1")
    with pytest.raises(ValidationError):
        service.ChatStreamReq(
            **base, scope={"kind": "workspace", "workspaceId": "ws_1"}
        )
    with pytest.raises(ValidationError):
        service.ChatStreamReq(
            **base, scope={"kind": "account", "workspaceIds": [], "userId": "u_2"}
        )
