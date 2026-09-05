"""Snapshot and validate the uploaded lab index before answering questions."""

import json
from collections import Counter
from pathlib import Path

import psycopg
from psycopg.rows import dict_row
from run_agent import supports

from pipeline.config import cfg
from pipeline.retrieval.chunking import CHUNKER_VERSION

root = Path("/lab")
assert cfg.gateway_url == "http://127.0.0.1:8082"
workspaces = json.loads((root / "corpus/workspaces.json").read_text())
questions = json.loads((root / "corpus/questions.json").read_text())
with psycopg.connect(cfg.dsn, row_factory=dict_row) as conn:
    snapshot = {"chunker_version": CHUNKER_VERSION, "workspaces": {}}
    for label, ws in workspaces.items():
        files = conn.execute(
            "SELECT id,name,status,indexed FROM files WHERE workspace_id=%s ORDER BY name",
            (ws["id"],),
        ).fetchall()
        assert len(files) == len(ws["files"]), (
            label,
            "unfinished upload",
            len(files),
            len(ws["files"]),
        )
        assert all(f["status"] == "ready" and f["indexed"] for f in files), (
            label,
            files,
        )
        chunks = conn.execute(
            """SELECT c.id AS chunk_id,f.id AS file_id,f.name AS file_name,
            c.chunk_idx,c.text,c.section_path,c.page_start,c.page_end,c.regions,c.lang
            FROM rag_chunks c JOIN rag_file_contents fc ON fc.content_id=c.content_id
            JOIN files f ON f.id=fc.file_id WHERE fc.workspace_id=%s ORDER BY f.name,c.chunk_idx""",
            (ws["id"],),
        ).fetchall()
        snapshot["workspaces"][label] = {
            "id": ws["id"],
            "files": files,
            "chunks": chunks,
        }
        print(
            label,
            len(files),
            "files",
            len(chunks),
            "chunks",
            dict(Counter(p["lang"] for p in chunks)),
        )
    checks = []
    for q in questions:
        passages = snapshot["workspaces"][q["workspace"]]["chunks"]
        reached = [
            any(supports(p, e) for p in passages for e in group)
            for group in q["evidence_groups"]
        ]
        checks.append({"id": q["id"], "evidence_present": reached})
        if not all(reached):
            print("SOURCE EVIDENCE MISSING", q["id"], reached)
    snapshot["checks"] = checks
    snapshot["models"] = (
        conn.execute("""SELECT provider_slug,model_slug,version,is_default_for
        FROM model_configs WHERE cardinality(is_default_for)>0""").fetchall()
    )
    snapshot["content_pins"] = conn.execute(
        """SELECT workspace_id,pipeline_identity,
        embedding_provider_slug,embedding_model_slug,embedding_model_version,count(*)
        FROM rag_contents WHERE workspace_id=ANY(%s) GROUP BY 1,2,3,4,5""",
        ([w["id"] for w in workspaces.values()],),
    ).fetchall()
    (root / "index-snapshot.json").write_text(
        json.dumps(snapshot, ensure_ascii=False, indent=2)
    )
    assert all(all(c["evidence_present"]) for c in checks), (
        "Resolve ingestion omissions before agent tests."
    )
