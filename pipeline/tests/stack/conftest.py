"""The Agent visibility lane (`pnpm test:visibility`, Q529-Q534): what a person
or the agent creates or edits reaches what the chat model receives.

Real Go, collaboration server and Postgres from deploy/docker-compose.e2e.yml
(this fixture starts its own compose project, as e2e/global-setup.ts does),
the real pipeline in process, a scripted model (test_agent's
``_script_stream``, which records every request) and stub embeddings over an
index seeded with the pipeline's own store functions. No provider is called:
any connection off the loopback fails the test (``no_provider``).

Environment, as the Playwright stack takes it: E2E_PREBUILT_IMAGES=true
starts the images without building them (CI loads them from its layer cache),
E2E_COMPOSE_OVERRIDES layers more compose files, E2E_SKIP_COMPOSE=true uses a
stack already up on the E2E_* ports and secrets, E2E_KEEP_STACK=true leaves it
running.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import secrets
import socket
import string
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import psycopg
import pytest
import requests
from test_agent import _answer, _assembled, _call, _model, _script_stream

from pipeline.config import cfg
from pipeline.retrieval import agent, contract, models, pending_hints, store
from pipeline.retrieval.chunking import chunk_markdown, tokenize_for_search
from pipeline.retrieval.scope import AccountScope, ScopeWorkspace
from pipeline.retrieval.tools import ToolContext

ROOT = Path(__file__).resolve().parents[3]
FILES = ROOT / "e2e" / "fixtures" / "files" / "basic"
CONTENT_TYPES = {
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "md": "text/markdown",
}
# Account chat's operations (Go sends them with the turn).
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


def _port() -> str:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return str(sock.getsockname()[1])


def vector(text: str) -> list[float]:
    """The stub embedding: a one-hot vector picked by the text's hash."""
    out = [0.0] * cfg.embedding_dim
    out[int(hashlib.sha256(text.encode()).hexdigest(), 16) % cfg.embedding_dim] = 1.0
    return out


