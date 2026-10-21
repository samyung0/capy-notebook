"""Office files in the playground: inspect_office_document and
edit_office_document run as production's handlers (pipeline.retrieval.tools),
and the gateway's three Office routes are answered here instead
(server/internal/httpapi internal_documents.go and internal_office.go):
commands normalized by the gateway's own function (server/cmd/officecommands),
then read, applied, created and exported by the Office engine, one
`office-service serve` child per server process speaking JSON lines
(vendor/betteroffice crates/office-service, src/wire.rs).

A run keeps its Office files in memory: a workspace file starts from its
published blob in the target's bucket, a created file (f_local_<n>) exists only
in the run, and every created or edited file is exported to the run's
materials/ directory. Nothing is written to UAT.

Pipeline modules are imported inside the functions: importing them here would
read pipeline.config before the playground has set the target's environment.
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import re
import subprocess
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any
from unittest.mock import patch

from common import REPO

# The engine binary, built from the fork (README, "Office files").
ENGINE_ENV = "OFFICE_SERVICE_BIN"
NOT_BUILT = (
    "The playground's Office engine is not set up: build it with `cargo build "
    "--release -p betteroffice-office-service --bin office-service` in "
    "vendor/betteroffice, set OFFICE_SERVICE_BIN to its "
    "target/release/office-service executable and restart the playground."
)
FORMATS = {".docx": "docx", ".xlsx": "xlsx", ".pptx": "pptx"}
CREATED = "f_local_"
# Exports are deterministic but for their time (office_service::Determinism).
SEED = "0" * 64

INSPECT = "/api/internal/documents/inspect"
EDIT = "/api/internal/documents/edit"
CREATE = "/api/internal/documents/office/create"
# The gateway's sentences (internal_documents.go, internal_office.go).
OFFICE_TOOLS = (
    "Office files are read and edited with inspect_office_document and "
    'edit_office_document, offered after read_skill("office_building").'
)
OFFICE_ONLY_READ = (
    "inspect_office_document reads Word, Excel and PowerPoint files; read this "
    "file with inspect_document."
)
OFFICE_ONLY_EDIT = (
    "edit_office_document edits Word, Excel and PowerPoint files; edit this one "
    "with edit_document."
)
PDF = "Cannot edit PDF files."
TITLE_UNSAFE = re.compile(r"[\\/\x00-\x1f]+")


class Refusal(Exception):
    """What the gateway answers with a 4xx: code, message, details."""

    def __init__(self, code: str, message: str, details: dict | None = None):
        super().__init__(message)
        self.code, self.message, self.details = code, message, details


class EngineFailure(Exception):
    """An engine answer other than an edit refusal (wire.rs kind)."""


class Engine:
    """One `office-service serve` child: a JSON request per line, its answer
    on the next line. Started on the first call and again after it exits."""

    def __init__(self, path: str):
        self.path = path
        self.proc: subprocess.Popen | None = None
        self.lock = threading.Lock()

    def call(self, method: str, *args: Any) -> Any:
        line = json.dumps({"method": method, "args": list(args)}).encode() + b"\n"
        with self.lock:
            if self.proc is None or self.proc.poll() is not None:
                self.proc = subprocess.Popen(
                    [self.path, "serve"], stdin=subprocess.PIPE, stdout=subprocess.PIPE
                )
            self.proc.stdin.write(line)
            self.proc.stdin.flush()
            raw = self.proc.stdout.readline()
        if not raw:
            raise EngineFailure("office-service exited without answering")
        answer = json.loads(raw)
        if "error" not in answer:
            return answer["value"]
        code, _, message = str(answer["error"]).partition(": ")
        if answer.get("kind") == "edit" and message:
            # The collaboration server's officeError: "<code>: <message>".
            raise Refusal(code, message, answer.get("details"))
        raise EngineFailure(f"{answer.get('kind')}: {answer['error']}")

    def close(self) -> None:
        """Ends the child: serve returns when its stdin closes."""
        if self.proc is not None and self.proc.poll() is None:
            self.proc.stdin.close()
            self.proc.wait(timeout=30)
        self.proc = None


_engine: Engine | None = None


def engine() -> Engine:
    global _engine
    path = os.environ.get(ENGINE_ENV, "")
    if not path or not Path(path).is_file():
        raise Refusal("unavailable_target", NOT_BUILT)
    if _engine is None or _engine.path != path:
        close()
        _engine = Engine(path)
    return _engine


def close() -> None:
    if _engine is not None:
        _engine.close()


async def call(method: str, *args: Any) -> Any:
    return await asyncio.to_thread(engine().call, method, *args)


def wire(data: bytes) -> dict[str, str]:
    return {"$bytes": base64.b64encode(data).decode()}


def unwire(value: dict[str, str]) -> bytes:
    return base64.b64decode(value["$bytes"])


def format_of(name: str) -> str | None:
    return FORMATS.get(Path(name).suffix.lower())


async def normalize(fmt: str, commands: list[dict[str, Any]]) -> list[dict]:
    """The engine's commands, by the gateway's NormalizeOfficeCommands."""
    proc = await asyncio.to_thread(
        subprocess.run,
        ["go", "run", "./cmd/officecommands"],
        cwd=REPO / "server",
        input=json.dumps({"format": fmt, "commands": commands}).encode(),
        capture_output=True,
    )
    if proc.returncode == 0:
        return json.loads(proc.stdout)
    if proc.returncode == 1 and proc.stdout.strip():
        refused = json.loads(proc.stdout)
        raise Refusal(refused["code"], refused["message"])
    raise RuntimeError(f"officecommands: {proc.stderr.decode().strip()[:600]}")


async def _published(workspace_id: str, file_id: str) -> dict[str, Any] | None:
    """A workspace file's row; a file a run created has none."""
    from pipeline.retrieval import store

    if file_id.startswith(CREATED):
        return None
    pool = await store.pool()
    async with pool.connection() as conn:
        cur = await conn.execute(
            "SELECT id, name, kind, blob_path, chapter_id FROM files "
            "WHERE id = %s AND workspace_id = %s AND trashed_at IS NULL",
            (file_id, workspace_id),
        )
        row = await cur.fetchone()
    return dict(row) if row else None


