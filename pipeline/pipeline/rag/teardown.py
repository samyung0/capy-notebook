"""Drop one workspace's LightRAG state.

The inverse of :mod:`pipeline.rag.clone`, and the reason it has to exist: every
piece of derived LightRAG state is keyed by the ``workspace`` value, none of it
is reachable from the Go schema, and so deleting a workspace there leaves the
``lightrag_*`` rows and the per-workspace Apache AGE graph behind forever.

Two things to remove:

* the ``lightrag_*`` Postgres rows carrying ``workspace = <id>``, and
* the AGE graph named ``{workspace}_chunk_entity_relation``, dropped whole
  rather than row by row so its labels, indexes and sequences go with it.

Called on workspace deletion and on account purge. It must be idempotent: the Go
side retries the job, and a workspace that was never ingested has no state at
all.
"""

from __future__ import annotations

import logging

from ..store import db
from .clone import _graph_name, _quote

log = logging.getLogger("evo.rag.teardown")


def _delete_lightrag_rows(cur, workspace: str) -> dict[str, int]:
    """DELETE every lightrag_* row for one workspace.

    The table list is discovered from the catalog rather than hardcoded, because
    LightRAG owns this schema and adds tables across versions; a stale hardcoded
    list would silently leak whichever table was added last.
    """
    cur.execute(
        """SELECT DISTINCT table_name FROM information_schema.columns
           WHERE table_schema='public' AND column_name='workspace'
             AND table_name LIKE 'lightrag%'"""
    )
    deleted: dict[str, int] = {}
    for table in sorted(r[0] for r in cur.fetchall()):
        cur.execute(f"DELETE FROM {_quote(table)} WHERE workspace=%s", (workspace,))
        if cur.rowcount:
            deleted[table] = cur.rowcount
    return deleted


def _drop_age_graph(cur, workspace: str) -> bool:
    graph = _graph_name(workspace)
    cur.execute("SELECT 1 FROM ag_catalog.ag_graph WHERE name=%s", (graph,))
    if cur.fetchone() is None:
        return False
    # cascade=true removes the label tables and their sequences; without it the
    # drop fails on any graph that ever held a vertex.
    cur.execute("SELECT ag_catalog.drop_graph(%s, true)", (graph,))
    return True


def drop_workspace_state(workspace: str) -> dict:
    """Remove all LightRAG state for one workspace, in a single transaction."""
    if not workspace:
        raise ValueError("workspace is required")
    with db.connect() as conn:
        with conn.cursor() as cur:
            tables = _delete_lightrag_rows(cur, workspace)
            cur.execute("LOAD 'age'")
            cur.execute('SET search_path = ag_catalog, "$user", public')
            graph_dropped = _drop_age_graph(cur, workspace)
        conn.commit()
    log.info(
        "dropped workspace %s state: tables=%s graph_dropped=%s",
        workspace,
        tables,
        graph_dropped,
    )
    return {"tables": tables, "graphDropped": graph_dropped}
