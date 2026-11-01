"""Account chat in the playground (config ``account``): the user's scope, and
the Go routes account tools call answered from the target database and the
run instead of a gateway.

Production's account reads ask Go about every item (documents/access) and
list through it (documents/list); here both run the SQL of
server/internal/store/account_scope.go read-only, with the run's own
materials added. create_workspace makes a workspace that exists only in the
run. Other gateway routes stay unreachable, as in workspace mode.
"""

from __future__ import annotations

from typing import Any

import office

# What Go grants an account chat (the loop trace's harness, Epo 2026-10-28).
OPERATIONS = frozenset(
    {
        "source.read",
        "material.read",
        "material.create",
        "document.edit",
        "workspace.create",
        "library.read",
    }
)
# account_scope.go's accountScopeSQL over listing.go's memberWorkspacesSQL.
SCOPE_SQL = """SELECT w.id, w.name,
    (w.user_id = %(u)s OR sm.role IN ('owner', 'editor')
        OR (w.share_role = 'editor' AND w.privacy IN ('link', 'public'))) AS can_edit
    FROM workspaces w
    LEFT JOIN workspace_members sm ON sm.workspace_id = w.id AND sm.user_id = %(u)s
    WHERE w.id IN (
        SELECT id FROM workspaces WHERE user_id = %(u)s
        UNION ALL
        SELECT vm.workspace_id FROM workspace_members vm
            JOIN workspaces vw ON vw.id = vm.workspace_id JOIN users vo ON vo.id = vw.user_id
        WHERE vm.user_id = %(u)s AND vo.deleted_at IS NULL
            AND vo.deletion_requested_at IS NULL AND vo.suspended_at IS NULL)"""
LIVE_CALLER = """EXISTS (SELECT 1 FROM users lc WHERE lc.id = %(u)s
    AND lc.deleted_at IS NULL AND lc.deletion_requested_at IS NULL)"""
LIST_MAX = 100
VIEW_ONLY = "You can view this but not edit it."


def user_of(c: dict[str, Any]) -> str:
    return str((c.get("account") or {}).get("user_id") or "")


async def scope(user_id: str):
    from pipeline.retrieval import store
    from pipeline.retrieval.scope import AccountScope, ScopeWorkspace

    pool = await store.pool()
    async with pool.connection() as conn:
        cur = await conn.execute(
            f"SELECT id, name, can_edit FROM ({SCOPE_SQL}) s ORDER BY id", {"u": user_id}
        )
        rows = await cur.fetchall()
    if not rows and not await _user_exists(user_id):
        raise RuntimeError(f"account.user_id {user_id} is not a user of this target")
    return AccountScope(
        user_id, tuple(ScopeWorkspace(r["id"], r["name"], r["can_edit"]) for r in rows)
    )


async def _user_exists(user_id: str) -> bool:
    from pipeline.retrieval import store

    pool = await store.pool()
    async with pool.connection() as conn:
        cur = await conn.execute("SELECT 1 FROM users WHERE id = %s", (user_id,))
        return await cur.fetchone() is not None


def _file_item(item: dict[str, Any], name: str, kind: str) -> dict[str, Any]:
    """internal_documents.go fileListItem: an Office file is editable."""
    item = {**item, "title": name, "format": kind}
    if (fmt := office.format_of(name)) is not None:
        item.update(format=fmt, editable=True)
    else:
        item["reason"] = (
            "Cannot edit PDF files." if kind == "pdf" else "This file type cannot be edited."
        )
    return item


def tag(record: dict[str, Any], args: dict[str, Any]) -> None:
    """Where a run-created item landed: the workspace the call named, or none."""
    record.setdefault("workspace_id", args.get("_workspace_id") or None)


def receipt(body: dict[str, Any], ctx, args: dict[str, Any]):
    """A local write's receipt; in account chat it names where the item went,
    as Go's does (tools._created_in)."""
    from pipeline.retrieval import tools

    if not ctx.account:
        return tools._receipt_result(body)
    body["effect"]["resource"]["workspaceId"] = args.get("_workspace_id") or ""
    return tools._receipt_result(body, ctx)


async def chapter_refusal(ctx, args: dict[str, Any], state: dict[str, Any]):
    """An account create's chapter_id must be a chapter of the workspace it
    names (Go checks it where the item lands)."""
    from pipeline.retrieval import store, tools

    if (refused := tools.unknown_chapter(ctx, args)) is not None:
        return refused
    chapter, workspace = str(args.get("chapter_id") or ""), args.get("_workspace_id")
    if not chapter or not workspace:
        return None
    outline = await store.workspace_outline(workspace)
    known = {c["id"] for c in outline["chapters"]} | {
        c["id"] for c in state.get("chapters", []) if c.get("workspace_id") == workspace
    }
    if chapter in known:
        return None
    return tools._refused(
        "chapter_id is not a chapter of that workspace; list_sources lists them."
    )


