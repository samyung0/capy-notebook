"""Alibaba Batch plumbing shared by the transcribe and tag stages: one task per
stage run under <run>/models/<stage>/ (prepare, submit, poll, collect), one
`review_tasks` row per book and stage, one `llm_calls` row per collected task,
and the live-endpoint call that serves retries and `--live` runs.
"""

from __future__ import annotations

import json
import os
import sys
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import llm
import store

sys.path.insert(0, str(store.REPO / "bench/rag/scripts"))
sys.path.insert(0, str(store.REPO / "pipeline"))
from knowledge_base_batch import (
    TERMINAL,
    BatchClient,
    PilotError,
    prepare,
    read_json,
    save_json,
)

WAITING = 3
LIVE_WORKERS = 4
ENV_KEYS = (
    "ALIBABA_API_KEY",
    "ALIBABA_BASE_URL",
    "KNOWLEDGE_BASE_B2_ENDPOINT",
    "KNOWLEDGE_BASE_B2_REGION",
    "KNOWLEDGE_BASE_B2_BUCKET",
    "KNOWLEDGE_BASE_B2_KEY_ID",
    "KNOWLEDGE_BASE_B2_APP_KEY",
)


def out(record: dict) -> None:
    """One JSON line of progress on stdout (the stage log)."""
    print(json.dumps(record, ensure_ascii=False), flush=True)


def load_env() -> None:
    from dotenv import dotenv_values

    local = dotenv_values(store.REPO / ".env.local")
    for key in ENV_KEYS:
        if local.get(key):
            os.environ.setdefault(key, local[key])


def tokens(usage: dict | None) -> dict:
    usage = usage or {}
    return {
        "prompt_tokens": usage.get("prompt_tokens") or 0,
        "completion_tokens": usage.get("completion_tokens") or 0,
        "reasoning_tokens": usage.get("reasoning_tokens")
        or (usage.get("completion_tokens_details") or {}).get("reasoning_tokens")
        or 0,
    }


def client() -> BatchClient:
    return BatchClient(
        os.environ.get("ALIBABA_API_KEY", ""), base_url=llm.alibaba_base()
    )


def row(custom_id: str, messages: list[dict], schema: dict, *, thinking: bool) -> dict:
    """One JSONL line of the batch task (thinking capped at 4,096 when on)."""
    return {
        "custom_id": custom_id,
        "method": "POST",
        "url": "/v1/chat/completions",
        "body": llm.alibaba_body(messages, schema, thinking=thinking),
    }


def submit(directory: Path, rows: list[dict], book: dict, stage: str) -> dict:
    """Freeze the JSONL and create the task; a state file left by an
    interrupted submit is resumed instead."""
    if not (directory / "state.json").exists():
        prepare(directory, rows, base_url=llm.alibaba_base())
    c = client()
    try:
        state = c.submit(directory)
    finally:
        c.close()
    now = time.time()
    store.set_review_task(
        book["sha256"],
        stage,
        batch_id=state["batch_id"],
        input_file_id=state.get("input_file_id"),
        status=state["status"],
        submitted_at=now,
        checked_at=now,
        requests=len(state["request_ids"]),
        done=None,
        failed=None,
        output_file_id=None,
        error_file_id=None,
        error=None,
    )
    return state


def task_fields(state: dict) -> dict:
    counts = state.get("request_counts") or {}
    return {
        "status": state["status"],
        "checked_at": time.time(),
        "done": counts.get("completed"),
        "failed": counts.get("failed"),
        "output_file_id": state.get("output_file_id"),
        "error_file_id": state.get("error_file_id"),
        "error": None,
    }


