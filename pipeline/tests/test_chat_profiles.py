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

import psycopg
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
# from the current code to make this pass. Changed on purpose since:
# create_chapter and the editing skill's chapter-list line (Epo 2026-10-29), the
# shorter Plan (Epo 2026-10-29),
# the owner schemas and skills/editing keys alone.
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
        "list_sources",
        "list_workspaces",
        "create_workspace",
        "create_chapter",
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
    # create_chapter names its workspace here; No workspace has no chapters.
    chapter = by_name["create_chapter"]["parameters"]
    assert "workspace_id" in chapter["properties"]
    assert chapter["required"] == ["workspace_id"]
    assert "required" not in contract.DEFINITIONS["create_chapter"]["inputSchema"]
    # Workspace chat's list_sources, listing by workspace here (Q523).
    listing = by_name["list_sources"]
    assert listing["description"] == profiles.account.LIST_SOURCES
    assert "workspace_id" in listing["parameters"]["properties"]
    assert contract.DEFINITIONS["list_sources"]["inputSchema"]["properties"] == {}
    # Go's workspace wording in account words (Epo 2026-10-28, T3).
    sources = by_name["create_material"]["parameters"]["properties"]["sources"]
    assert "the user's files" in sources["description"]
    assert (
        "(ids from search_files_summary, list_sources or a read)"
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
    # The outline also offers where new files go (review F1/F3; Epo 2026-10-29).
    assert "No workspace, which has no chapters" in editing
    assert "create_chapter" in editing and "create_workspace" in editing
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


async def test_a_file_with_no_workspace_is_inspected_and_edited_through_go(
    monkeypatch,
):
    # Go's source sessions take a file with no workspace, its owner's alone
    # (Epo 2026-10-27): account chat asks Go instead of refusing.
    row = {**_row("source_file", "f_loose", ws="", name="", edit=True), "format": "md"}
    posts: list[tuple[str, dict[str, Any]]] = []

    async def read(path: str, payload: dict[str, Any], _failure: str, *_a, **_k):
        posts.append((path, payload))
        if path.endswith("/documents/access"):
            return {"items": [row]}
        return {
            "format": "text",
            "title": "notes.md",
            "incarnation": 1,
            "access": "write",
            "lines": [{"start": 0, "text": "Loose notes"}],
            "total": 1,
            "nextStart": None,
            "supportedOperations": ["replace_text"],
        }

    monkeypatch.setattr(tools, "_gateway_read", read)
    monkeypatch.setattr(tools, "_gateway_ready", lambda: True)
    ctx = _account()
    target = {"kind": "source_file", "id": "f_loose"}

    for result in [
        await tools._inspect_document({"target": target}, ctx),
        await tools._inspect_office_document({"file_id": "f_loose"}, ctx),
    ]:
        assert not result.refused and "Loose notes" in result.text()
    assert await tools._check_source_target(ctx, "f_loose") is None
    inspected = [p for path, p in posts if path == "/api/internal/documents/inspect"]
    assert len(inspected) == 2
    assert all(p["target"] == target and not p.get("workspaceId") for p in inspected)


async def test_the_document_tools_point_a_missing_id_to_list_sources(monkeypatch):
    # Q523, Q525: account chat's not found names list_sources, now a tool
    # there too, and search_files_summary; Go is not asked to inspect or edit.
    gateway = _Gateway()
    monkeypatch.setattr(tools, "_gateway_read", gateway.read)
    ctx = _account()
    target = {"kind": "source_file", "id": "f_gone"}

    for result in [
        await tools._inspect_document({"target": target}, ctx),
        await tools._edit_document(
            {"target": target, "commands": [], "_tool_call_id": "c_1"}, ctx
        ),
        await tools._inspect_office_document({"file_id": "f_gone"}, ctx),
        await tools._edit_office_document(
            {
                "file_id": "f_gone",
                "commands": [{"type": "set_cell"}],
                "_tool_call_id": "c_2",
            },
            ctx,
        ),
    ]:
        assert result.refused
        assert tools.NO_ACCOUNT_ITEM.format(id="f_gone") in result.text()
        assert (
            "list_sources shows a workspace's current ids; search_files_summary "
            "finds a file by name across your workspaces." in result.text()
        )
    assert {path for path, _ in gateway.posts} == {"/api/internal/documents/access"}


async def test_a_not_found_after_the_access_check_is_account_chats_one_text(
    monkeypatch,
):
    # Review W1, Q525: Go answering 404 after access passed (the item trashed
    # in between) gives the access refusal's text, not workspace chat's
    # NO_WORKSPACE_ITEM; a quiz the user names is read and edited the same.
    readable = _row("source_file", "f_1", edit=True)

    def post(url, **kwargs):
        if url.endswith("/documents/access"):
            items = json.loads(kwargs["data"])["items"]
            return _Resp({"items": [{**i, **readable} for i in items]})
        return _Resp({"code": "not_found", "message": "not found"}, 404)

    monkeypatch.setattr(tools.requests, "post", post)
    ctx = _account()
    target = {"kind": "source_file", "id": "f_1"}
    quizzes = tools._gateway_quizzes(ctx, "c_3")

    for result in [
        await tools._inspect_document({"target": target}, ctx),
        await tools._edit_document(
            {"target": target, "commands": [], "_tool_call_id": "c_1"}, ctx
        ),
        await tools._inspect_office_document({"file_id": "f_1"}, ctx),
        await tools._edit_office_document(
            {
                "file_id": "f_1",
                "commands": [{"type": "set_cell"}],
                "_tool_call_id": "c_2",
            },
            ctx,
        ),
    ]:
        assert result.refused
        assert tools.NO_ACCOUNT_ITEM.format(id="f_1") in result.text()
        assert "No workspace item" not in result.text()
    for result in [await quizzes.load("q_1"), await quizzes.edit("q_1", [], [], [])]:
        assert result.refused
        assert tools.NO_ACCOUNT_ITEM.format(id="q_1") in result.text()


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


async def test_list_sources_lists_one_workspace_or_the_files_with_none(monkeypatch):
    # Account chat's list_sources (Q523), through dispatch: its workspace_id
    # is the profile's argument, not Go's.
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

    loose = (await tools.run("list_sources", {}, ctx)).text()
    biology = (await tools.run("list_sources", {"workspace_id": "ws_2"}, ctx)).text()
    outside = await tools.run("list_sources", {"workspace_id": "ws_9"}, ctx)

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


def _item_changes(asked: list, after: str):
    """Go's /api/internal/changes for one file with one unindexed change."""

    def item_changes(user_id, kind, item_id, live):
        asked.append((kind, item_id))
        return {
            "files": [
                {
                    "fileId": item_id,
                    "name": "grades.xlsx",
                    "workspaceId": "ws_1",
                    "epoch": 1,
                    "checkpoint": 4,
                    "indexedCheckpoint": 2,
                    "changes": [{"id": "c_1", "operation": "replace", "after": after}],
                }
            ],
            "notes": [],
            "unread": [],
        }

    return item_changes


async def _snapshot(workspace_id, file_ids, *, evidence=True):
    return [
        {
            "fileId": f,
            "revision": 1,
            "content_id": "rc",
            "epoch": 1,
            "indexedCheckpoint": 2,
        }
        for f in file_ids
    ]


async def test_an_account_office_inspect_carries_its_items_changes(monkeypatch):
    """Q526: inspect_office_document loads the file's changes and appends
    them once per turn, as read_document does."""
    gateway = _Gateway([_row("source_file", "f_9", ws="ws_1", edit=True)])

    async def read(path, payload, failure, *args, **kwargs):
        if path.endswith("/documents/inspect"):
            return {
                "format": "xlsx",
                "title": "grades.xlsx",
                "scoped": {
                    "sheets": [{"id": "0", "name": "Grades", "usedRange": "A1:B2"}]
                },
            }
        return await gateway.read(path, payload, failure)

    asked: list = []
    monkeypatch.setattr(tools, "_gateway_read", read)
    monkeypatch.setattr(tools, "_gateway_ready", lambda: True)
    monkeypatch.setattr(pending, "_item_changes", _item_changes(asked, "B2 now 77"))
    monkeypatch.setattr(pending, "_snapshot", _snapshot)
    ctx = _account(pending_sources=pending.PendingSources.for_account("u_1"))

    first = await tools._inspect_office_document({"file_id": "f_9"}, ctx)
    again = await tools._inspect_office_document({"file_id": "f_9"}, ctx)

    assert '"after":"B2 now 77"' in first.pending and again.pending == ""
    assert asked == [("source_file", "f_9")]


async def test_account_search_passages_say_their_edits_are_not_indexed(monkeypatch):
    """Q527: as workspace chat's do, a file's or a note's passage, loading
    each passage's item as a read; an item whose load fails (here the
    database) only loses its line, and its read says sources may be outdated."""
    ids = ("f_edited", "f_still", "mat_note", "f_broken")
    found = [
        Passage(
            chunk_id=f"c_{rid}",
            file_id=rid,
            file_name=f"{rid}.xlsx",
            chunk_idx=0,
            section_path="",
            text="t",
            kind="material" if rid.startswith("mat_") else "file",
        )
        for rid in ids
    ]

    async def search_account(**_kwargs):
        return found

    async def item_places(file_ids, material_ids):
        return {
            rid: {
                "workspace_id": "ws_1",
                "chapter_id": None,
                "chapter_name": None,
                "owner_id": "u_1",
            }
            for rid in [*file_ids, *material_ids]
        }

    asked: list = []
    edited = _item_changes(asked, "77")

    def item_changes(user_id, kind, item_id, live):
        body = edited(user_id, kind, item_id, live)
        if item_id == "mat_note":
            note = {"materialId": item_id, "title": "Tides", "revision": 3}
            return {**body, "files": [], "notes": [{**note, "changes": [{}, {}]}]}
        return body if item_id == "f_edited" else {**body, "files": []}

    async def note_identities(workspace_id, material_ids):
        return [(material_ids[0], "rc_note")]

    async def snapshot(workspace_id, file_ids, *, evidence=True):
        if file_ids == ["f_broken"]:
            raise psycopg.OperationalError("the database went away")
        return await _snapshot(workspace_id, file_ids, evidence=evidence)

    async def read_file_range(**_kwargs):
        return []

    gateway = _Gateway([_row("source_file", "f_broken", ws="ws_1")])
    monkeypatch.setattr(tools, "_gateway_read", gateway.read)
    monkeypatch.setattr(tools, "search_account", search_account)
    monkeypatch.setattr(tools.store, "item_places", item_places)
    monkeypatch.setattr(tools.store, "read_file_range", read_file_range)
    monkeypatch.setattr(pending, "_item_changes", item_changes)
    monkeypatch.setattr(pending, "_note_identities", note_identities)
    monkeypatch.setattr(pending, "_snapshot", snapshot)
    ctx = _account(pending_sources=pending.PendingSources.for_account("u_1"))

    result = await tools._search_files_content({"query": "grades"}, ctx)
    text = tools.render_result(result, list(enumerate(result.passages, 1)))
    read = await tools._read_document({"file_id": "f_broken"}, ctx)

    assert [p.file_id for p in result.passages] == list(ids)
    assert sorted(asked) == [
        ("material", "mat_note"),
        ("source_file", "f_edited"),
        ("source_file", "f_still"),
    ]
    assert '[1] "f_edited.xlsx" has 1 edit not indexed yet' in text
    assert '[3] "mat_note.xlsx" has 2 edits not indexed yet' in text
    assert ctx.passage_flags == {"c_f_edited": 1, "c_mat_note": 2}
    assert read.pending == pending.NOTICE


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


async def test_create_chapter_cuts_its_name_and_names_its_workspace(monkeypatch):
    sent = {}

    async def post(path, payload, op_id, ctx, **_kwargs):
        sent.update(payload, path=path)
        return tools._receipt_result(
            {
                "operationId": op_id,
                "kind": "create_chapter",
                "outcome": "succeeded",
                "workspaceId": payload["workspaceId"],
                "name": payload["name"],
            },
            ctx,
        )

    monkeypatch.setattr(tools, "_post_operation", post)
    name = "N" * (tools.CHAPTER_NAME_MAX + 5)

    result = await tools.run(
        "create_chapter",
        {"name": name, "workspace_id": "ws_1", "_tool_call_id": "call_1"},
        _account(),
    )
    missing = await tools.run("create_chapter", {"_tool_call_id": "call_2"}, _account())

    assert sent["path"] == "/api/internal/chapters"
    assert sent["scope"] == "account" and sent["workspaceId"] == "ws_1"
    assert sent["name"] == name[: tools.CHAPTER_NAME_MAX]
    text = result.text()
    assert not result.refused, text
    assert f"chapter_id={tools.chapter_id(tools.operation_id('m_1', 'call_1'))}" in text
    assert tools.CUT_NOTE.format(what="name", limit=tools.CHAPTER_NAME_MAX) in text
    assert missing.refused
    assert tools.CHAPTER_NEEDS_ITS_WORKSPACE in missing.text()


def test_list_sources_names_empty_chapters():
    # Review F2: a build reuses a chapter with nothing in it yet.
    outline = {"chapters": [{"id": "ch_1", "name": "Kinematics"}], "files": []}

    text = tools._source_listing(outline, [], None).text()

    assert "## Kinematics (chapter_id=ch_1)" in text


async def test_a_chapter_the_turn_creates_takes_its_items(monkeypatch):
    # Workspace chat checks chapter_id against the turn's chapters before Go.
    def post(url, **kwargs):
        return _Resp(
            {
                "operationId": "op_abc",
                "kind": "create_chapter",
                "outcome": "succeeded",
                "workspaceId": "ws_1",
                "name": "Kinematics",
            }
        )

    monkeypatch.setattr(tools.requests, "post", post)
    ctx = _ctx(assistant_message_id="m_1")

    created = await tools._create_chapter(
        {"name": "Kinematics", "_tool_call_id": "call_1"}, ctx
    )

    assert not created.refused, created.text()
    assert ctx.chapters == [{"id": "ch_abc", "name": "Kinematics"}]
    assert tools.unknown_chapter(ctx, {"chapter_id": "ch_abc"}) is None


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


class _Resp:
    def __init__(self, body: dict[str, Any], status: int = 200) -> None:
        self._body = body
        self.status_code = status
        self.headers: dict[str, str] = {}

    def json(self) -> dict[str, Any]:
        return self._body


async def test_a_workspace_the_turn_creates_joins_its_list(monkeypatch):
    # Review r1 M-2: list_workspaces and list_sources reach it at once.
    def post(url, **kwargs):
        return _Resp(
            {
                "kind": "create_workspace",
                "outcome": "succeeded",
                "workspaceId": "ws_new",
                "name": json.loads(kwargs["data"])["name"],
            }
        )

    async def read(path, payload, _failure):
        return {"items": []}

    async def workspace_outline(workspace_id):
        return {"chapters": [], "files": []}

    monkeypatch.setattr(tools.requests, "post", post)
    monkeypatch.setattr(tools, "_gateway_read", read)
    monkeypatch.setattr(tools.store, "workspace_outline", workspace_outline)
    ctx = _account()

    created = await tools._create_workspace(
        {"name": "Physics", "_tool_call_id": "call_ws"}, ctx
    )
    listed = (await tools._list_workspaces({}, ctx)).text()
    files = await tools.run("list_sources", {"workspace_id": "ws_new"}, ctx)

    assert not created.refused, created.text()
    assert "- Physics (workspace_id=ws_new, view and edit)" in listed
    assert not files.refused
    assert files.text().startswith("The Physics workspace (workspace_id=ws_new):")
    assert (
        tools._created_in({"workspaceId": "ws_new"}, ctx)
        == "the workspace 'Physics' (workspace_id=ws_new)"
    )


async def test_an_account_read_of_a_file_moved_away_says_so(monkeypatch):
    # Q489: Go marks a file this account chat edited, moved where the user
    # cannot open it.
    moved = {**_row("source_file", "f_moved", ws="", name=""), "canRead": False}
    gateway = _Gateway([{**moved, "movedOut": True}])
    monkeypatch.setattr(tools, "_gateway_read", gateway.read)

    result = await tools._read_document({"file_id": "f_moved"}, _account())

    assert result.refused and tools.ACCOUNT_MOVED_OUT in result.text()


@pytest.mark.parametrize(
    ("account", "told"), [(True, tools.ACCOUNT_MOVED_OUT), (False, tools.MOVED_OUT)]
)
def test_a_moved_out_write_is_told_in_its_chats_words(account, told):
    resp = _Resp({"code": "moved_out", "message": "gone"}, 404)

    result = tools._gateway_refused(resp, "Could not edit", account=account)

    assert result.refused and told in result.text()


def test_an_account_permission_denied_refuses_only_that_edit():
    # E1: in account chat a view-only item stops that edit, not the turn.
    resp = _Resp({"code": "permission_denied", "message": "view only"}, 403)

    result = tools._gateway_refused(resp, "Could not edit", account=True)

    assert tools.ACCOUNT_NO_EDIT in result.detail


@pytest.mark.parametrize(
    "code", sorted(tools._NO_PERMISSION_CODES - {"permission_denied"})
)
def test_an_account_frozen_or_locked_still_stops_the_turn(code):
    resp = _Resp({"code": code, "message": "no"}, 403)

    result = tools._gateway_refused(resp, "Could not edit", account=True)

    assert tools.NO_PERMISSION in result.detail


async def test_an_account_inspect_of_a_file_moved_away_says_so(monkeypatch):
    posts = []

    def post_json(path, payload):
        posts.append(path)
        if path.endswith("/documents/access"):
            return _Resp({"items": [_row("source_file", "f_1")]})
        return _Resp({"code": "moved_out", "message": "gone"}, 404)

    monkeypatch.setattr(tools, "_post_json", post_json)
    target = {"kind": "source_file", "id": "f_1"}

    result = await tools._inspect_document({"target": target}, _account())

    assert posts[-1] == "/api/internal/documents/inspect"
    assert result.refused and tools.ACCOUNT_MOVED_OUT in result.text()


async def test_an_account_edit_names_the_account_scope_not_a_workspace(monkeypatch):
    gateway = _Gateway(
        [_row("source_file", "f_1", ws="ws_1", name="Chemistry", edit=True)]
    )
    sent = {}

    def post(url, **kwargs):
        sent.update(json.loads(kwargs["data"]), url=url)
        return _Resp(
            {
                "operationId": "op_1",
                "outcome": "succeeded",
                "effect": {
                    "operation": "edited",
                    "operationId": "op_1",
                    "resource": {"kind": "source_file", "id": "f_1", "title": "a.pdf"},
                },
            }
        )

    async def load(*_args, **_kwargs):
        return pending.PendingSources()

    monkeypatch.setattr(tools, "_gateway_read", gateway.read)
    monkeypatch.setattr(tools.requests, "post", post)
    monkeypatch.setattr(tools.pending, "load", load)
    ctx = _account(skills_read={skills.EDITING})
    commands = [{"type": "replace_text", "expected_text": "old", "text": "new"}]

    result = await tools.run(
        "edit_document",
        {
            "target": {"kind": "source_file", "id": "f_1"},
            "commands": commands,
            "_tool_call_id": "c1",
        },
        ctx,
    )

    assert not result.refused, result.text()
    assert sent["url"].endswith("/api/internal/documents/edit")
    assert sent["scope"] == "account" and "workspaceId" not in sent