async def office_format(
    state: dict[str, Any], workspace_id: str, file_id: str
) -> str | None:
    """A source file's Office format, or None for any other file."""
    if file_id in state.setdefault("office", {}):
        return state["office"][file_id]["format"]
    row = await _published(workspace_id, file_id)
    return format_of(row["name"]) if row else None


async def _open(
    state: dict[str, Any], workspace_id: str, file_id: str, office_only: str
) -> dict[str, Any]:
    """This run's copy of a source file, from its published blob on first use,
    or the gateway's refusal of a file that is not an Office file."""
    from pipeline.store import blobstore

    files = state.setdefault("office", {})
    if file_id in files:
        return files[file_id]
    row = await _published(workspace_id, file_id)
    if row is None:
        raise Refusal("unavailable_target", "not found")
    fmt = format_of(row["name"])
    if fmt is None:
        if row["kind"] == "pdf":
            raise Refusal("unsupported_format", PDF)
        raise Refusal("unsupported_operation", office_only)
    base = await asyncio.to_thread(blobstore.read_bytes, row["blob_path"] or "")
    if not base:
        raise RuntimeError(f"{file_id}: bucket object {row['blob_path']} is missing")
    files[file_id] = {
        "id": file_id,
        "name": row["name"],
        "format": fmt,
        "chapter_id": row["chapter_id"],
        "base": base,
        "checkpoint": await call("seedOffice", fmt, wire(base)),
        "edits": [],
    }
    return files[file_id]


def _now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())


def _kept(state: dict[str, Any], record: dict[str, Any], data: bytes) -> None:
    """The file's current bytes under the run's materials/, and its entry in
    the page's Materials panel with the path to download."""
    name = f"{record['id']}.{record['format']}"
    path = state["run_dir"] / "materials" / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    state["extra"].append(
        {
            "type": "material",
            "id": record["id"],
            "title": record["name"],
            "kind": record["format"],
            "size": f"{len(data) / 1024:.0f} KB",
            # Served by /api/runs/<run>/materials/<name>, under local/.
            "file": f"runs/{state['run_dir'].name}/materials/{name}",
            "edits": list(record["edits"]),
        }
    )


def _page_count(count: Any) -> int:
    """internal_documents.go pageCount: 60 targets unless 1 to 200 are asked."""
    count = int(count or 0)
    return count if 0 < count <= 200 else 60


async def _inspect(state: dict[str, Any], payload: dict[str, Any]) -> dict[str, Any]:
    """internalInspectDocument for a source file with an office query."""
    record = await _open(
        state, payload["workspaceId"], payload["target"]["id"], OFFICE_ONLY_READ
    )
    query, fmt = payload["office"], record["format"]
    body = {"format": fmt, "title": record["name"]}
    base, checkpoint = wire(record["base"]), record["checkpoint"]
    if fmt == "xlsx":
        scoped = {k: query[k] for k in ("sheet", "range") if query.get(k)}
        body["scoped"] = await call("inspectOfficeScoped", base, checkpoint, scoped)
        return body
    page = {
        "start": max(int(query.get("start") or 0), 0),
        "count": _page_count(query.get("count")),
    }
    # PPTX: a page of slides, or one slide's shapes and a page of its paragraphs.
    if fmt == "pptx" and int(query.get("slide") or 0) > 0:
        page["slide"] = int(query["slide"])
    body["scoped"] = await call("inspectOfficeScoped", base, checkpoint, page)
    return body


