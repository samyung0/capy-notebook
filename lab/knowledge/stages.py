"""Plumbing the transcribe and tag stages share: progress lines, the Alibaba
secrets, token sums, the live-endpoint pool and the run receipts."""

from __future__ import annotations

import json
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import llm
import store

sys.path.insert(0, str(store.REPO / "bench/rag/scripts"))
sys.path.insert(0, str(store.REPO / "pipeline"))
from knowledge_base_common import read_json

LIVE_WORKERS = 4
ENV_KEYS = ("ALIBABA_API_KEY", "ALIBABA_BASE_URL")


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


def live(
    pending: list[tuple[str, list[dict]]], schema: dict, *, stage: str, sha256: str
):
    """Every pending (custom id, messages) through the live endpoint, four in
    flight; yields (custom id, record or None, error or None)."""

    def one(item):
        cid, messages = item
        try:
            result = llm.alibaba(messages, schema, stage=stage, sha256=sha256)
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
