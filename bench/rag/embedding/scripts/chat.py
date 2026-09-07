"""Run or serve the unchanged lab agent with explicit embedding-only hooks."""

from __future__ import annotations

import argparse
import contextlib
import hashlib
import http.client
import json
import shutil
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

import httpx
import psycopg
from embed import CONDITIONS, QWEN_TASK, ROOT, append, request, write_json
from psycopg.rows import dict_row
from run import SCHEMA, fingerprint, freeze

sys.path.insert(0, "/lab")
import run_agent

from pipeline.config import cfg
from pipeline.retrieval import agent, models, store, tools


def serve():
    import lab_server
    import uvicorn

    lab_server.ROOT = ROOT
    original_table = store.vector_table_for_pin
    client = httpx.AsyncClient(timeout=30)

    def selected():
        condition = json.loads((ROOT / "variant.json").read_text())["name"]
        assert condition in CONDITIONS
        return condition

    def vector_table(pin):
        assert original_table(pin) == "rag_chunk_vectors_2560"
        return f"{SCHEMA}.{selected()}"

    async def embed_query(texts, *, spec):
        assert spec.pin == ("deepinfra", "Qwen/Qwen3-Embedding-4B", 1)
        prefix = f"Instruct: {QWEN_TASK}\nQuery:"
        assert all(t.startswith(prefix) for t in texts)
        condition = selected()
        vectors, _ = await request(
            client, condition, [t[len(prefix) :] for t in texts], "query", phase="chat"
        )
        return vectors

    def prompt(locale):
        return lab_server.original_prompt(locale) + lab_server.FOLLOW_LINKS

    def render(result, numbered):
        text = lab_server.original_render(result, numbered)
        if numbered:
            locations = "\n".join(
                f"[{number}] file_id={passage.file_id}, start={passage.chunk_idx}"
                for number, passage in numbered
            )
            text += "\n\nLocations for read_document:\n" + locations
        return text

    store.vector_table_for_pin = vector_table
    # Same exact candidate search as the retrieval-quality phase.
    store._SEARCH_SQL_TEMPLATE = store._SEARCH_SQL_TEMPLATE.replace(
        "v.embedding <=> %(vector)s::halfvec",
        "(v.embedding <=> %(vector)s::halfvec) + 0",
    )
    models.embed = embed_query
    agent.system_prompt = prompt
    tools.render_result = render
    uvicorn.run("pipeline.retrieve.service:app", host="127.0.0.1", port=8002)


