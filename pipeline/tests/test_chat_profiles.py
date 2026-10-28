"""Chat profiles (todo-account-chat.md): workspace chat shows the model what it
did before account chat, byte for byte; account chat offers its own tools,
prompt and turn context, checks access through Go before reading, and
creates into No workspace unless a workspace is named."""

from __future__ import annotations

import base64
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
    evidence,
    pending,
    profiles,
    search,
    skills,
    tools,
    turn_context,
)
from pipeline.retrieval.scope import AccountScope, ScopeWorkspace
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
    {
        "source.read",
        "material.read",
        "material.create",
        "document.edit",
        "workspace.create",
        "library.read",
    }
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
            "scope": AccountScope(
                "u_1",
                (
                    ScopeWorkspace("ws_1", "Chemistry", True),
                    ScopeWorkspace("ws_2", "Biology", False),
                ),
            ),
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
        "search_files_summary",
        "search_files_content",
        "list_files",
        "list_workspaces",
        "create_workspace",
        "resolve_source_change",
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
    office = {
        s["function"]["name"]: s["function"]
        for s in profiles.account.PROFILE.schemas(
            _account(library_catalog=CATALOG, office_tools=True)
        )
    }
    # Every tool that creates takes where it lands (Epo 2026-10-28, T2).
    for name, schema in [
        *((n, by_name[n]) for n in ("create_material", "create_deck", "add_questions")),
        ("edit_office_document", office["edit_office_document"]),
    ]:
        assert "workspace_id" in schema["parameters"]["properties"]
        # Go's definition stays as it is.
        assert (
            "workspace_id"
            not in contract.DEFINITIONS[name]["inputSchema"]["properties"]
        )
    # Go's workspace wording in account words (Epo 2026-10-28, T3).
    sources = by_name["create_material"]["parameters"]["properties"]["sources"]
    assert "the user's files" in sources["description"]
    assert (
        "(ids from search_files_summary, list_files or a read)"
        in (sources["description"])
    )
    assert (
        "when the learner's files, the library" in by_name["search_web"]["description"]
    )


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
    # No open item, and the workspaces ride with the first message instead.
    assert "Open:" not in context and "workspace_id=" not in context
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
        **({"format": "pdf"} if kind == "source_file" else {"materialKind": "note"}),
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
    # A read also says what the item is (Epo 2026-10-28).
    assert (
        'Access: {"workspaceId": "ws_2", "workspaceName": "Biology", "canEdit": false, '
        '"kind": "source_file", "format": "pdf"}' in read.text()
    )


async def test_search_files_content_labels_hits_from_the_turns_scope(monkeypatch):
    found = [
        Passage(
            chunk_id=f"c_{f}",
            file_id=f,
            file_name=f"{f}.pdf",
            chunk_idx=0,
            section_path="",
            text="t",
        )
        for f in ("f_mine", "f_chem", "f_gone", "f_out", "f_theirs", "f_pdf")
    ]
    seen = {}

    async def search_account(**kwargs):
        seen.update(kwargs)
        return found

    async def item_places(file_ids, material_ids):
        place = {"chapter_id": None, "chapter_name": None, "owner_id": "u_other"}
        return {
            "f_mine": {**place, "workspace_id": None, "owner_id": "u_1"},
            "f_chem": {
                **place,
                "workspace_id": "ws_1",
                "chapter_id": "ch_1",
                "chapter_name": "Acids",
            },
            "f_out": {**place, "workspace_id": "ws_9"},
            "f_theirs": {**place, "workspace_id": None},
            "f_pdf": {**place, "workspace_id": "ws_1", "file_kind": "pdf"},
        }

    monkeypatch.setattr(tools, "search_account", search_account)
    monkeypatch.setattr(tools.store, "item_places", item_places)

    result = await tools._search_files_content({"query": "atp"}, _account())

    assert (seen["user_id"], seen["workspace_ids"]) == ("u_1", ["ws_1", "ws_2"])
    assert [p.file_id for p in result.passages] == ["f_mine", "f_chem", "f_pdf"]
    mine, chem, pdf = result.passages
    assert pdf.can_edit is False  # a PDF reads view only
    assert mine.location().startswith("No workspace › f_mine.pdf")
    assert chem.location().startswith("Chemistry › Acids › f_chem.pdf")
    assert (mine.can_edit, chem.can_edit) == (True, True)
    text = tools.render_result(result, list(enumerate(result.passages, 1)))
    assert "[1] file_id=f_mine, start=0, view and edit" in text
    assert (
        "[2] file_id=f_chem, start=0, workspace_id=ws_1, chapter_id=ch_1, "
        "view and edit" in text
    )


