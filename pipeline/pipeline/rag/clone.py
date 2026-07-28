"""Clone one workspace's parsed LightRAG state into another workspace.

LightRAG keys every piece of derived state by the ``workspace`` value:

* the ``lightrag_*`` Postgres tables (KV / vectors / doc status / chunks /
  entities / relations) carry a ``workspace`` column, and
* the knowledge graph lives in a per-workspace Apache AGE graph named
  ``{workspace}_chunk_entity_relation`` with exactly two labels
  (``base`` vertices, ``DIRECTED`` edges — see PGGraphStorage.initialize).

Cloning therefore is (a) an ``INSERT … SELECT`` per lightrag table rewriting
the workspace column, and (b) a row-level copy of the two AGE label tables.

The AGE copy relies on both graphs being created by LightRAG the same way, so
the label ids embedded in the 64-bit graphids line up (fresh graphs allocate
label ids deterministically: vertex=1, edge=2, base=3, DIRECTED=4). The caller
MUST initialize the target workspace via LightRAG first (build a RAG instance)
so the graph + labels + indexes exist; we assert the label ids match and abort
otherwise rather than corrupt the graph. Per-label sequences are bumped to the
source's last value so future inserts can't collide with copied graphids.

The LLM response cache (``lightrag_llm_cache``) is intentionally skipped — it
is large and purely an ingest-cost optimisation.
"""

from __future__ import annotations

import logging
import re

from ..store import db

log = logging.getLogger("evo.rag.clone")

_SKIP_TABLES = {"lightrag_llm_cache"}

# AGE's built-in parent labels; rows live in the user labels (base/DIRECTED).
_AGE_DEFAULT_LABELS = {"_ag_label_vertex", "_ag_label_edge"}


def _graph_name(workspace: str) -> str:
    """Mirror PGGraphStorage._get_workspace_graph_name for our namespace."""
    safe = re.sub(r"[^a-zA-Z0-9_]", "_", workspace.strip())
    return f"{safe}_chunk_entity_relation"


def _quote(ident: str) -> str:
    return '"' + ident.replace('"', '""') + '"'


def _copy_lightrag_tables(cur, src: str, tgt: str) -> dict[str, int]:
    """INSERT … SELECT every lightrag_* row, rewriting workspace src -> tgt."""
    cur.execute(
        """SELECT DISTINCT table_name FROM information_schema.columns
           WHERE table_schema='public' AND column_name='workspace'
             AND table_name LIKE 'lightrag%'"""
    )
    tables = sorted(r[0] for r in cur.fetchall())
    copied: dict[str, int] = {}
    for table in tables:
        if table in _SKIP_TABLES:
            continue
        cur.execute(
            """SELECT column_name FROM information_schema.columns
               WHERE table_schema='public' AND table_name=%s
               ORDER BY ordinal_position""",
            (table,),
        )
        cols = [r[0] for r in cur.fetchall()]
        col_list = ", ".join(_quote(c) for c in cols)
        sel_list = ", ".join("%s" if c == "workspace" else _quote(c) for c in cols)
        cur.execute(
            f"INSERT INTO {_quote(table)} ({col_list}) "
            f"SELECT {sel_list} FROM {_quote(table)} WHERE workspace=%s "
            "ON CONFLICT DO NOTHING",
            (tgt, src),
        )
        copied[table] = cur.rowcount
    return copied


def _age_labels(cur, graph: str) -> dict[str, tuple[int, str]]:
    """name -> (label id, kind) for one AGE graph."""
    cur.execute(
        """SELECT l.name, l.id, l.kind FROM ag_catalog.ag_label l
           JOIN ag_catalog.ag_graph g ON g.graphid = l.graph WHERE g.name=%s""",
        (graph,),
    )
    return {r[0]: (r[1], r[2]) for r in cur.fetchall()}


def _copy_age_graph(cur, src_ws: str, tgt_ws: str) -> dict[str, int]:
    """Copy the source AGE graph's rows into the (already created) target graph."""
    src_g, tgt_g = _graph_name(src_ws), _graph_name(tgt_ws)

    cur.execute("SELECT 1 FROM ag_catalog.ag_graph WHERE name=%s", (src_g,))
    if cur.fetchone() is None:
        log.info("clone: source graph %s does not exist — nothing to copy", src_g)
        return {}
    cur.execute("SELECT 1 FROM ag_catalog.ag_graph WHERE name=%s", (tgt_g,))
    if cur.fetchone() is None:
        raise RuntimeError(
            f"target graph {tgt_g} missing — initialize the target LightRAG instance first"
        )

    src_labels = _age_labels(cur, src_g)
    tgt_labels = _age_labels(cur, tgt_g)
    copied: dict[str, int] = {}
    for name, (src_id, kind) in sorted(src_labels.items()):
        if name in _AGE_DEFAULT_LABELS:
            continue
        if name not in tgt_labels:
            fn = "create_vlabel" if kind == "v" else "create_elabel"
            cur.execute(f"SELECT ag_catalog.{fn}(%s, %s)", (tgt_g, name))
            tgt_labels = _age_labels(cur, tgt_g)
        tgt_id = tgt_labels[name][0]
        if tgt_id != src_id:
            # graphids embed the label id in their top bits; a mismatch would
            # silently corrupt vertex/edge references, so refuse to copy.
            raise RuntimeError(
                f"AGE label id mismatch for {name}: src={src_id} tgt={tgt_id}; "
                "cannot copy graph rows verbatim"
            )

        # Copy rows only when the target label is still empty (idempotency —
        # AGE label tables have no usable conflict target).
        cur.execute(f"SELECT 1 FROM ONLY {_quote(tgt_g)}.{_quote(name)} LIMIT 1")
        if cur.fetchone() is not None:
            log.info("clone: %s.%s already has rows — skipping", tgt_g, name)
            continue
        if kind == "v":
            cur.execute(
                f"INSERT INTO {_quote(tgt_g)}.{_quote(name)} (id, properties) "
                f"SELECT id, properties FROM ONLY {_quote(src_g)}.{_quote(name)}"
            )
        else:
            cur.execute(
                f"INSERT INTO {_quote(tgt_g)}.{_quote(name)} (id, start_id, end_id, properties) "
                f"SELECT id, start_id, end_id, properties FROM ONLY {_quote(src_g)}.{_quote(name)}"
            )
        copied[name] = cur.rowcount

        # Bump the per-label entry-id sequence past the copied ids so future
        # inserts (LightRAG upserts) can't reuse a graphid.
        seq = f"{name}_id_seq"
        cur.execute(f"SELECT last_value FROM {_quote(src_g)}.{_quote(seq)}")
        last = cur.fetchone()[0]
        cur.execute(
            "SELECT setval(%s::regclass, %s)",
            (f"{_quote(tgt_g)}.{_quote(seq)}", max(int(last), 1)),
        )
    return copied


def clone_workspace_state(src_ws: str, tgt_ws: str) -> dict:
    """Synchronously copy all LightRAG PG rows + the AGE graph src -> tgt.

    Runs in one transaction: either the whole parsed state lands or nothing
    does. The target LightRAG instance must have been initialized already.
    """
    with db.connect() as conn:
        with conn.cursor() as cur:
            tables = _copy_lightrag_tables(cur, src_ws, tgt_ws)
            cur.execute("LOAD 'age'")
            cur.execute('SET search_path = ag_catalog, "$user", public')
            graph = _copy_age_graph(cur, src_ws, tgt_ws)
        conn.commit()
    log.info(
        "cloned workspace %s -> %s: tables=%s graph=%s", src_ws, tgt_ws, tables, graph
    )
    return {"tables": tables, "graph": graph}
