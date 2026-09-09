"""Process-local Qwen transport for the isolated parser/RAG comparison."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import os
import time
import uuid
from contextlib import contextmanager
from contextvars import ContextVar
from pathlib import Path
from urllib.parse import urlsplit

from pipeline.config import cfg
from pipeline.elitellm import client

from pipeline import elitellm, registry

MODEL = "qwen3.8-flash"
PIN = ("alibaba", MODEL, 1)
EMBEDDING_PIN = ("deepinfra", "Qwen/Qwen3-Embedding-4B", 1)
QWEN_HOST = "ws-2y5yiplq25glam7r.eu-central-1.maas.aliyuncs.com"
_context: ContextVar[dict | None] = ContextVar("odl_eval_receipt_context", default=None)
_installed: tuple[Path, Path] | None = None


def model_config() -> registry.ModelConfig:
    """Explicit experiment limits, not a statement of the vendor's maximum."""
    context = int(os.environ["ODL_QWEN_CONTEXT_TOKENS"])
    output = int(os.environ["ODL_QWEN_MAX_OUTPUT_TOKENS"])
    if output != 8192 or context != 65536:
        raise ValueError(
            "This frozen experiment requires 65536 context and 8192 output tokens"
        )
    return registry.ModelConfig(
        version=1,
        provider_name="Alibaba Cloud",
        model_name="Qwen3.8 Flash",
        provider_slug=PIN[0],
        model_slug=MODEL,
        params={"temperature": 0.3, "max_tokens": output},
        slots=(registry.Slot.CHAT, registry.Slot.INGEST, registry.Slot.CAPTIONING),
        thinking_levels=("instant",),
        default_thinking="instant",
        context_window_tokens=context,
    )


def guard_database() -> None:
    from psycopg.conninfo import conninfo_to_dict

    dsn = conninfo_to_dict(cfg.dsn)
    if dsn.get("host") not in {"127.0.0.1", "localhost"} or dsn.get("port") != "55435":
        raise ValueError("Only the isolated loopback database on port 55435 is allowed")


def validate_endpoint(url: str) -> None:
    parsed = urlsplit(url)
    if (
        parsed.scheme != "https"
        or parsed.port not in (None, 443)
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
        or parsed.hostname != QWEN_HOST
        or not parsed.path.endswith("/chat/completions")
    ):
        raise ValueError("The supplied HTTPS Alibaba MaaS host is required")


@contextmanager
def recording_context(**fields):
    token = _context.set({**(_context.get() or {}), **fields})
    try:
        yield
    finally:
        _context.reset(token)


def redact_images(value):
    """Keep text evidence, but replace image data with a reproducible digest."""
    if isinstance(value, str) and value.startswith("data:image/"):
        header, encoded = value.split(",", 1)
        raw = base64.b64decode(encoded, validate=True)
        return {
            "image_mime": header[5:].split(";")[0],
            "bytes": len(raw),
            "sha256": hashlib.sha256(raw).hexdigest(),
        }
    if isinstance(value, dict):
        return {k: redact_images(v) for k, v in value.items()}
    if isinstance(value, list):
        return [redact_images(v) for v in value]
    return value


def wire_body(
    spec,
    messages,
    *,
    stream,
    temperature=None,
    tools=None,
    max_tokens=None,
    reasoning=None,
    response_format=None,
    input_items=None,
    tool_choice=None,
):
    if spec.pin != PIN or input_items:
        raise ValueError("Only the exact Qwen chat-completions pin is supported")
    if reasoning not in (
        None,
        False,
    ) or registry.current_request_llm().thinking not in ("", "instant"):
        raise ValueError("The frozen comparison disables thinking")
    cap = spec.params["max_tokens"]
    if max_tokens is not None and not 0 < max_tokens <= cap:
        raise ValueError("Requested output exceeds the matched experiment cap")
    body = {
        "model": MODEL,
        "messages": messages,
        "temperature": spec.temperature() if temperature is None else temperature,
        "enable_thinking": False,
        "max_tokens": cap if max_tokens is None else max_tokens,
        "stream": stream,
    }
    if stream:
        body["stream_options"] = {"include_usage": True}
    if tools:
        body["tools"] = tools
        body["tool_choice"] = "auto" if tool_choice is None else tool_choice
    else:
        if tool_choice not in (None, "none"):
            raise ValueError("Tool choice requires available tool schemas")
        body["tool_choice"] = "none"
    if response_format:
        body["response_format"] = response_format
    return body