@dataclass
class Stack:
    api_url: str
    auth_secret: str
    pipeline_secret: str
    dsn: str

    @staticmethod
    def marker() -> str:
        """A word no fixture holds, to find in what the model receives."""
        return "vis" + "".join(secrets.choice(string.ascii_lowercase) for _ in range(8))

    def owner(self, workspace_id: str, user: str = "u_owner") -> ToolContext:
        """A workspace turn of `user` (all the operations an owner has)."""
        return ToolContext(
            workspace_id=workspace_id,
            user_id=user,
            operations=frozenset(contract.OPERATIONS),
            assistant_message_id=self.message(user, workspace_id),
        )

    def account(self, user: str) -> ToolContext:
        """An account turn reaching the user's workspaces, as Go sends them."""
        rows = self.sql(
            "SELECT w.id, w.name, m.role IN ('owner','editor') FROM workspace_members m"
            " JOIN workspaces w ON w.id=m.workspace_id WHERE m.user_id=%s ORDER BY w.id",
            (user,),
        )
        return ToolContext(
            workspace_id="",
            scope=AccountScope(user, tuple(ScopeWorkspace(*row) for row in rows)),
            user_id=user,
            operations=ACCOUNT,
            assistant_message_id=self.message(user, None),
        )

    def sql(self, query: str, params: tuple = ()) -> list[tuple]:
        with psycopg.connect(self.dsn, autocommit=True) as conn:
            cur = conn.execute(query, params)
            return cur.fetchall() if cur.description else []

    def call(self, user: str, method: str, path: str, **kwargs) -> Any:
        """Go's public API as `user` (the e2e auth headers)."""
        response = requests.request(
            method,
            self.api_url + path,
            headers={"X-E2E-Secret": self.auth_secret, "X-E2E-User-Id": user},
            timeout=60,
            **kwargs,
        )
        assert response.status_code < 300, f"{path}: {response.text}"
        return response.json() if response.content else None

    def internal(self, path: str, body: dict[str, Any]) -> dict[str, Any]:
        """Go's internal agent routes, as the retrieval service calls them."""
        response = requests.post(
            self.api_url + path,
            headers={"X-Pipeline-Secret": self.pipeline_secret},
            json=body,
            timeout=60,
        )
        assert response.status_code < 300, f"{path}: {response.text}"
        return response.json()

    def workspace(self, owner: str = "u_owner", members: tuple = ("u_editor",)):
        """A workspace of its own for one test, the editor a member, with one
        chapter (id ch_<workspace id>, name "Chapter <workspace id>")."""
        ws = f"ws_vis_{secrets.token_hex(4)}"
        self.sql(
            "INSERT INTO workspaces (id, user_id, name, privacy, share_role)"
            " VALUES (%s, %s, %s, 'private', 'viewer')",
            (ws, owner, f"Visibility {ws}"),
        )
        self.sql(
            "INSERT INTO chapters (id, workspace_id, name, position)"
            " VALUES (%s, %s, %s, 0)",
            (f"ch_{ws}", ws, f"Chapter {ws}"),
        )
        for user in (owner, *members):
            self.sql(
                "INSERT INTO workspace_members (workspace_id, user_id, role)"
                " VALUES (%s, %s, %s)",
                (ws, user, "owner" if user == owner else "editor"),
            )
        return ws

    def message(self, user: str, workspace_id: str | None) -> str:
        """A conversation's assistant message: what an agent write is
        recorded under (account chat's has no workspace)."""
        conv, msg = f"conv_{secrets.token_hex(6)}", f"msg_{secrets.token_hex(6)}"
        self.sql(
            "INSERT INTO conversations (id, user_id, workspace_id, title)"
            " VALUES (%s, %s, %s, 'Visibility')",
            (conv, user, workspace_id),
        )
        self.sql(
            "INSERT INTO messages (id, conversation_id, role, status)"
            " VALUES (%s, %s, 'assistant', 'complete')",
            (msg, conv),
        )
        return msg

    def upload(self, user: str, workspace_id: str, name: str, data: bytes) -> str:
        """An upload as the browser sends it: a ticket, then one request with
        the metadata part before the file part."""
        path = f"/api/workspaces/{workspace_id}/sources/uploads"
        metadata = {
            "batchId": f"vis-{secrets.token_hex(4)}",
            "batchTotal": 1,
            "contentType": CONTENT_TYPES[name.rsplit(".", 1)[1]],
            "name": name,
            "sizeBytes": len(data),
        }
        ticket = self.call(user, "POST", path + "/tickets", json=metadata)
        made = self.call(
            user,
            "POST",
            path,
            params={"ticket": ticket["ticketId"]},
            files=[
                ("metadata", (None, json.dumps(metadata))),
                ("file", (name, data, metadata["contentType"])),
            ],
        )
        return made["id"]

    def fixture(self, user: str, workspace_id: str, name: str) -> str:
        """One of e2e/fixtures/files/basic, uploaded under a unique name."""
        data = (FILES / name).read_bytes()
        return self.upload(user, workspace_id, f"{self.marker()}-{name}", data)

    def edit(
        self,
        user: str,
        workspace_id: str | None,
        target: dict[str, str],
        commands: list[dict[str, Any]],
        *,
        office: bool = False,
    ) -> dict[str, Any]:
        """A saved edit by `user`'s own chat: the no-room path a collaborator's
        save takes to the stored document."""
        receipt = self.internal(
            "/api/internal/documents/edit",
            {
                **(
                    {"workspaceId": workspace_id}
                    if workspace_id
                    else {"scope": "account"}
                ),
                "userId": user,
                "assistantMessageId": self.message(user, workspace_id),
                "toolCallId": f"call_{secrets.token_hex(6)}",
                "target": target,
                "commands": commands,
                "office": office,
            },
        )
        assert receipt["outcome"] == "succeeded", receipt
        return receipt

    def inspect(
        self,
        workspace_id: str,
        target: dict[str, str],
        office: dict[str, Any] | None = None,
        user: str = "u_owner",
    ) -> dict[str, Any]:
        return self.internal(
            "/api/internal/documents/inspect",
            {
                "workspaceId": workspace_id,
                "userId": user,
                "target": target,
                "count": 200,
                **({"office": office} if office is not None else {}),
            },
        )

    async def index_file(self, workspace_id: str, file_id: str, text: str) -> None:
        """The file's published index, as an ingest would leave it: the
        baseline its later edits are not in."""
        content_hash = hashlib.sha256(text.encode()).hexdigest()
        attached = await store.attach_file_content(
            workspace_id=workspace_id,
            file_id=file_id,
            content_hash=content_hash,
            claim_job_id="job_vis",
        )
        await store.replace_content_chunks(
            workspace_id=workspace_id,
            content_id=attached["content_id"],
            rows=_rows(file_id, chunk_markdown(text)),
            claim_job_id="job_vis",
        )
        await store.publish_file_content(
            workspace_id=workspace_id,
            file_id=file_id,
            content_id=attached["content_id"],
            claim_job_id="job_vis",
        )
        self.sql(
            "UPDATE files SET status='ready', indexed=true WHERE id=%s", (file_id,)
        )

    async def index_note(self, workspace_id: str, material_id: str) -> None:
        """The note's published index, as the note index job writes it from
        Go's index text: its blocks are the baseline Go measures changes by."""
        response = await asyncio.to_thread(
            requests.get,
            f"{self.api_url}/api/internal/materials/{material_id}/index-text",
            params={"workspaceId": workspace_id},
            headers={"X-Pipeline-Secret": self.pipeline_secret},
            timeout=30,
        )
        assert response.status_code == 200, response.text
        note = response.json()
        chunks = chunk_markdown(str(note.get("text") or ""))
        attached = await store.attach_material_content(
            workspace_id=workspace_id,
            material_id=material_id,
            content_hash="note:" + secrets.token_hex(8),
            claim_job_id="job_vis",
            blocks=note["blocks"],
        )
        await store.replace_content_chunks(
            workspace_id=workspace_id,
            content_id=attached["content_id"],
            rows=_rows(material_id, chunks),
            claim_job_id="job_vis",
        )
        await store.publish_material_content(
            workspace_id=workspace_id,
            material_id=material_id,
            content_id=attached["content_id"],
            claim_job_id="job_vis",
            blocks=note["blocks"],
        )