class Gateway:
    """Go's account routes for one turn; any other path goes to ``read`` and
    ``post``, the unreachable gateway the playground already has."""

    def __init__(self, ctx, state: dict[str, Any], read, post):
        self.ctx, self.state, self._read, self._post = ctx, state, read, post

    @property
    def user(self) -> str:
        return self.ctx.scope.user_id

    def _place(self, workspace_id: str | None) -> tuple[str, str, bool]:
        """(id, name, can edit) of an item's workspace; No workspace is the user's own."""
        if not workspace_id:
            return "", "", True
        known = self.ctx.scope.workspace(workspace_id)
        return (workspace_id, known.name, known.can_edit) if known else ("", "", False)

    def _run_items(self) -> list[dict[str, Any]]:
        """The run's own materials, editable by the user who made them."""
        out = []
        for m in self.state["materials"]:
            ws, ws_name, can_edit = self._place(m.get("workspace_id"))
            out.append(
                {
                    "kind": "material",
                    "id": m["id"],
                    "title": m["title"],
                    "format": "plate",
                    "materialKind": m["kind"],
                    "chapterId": m.get("chapter_id"),
                    "editable": can_edit,
                    "workspaceId": ws,
                    "workspaceName": ws_name,
                }
            )
        return out

    async def read(self, path: str, payload: dict[str, Any], failure: str, *a, **kw):
        if path == "/api/internal/documents/access":
            return {"items": await self.access(payload["items"])}
        if path == "/api/internal/documents/list" and payload.get("scope") == "account":
            return await self.listing(str(payload.get("workspaceId") or ""))
        return await self._read(path, payload, failure, *a, **kw)

    async def post(self, path: str, payload: dict[str, Any], op_id: str, ctx, **kw):
        if path == "/api/internal/workspaces":
            return self.create_workspace(payload, op_id)
        return await self._post(path, payload, op_id, ctx, **kw)

    async def access(self, items: list[dict[str, str]]) -> list[dict[str, Any]]:
        """AccountDocumentAccess: each item in order, readable when it lives in
        a scope workspace or is the user's own with no workspace."""
        from pipeline.retrieval import store

        run = {i["id"]: i for i in self._run_items()}
        rows: list[dict[str, Any]] = []
        pool = await store.pool()
        async with pool.connection() as conn:
            for item in items:
                kind, rid = item["kind"], item["id"]
                row: dict[str, Any] = {"kind": kind, "id": rid, "canRead": False, "canEdit": False}
                if kind == "material" and rid in run:
                    mine = run[rid]
                    row.update(
                        canRead=True,
                        canEdit=mine["editable"],
                        editable=mine["editable"],
                        workspaceId=mine["workspaceId"],
                        workspaceName=mine["workspaceName"],
                        materialKind=mine["materialKind"],
                    )
                    rows.append(row)
                    continue
                if kind == "source_file":
                    sql = "SELECT workspace_id AS ws, user_id AS owner, name AS title, kind AS file_kind, '' AS material_kind FROM files WHERE id = %(id)s AND trashed_at IS NULL"
                else:
                    sql = (
                        "SELECT COALESCE(p.workspace_id, m.workspace_id) AS ws, COALESCE(p.owner_user_id, m.owner_user_id) AS owner, "
                        "m.title, '' AS file_kind, m.kind AS material_kind FROM materials m "
                        "LEFT JOIN materials p ON p.id = m.parent_material_id AND p.trashed_at IS NULL "
                        "WHERE m.id = %(id)s AND m.trashed_at IS NULL AND (m.parent_material_id IS NULL OR p.id IS NOT NULL)"
                    )
                cur = await conn.execute(
                    f"SELECT i.*, {LIVE_CALLER} AS live FROM ({sql}) i", {"id": rid, "u": self.user}
                )
                found = await cur.fetchone()
                if found and found["live"]:
                    ws, ws_name, can_edit = self._place(found["ws"])
                    if ws or (not found["ws"] and found["owner"] == self.user):
                        row.update(canRead=True, canEdit=can_edit, workspaceId=ws, workspaceName=ws_name)
                        if kind == "source_file":
                            listed = _file_item({}, found["title"], found["file_kind"])
                            row.update(format=listed["format"], editable=listed.get("editable", False) and can_edit)
                        else:
                            row.update(materialKind=found["material_kind"], editable=can_edit)
                rows.append(row)
        return rows

    async def listing(self, workspace_id: str) -> dict[str, Any]:
        """listAccountDocuments: one scope workspace's files and materials, or
        the user's newest with no workspace (at most 100, saying whether more)."""
        from pipeline.retrieval import store

        where = "d.ws_id = %(ws)s" if workspace_id else "d.ws_id IS NULL"
        order = "d.part, d.position, d.at DESC" if workspace_id else "d.at DESC, d.id"
        limit = "" if workspace_id else f" LIMIT {LIST_MAX + 1}"
        pool = await store.pool()
        async with pool.connection() as conn:
            cur = await conn.execute(
                f"""WITH scope AS ({SCOPE_SQL})
                SELECT d.kind, d.id, d.title, d.file_kind, d.material_kind, d.chapter_id,
                    COALESCE(ch.name, '') AS chapter_name, COALESCE(sc.id, '') AS ws,
                    COALESCE(sc.name, '') AS ws_name, COALESCE(sc.can_edit, true) AS can_edit,
                    COALESCE(rs.descriptor, '') AS descriptor
                FROM (
                    SELECT 0 AS part, 'source_file' AS kind, f.id, f.name AS title, f.kind AS file_kind,
                        '' AS material_kind, f.chapter_id, f.workspace_id AS ws_id, f.position, f.added_at AS at,
                        fc.content_id
                    FROM files f LEFT JOIN rag_file_contents fc ON fc.file_id = f.id
                    WHERE f.trashed_at IS NULL
                        AND (f.workspace_id IN (SELECT id FROM scope) OR (f.workspace_id IS NULL AND f.user_id = %(u)s))
                    UNION ALL
                    SELECT 1, 'material', m.id, m.title, '', m.kind, m.chapter_id, m.workspace_id, m.position,
                        m.created_at, mc.content_id
                    FROM materials m LEFT JOIN rag_material_contents mc ON mc.material_id = m.id
                    WHERE m.trashed_at IS NULL AND m.parent_material_id IS NULL
                        AND (m.workspace_id IN (SELECT id FROM scope) OR (m.workspace_id IS NULL AND m.owner_user_id = %(u)s))
                ) d
                LEFT JOIN scope sc ON sc.id = d.ws_id
                LEFT JOIN chapters ch ON ch.id = d.chapter_id
                LEFT JOIN rag_content_summaries rs ON rs.content_id = d.content_id
                WHERE {LIVE_CALLER} AND {where}
                ORDER BY {order}{limit}""",
                {"u": self.user, "ws": workspace_id},
            )
            docs = await cur.fetchall()
        items: list[dict[str, Any]] = []
        for d in docs:
            item: dict[str, Any] = {"kind": d["kind"], "id": d["id"], "title": d["title"], "chapterId": d["chapter_id"]}
            if d["kind"] == "material":
                item.update(format="plate", materialKind=d["material_kind"], editable=True)
            else:
                item = _file_item({**item, "materialKind": ""}, d["title"], d["file_kind"])
            if item.get("editable") and not d["can_edit"]:
                item.update(editable=False, reason=VIEW_ONLY)
            item.update(workspaceId=d["ws"], workspaceName=d["ws_name"])
            if d["chapter_name"]:
                item["chapterName"] = d["chapter_name"]
            if d["descriptor"]:
                item["descriptor"] = d["descriptor"]
            items.append({"editable": False, **item})
        # The run's materials in this place, newest first as Go lists them.
        mine = [i for i in self._run_items() if i["workspaceId"] == workspace_id]
        items = [*reversed(mine), *items] if not workspace_id else [*items, *mine]
        more = not workspace_id and len(items) > LIST_MAX
        return {"items": items[:LIST_MAX] if more else items, "more": more}

    def create_workspace(self, payload: dict[str, Any], op_id: str):
        """internalCreateWorkspace, in the run only: named as asked or Go's
        "New Workspace (n)"."""
        from pipeline.retrieval import tools

        made = self.state.setdefault("workspaces", [])
        name = str(payload.get("name") or "").strip()
        if not name:
            taken = {w.name for w in self.ctx.scope.workspaces}
            n = 1
            while f"New Workspace ({n})" in taken:
                n += 1
            name = f"New Workspace ({n})"
        workspace_id = "ws_run_" + op_id.removeprefix("op_")[-10:]
        made.append({"id": workspace_id, "name": name, "description": payload.get("description") or ""})
        return tools._receipt_result(
            {"kind": "create_workspace", "outcome": "succeeded", "workspaceId": workspace_id, "name": name},
            self.ctx,
        )


def outline_with_run(original, state: dict[str, Any]):
    """store.workspace_outline plus the chapters this run created in that
    workspace; a workspace the run created starts empty."""

    async def outline(workspace_id: str) -> dict[str, Any]:
        made = {w["id"] for w in state.get("workspaces", [])}
        base = (
            {"chapters": [], "files": [], "materials": []}
            if workspace_id in made
            else await original(workspace_id)
        )
        extra = [c for c in state.get("chapters", []) if c.get("workspace_id") == workspace_id]
        return {**base, "chapters": [*base["chapters"], *extra]}

    return outline