def run(challenger):
    freeze()
    assert challenger in CONDITIONS and challenger != "qwen4"
    variants = ["qwen4", challenger]
    (ROOT / "corpus").mkdir(exist_ok=True)
    for name in ("questions.json", "workspaces.json", "manifest.json"):
        shutil.copyfile(Path("/lab/corpus") / name, ROOT / "corpus" / name)
    questions = json.loads((ROOT / "corpus/questions.json").read_text())
    workspaces = json.loads((ROOT / "corpus/workspaces.json").read_text())
    assert len(questions) == 48
    with psycopg.connect(cfg.dsn, row_factory=dict_row) as conn:
        snapshots = {}
        for label, ws in workspaces.items():
            snapshots[label] = conn.execute(
                """SELECT c.id AS chunk_id,f.id AS file_id,f.name AS file_name,
                c.chunk_idx,c.text,c.section_path,c.page_start,c.page_end,c.regions,c.lang
                FROM rag_chunks c JOIN rag_file_contents fc ON fc.content_id=c.content_id
                JOIN files f ON f.id=fc.file_id WHERE fc.workspace_id=%s ORDER BY f.name,c.chunk_idx""",
                (ws["id"],),
            ).fetchall()
        for q in questions:
            assert all(
                any(
                    run_agent.supports(p, e)
                    for p in snapshots[q["workspace"]]
                    for e in group
                )
                for group in q["evidence_groups"]
            ), q["id"]
        pins = conn.execute(
            "SELECT provider_slug,model_slug,version,is_default_for FROM model_configs WHERE cardinality(is_default_for)>0 ORDER BY 1,2,3"
        ).fetchall()
    write_json(ROOT / "chat-sources.json", snapshots)
    frozen = {
        "variants": variants,
        "repeats": 2,
        "cases": 48,
        "pins": pins,
        "agent_behavior": "follow_links_ids",
        "search": "exact hybrid, 40 candidates, top5, per-file cap4",
        "files": {
            str(p): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in [
                ROOT / "chat.py",
                ROOT / "chat-sources.json",
                ROOT / "embed.py",
                ROOT / "corpus/questions.json",
                ROOT / "corpus/workspaces.json",
                Path(run_agent.__file__),
            ]
        },
        "runtime_sources": {
            m.__name__: hashlib.sha256(Path(m.__file__).read_bytes()).hexdigest()
            for m in (agent, tools, models, store)
        },
    }
    if (ROOT / "chat-freeze.json").exists():
        assert json.loads((ROOT / "chat-freeze.json").read_text()) == frozen
    else:
        write_json(ROOT / "chat-freeze.json", frozen)
    for v in variants:
        run_agent.CONDITIONS[v] = dict(run_agent.CONDITIONS["follow_links_ids"])

    real_urlopen = urllib.request.urlopen

    @contextlib.contextmanager
    def recorded_transport(req, *args, **kwargs):
        # The reused recorder already saves HTTP errors. Convert interrupted SSE
        # iteration into an error event so it also preserves those first attempts.
        if not isinstance(req, urllib.request.Request) or not req.full_url.endswith(
            "/chat/stream"
        ):
            with real_urlopen(req, *args, **kwargs) as response:
                yield response
            return

        def lines(response):
            try:
                yield from response
            except (OSError, ValueError, http.client.HTTPException) as exc:
                yield (
                    b"data: "
                    + json.dumps({"type": "error", "message": str(exc)}).encode()
                    + b"\n"
                )

        try:
            response = real_urlopen(req, *args, **kwargs)
        except urllib.error.HTTPError:
            raise
        except OSError as exc:
            yield [
                b"data: "
                + json.dumps({"type": "error", "message": str(exc)}).encode()
                + b"\n"
            ]
        else:
            with response:
                yield lines(response)

    urllib.request.urlopen = recorded_transport
    api = "http://127.0.0.1:8082"
    original_locale = run_agent.request(api + "/api/me")["locale"]
    run_agent.request(api + "/api/me/locale", {"locale": "en"}, method="PATCH")
    args = argparse.Namespace(
        variants=",".join(variants),
        split="all",
        repeats=2,
        output="chat.jsonl",
        ids=None,
        skip_attempted=True,
    )
    try:
        while True:
            before = (
                len((ROOT / "chat.jsonl").read_text().splitlines())
                if (ROOT / "chat.jsonl").exists()
                else 0
            )
            try:
                run_agent.run(ROOT, args)
                break
            except RuntimeError:
                records = [
                    json.loads(s)
                    for s in (ROOT / "chat.jsonl").read_text().splitlines()
                ]
                assert len(records) > before and records[-1]["errors"]
                append(
                    "chat-resumes.jsonl",
                    {
                        "attempts": len(records),
                        "failed_id": records[-1]["id"],
                        "reason": "Continue remaining cases; preserve and skip the failed first attempt.",
                    },
                )
                if len(records) >= 3 and all(r["errors"] for r in records[-3:]):
                    raise RuntimeError(
                        "Three consecutive infrastructure failures; inspect before continuing."
                    ) from None
    finally:
        run_agent.request(
            api + "/api/me/locale", {"locale": original_locale}, method="PATCH"
        )
    with psycopg.connect(cfg.dsn, row_factory=dict_row) as conn:
        frozen_index = json.loads((ROOT / "freeze.json").read_text())
        assert (
            fingerprint(conn, frozen_index["workspaces"]) == frozen_index["index_state"]
        )
    write_json(
        ROOT / "chat-completion.json",
        {
            "completed_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "attempts": len((ROOT / "chat.jsonl").read_text().splitlines()),
        },
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=["serve", "run"])
    parser.add_argument("challenger", nargs="?", choices=list(CONDITIONS))
    args = parser.parse_args()
    if args.mode == "serve":
        serve()
    else:
        run(args.challenger)
