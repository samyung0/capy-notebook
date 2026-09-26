"""Paid model calls for the delta-summary probe, with a hard spend cap.

DeepSeek V4.1 Flash (the model behind the pipeline's ``deepseek-flash`` ingest
pin) is reached through DeepInfra with the DEEPINFRA_API_KEY from the
repository-root .env.local: .env.local and deploy/.env hold no DeepSeek key.
Settings match the pipeline's summary call: temperature 0.3 (catalog param),
thinking disabled, no response_format. Every call is appended to ledger.jsonl
with its usage and DeepInfra's estimated_cost. Before a call the worst case
(estimated input x 1.3 at list price plus max_tokens of output) must fit under
the cap together with what the ledger already spent.
"""

from __future__ import annotations

import hashlib
import json
import sys
import time
from pathlib import Path

import httpx
from dotenv import dotenv_values

sys.path.insert(0, r"C:\WEB\capy-notebook\pipeline")
from pipeline.retrieval.chunking import estimate_tokens

HERE = Path(__file__).resolve().parent
LEDGER = HERE / "ledger.jsonl"
CACHE = HERE / "calls"
URL = "https://api.deepinfra.com/v1/openai/chat/completions"
EMBED_URL = "https://api.deepinfra.com/v1/openai/embeddings"
CAP_USD = 2.00
SOFT_CAP_USD = 1.85

# DeepInfra list prices, USD per million tokens (models endpoint, 2026-09-25).
PRICES = {
    "deepseek-ai/DeepSeek-V4.1-Flash": (0.20, 0.60),
    "deepseek-ai/DeepSeek-V4-Pro-0813": (1.30, 2.60),
    "Qwen/Qwen3-Embedding-4B": (0.02, 0.0),
}
FLASH = "deepseek-ai/DeepSeek-V4.1-Flash"
KEY = dotenv_values(r"C:\WEB\capy-notebook\.env.local").get("DEEPINFRA_API_KEY") or ""


class BudgetExceeded(RuntimeError):
    pass


def spent() -> float:
    if not LEDGER.exists():
        return 0.0
    total = 0.0
    for line in LEDGER.read_text(encoding="utf-8").splitlines():
        row = json.loads(line)
        total += float(row.get("cost_usd") or 0.0)
    return total


def _worst_case(model: str, messages: list[dict], max_tokens: int) -> float:
    text = "".join(str(m.get("content") or "") for m in messages)
    price_in, price_out = PRICES[model]
    return (estimate_tokens(text) * 1.3 * price_in + max_tokens * price_out) / 1e6


def _thinking_off(model: str) -> dict:
    # DeepInfra's DeepSeek V4 family takes the chat-template switch; the
    # pipeline sends DeepSeek's own {"thinking": {"type": "disabled"}}.
    return {"chat_template_kwargs": {"thinking": False}} if "DeepSeek" in model else {}


def chat(
    tag: str,
    messages: list[dict],
    *,
    model: str = FLASH,
    temperature: float = 0.3,
    max_tokens: int = 4000,
    extra: dict | None = None,
    reuse: bool = True,
) -> dict:
    """One completion. A result cached under the same tag and request is reused."""
    CACHE.mkdir(exist_ok=True)
    thinking = {} if "reasoning_effort" in (extra or {}) else _thinking_off(model)
    body = {
        "model": model,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
        **thinking,
        **(extra or {}),
    }
    digest = hashlib.sha256(json.dumps(body, sort_keys=True).encode()).hexdigest()[:16]
    path = CACHE / f"{tag}-{digest}.json"
    if reuse and path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    worst = _worst_case(model, messages, max_tokens)
    already = spent()
    if already + worst > SOFT_CAP_USD:
        raise BudgetExceeded(
            f"{tag}: spent {already:.4f} + worst {worst:.4f} > {SOFT_CAP_USD}"
        )
    started = time.perf_counter()
    response = httpx.post(
        URL, headers={"Authorization": f"Bearer {KEY}"}, json=body, timeout=600
    )
    elapsed = time.perf_counter() - started
    response.raise_for_status()
    raw = response.json()
    usage = raw.get("usage") or {}
    cost = usage.get("estimated_cost")
    if cost is None:
        price_in, price_out = PRICES[model]
        cost = (
            usage.get("prompt_tokens", 0) * price_in
            + usage.get("completion_tokens", 0) * price_out
        ) / 1e6
    message = (raw.get("choices") or [{}])[0].get("message") or {}
    record = {
        "tag": tag,
        "model": model,
        "elapsed_s": round(elapsed, 1),
        "usage": usage,
        "cost_usd": float(cost),
        "worst_case_usd": round(worst, 5),
        "estimated_input_tokens": estimate_tokens(
            "".join(str(m.get("content") or "") for m in messages)
        ),
        "finish_reason": (raw.get("choices") or [{}])[0].get("finish_reason"),
        "content": message.get("content") or "",
        "reasoning": message.get("reasoning_content") or "",
    }
    with LEDGER.open("a", encoding="utf-8") as fh:
        fh.write(
            json.dumps(
                {k: v for k, v in record.items() if k not in ("content", "reasoning")}
            )
            + "\n"
        )
    path.write_text(json.dumps(record, ensure_ascii=False, indent=1), encoding="utf-8")
    return record


def embed(tag: str, texts: list[str]) -> list[list[float]]:
    """Qwen3-Embedding-4B vectors, the production embedding model, for similarity."""
    CACHE.mkdir(exist_ok=True)
    model = "Qwen/Qwen3-Embedding-4B"
    body = {"model": model, "input": texts, "encoding_format": "float"}
    digest = hashlib.sha256(json.dumps(body, sort_keys=True).encode()).hexdigest()[:16]
    path = CACHE / f"embed-{tag}-{digest}.json"
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))["vectors"]
    worst = sum(estimate_tokens(t) for t in texts) * 1.3 * PRICES[model][0] / 1e6
    if spent() + worst > SOFT_CAP_USD:
        raise BudgetExceeded(f"embed {tag}")
    response = httpx.post(
        EMBED_URL, headers={"Authorization": f"Bearer {KEY}"}, json=body, timeout=120
    )
    response.raise_for_status()
    raw = response.json()
    usage = raw.get("usage") or {}
    cost = usage.get("estimated_cost")
    if cost is None:
        cost = usage.get("prompt_tokens", 0) * PRICES[model][0] / 1e6
    vectors = [row["embedding"] for row in raw["data"]]
    with LEDGER.open("a", encoding="utf-8") as fh:
        fh.write(
            json.dumps(
                {
                    "tag": f"embed-{tag}",
                    "model": model,
                    "usage": usage,
                    "cost_usd": float(cost),
                }
            )
            + "\n"
        )
    path.write_text(json.dumps({"vectors": vectors}), encoding="utf-8")
    return vectors