async def test_list_files_lists_one_workspace_or_the_files_with_none(monkeypatch):
    posts = []

    async def read(path, payload, _failure):
        posts.append(payload)
        if payload.get("workspaceId"):
            return {
                "items": [
                    {
                        "kind": "source_file",
                        "id": "f_2",
                        "title": "cells.pdf",
                        "editable": False,
                    }
                ]
            }
        return {
            "items": [
                {
                    "kind": "material",
                    "id": "mat_1",
                    "title": "My note",
                    "materialKind": "note",
                    "editable": True,
                }
            ],
            "more": True,
        }

    async def workspace_outline(workspace_id):
        return {
            "chapters": [{"id": "ch_1", "name": "Cells"}],
            "files": [
                {
                    "id": "f_2",
                    "name": "cells.pdf",
                    "kind": "file",
                    "chapter_id": "ch_1",
                    "chunks": 3,
                    "status": "ready",
                }
            ],
        }

    monkeypatch.setattr(tools, "_gateway_read", read)
    monkeypatch.setattr(tools.store, "workspace_outline", workspace_outline)
    ctx = _account()

    loose = (await tools._list_files({}, ctx)).text()
    biology = (await tools._list_files({"workspace_id": "ws_2"}, ctx)).text()
    outside = await tools._list_files({"workspace_id": "ws_9"}, ctx)

    assert loose.startswith(tools.NO_WORKSPACE_LISTED)
    assert "- My note (id=mat_1, kind=material" in loose
    assert tools.MORE_UNLISTED.format(count=1) in loose
    assert biology.startswith("The Biology workspace (workspace_id=ws_2):")
    assert "## Cells (chapter_id=ch_1)" in biology
    assert "cells.pdf (file_id=f_2" in biology
    assert outside.refused and len(posts) == 2


async def test_an_account_read_carries_its_items_changes(monkeypatch):
    """Epo 2026-10-28: loaded per item through Go's check when read, once
    per turn, and read again after this turn edits the item."""
    gateway = _Gateway([_row("source_file", "f_1")])
    monkeypatch.setattr(tools, "_gateway_read", gateway.read)
    asked = []

    def item_changes(user_id, kind, item_id, live):
        asked.append((user_id, kind, item_id, live))
        return {
            "files": [
                {
                    "fileId": item_id,
                    "name": "cells.md",
                    "workspaceId": "ws_2",
                    "epoch": 1,
                    "checkpoint": 2,
                    "indexedCheckpoint": 1,
                    "changes": [
                        {"id": "e1", "operation": "add", "after": "ATP synthase"}
                    ],
                }
            ],
            "notes": [],
            "unread": [],
        }

    async def snapshot(workspace_id, file_ids, *, evidence=True):
        return [
            {
                "fileId": "f_1",
                "revision": 1,
                "content_id": "rc_1",
                "epoch": 1,
                "indexedCheckpoint": 1,
            }
        ]

    async def read_file_range(**kwargs):
        return [
            {
                "id": "c_1",
                "file_id": "f_1",
                "file_name": "cells.md",
                "chunk_idx": 0,
                "text": "ATP",
            }
        ]

    monkeypatch.setattr(pending, "_item_changes", item_changes)
    monkeypatch.setattr(pending, "_snapshot", snapshot)
    monkeypatch.setattr(tools.store, "read_file_range", read_file_range)
    ctx = _account(pending_sources=pending.PendingSources.for_account("u_1"))

    first = await tools._read_document({"file_id": "f_1"}, ctx)
    again = await tools._read_document({"file_id": "f_1", "start": 1}, ctx)
    ctx.pending_sources.forget("f_1")
    after_edit = await tools._read_document({"file_id": "f_1"}, ctx)

    assert "ATP synthase" in first.pending and not again.pending
    assert "ATP synthase" in after_edit.pending
    assert asked == [("u_1", "source_file", "f_1", False)] * 2
    await ctx.pending_sources.validate()
    # An index published after the load no longer pairs with its changes.
    published = {
        "revision": 2,
        "content_id": "rc_2",
        "epoch": 1,
        "indexedCheckpoint": 2,
    }

    async def republished(workspace_id, file_ids, *, evidence=True):
        return [{"fileId": "f_1", **published}]

    monkeypatch.setattr(pending, "_snapshot", republished)
    with pytest.raises(pending.SourceChanged):
        await ctx.pending_sources.validate()