def install_transport(
    root: Path | None = None, secrets: Path = Path("/run/odl-eval-secrets.json")
) -> registry.ModelConfig:
    """Install once per disposable process; leave agent, search and retries intact."""
    global _installed
    root = Path(root or os.environ.get("ODL_EVAL_ROOT", "/lab")).resolve()
    secrets = Path(secrets).resolve()
    guard_database()
    spec = model_config()
    identity = (root, secrets)
    if _installed is not None:
        if _installed != identity:
            raise ValueError("Transport already installed for another experiment")
        return spec
    url = os.environ["ODL_QWEN_CHAT_URL"]
    validate_endpoint(url)
    keys = json.loads(secrets.read_text())
    if not all(
        isinstance(keys.get(k), str) and keys[k] for k in ("alibaba", "deepinfra")
    ):
        raise ValueError("Both experiment provider credentials are required")
    os.environ["DEEPINFRA_API_KEY"] = keys["deepinfra"]
    root.mkdir(parents=True, exist_ok=True)
    original_stream, original_post = client._stream_sse, client._post_json
    native_stream, native_complete = elitellm.stream, elitellm.complete

    def begin(endpoint, body):
        expected = MODEL if endpoint == url else EMBEDDING_PIN[1]
        if (
            endpoint not in (url, client.DEEPINFRA_EMBED_URL)
            or body.get("model") != expected
        ):
            raise ValueError("Unexpected provider route in the isolated comparison")
        return {
            **(_context.get() or {}),
            "attempt_id": uuid.uuid4().hex,
            "started_unix": time.time(),
            "url": endpoint,
            "model": expected,
            "body": redact_images(body),
            "responses": [],
        }, time.perf_counter()

    def observe(record, response, start):
        record.setdefault("first_event_seconds", time.perf_counter() - start)
        returned = response.get("model")
        if returned and returned != record["model"]:
            raise ValueError(f"Provider returned a different model: {returned}")
        for key in ("id", "model", "usage"):
            if response.get(key) is not None:
                record["response_" + key] = response[key]
        if record["model"] == MODEL:
            record["responses"].append(redact_images(response))
        else:
            record["vector_dimensions"] = [
                len(row["embedding"]) for row in response.get("data", [])
            ]

    def finish(record, start):
        record["elapsed_seconds"] = time.perf_counter() - start
        with (root / "provider-requests.jsonl").open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(record, ensure_ascii=False) + "\n")

    async def observed_stream(endpoint, headers, body):
        record, start = begin(endpoint, body)
        try:
            async for response in original_stream(endpoint, headers, body):
                observe(record, response, start)
                yield response
        except BaseException as exc:
            record["error"] = f"{type(exc).__name__}: {exc}"
            raise
        finally:
            finish(record, start)

    async def observed_post(endpoint, headers, body):
        record, start = begin(endpoint, body)
        try:
            response = await original_post(endpoint, headers, body)
            observe(record, response, start)
            return response
        except BaseException as exc:
            record["error"] = f"{type(exc).__name__}: {exc}"
            raise
        finally:
            finish(record, start)

    async def qwen_stream(model, messages, **kwargs):
        if model.pin != PIN:
            async for chunk in native_stream(model, messages, **kwargs):
                yield chunk
            return
        body = wire_body(model, messages, stream=True, **kwargs)
        async for chunk in observed_stream(url, client._bearer(keys["alibaba"]), body):
            yield client._as_obj(chunk)

    async def qwen_complete(model, messages, **kwargs):
        if model.pin != PIN:
            return await native_complete(model, messages, **kwargs)
        body = wire_body(model, messages, stream=False, **kwargs)
        return client._as_obj(
            await observed_post(url, client._bearer(keys["alibaba"]), body)
        )

    client._stream_sse, client._post_json = observed_stream, observed_post
    elitellm.stream, elitellm.complete = qwen_stream, qwen_complete
    registry.bind_request_llm(thinking="instant")
    _installed = identity
    return spec


