"""Account chat's searches against the real schema (todo-account-chat.md):
search_files_content takes two workspaces and the caller's standalone files
in one search, and nothing outside the scope Go resolved (another user's
standalone file, a workspace the caller only reached by link);
search_files_summary matches names and descriptors as the hints do."""

from __future__ import annotations

import hashlib
import secrets

import psycopg
import pytest

from pipeline import registry
from pipeline.config import cfg
from pipeline.retrieval import search, store, tools
from pipeline.retrieval.chunking import tokenize_for_search
from pipeline.retrieval.scope import AccountScope, ScopeWorkspace

pytestmark = pytest.mark.integration

_PIN = {
    "embedding_provider_slug": "deepinfra",
    "embedding_model_slug": "Qwen/Qwen3-Embedding-4B",
    "embedding_model_version": 1,
    "embedding_dim": 2560,
}


def _vector(axis: int) -> list[float]:
    vector = [0.0] * cfg.embedding_dim
    vector[axis % cfg.embedding_dim] = 1.0
    return vector


@pytest.fixture
def accounts(_test_infra):
    """The caller with two workspaces and a standalone file, another user with
    a standalone file and a workspace the caller only reached by link."""
    dsn = _test_infra
    me, other = (f"u_{secrets.token_hex(6)}" for _ in range(2))
    spaces = {name: f"ws_{secrets.token_hex(6)}" for name in ("own", "member", "link")}
    with psycopg.connect(dsn, autocommit=True) as conn:
        for user in (me, other):
            conn.execute(
                "INSERT INTO users (id, name, email) VALUES (%s, 'U', %s)",
                (user, f"{user}@capynotebook.test"),
            )
        for name, ws in spaces.items():
            conn.execute(
                "INSERT INTO workspaces (id, user_id, name) VALUES (%s, %s, %s)",
                (ws, me if name == "own" else other, name),
            )
    registry.registry.refresh()
    try:
        yield {"dsn": dsn, "me": me, "other": other, "spaces": spaces}
    finally:
        with psycopg.connect(dsn, autocommit=True) as conn:
            conn.execute("DELETE FROM files WHERE user_id = ANY(%s)", ([me, other],))
            conn.execute(
                "DELETE FROM workspaces WHERE id = ANY(%s)", (list(spaces.values()),)
            )
            conn.execute("DELETE FROM users WHERE id = ANY(%s)", ([me, other],))


async def _index(dsn: str, *, workspace: str | None, owner: str, text: str) -> str:
    """One indexed file holding ``text``, in a workspace or standalone."""
    file_id = f"f_{secrets.token_hex(6)}"
    with psycopg.connect(dsn, autocommit=True) as conn:
        conn.execute(
            """
            INSERT INTO files (id, workspace_id, user_id, name, kind, size_bytes,
                               status, blob_path)
            VALUES (%s, %s, %s, %s, 'txt', 1024, 'ready', %s)
            """,
            (file_id, workspace, owner, f"{file_id}.txt", f"sources/{file_id}"),
        )
    association = await store.attach_file_content(
        workspace_id=workspace,
        owner_user_id=None if workspace else owner,
        file_id=file_id,
        content_hash=hashlib.sha256(f"{file_id}{text}".encode()).hexdigest(),
        claim_job_id="job_index",
    )
    await store.replace_content_chunks(
        workspace_id=workspace,
        content_id=association["content_id"],
        pin=None if workspace else _PIN,
        rows=[
            {
                "id": f"{file_id}_c0",
                "chunk_idx": 0,
                "section_path": "",
                "text": text,
                "indexed_text": text,
                "token_count": len(text) // 4,
                "page_start": None,
                "page_end": None,
                "regions": [],
                "lang": "en",
                "search_text": tokenize_for_search(text),
                "embedding": store.vector_literal(_vector(1)),
            }
        ],
    )
    if not association["ready"]:
        await store.publish_file_content(
            workspace_id=workspace,
            file_id=file_id,
            content_id=association["content_id"],
            claim_job_id="job_index",
        )
    return file_id