async def test_account_resolves_go_through_the_items_check(monkeypatch):
    raw = b"png bytes"
    posted = []

    def resolve_item(user_id, body):
        posted.append((user_id, body))
        if body["item"]["kind"] == "material":
            return {"before": "old chart", "after": "new chart"}
        return {
            "bytes": base64.b64encode(raw).decode(),
            "sha256": hashlib.sha256(raw).hexdigest(),
        }

    async def validate(self):
        return None

    monkeypatch.setattr(pending, "_resolve_item", resolve_item)
    monkeypatch.setattr(pending.PendingSources, "validate", validate)
    sources = pending.PendingSources.for_account("u_1")
    sources.files = [
        {
            "fileId": "f_1",
            "epoch": 3,
            "checkpoint": 5,
            "changes": [{"id": "e1", "assetRef": "a"}],
        }
    ]
    sources.notes = [
        {"materialId": "mat_1", "changes": [{"blockId": "b1", "kind": "data"}]}
    ]
    sources.read_ids = {"f_1", "mat_1"}

    image = await pending.resolve(
        sources=sources,
        workspace_id="",
        user_id="u_1",
        file_id="f_1",
        change_id="e1",
        checkpoint=5,
    )
    block = await pending.resolve_note(
        sources=sources,
        workspace_id="",
        user_id="u_1",
        material_id="mat_1",
        block_id="b1",
    )

    assert image == raw and block == {"before": "old chart", "after": "new chart"}
    assert posted == [
        (
            "u_1",
            {
                "item": {"kind": "source_file", "id": "f_1"},
                "epoch": 3,
                "checkpoint": 5,
                "changeId": "e1",
            },
        ),
        ("u_1", {"item": {"kind": "material", "id": "mat_1"}, "blockId": "b1"}),
    ]


async def test_an_account_office_create_lands_where_the_user_named(monkeypatch):
    sent = {}

    async def post(path, payload, op_id, ctx, **_kwargs):
        sent.update(payload, path=path)
        return tools._result("Created.")

    async def validate(self):
        return None

    monkeypatch.setattr(tools, "_post_operation", post)
    monkeypatch.setattr(pending.PendingSources, "validate", validate)
    ctx = _account(
        office_tools=True,
        skills_read={skills.EDITING, "office_building"},
        pending_sources=pending.PendingSources.for_account("u_1"),
    )

    await tools.run(
        "edit_office_document",
        {
            "commands": [{"type": "create", "format": "docx", "title": "Plan"}],
            "workspace_id": "ws_1",
            "_tool_call_id": "call_doc",
        },
        ctx,
    )

    assert sent["path"] == "/api/internal/documents/office/create"
    assert (sent["scope"], sent["workspaceId"]) == ("account", "ws_1")


async def test_the_workspace_list_rides_once_and_list_workspaces_is_current():
    """Epo 2026-10-28: the first message lists the workspaces, its answer
    keeps that text and later turns replay it unchanged; list_workspaces
    gives the turn's own list."""
    ctx = _account()
    listed = (await tools._list_workspaces({}, ctx)).text()
    assert listed == (
        "The user's workspaces:\n"
        "- Biology (workspace_id=ws_2, view only)\n"
        "- Chemistry (workspace_id=ws_1, view and edit)\n"
        "Their other files are in No workspace."
    )
    ctx.workspaces_shown = listed
    packed = evidence.pack(ctx, [])
    assert packed["workspaces"] == listed

    later = _account()
    replayed = await evidence.history_turns(
        [
            {"id": "u1", "role": "user", "content": "hi"},
            {
                "id": "a1",
                "role": "assistant",
                "content": "hello",
                "toolEvidence": packed,
            },
        ],
        later,
    )
    assert replayed[0]["content"] == f"{listed}\n\nhi"