def _rows(doc_id: str, chunks: list) -> list[dict[str, Any]]:
    return [
        {
            "id": f"{doc_id}_c{i}_{secrets.token_hex(3)}",
            "chunk_idx": i,
            "section_path": chunk.section_path,
            "text": chunk.text,
            "indexed_text": chunk.indexed_text(),
            "token_count": max(1, len(chunk.text) // 4),
            "page_start": None,
            "page_end": None,
            "regions": [],
            "lang": "en",
            "search_text": tokenize_for_search(chunk.indexed_text()),
            "embedding": store.vector_literal(vector(chunk.indexed_text())),
        }
        for i, chunk in enumerate(chunks)
    ]


@pytest.fixture(scope="session")
def stack():
    """The compose stack, seeded with e2e/fixtures/seed.sql, and the pipeline
    pointed at it."""
    env = dict(os.environ)
    for key in ("E2E_AUTH_SECRET", "SHARE_LINK_SECRET", "E2E_PIPELINE_SECRET"):
        env.setdefault(key, secrets.token_hex(24))
    for key in (
        "E2E_DB_PORT",
        "E2E_REDIS_PORT",
        "E2E_API_PORT",
        "E2E_COLLABORATION_PORT",
    ):
        env.setdefault(key, _port())
    project = (
        env.get("E2E_COMPOSE_PROJECT") or f"capy-visibility-{secrets.token_hex(4)}"
    )
    overrides = [f for f in env.get("E2E_COMPOSE_OVERRIDES", "").split(",") if f]
    files = [str(ROOT / "deploy" / "docker-compose.e2e.yml"), *overrides]
    base = ["docker", "compose", *[a for f in files for a in ("-f", f)], "-p", project]

    def compose(*args: str, stdin: str | None = None) -> None:
        done = subprocess.run(
            [*base, *args],
            env=env,
            input=stdin,
            capture_output=True,
            text=True,
            check=False,
        )
        assert done.returncode == 0, f"compose {args[0]}:\n{done.stdout}\n{done.stderr}"

    started = env.get("E2E_SKIP_COMPOSE") != "true"
    try:
        if started:
            build = (
                "--no-build" if env.get("E2E_PREBUILT_IMAGES") == "true" else "--build"
            )
            compose(
                "up", "-d", "--wait", build, "db", "redis", "server", "collaboration"
            )
        seed = (ROOT / "e2e" / "fixtures" / "seed.sql").read_text(encoding="utf-8")
        compose("exec", "-T", "db", "psql", "-U", "capy", "-d", "capy", "-v",
                "ON_ERROR_STOP=1", stdin=seed)  # fmt: skip
        dsn = (
            f"postgres://capy:capy@127.0.0.1:{env['E2E_DB_PORT']}/capy?sslmode=disable"
        )
        with pytest.MonkeyPatch.context() as patch:
            patch.setattr(cfg, "dsn", dsn)
            patch.setattr(cfg, "gateway_url", f"http://127.0.0.1:{env['E2E_API_PORT']}")
            patch.setattr(cfg, "pipeline_secret", env["E2E_PIPELINE_SECRET"])
            # No knowledge library: its tools stay off.
            patch.setattr(cfg, "library_dsn", "")
            yield Stack(
                cfg.gateway_url, env["E2E_AUTH_SECRET"], cfg.pipeline_secret, dsn
            )
    finally:
        if started and env.get("E2E_KEEP_STACK") != "true":
            compose("down", "-v", "--remove-orphans")


@pytest.fixture(autouse=True)
def no_provider(monkeypatch):
    """Embeddings are the stub; every connection off the loopback (a
    provider, a model router) is refused and fails the test."""
    refused: list[Any] = []
    real = socket.socket.connect

    def connect(sock, address):
        if isinstance(address, tuple) and address[0] not in ("127.0.0.1", "::1"):
            refused.append(address)
            raise ConnectionRefusedError(f"the lane reaches no provider: {address}")
        return real(sock, address)

    async def embed(texts, *, spec):
        return [vector(text) for text in texts]

    monkeypatch.setattr(socket.socket, "connect", connect)
    monkeypatch.setattr(models, "embed", embed)
    yield refused
    assert not refused, f"outbound connections: {refused}"


@dataclass
class Turn:
    """One chat turn: every request the scripted model received."""

    requests: list[dict[str, Any]]

    def result(self, call_id: str) -> str:
        """The tool result the model received for this call."""
        for message in self.requests[-1]["messages"]:
            if message.get("role") == "tool" and message.get("tool_call_id") == call_id:
                return str(message["content"])
        raise AssertionError(f"no result for {call_id}")

    def changes(self, call_id: str) -> str:
        """The unindexed changes a read appended to its result."""
        return self.result(call_id).partition("Edits made since the last index")[2]

    def hints(self) -> str:
        """The unindexed-edit hints that followed the user's message."""
        return "\n".join(
            str(m["content"])
            for m in self.requests[0]["messages"]
            if m.get("_kind") == pending_hints.KIND
        )


@pytest.fixture
def turn(monkeypatch):
    """Runs one turn whose model calls the given tools, one list per response,
    then answers. Calls are (id, name, arguments)."""

    async def run(
        ctx: ToolContext, *steps: list[tuple], query: str = "Check my sources."
    ) -> Turn:
        responses = [
            _assembled(
                "", [_call(name, json.dumps(args), cid) for cid, name, args in step]
            )
            for step in steps
        ] + [_assembled(_answer(("Done.", [])))]
        stream, seen = _script_stream(responses)
        monkeypatch.setattr(agent.models, "stream_agent_response", stream)
        events = [
            event
            async for event in agent.run_agent(
                query=query, ctx=ctx, history=None, model=_model()
            )
        ]
        failed = [e for e in events if e.get("type") == "error"]
        assert not failed, failed
        return Turn(seen)

    return run
