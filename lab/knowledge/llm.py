"""Model routing for the builder: GLM-5.3-Flash through the local Ollama cloud
model for topics and scraping, Qwen3.8-Flash through Alibaba Model Studio for
the transcribe and tag stages (the live endpoint here; `alibaba_body` is also
the Batch request body). Both endpoints wait and retry on a connection error, a 429 and
a 5xx (5, 20, 60 s), retry a schema failure once on the same endpoint and
never fall back to another endpoint. Every attempt is an `llm_calls` row.
"""

from __future__ import annotations

import base64
import json
import os
import re
import time
from dataclasses import dataclass

import httpx
import store
from jsonschema import Draft202012Validator

OLLAMA = "http://127.0.0.1:11434/v1/chat/completions"
OLLAMA_MODEL = "glm-5.3-flash:cloud"
ALIBABA_MODEL = "qwen3.8-flash"
THINKING_BUDGET = 4096
BACKOFF = (5, 20, 60)
# Measured 2026-09-19 on the Ollama cloud model: `thinking: false` still
# returned reasoning, `reasoning_effort: none` leaked the reasoning into the
# content, `low` returned clean JSON at a quarter of the tokens. GLM only
# accepts low/high/max.
EFFORT = {False: "low", True: "high"}
FENCE = re.compile(r"^\s*```(?:json)?\s*|\s*```\s*$")


class LLMError(RuntimeError):
    """The endpoint refused or stayed unreachable through the retries."""


class SchemaError(LLMError):
    """The model answered twice without matching the schema."""


@dataclass
class Result:
    value: dict
    model: str
    endpoint: str
    request_id: str | None
    usage: dict


def image_part(jpeg: bytes) -> dict:
    return {
        "type": "image_url",
        "image_url": {
            "url": "data:image/jpeg;base64," + base64.b64encode(jpeg).decode("ascii")
        },
    }


def alibaba_base() -> str:
    url = os.environ.get("ALIBABA_BASE_URL")
    if not url or not os.environ.get("ALIBABA_API_KEY"):
        raise LLMError("ALIBABA_BASE_URL and ALIBABA_API_KEY are needed in .env.local")
    return url.rstrip("/")


def alibaba_headers() -> dict:
    return {"Authorization": f"Bearer {os.environ['ALIBABA_API_KEY']}"}


def alibaba_body(messages: list[dict], schema: dict, *, thinking: bool) -> dict:
    """The Qwen request the probe proved: strict json_schema, temperature 0,
    thinking capped at 4,096 tokens in batch and off live."""
    body = {
        "model": ALIBABA_MODEL,
        "messages": messages,
        "temperature": 0,
        "enable_thinking": thinking,
        "response_format": {
            "type": "json_schema",
            "json_schema": {"name": "review", "strict": True, "schema": schema},
        },
    }
    if thinking:
        body["thinking_budget"] = THINKING_BUDGET
    return body


def alibaba(
    messages: list[dict],
    schema: dict,
    *,
    stage: str,
    sha256: str | None = None,
    thinking: bool = False,
    timeout: float = 600,
    transport: httpx.BaseTransport | None = None,
) -> Result:
    return post(
        alibaba_base() + "/chat/completions",
        alibaba_body(messages, schema, thinking=thinking),
        headers=alibaba_headers(),
        schema=schema,
        stage=stage,
        sha256=sha256,
        timeout=timeout,
        transport=transport,
    )


def complete(
    messages: list[dict],
    schema: dict,
    *,
    images: list[bytes] | None = None,
    stage: str,
    sha256: str | None = None,
    thinking: bool = False,
    timeout: float = 120,
    transport: httpx.BaseTransport | None = None,
) -> Result:
    """GLM on Ollama for topics and scraping."""
    messages = list(messages)
    if images:
        # Images ride on the last user message as data URLs in image_url parts.
        last = dict(messages[-1])
        text = last["content"] if isinstance(last["content"], str) else None
        parts = [image_part(i) for i in images]
        last["content"] = (
            [{"type": "text", "text": text}] if text else list(last["content"])
        ) + parts
        messages[-1] = last
    # Ollama does not enforce the schema server-side; the instruction is the
    # part that works, the local validation is the part that decides.
    messages.append(
        {
            "role": "system",
            "content": "Return exactly one JSON object matching this JSON schema. No prose, no markdown code fences.\n"
            + json.dumps(schema, ensure_ascii=False),
        }
    )
    body = {
        "model": OLLAMA_MODEL,
        "messages": messages,
        "temperature": 0,
        "reasoning_effort": EFFORT[thinking],
        "response_format": {
            "type": "json_schema",
            "json_schema": {"name": "out", "schema": schema},
        },
    }
    return post(
        OLLAMA,
        body,
        headers={},
        schema=schema,
        stage=stage,
        sha256=sha256,
        timeout=timeout,
        transport=transport,
    )