async def test_create_workspace_cuts_what_is_over_its_limit(monkeypatch):
    sent = {}

    async def post(path, payload, op_id, ctx, **_kwargs):
        sent.update(payload, path=path)
        return tools._receipt_result(
            {
                "kind": "create_workspace",
                "outcome": "succeeded",
                "workspaceId": "ws_new",
                "name": payload["name"],
            }
        )

    monkeypatch.setattr(tools, "_post_operation", post)
    name = "N" * (tools.WORKSPACE_NAME_MAX + 5)
    tags = [f"tag {i}" for i in range(tools.WORKSPACE_TAGS_MAX + 2)]

    result = await tools._create_workspace(
        {"name": name, "tags": tags, "_tool_call_id": "call_ws"}, _account()
    )

    assert sent["path"] == "/api/internal/workspaces"
    assert sent["name"] == name[: tools.WORKSPACE_NAME_MAX]
    assert sent["tags"] == tags[: tools.WORKSPACE_TAGS_MAX]
    assert sent["description"] == ""
    text = result.text()
    assert "workspace_id=ws_new" in text and not result.refused
    assert "Every tool that creates can create in it" in text
    assert tools.CUT_NOTE.format(what="name", limit=tools.WORKSPACE_NAME_MAX) in text
    assert tools.TAGS_CUT_NOTE.format(limit=tools.WORKSPACE_TAGS_MAX, left=2) in text


@pytest.mark.parametrize("named", ["ws_2", None])
@pytest.mark.parametrize("tool", ["create_material", "add_questions"])
async def test_an_account_create_lands_where_the_user_named(monkeypatch, named, tool):
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
                        **({"workspaceId": named} if named else {}),
                    },
                },
            }

    def post(url, **kwargs):
        sent.update(json.loads(kwargs["data"]), url=url)
        return _Resp()

    monkeypatch.setattr(tools.requests, "post", post)
    ctx = _account(skills_read={skills.EDITING})
    args = (
        {
            "kind": "flashcards",
            "title": "Cards",
            "cards": [{"front": "a", "back": "b"}],
            "_tool_call_id": "call_1",
        }
        if tool == "create_material"
        else {
            "title": "Quiz",
            "questions": [{"question": "Q?", "options": ["a", "b"], "correct": "a"}],
            "_tool_call_id": "call_1",
        }
    )

    result = await tools.run(tool, {**args, "workspace_id": named}, ctx)

    assert not result.refused, result.text()
    assert sent["url"].endswith("/api/internal/materials")
    assert sent["scope"] == "account"
    assert sent.get("workspaceId") == named
    assert "workspaceId" in sent if named else "workspaceId" not in sent
    if tool == "create_material":
        where = (
            "the workspace 'Biology' (workspace_id=ws_2)" if named else "No workspace"
        )
        assert f"It is now in {where}." in result.text()


async def test_an_account_chapter_names_its_workspace(monkeypatch):
    class _Resp:
        status_code = 400

        @property
        def headers(self) -> dict[str, str]:
            return {}

        def json(self):
            return {"code": "unknown_chapter", "message": "not there"}

    monkeypatch.setattr(tools.requests, "post", lambda *_a, **_k: _Resp())
    ctx = _account(skills_read={skills.EDITING, skills.NOTE_BUILDING})
    note = {
        "kind": "note",
        "title": "N",
        "content": "body",
        "chapter_id": "ch_1",
        "_tool_call_id": "c",
    }

    alone = await tools.run("create_material", note, ctx)
    elsewhere = await tools.run(
        "create_material", {**note, "workspace_id": "ws_1"}, ctx
    )

    assert alone.refused and tools.CHAPTER_NEEDS_WORKSPACE in alone.text()
    assert elsewhere.refused
    assert tools.CHAPTERS_LISTED[True] in elsewhere.detail


async def test_search_account_ranks_each_pins_files_together_and_merges_pins(
    monkeypatch,
):
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
        target = kwargs["workspace_ids"][0]
        return [row(f"{target}_{i}") for i in range(2)]

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
    # One statement per pin: its workspace and standalone files in one pool.
    assert sorted(searched, key=str) == sorted(
        [(["ws_1"], "u_1", "a"), (["ws_2"], None, "b")], key=str
    )
    # Each pin's first rows lead, before any pin's second.
    assert {p.chunk_id for p in found[:2]} == {"ws_1_0", "ws_2_0"}


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
