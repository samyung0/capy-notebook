"""Isolated Qwen chat transport over the frozen embedding-evaluation agent."""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import sqlite3
import time
from pathlib import Path

import embed
import psycopg
from psycopg.rows import dict_row

ROOT = Path("/lab/qwen38")
SCHEMA = "qwen38_eval_20260907"
MODEL = "qwen3.8-flash"
URL = "https://ws-2y5yiplq25glam7r.eu-central-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions"
embed.ROOT = ROOT
for name in list(embed.CONDITIONS):
    if name not in {"qwen4", "voyage4"}:
        del embed.CONDITIONS[name]

import run

run.ROOT, run.SCHEMA = ROOT, SCHEMA
import chat

chat.ROOT, chat.SCHEMA = ROOT, SCHEMA

from pipeline.config import cfg
from pipeline.elitellm import client


def shape(body):
    assert body["model"] == "deepseek-v4-flash-vision-exp"
    assert body["thinking"] == {"type": "disabled"}
    assert "reasoning_effort" not in body
    wire = {k: v for k, v in body.items() if k != "thinking"}
    wire.update(model=MODEL, enable_thinking=False)
    return wire


def install_transport():
    """Keep the original assembler, timeouts, continuity and retry accounting."""
    original_stream, original_post = client._stream_sse, client._post_json
    key = json.loads(Path("/lab/embedding-secrets.json").read_text())["alibaba"]

    def begin(url, body):
        assert url == client.DEEPSEEK_CHAT_URL
        wire = shape(body)
        record = {
            "started_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "variant": json.loads((ROOT / "variant.json").read_text())["name"],
            "actual_model": MODEL,
            "url": URL,
            "body": wire,
            "responses": [],
        }
        return wire, record, time.perf_counter()

    def observe(record, event, started):
        if "first_event_ms" not in record:
            record["first_event_ms"] = (time.perf_counter() - started) * 1000
        if event.get("model"):
            assert event["model"] == MODEL, event["model"]
        if event.get("usage"):
            record["usage"] = event["usage"]
        if event.get("id"):
            record["response_id"] = event["id"]
        # No reasoning is requested. Retain complete response evidence.
        record["responses"].append(event)

    async def stream(url, headers, body):
        del headers
        wire, record, started = begin(url, body)
        try:
            async for event in original_stream(URL, client._bearer(key), wire):
                observe(record, event, started)
                yield event
        except BaseException as exc:
            record["error"] = f"{type(exc).__name__}: {exc}"
            raise
        finally:
            record["elapsed_ms"] = (time.perf_counter() - started) * 1000
            embed.append("llm-requests.jsonl", record)

    async def post(url, headers, body):
        del headers
        wire, record, started = begin(url, body)
        try:
            event = await original_post(URL, client._bearer(key), wire)
            observe(record, event, started)
            return event
        except BaseException as exc:
            record["error"] = f"{type(exc).__name__}: {exc}"
            raise
        finally:
            record["elapsed_ms"] = (time.perf_counter() - started) * 1000
            embed.append("llm-requests.jsonl", record)

    client._stream_sse, client._post_json = stream, post


def setup():
    assert "55434" in cfg.dsn
    run.freeze()
    baseline = json.loads((ROOT / "baseline-freeze.json").read_text())
    frozen = json.loads((ROOT / "freeze.json").read_text())
    assert baseline["index_state"] == frozen["index_state"]
    assert baseline["runtime_sources"] == frozen["runtime_sources"]
    old = json.loads((ROOT / "baseline-before-chat-state.json").read_text())
    for path, digest in old["older_artifact_hashes"].items():
        assert hashlib.sha256(Path(path).read_bytes()).hexdigest() == digest, path
    rows = json.loads(gzip.decompress((ROOT / "curated-chunks.json.gz").read_bytes()))
    assert len(rows) == 532
    with psycopg.connect(cfg.dsn, row_factory=dict_row) as conn:
        before = {
            "conversation_ids": [
                r["id"]
                for r in conn.execute("SELECT id FROM conversations ORDER BY id")
            ],
            "workspace_pins": conn.execute(
                "SELECT id,embedding_provider_slug,embedding_model_slug,embedding_model_version,embedding_dim FROM workspaces ORDER BY id"
            ).fetchall(),
            "older_artifact_hashes": old["older_artifact_hashes"],
        }
        assert set(before["conversation_ids"]) == set(old["conversation_ids"])
        assert before["workspace_pins"] == old["workspace_pins"]
        embed.write_json(ROOT / "before-chat-state.json", before)
        assert (
            conn.execute("SELECT to_regnamespace(%s) AS value", (SCHEMA,)).fetchone()[
                "value"
            ]
            is None
        )
        conn.execute(f"CREATE SCHEMA {SCHEMA}")
        with sqlite3.connect(ROOT / "vectors.sqlite3") as cache:
            for condition, spec in embed.CONDITIONS.items():
                table = f"{SCHEMA}.{condition}"
                conn.execute(
                    f"CREATE TABLE {table} (chunk_id text PRIMARY KEY,workspace_id text NOT NULL,embedding halfvec({spec[2]}) NOT NULL)"
                )
                with conn.cursor().copy(f"COPY {table} FROM STDIN") as copy:
                    for row in rows:
                        key = embed.cache_key(
                            condition, "document", row["indexed_text"]
                        )
                        blob = cache.execute(
                            "SELECT value FROM vectors WHERE key=?", (key,)
                        ).fetchone()[0]
                        vector = embed.unpack(blob)
                        assert len(vector) == spec[2]
                        copy.write_row(
                            (
                                row["id"],
                                row["workspace_id"],
                                run.store.vector_literal(vector),
                            )
                        )
                conn.execute(
                    f"CREATE INDEX {condition}_ws_idx ON {table}(workspace_id)"
                )
                conn.execute(f"ANALYZE {table}")
    embed.write_json(
        ROOT / "qwen-freeze.json",
        {
            "actual_model": MODEL,
            "url": URL,
            "enable_thinking": False,
            "reason": "Matches the previous DeepSeek instant setting; shape asserts every original request disables thinking.",
            "temperature": 0.3,
            "provider_timeout_s": cfg.interactive_provider_timeout_s,
            "restored_chunks_per_embedder": len(rows),
            "search": "Exact hybrid over both complete curated workspaces; no ANN; original vectors reused.",
            "database_pin": "Unchanged DeepSeek pin is only the lab admission/accounting envelope; actual provider body and receipts are saved separately. Do not use lab dollar charges as Qwen pricing.",
            "adapter_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        },
    )
    print("Frozen baseline verified; restored 532 chunks for each of two embedders.")


def self_check():
    before = {
        "model": "deepseek-v4-flash-vision-exp",
        "thinking": {"type": "disabled"},
        "messages": [{"role": "user", "content": "test"}],
        "temperature": 0.3,
    }
    after = shape(before)
    assert after["model"] == MODEL and after["enable_thinking"] is False
    assert after["messages"] == before["messages"] and "thinking" in before
    try:
        shape({**before, "thinking": {"type": "enabled"}})
    except AssertionError:
        pass
    else:
        raise AssertionError("Unexpected thinking mode accepted")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=["setup", "serve", "run", "check"])
    mode = parser.parse_args().mode
    self_check()
    if mode == "setup":
        setup()
    elif mode == "serve":
        install_transport()
        chat.serve()
    elif mode == "run":
        chat.run("voyage4")
