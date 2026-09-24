"""Recompute the keyword vector of chunks whose indexed text holds a typographic
ligature (U+FB00-U+FB06) or a printed sub- or superscript (decisions 2026-09-24).

``tokenize_for_search`` maps those characters to plain letters and digits
(``SEARCH_FOLD``); rows indexed before that carry lexemes like 'ﬁnd', or 'h'
for 'H₀', that no typed query reaches. Only
``search`` changes: text, indexed text, lang and embeddings stay as they are.
Each row is rebuilt the way the writers build it, ``to_tsvector`` of its own
``lang`` configuration over ``tokenize_for_search(indexed_text)``; a reference
list keeps its empty vector (the empty vector is how a reference is stored,
see ``store.load_content_chunks``). A row already current is left alone, so a
rerun reports nothing stale.

  app      rag_chunks at DATABASE_URL: uploads and notes (UAT, production, local)
  library  library_chunks at LIBRARY_DATABASE_URL (owner URL): every stored
           book version, current, retained or not searchable
  pilot    pilot_chunks at DATABASE_URL: the local knowledge-base pilot
           database the library loader copies vectors from

Run it after the release carrying the tokenizer, so nothing new is written the
old way. ``--dry-run`` counts without writing. Prints one JSON line.
"""

from __future__ import annotations

import argparse
import json

import psycopg

from pipeline.config import cfg
from pipeline.retrieval.chunking import SEARCH_FOLD, tokenize_for_search
from pipeline.retrieval.lang import TS_CONFIG

TABLES = {"app": "rag_chunks", "library": "library_chunks", "pilot": "pilot_chunks"}


def reindex(conn: psycopg.Connection, table: str, *, dry_run: bool) -> dict:
    """Candidates are non-reference rows holding a folded character; stale are
    those whose stored vector differs from the rebuilt one (rewritten unless dry)."""
    rows = conn.execute(
        f"SELECT id, lang, indexed_text FROM {table} "
        "WHERE indexed_text ~ %s AND search <> ''::tsvector",
        ("[" + "".join(map(chr, SEARCH_FOLD)) + "]",),
    ).fetchall()
    params = (
        [row[0] for row in rows],
        [TS_CONFIG[row[1]] for row in rows],
        [tokenize_for_search(row[2]) for row in rows],
    )
    source = "unnest(%s::text[], %s::text[], %s::text[]) AS u(id, cfg, body)"
    stale = "c.id = u.id AND c.search IS DISTINCT FROM to_tsvector(u.cfg::regconfig, u.body)"
    if dry_run:
        count = conn.execute(
            f"SELECT count(*) FROM {table} c, {source} WHERE {stale}", params
        ).fetchone()[0]
    else:
        count = conn.execute(
            f"UPDATE {table} c SET search = to_tsvector(u.cfg::regconfig, u.body) "
            f"FROM {source} WHERE {stale}",
            params,
        ).rowcount
    return {"table": table, "candidates": len(rows), "stale": count, "dry_run": dry_run}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("target", choices=TABLES)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    dsn = cfg.library_dsn if args.target == "library" else cfg.dsn
    if not dsn:
        raise SystemExit("LIBRARY_DATABASE_URL is not set")
    with psycopg.connect(dsn) as conn:
        print(json.dumps(reindex(conn, TABLES[args.target], dry_run=args.dry_run)))


if __name__ == "__main__":
    main()
