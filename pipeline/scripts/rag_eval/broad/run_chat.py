"""Freeze the fresh index and reuse the earlier complete SSE/tool recorder."""

import argparse
import hashlib
import json
import sys
import time
from pathlib import Path

import psycopg
from psycopg.rows import dict_row

sys.path.insert(0, "/lab")
import run_agent
from index_corpus import ROOT, guard, write_json

from pipeline.config import cfg
from pipeline.retrieval import agent, tools


def main():
    guard()
    questions = json.loads((ROOT / "corpus/questions.json").read_text())
    workspaces = json.loads((ROOT / "corpus/workspaces.json").read_text())
    snapshot = {}
    with psycopg.connect(cfg.dsn, row_factory=dict_row) as conn:
        for label, ws in workspaces.items():
            files = conn.execute(
                "SELECT id,name,status,indexed FROM files WHERE workspace_id=%s ORDER BY id",
                (ws["id"],),
            ).fetchall()
            assert len(files) == len(ws["files"]) and all(
                f["status"] == "ready" and f["indexed"] for f in files
            ), label
            chunks = conn.execute(
                """SELECT c.id AS chunk_id,f.id AS file_id,f.name AS file_name,
                c.chunk_idx,c.text,c.lang FROM rag_chunks c
                JOIN rag_file_contents fc ON fc.content_id=c.content_id
                JOIN files f ON f.id=fc.file_id WHERE fc.workspace_id=%s ORDER BY f.id,c.chunk_idx""",
                (ws["id"],),
            ).fetchall()
            snapshot[label] = {
                "id": ws["id"],
                "mode": ws["mode"],
                "files": files,
                "chunks": chunks,
            }
        for q in questions:
            passages = snapshot[q["workspace"]]["chunks"]
            assert all(
                any(run_agent.supports(p, e) for p in passages for e in group)
                for group in q["evidence_groups"]
            ), q["id"]
            if q["category"] == "missing_source":
                assert all(
                    f["name"] != q["omitted_file"]
                    for f in snapshot[q["workspace"]]["files"]
                )
        pins = conn.execute("""SELECT provider_slug,model_slug,version,is_default_for
            FROM model_configs WHERE cardinality(is_default_for)>0 ORDER BY provider_slug,model_slug,version""").fetchall()
        workspace_pins = conn.execute(
            """SELECT id,embedding_provider_slug,embedding_model_slug,
            embedding_model_version,embedding_dim FROM workspaces WHERE id=ANY(%s) ORDER BY id""",
            ([w["id"] for w in workspaces.values()],),
        ).fetchall()
        assert all(
            (
                p["embedding_provider_slug"],
                p["embedding_model_slug"],
                p["embedding_model_version"],
                p["embedding_dim"],
            )
            == ("deepinfra", "Qwen/Qwen3-Embedding-4B", 1, 2560)
            for p in workspace_pins
        )
    write_json(ROOT / "chat-index.json", snapshot)
    names = [
        "PLAN.md",
        "build_agent.py",
        "upload_agent.py",
        "run_chat.py",
        "serve.py",
        "corpus/questions.json",
        "corpus/manifest.json",
        "corpus/workspaces.json",
        "chat-index.json",
    ]
    freeze = {
        "files": {
            n: hashlib.sha256((ROOT / n).read_bytes()).hexdigest() for n in names
        },
        "recorder_sha256": hashlib.sha256(
            Path(run_agent.__file__).read_bytes()
        ).hexdigest(),
        "lab_server_sha256": hashlib.sha256(
            Path("/lab/lab_server.py").read_bytes()
        ).hexdigest(),
        "models": pins,
        "workspace_pins": workspace_pins,
        "baseline_runtime": {
            m.__name__: hashlib.sha256(Path(m.__file__).read_bytes()).hexdigest()
            for m in (agent, tools)
        },
        "variants": ["baseline", "follow_links_ids"],
        "repeats": 2,
        "cases": len(questions),
    }
    path = ROOT / "chat-freeze.json"
    if path.exists():
        previous = json.loads(path.read_text())
        previous.pop("created_utc")
        assert previous == freeze, "Frozen chat artifacts changed."
    else:
        write_json(
            path,
            {
                "created_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                **freeze,
            },
        )
    real_request = run_agent.request
    locales = {
        f"eval {q['id']} {v} {i}": "zh" if q["language"] == "zh" else "en"
        for q in questions
        for v in freeze["variants"]
        for i in range(2)
    }
    original = real_request("http://127.0.0.1:8082/api/me")["locale"]

    def request_with_locale(url, data=None, **kwargs):
        if url.endswith("/conversations") and isinstance(data, dict):
            real_request(
                "http://127.0.0.1:8082/api/me/locale",
                {"locale": locales[data["title"]]},
                method="PATCH",
            )
        return real_request(url, data, **kwargs)

    run_agent.request = request_with_locale
    try:
        run_agent.run(
            ROOT,
            argparse.Namespace(
                variants="baseline,follow_links_ids",
                split="holdout",
                repeats=2,
                output="chat.jsonl",
                ids=None,
            ),
        )
    finally:
        real_request(
            "http://127.0.0.1:8082/api/me/locale", {"locale": original}, method="PATCH"
        )


if __name__ == "__main__":
    main()