async def _edit(state: dict[str, Any], payload: dict[str, Any]) -> dict[str, Any]:
    """internalEditDocument for a source file with office set."""
    rid = payload["target"]["id"]
    record = await _open(state, payload["workspaceId"], rid, OFFICE_ONLY_EDIT)
    commands = await normalize(record["format"], payload["commands"])
    applied = await call(
        "applyOfficeCommands", wire(record["base"]), record["checkpoint"], commands
    )
    record["checkpoint"] = {**record["checkpoint"], "state": applied["state"]}
    record["edits"].extend(payload["commands"])
    exported = await call(
        "exportOffice",
        wire(record["base"]),
        record["checkpoint"],
        {"seed": SEED, "now": _now()},
    )
    _kept(state, record, unwire(exported))
    return {
        "outcome": "succeeded",
        "effect": {
            "operation": "edited",
            "resource": {"kind": "source_file", "id": rid, "title": record["name"]},
        },
        "notice": applied.get("notice"),
    }


async def _create(state: dict[str, Any], payload: dict[str, Any]) -> dict[str, Any]:
    """internalCreateOfficeDocument: the starter with the call's other
    commands, kept in the run instead of stored as an upload."""
    fmt = payload["format"]
    if fmt not in ("xlsx", "docx"):
        raise Refusal(
            "invalid_input",
            "create makes an xlsx or docx file; a deck is made with create_deck",
        )
    title = " ".join(TITLE_UNSAFE.sub(" ", str(payload["title"])).split())
    if not title:
        raise Refusal("invalid_input", "create needs a title")
    commands = await normalize(fmt, payload["commands"])
    created = await call("createOffice", fmt, commands, {"seed": SEED, "now": _now()})
    data = unwire(created["bytes"])
    files = state.setdefault("office", {})
    fid = f"{CREATED}{sum(1 for k in files if k.startswith(CREATED)) + 1}"
    files[fid] = {
        "id": fid,
        "name": f"{title}.{fmt}",
        "format": fmt,
        "chapter_id": payload.get("chapterId") or None,
        "base": data,
        "checkpoint": await call("seedOffice", fmt, wire(data)),
        "edits": list(payload["commands"]),
    }
    _kept(state, files[fid], data)
    return {
        "outcome": "succeeded",
        "effect": {
            "operation": "created",
            "resource": {"kind": "source_file", "id": fid, "title": files[fid]["name"]},
        },
        "notice": created.get("notice"),
    }


def _error_code(code: str) -> str:
    """tools._gateway_error_code for a refusal's code."""
    from pipeline.retrieval import contract, tools

    if code in contract.ERROR_CODES:
        return code
    return tools._GATEWAY_CODES.get(code, "invalid_input")


@contextmanager
def local_gateway(state: dict[str, Any]):
    """Answer the gateway's Office routes for production's tools in this run,
    and list the files the run created in the workspace outline, as a stored
    upload is. Every other gateway call goes where it went before."""
    from pipeline.retrieval import store, tools

    read, post, outline = (
        tools._gateway_read,
        tools._post_operation,
        store.workspace_outline,
    )

    async def gateway_read(path: str, payload: dict[str, Any], failure: str):
        target = payload.get("target") or {}
        try:
            if path == INSPECT and "office" in payload:
                return await _inspect(state, payload)
            if (
                path == INSPECT
                and target.get("kind") == "source_file"
                and await office_format(state, payload["workspaceId"], target["id"])
            ):
                raise Refusal("unsupported_operation", OFFICE_TOOLS)
        except Refusal as refused:
            return tools._refused(
                f"Could not {failure}: {refused.message}",
                code=_error_code(refused.code),
            )
        except EngineFailure as exc:
            return tools._failed(
                f"Could not {failure}: the Office engine answered {exc}"
            )
        return await read(path, payload, failure)

    async def post_operation(
        path, payload, op_id, ctx, *, failure, timeout=10, explain=None
    ):
        try:
            if path == CREATE:
                return tools._receipt_result(await _create(state, payload))
            if path == EDIT and payload.get("office"):
                return tools._receipt_result(await _edit(state, payload))
        except Refusal as refused:
            return tools._refused(
                f"Could not {failure}: {refused.message}",
                code=_error_code(refused.code),
                detail=explain(refused.details) if explain and refused.details else "",
            )
        except EngineFailure as exc:
            return tools._failed(
                f"Could not {failure}: the Office engine answered {exc}"
            )
        return await post(
            path, payload, op_id, ctx, failure=failure, timeout=timeout, explain=explain
        )

    async def workspace_outline(workspace_id: str) -> dict[str, Any]:
        out = await outline(workspace_id)
        created = [
            {
                "id": f["id"],
                "name": f["name"],
                "chapter_id": f["chapter_id"],
                "status": "pending",
                "descriptor": "",
                "chunks": 0,
            }
            for f in state.setdefault("office", {}).values()
            if f["id"].startswith(CREATED)
        ]
        return {**out, "files": [*out["files"], *created]}

    with (
        patch.object(tools, "_gateway_read", gateway_read),
        patch.object(tools, "_post_operation", post_operation),
        patch.object(store, "workspace_outline", workspace_outline),
    ):
        yield
