"""Load the pending-hints eval workspace into a scratch Postgres.

The database is a stock pgvector/pgvector:pg16 container you start and remove
yourself (the pipeline tests' image). This applies every numbered
server/migrations file, as the pipeline integration tests do, then writes the
fixture workspace: chapters, files, notes, and each document's indexed chunks
with real Qwen3-Embedding-4B vectors (DeepInfra, about 4k tokens in all)
through production's store.replace_content_chunks.

  docker run -d --name hints-eval-pg -e POSTGRES_USER=capy -e POSTGRES_PASSWORD=capy \
      -e POSTGRES_DB=capy -p 127.0.0.1:55991:5432 pgvector/pgvector:pg16
  uv run python bench/rag/scripts/hints_eval_db.py --dsn postgres://capy:capy@127.0.0.1:55991/capy

DEEPINFRA_API_KEY is read from the repository-root .env.local (or --env-file)
into this process only.
"""

from __future__ import annotations

import argparse
import asyncio
import os
import re
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
REPO = HERE.parents[2]
MIGRATION = re.compile(r"^\d{4}_.+\.sql$")
USER = "u_1"


def load_keys(env_file: Path, names: tuple[str, ...]) -> None:
    """Copy the named keys from a dotenv file into this process's environment.
    Values are never printed."""
    from dotenv import dotenv_values

    values = dotenv_values(env_file)
    for name in names:
        if values.get(name):
            os.environ.setdefault(name, values[name])
        elif not os.environ.get(name):
            raise SystemExit(f"{name} is missing from {env_file}")


def migrate(dsn: str) -> None:
    import psycopg

    for _ in range(60):
        try:
            with psycopg.connect(dsn, connect_timeout=3) as conn:
                conn.execute("SELECT 1")
            break
        except psycopg.Error:
            time.sleep(1)
    with psycopg.connect(dsn, autocommit=True) as conn:
        if conn.execute("SELECT to_regclass('public.workspaces')").fetchone()[0]:
            print("schema present, skipping migrations")
        else:
            files = sorted(
                p for p in (REPO / "server" / "migrations").glob("*.sql") if MIGRATION.match(p.name)
            )
            for path in files:
                conn.execute(path.read_text(encoding="utf-8"))
            print(f"applied {len(files)} migrations")
        conn.execute(
            "INSERT INTO users (id, name, email) VALUES (%s, 'Hints eval', 'hints@capynotebook.test') "
            "ON CONFLICT (id) DO NOTHING",
            (USER,),
        )


async def load(dsn: str) -> None:
    import psycopg
    from psycopg.types.json import Jsonb

    import hints_eval_fixture as fx
    from pipeline import registry
    from pipeline.retrieval import models, store
    from pipeline.retrieval.chunking import estimate_tokens, tokenize_for_search
    from pipeline.retrieval.lang import detect_lang

    meta = fx.workspace_meta()
    ws = meta["workspace"]["id"]
    docs = fx.load()
    with psycopg.connect(dsn, autocommit=True) as conn:
        conn.execute("DELETE FROM workspaces WHERE id = %s", (ws,))
        conn.execute(
            "INSERT INTO workspaces (id, user_id, name) VALUES (%s, %s, %s)",
            (ws, USER, meta["workspace"]["name"]),
        )
        pin = conn.execute(
            "SELECT embedding_provider_slug, embedding_model_slug, embedding_model_version "
            "FROM workspaces WHERE id = %s",
            (ws,),
        ).fetchone()
        for position, chapter in enumerate(meta["chapters"]):
            conn.execute(
                "INSERT INTO chapters (id, workspace_id, name, position) VALUES (%s, %s, %s, %s)",
                (chapter["id"], ws, chapter["name"], position),
            )
        for position, doc in enumerate(docs):
            if doc.kind == "file":
                conn.execute(
                    """INSERT INTO files (id, workspace_id, user_id, chapter_id, name, kind,
                           size_bytes, status, blob_path, position, indexed)
                       SELECT %s, w.id, w.user_id, %s, %s, %s, 4096, 'ready', %s, %s, true
                       FROM workspaces w WHERE w.id = %s""",
                    (doc.id, doc.chapter, doc.name, doc.format, f"sources/{doc.id}", position, ws),
                )
            else:
                conn.execute(
                    """INSERT INTO materials (id, created_by, workspace_id, owner_user_id,
                           chapter_id, kind, title, position)
                       VALUES (%s, %s, %s, %s, %s, 'note', %s, %s)""",
                    (doc.id, USER, ws, USER, doc.chapter, doc.name, position),
                )
    registry.registry.refresh()
    spec = registry.resolve_pinned(pin[0], pin[1], pin[2], registry.Slot.RETRIEVAL)
    texts = []
    for doc in docs:
        for chunk in doc.chunks:
            texts.append(
                f"{chunk['section_path']}\n\n{chunk['text']}" if chunk["section_path"] else chunk["text"]
            )
    vectors = await models.embed(texts, spec=spec)
    print(f"embedded {len(texts)} chunks")
    i = 0
    for doc in docs:
        content_id = f"rgc_{doc.id}"
        with psycopg.connect(dsn, autocommit=True) as conn:
            conn.execute(
                "INSERT INTO rag_contents (id, workspace_id, content_hash, status) VALUES (%s, %s, %s, 'ready')",
                (content_id, ws, content_id),
            )
        rows = []
        for idx, chunk in enumerate(doc.chunks):
            indexed = texts[i]
            rows.append(
                {
                    "id": f"chk_{doc.id}_{idx}",
                    "chunk_idx": idx,
                    "section_path": chunk["section_path"],
                    "text": chunk["text"],
                    "indexed_text": indexed,
                    "token_count": max(1, estimate_tokens(indexed)),
                    "page_start": None,
                    "page_end": None,
                    "regions": [],
                    "lang": detect_lang(chunk["text"]),
                    "search_text": tokenize_for_search(indexed),
                    "confidence": None,
                    "confidence_reasons": [],
                    "embedding": store.vector_literal(vectors[i]),
                }
            )
            i += 1
        await store.replace_content_chunks(workspace_id=ws, content_id=content_id, rows=rows)
        with psycopg.connect(dsn, autocommit=True) as conn:
            if doc.kind == "file":
                conn.execute(
                    "INSERT INTO rag_file_contents (file_id, workspace_id, content_id) VALUES (%s, %s, %s)",
                    (doc.id, ws, content_id),
                )
            else:
                conn.execute(
                    "UPDATE materials SET indexed_blocks = %s WHERE id = %s",
                    (Jsonb([{"id": b["id"], "text": b["text"]} for b in doc.blocks]), doc.id),
                )
                conn.execute(
                    "INSERT INTO rag_material_contents (material_id, workspace_id, content_id) VALUES (%s, %s, %s)",
                    (doc.id, ws, content_id),
                )
    await store.close_pool()
    print(f"loaded {len(docs)} documents into {ws}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dsn", required=True)
    parser.add_argument("--env-file", type=Path, default=Path("C:/WEB/capy-notebook/.env.local"))
    args = parser.parse_args()
    os.environ["DATABASE_URL"] = args.dsn
    os.environ.setdefault("EMBEDDING_DIM", "2560")
    load_keys(args.env_file, ("DEEPINFRA_API_KEY",))
    migrate(args.dsn)
    from pipeline import use_compatible_event_loop

    use_compatible_event_loop()
    asyncio.run(load(args.dsn))


if __name__ == "__main__":
    main()