def post(
    url: str,
    body: dict,
    *,
    headers: dict,
    schema: dict,
    stage: str,
    sha256: str | None,
    timeout: float,
    transport: httpx.BaseTransport | None,
) -> Result:
    Draft202012Validator.check_schema(schema)
    validator = Draft202012Validator(schema)
    waits = list(BACKOFF)
    schema_retry = True
    with httpx.Client(timeout=timeout, transport=transport) as client:
        while True:
            started = time.monotonic()
            receipt = {
                "stage": stage,
                "sha256": sha256,
                "model": body["model"],
                "endpoint": url,
            }
            try:
                response = client.post(url, json=body, headers=headers)
            except httpx.HTTPError as exc:
                store.record_llm_call(
                    **receipt, elapsed_ms=_ms(started), ok=0, error=type(exc).__name__
                )
                if not waits:
                    raise LLMError(
                        f"{url}: {type(exc).__name__} after {len(BACKOFF)} retries"
                    ) from exc
                time.sleep(waits.pop(0))
                continue
            elapsed = _ms(started)
            request_id = response.headers.get("x-request-id")
            code = response.status_code
            if code == 429 or code >= 500:
                store.record_llm_call(
                    **receipt,
                    request_id=request_id,
                    elapsed_ms=elapsed,
                    ok=0,
                    error=f"http_{code}",
                )
                if not waits:
                    raise LLMError(
                        f"{url} answered {code} after {len(BACKOFF)} retries"
                    )
                pause = waits.pop(0)
                time.sleep(retry_after(response.headers.get("retry-after"), pause))
                continue
            if code != 200:
                store.record_llm_call(
                    **receipt,
                    request_id=request_id,
                    elapsed_ms=elapsed,
                    ok=0,
                    error=f"http_{code}",
                )
                raise LLMError(f"{url} answered {code}: {response.text[:300]}")
            payload = response.json()
            request_id = request_id or payload.get("id")
            usage = usage_of(payload)
            message = (payload.get("choices") or [{}])[0].get("message") or {}
            # Reasoning comes back in its own field; `content` is the answer.
            value, error = parse(message.get("content") or "", validator)
            store.record_llm_call(
                **receipt,
                request_id=request_id,
                elapsed_ms=elapsed,
                ok=int(error is None),
                error=error,
                input_tokens=usage["prompt_tokens"],
                output_tokens=usage["completion_tokens"],
            )
            if error is None:
                return Result(value, body["model"], url, request_id, usage)
            if not schema_retry:
                raise SchemaError(f"{body['model']} on {url}: {error} after a retry")
            schema_retry = False


def retry_after(header: str | None, default: float) -> float:
    """Seconds from a Retry-After header; an HTTP date or nothing means the
    backoff's own pause."""
    try:
        return float(header)
    except (TypeError, ValueError):
        return default


def usage_of(payload: dict) -> dict:
    usage = payload.get("usage") or {}
    return {
        "prompt_tokens": usage.get("prompt_tokens"),
        "completion_tokens": usage.get("completion_tokens"),
        "reasoning_tokens": (usage.get("completion_tokens_details") or {}).get(
            "reasoning_tokens"
        ),
    }


def parse(
    content: str, validator: Draft202012Validator
) -> tuple[dict | None, str | None]:
    try:
        value = json.loads(FENCE.sub("", content))
    except ValueError:
        return None, "invalid_json"
    problem = next(validator.iter_errors(value), None)
    if problem is not None:
        return None, f"schema: {problem.message[:200]}"
    return value, None


def _ms(started: float) -> int:
    return int((time.monotonic() - started) * 1000)