def check():
    from pipeline.retrieval import models

    os.environ["ODL_QWEN_CONTEXT_TOKENS"] = "65536"
    os.environ["ODL_QWEN_MAX_OUTPUT_TOKENS"] = "8192"
    endpoint = f"https://{QWEN_HOST}/compatible-mode/v1/chat/completions"
    validate_endpoint(endpoint)
    for invalid in (
        endpoint.replace(QWEN_HOST, "other.eu-central-1.maas.aliyuncs.com"),
        endpoint.replace(QWEN_HOST, "example.com"),
        endpoint.replace("https:", "http:"),
        endpoint + "?key=never",
    ):
        try:
            validate_endpoint(invalid)
        except ValueError:
            pass
        else:
            raise AssertionError("Unapproved endpoint accepted")
    spec = model_config()
    messages = [{"role": "user", "content": "test"}]
    body = wire_body(spec, messages, stream=True)
    assert body["messages"] is messages and body["tool_choice"] == "none"
    assert body["enable_thinking"] is False and body["max_tokens"] == 8192
    schemas = [{"type": "function", "function": {"name": "read_document"}}]
    assert wire_body(spec, messages, stream=False, tools=schemas)["tools"] is schemas
    registry.bind_request_llm(thinking="instant")
    assert elitellm.resolve_thinking(spec) == "instant"
    assert elitellm.resolve_thinking(spec, reasoning=False) == ""
    assert not elitellm.uses_responses(spec, tools=True)
    assert client.transport_model_slug(spec) == MODEL
    context = models.measure_request_context(messages, model=spec, tools=schemas)
    assert context.total_tokens > 0 and context.window_tokens == 65536

    async def assembled_check():
        original = elitellm.stream

        async def fake_stream(model, submitted, **kwargs):
            wire_body(model, submitted, stream=True, **kwargs)
            yield client._as_obj(
                {
                    "choices": [
                        {
                            "delta": {
                                "tool_calls": [
                                    {
                                        "index": 0,
                                        "id": "call_1",
                                        "function": {
                                            "name": "read_document",
                                            "arguments": '{"file_id":"test","start":0}',
                                        },
                                    }
                                ]
                            }
                        }
                    ]
                }
            )
            yield client._as_obj(
                {"choices": [], "usage": {"prompt_tokens": 20, "completion_tokens": 10}}
            )

        elitellm.stream = fake_stream
        try:
            result = await models.stream_agent_response(
                messages, model=spec, tools=schemas
            )
            assert result.tool_calls[0].name == "read_document"
            assert result.usage.input_tokens == 20 and result.usage.output_tokens == 10
        finally:
            elitellm.stream = original

    asyncio.run(assembled_check())
    assert redact_images("data:image/png;base64,YWJj") == {
        "image_mime": "image/png",
        "bytes": 3,
        "sha256": hashlib.sha256(b"abc").hexdigest(),
    }
    for kwargs in (
        {"reasoning": True},
        {"max_tokens": 8193},
        {"tool_choice": "required"},
    ):
        try:
            wire_body(spec, messages, stream=True, **kwargs)
        except ValueError:
            pass
        else:
            raise AssertionError("Invalid experiment settings accepted")
    print(
        "Qwen pin, production context/thinking/stream assembly, tool disabling and image redaction checks passed"
    )


if __name__ == "__main__":
    check()