async def test_search_files_merges_the_scope_and_keeps_out_the_rest(
    accounts, monkeypatch
):
    me, other, spaces = accounts["me"], accounts["other"], accounts["spaces"]
    dsn = accounts["dsn"]
    text = "Mitochondria make ATP by oxidative phosphorylation"
    own = await _index(dsn, workspace=spaces["own"], owner=me, text=text)
    member = await _index(dsn, workspace=spaces["member"], owner=other, text=text)
    mine = await _index(dsn, workspace=None, owner=me, text=text)
    theirs = await _index(dsn, workspace=None, owner=other, text=text)
    linked = await _index(dsn, workspace=spaces["link"], owner=other, text=text)
    embedded: list[str] = []

    async def embed(texts, *, spec):
        embedded.append(spec.model_slug)
        return [_vector(1) for _ in texts]

    monkeypatch.setattr(search.models, "embed", embed)
    stats = search.SearchStats()

    passages = await search.search_account(
        user_id=me,
        workspace_ids=[spaces["own"], spaces["member"]],
        query="mitochondria ATP",
        stats=stats,
    )

    found = {p.file_id for p in passages}
    assert found == {own, member, mine}
    assert not found & {theirs, linked}
    # The workspaces and the standalone content share one pin: one embedding.
    assert embedded == [_PIN["embedding_model_slug"]] and stats.embeddings == 1

    restricted = await search.search_account(
        user_id=me,
        workspace_ids=[spaces["own"], spaces["member"]],
        query="mitochondria ATP",
        file_ids=[mine, theirs],
    )
    assert [p.file_id for p in restricted] == [mine]

    # Labels read where each item lives now.
    places = await store.item_places([own, mine], [])
    assert places[own]["workspace_id"] == spaces["own"]
    assert (places[mine]["workspace_id"], places[mine]["owner_id"]) == (None, me)


async def test_an_account_read_takes_a_standalone_file(accounts):
    me = accounts["me"]
    mine = await _index(accounts["dsn"], workspace=None, owner=me, text="Krebs cycle")

    rows = await store.read_file_range(
        workspace_id=None, file_id=mine, start=0, count=4
    )

    assert [row["text"] for row in rows] == ["Krebs cycle"]
    history = await store.account_history_passages(me, [], [f"{mine}_c0"])
    assert [row["file_id"] for row in history] == [mine]


async def test_search_files_summary_matches_names_and_summaries_in_scope(
    accounts, monkeypatch
):
    """Option B (Epo 2026-10-28): one scoped query over names and each
    summary's stored search vector, then Go's check on the hits."""
    me, other, spaces = accounts["me"], accounts["other"], accounts["spaces"]
    dsn = accounts["dsn"]
    summary = "Mitochondria produce ATP through oxidative phosphorylation."
    own = await _index(dsn, workspace=spaces["own"], owner=me, text="cells")
    named = await _index(dsn, workspace=None, owner=me, text="leaves")
    theirs = await _index(dsn, workspace=None, owner=other, text="cells")
    linked = await _index(dsn, workspace=spaces["link"], owner=other, text="cells")
    for file_id in (own, theirs, linked):
        content = (await store.file_content(file_id))["id"]
        await store.upsert_content_summary(
            content_id=content, fingerprint="f", descriptor=summary, change_share=0
        )
    with psycopg.connect(dsn, autocommit=True) as conn:
        conn.execute(
            "UPDATE files SET name = 'Photosynthesis notes.md' WHERE id = %s", (named,)
        )
    asked = []

    async def read(path, payload, _failure):
        asked.append(payload)
        return {
            "items": [
                {
                    **item,
                    "canRead": True,
                    "canEdit": True,
                    "editable": item["id"] != own,
                    "workspaceId": spaces["own"] if item["id"] == own else "",
                    "workspaceName": "Biology" if item["id"] == own else "",
                }
                for item in payload["items"]
            ]
        }

    monkeypatch.setattr(tools, "_gateway_read", read)
    monkeypatch.setattr(tools, "_gateway_ready", lambda: True)
    ctx = tools.ToolContext(
        workspace_id="",
        scope=AccountScope(me, (ScopeWorkspace(spaces["own"], "Biology", True),)),
        user_id=me,
        operations=frozenset({"source.read", "material.read", "document.edit"}),
    )

    cells = (
        await tools._search_files_summary({"query": "mitochondria ATP"}, ctx)
    ).text()
    leaves = (
        await tools._search_files_summary({"query": "photosynthesis"}, ctx)
    ).text()

    assert f"file_id={own}" in cells and theirs not in cells and linked not in cells
    assert f'workspace "Biology" workspace_id={spaces["own"]}, view only' in cells
    assert summary in cells
    assert f"file_id={named}, outside workspaces, view and edit" in leaves
    # Go is asked about the hits alone, never the whole scope.
    assert [item["id"] for item in asked[0]["items"]] == [own]