def collect(directory: Path, book: dict, stage: str) -> dict:
    """Poll the task and, once terminal, download and validate its output;
    the task's totals become one `llm_calls` row the first time."""
    c = client()
    try:
        state = c.collect(directory)
    finally:
        c.close()
    # The row is complete even when the submit crashed before writing it.
    store.set_review_task(
        book["sha256"],
        stage,
        batch_id=state["batch_id"],
        requests=len(state["request_ids"]),
        submitted_at=state.get("created_at") or time.time(),
        **task_fields(state),
    )
    if state["status"] in TERMINAL and not state.get("recorded"):
        results = read_json(directory / "results.json")
        usage = Counter()
        for record in results["success"].values():
            usage.update(tokens(record["usage"]))
        started, ended = (
            state.get("created_at"),
            (state.get("completed_at") or state.get("failed_at")),
        )
        store.record_llm_call(
            stage=stage,
            sha256=book["sha256"],
            model=state["model"],
            endpoint=llm.alibaba_base() + "/batches",
            request_id=state["batch_id"],
            input_tokens=usage["prompt_tokens"],
            output_tokens=usage["completion_tokens"],
            elapsed_ms=int((ended - started) * 1000) if started and ended else 0,
            ok=int(state["status"] == "completed"),
            error=None if state["status"] == "completed" else state["status"],
        )
        state["recorded"] = True
        save_json(directory / "state.json", state)
        out(
            {
                "batch": state["batch_id"],
                "status": state["status"],
                **state["collection"],
            }
        )
    return state


def poll(sha256: str, stage: str) -> str:
    """One status check of a waiting book's task, from the ingestion worker;
    returns the provider status (the last known one when the check failed)."""
    task = store.review_task(sha256, stage)
    try:
        c = client()
    except llm.LLMError as exc:
        store.set_review_task(sha256, stage, checked_at=time.time(), error=str(exc))
        return task["status"]
    try:
        job = c.call("GET", f"/batches/{task['batch_id']}").json()
    except PilotError as exc:
        store.set_review_task(sha256, stage, checked_at=time.time(), error=str(exc))
        return task["status"]
    finally:
        c.close()
    if not isinstance(job, dict) or not job.get("status"):
        store.set_review_task(
            sha256, stage, checked_at=time.time(), error="batch status missing"
        )
        return task["status"]
    store.set_review_task(sha256, stage, **task_fields(job))
    return job["status"]


def answers(directory: Path) -> dict[str, dict]:
    """The batch task's JSON-valid answers by custom id, each carrying the
    task's model and endpoint."""
    path = directory / "results.json"
    if not path.exists():
        return {}
    state = read_json(directory / "state.json")
    endpoint = f"{state.get('base_url')}/batches/{state.get('batch_id')}"
    return {
        cid: {
            **record,
            "model": state["model"],
            "endpoint": endpoint,
            "source": "batch",
        }
        for cid, record in read_json(path)["success"].items()
    }


def live(
    pending: list[tuple[str, list[dict]]], schema: dict, *, stage: str, sha256: str
):
    """Every pending (custom id, messages) through the live endpoint, four in
    flight, thinking off; yields (custom id, record or None, error or None)."""

    def one(item):
        cid, messages = item
        try:
            result = llm.alibaba(
                messages, schema, stage=stage, sha256=sha256, thinking=False
            )
        except llm.LLMError as exc:
            return cid, None, f"{type(exc).__name__}: {str(exc)[:300]}"
        return (
            cid,
            {
                "value": result.value,
                "usage": result.usage,
                "request_id": result.request_id,
                "model": result.model,
                "endpoint": result.endpoint,
                "at": time.time(),
                "source": "live",
            },
            None,
        )

    with ThreadPoolExecutor(LIVE_WORKERS) as pool:
        yield from pool.map(one, pending)


def archive(run_dir: Path, name: str, stamp: int) -> None:
    """<run>/models/<name> out of the loader's model-run walk."""
    directory = run_dir / "models" / name
    if directory.exists():
        dest = run_dir / "archive" / f"{name}-{stamp}"
        dest.parent.mkdir(parents=True, exist_ok=True)
        directory.rename(dest)


def stamp(started: float) -> str:
    return time.strftime("%Y-%m-%dT%H-%M-%S", time.localtime(started))


def latest_receipt(run_dir: Path, stage: str) -> dict | None:
    names = sorted(run_dir.glob(f"{stage}-*.json"))
    return read_json(names[-1]) if names else None
