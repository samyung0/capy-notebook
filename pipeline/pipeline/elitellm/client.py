"""Hand-rolled provider HTTP. Callers pass a resolved snapshot."""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator, Mapping
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from typing import Any

import httpx

from .. import registry
from ..config import cfg
from ..registry import ModelConfig, RegistryError
from .providers import platform_api_key

ANTHROPIC_URL = "https://api.anthropic.com/v1/messages"
OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions"
OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses"
DEEPSEEK_CHAT_URL = "https://api.deepseek.com/chat/completions"
DEEPINFRA_CHAT_URL = "https://api.deepinfra.com/v1/openai/chat/completions"
DEEPINFRA_EMBED_URL = "https://api.deepinfra.com/v1/openai/embeddings"

DEEPINFRA_QWEN_EMBED_MODEL = "Qwen/Qwen3-Embedding-4B"
ZAI_GLM_FLASH_MODEL = "glm-5.3-flash"
DEEPINFRA_GLM_FLASH_MODEL = "zai-org/GLM-5.3-Flash"

CONTINUITY_KEYS = (
    "thinking_blocks",
    "reasoning_content",
    "encrypted_content",
    "reasoning",
    "provider_specific_fields",
)

_THINKING_TO_OPENAI = {
    "instant": "none",
    "low": "low",
    "mid": "medium",
    "high": "high",
    "max": "xhigh",
}

_ANTHROPIC_BUDGET = {
    "low": 4096,
    "mid": 8192,
    "high": 16384,
    "max": 32000,
}


def _is_routed_zai_glm(spec: ModelConfig) -> bool:
    return spec.provider_slug == "zai" and spec.model_slug == ZAI_GLM_FLASH_MODEL


BUSY_STATUSES = frozenset({429, 503, 529})


class ProviderError(RuntimeError):
    def __init__(
        self,
        message: str,
        *,
        status_code: int | None = None,
        retry_after: float | None = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        # Seconds the provider asked us to wait (``Retry-After``), when it did.
        self.retry_after = retry_after

    @property
    def busy(self) -> bool:
        """A capacity answer: rate limited or overloaded, never a bad request."""
        return self.status_code in BUSY_STATUSES


class ProviderBusy(ProviderError):
    """The call's busy budget is spent, or the model's own gate never opened.

    ``retry_after`` is the hint handed to clients and is always set;
    ``provider_retry_after`` is the provider's own Retry-After, None when it
    sent none or when the gate refused, and is what ingest backs off on.
    """

    def __init__(
        self,
        message: str,
        *,
        status_code: int | None = None,
        retry_after: float | None = None,
        provider_retry_after: float | None = None,
    ) -> None:
        super().__init__(message, status_code=status_code, retry_after=retry_after)
        self.provider_retry_after = provider_retry_after

    @property
    def busy(self) -> bool:
        return True


def _retry_after(headers: Mapping[str, str]) -> float | None:
    raw = (headers.get("retry-after") or "").strip()
    if not raw:
        return None
    if raw.isdigit():
        return float(raw)
    try:
        when = parsedate_to_datetime(raw)
    except (TypeError, ValueError, IndexError):
        return None
    if when.tzinfo is None:
        when = when.replace(tzinfo=timezone.utc)
    return max(0.0, (when - datetime.now(timezone.utc)).total_seconds())


def _error_from_response(
    status_code: int, text: str, headers: Mapping[str, str]
) -> ProviderError:
    return ProviderError(
        text or f"provider HTTP {status_code}",
        status_code=status_code,
        retry_after=_retry_after(headers),
    )


def _has_payload(value: Any) -> bool:
    return value not in (None, "", [], {})


def observed_continuity(obj: Any) -> list[str]:
    present: set[str] = set()

    def walk(node: Any) -> None:
        if isinstance(node, dict):
            for key, value in node.items():
                if key in CONTINUITY_KEYS and _has_payload(value):
                    present.add(key)
                walk(value)
            return
        if isinstance(node, list):
            for item in node:
                walk(item)

    walk(obj)
    return [key for key in CONTINUITY_KEYS if key in present]


def _request_thinking() -> str:
    return registry.current_request_llm().thinking


def resolve_api_key(spec: ModelConfig) -> str:
    return registry.provider_api_key_for(spec)


def _uses_responses(spec: ModelConfig, thinking: str, tools: bool) -> bool:
    return spec.provider_slug == "openai" and tools and thinking not in ("", "instant")


def uses_responses(
    spec: ModelConfig, *, tools: bool = False, reasoning: bool | None = None
) -> bool:
    return _uses_responses(spec, _thinking_for_call(spec, reasoning), tools)


def resolve_thinking(spec: ModelConfig, reasoning: bool | None = None) -> str:
    return _thinking_for_call(spec, reasoning)


def openai_reasoning_effort(thinking: str) -> str:
    return _THINKING_TO_OPENAI.get(thinking, "none")


def anthropic_thinking_body(thinking: str) -> dict[str, Any]:
    if thinking in ("", "instant"):
        return {"type": "disabled"}
    if thinking == "max":
        return {"type": "adaptive"}
    return {"type": "enabled", "budget_tokens": _ANTHROPIC_BUDGET.get(thinking, 8192)}


def _anthropic_max_tokens(max_tokens: int | None, thinking: str) -> int:
    tokens = max_tokens or 8192
    budget = anthropic_thinking_body(thinking).get("budget_tokens")
    return budget + 4096 if isinstance(budget, int) and tokens <= budget else tokens


def output_budget(
    spec: ModelConfig,
    *,
    max_tokens: int | None = None,
    reasoning: bool | None = None,
) -> int:
    """Reserve the outbound cap, retaining 8192 for unspecified provider caps."""
    if spec.provider_slug == "anthropic":
        return _anthropic_max_tokens(max_tokens, _thinking_for_call(spec, reasoning))
    return max_tokens if max_tokens is not None else 8192


def deepseek_thinking_body(thinking: str) -> dict[str, Any]:
    if thinking in ("", "instant"):
        return {"thinking": {"type": "disabled"}}
    effort = "high" if thinking in ("high", "max") else thinking
    if effort == "mid":
        effort = "medium"
    return {"thinking": {"type": "enabled"}, "reasoning_effort": effort}


def zai_thinking_body(thinking: str) -> dict[str, Any]:
    if thinking not in ("low", "high", "max"):
        raise RegistryError(
            "Z.ai GLM-5.3-Flash supports only low, high, or max reasoning"
        )
    return {"reasoning_effort": thinking}


def transport_provider_slug(spec: ModelConfig) -> str:
    if _is_routed_zai_glm(spec):
        return "deepinfra"
    return spec.provider_slug


def transport_model_slug(spec: ModelConfig) -> str:
    if _is_routed_zai_glm(spec):
        return DEEPINFRA_GLM_FLASH_MODEL
    return spec.model_slug


def anthropic_endpoint(spec: ModelConfig) -> tuple[str, dict[str, str]]:
    return (
        ANTHROPIC_URL,
        {
            "x-api-key": resolve_api_key(spec),
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
    )


def _split_system(messages: list[dict[str, Any]]) -> tuple[str, list[dict[str, Any]]]:
    system_parts: list[str] = []
    out: list[dict[str, Any]] = []
    for message in messages:
        role = message.get("role")
        if role == "system":
            system_parts.append(str(message.get("content") or ""))
            continue
        out.append(message)
    return "\n\n".join(part for part in system_parts if part), out


def anthropic_request(
    spec: ModelConfig,
    messages: list[dict[str, Any]],
    *,
    temperature: float | None,
    tools: list[dict[str, Any]] | None,
    max_tokens: int | None,
    thinking: str,
) -> dict[str, Any]:
    system, rest = _split_system(messages)
    thinking_body = anthropic_thinking_body(thinking)
    body: dict[str, Any] = {
        "model": spec.model_slug,
        "messages": _anthropic_messages(rest),
        "max_tokens": _anthropic_max_tokens(max_tokens, thinking),
        "thinking": thinking_body,
    }
    if system:
        body["system"] = system
    if temperature is not None and thinking_body.get("type") == "disabled":
        body["temperature"] = temperature
    if tools:
        body["tools"] = [
            {
                "name": (schema.get("function") or schema).get("name"),
                "description": (schema.get("function") or schema).get("description")
                or "",
                "input_schema": (schema.get("function") or schema).get("parameters")
                or {"type": "object", "properties": {}},
            }
            for schema in tools
        ]
    return body


def _anthropic_messages(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for message in messages:
        role = message.get("role")
        if role == "tool":
            out.append(
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "tool_result",
                            "tool_use_id": message.get("tool_call_id"),
                            "content": message.get("content") or "",
                        }
                    ],
                }
            )
            continue
        if role == "assistant" and message.get("tool_calls"):
            content: list[dict[str, Any]] = []
            if message.get("content"):
                content.append({"type": "text", "text": message["content"]})
            content.extend(message.get("thinking_blocks") or [])
            for call in message["tool_calls"]:
                fn = call.get("function") or {}
                content.append(
                    {
                        "type": "tool_use",
                        "id": call.get("id"),
                        "name": fn.get("name"),
                        "input": _json_or_raw(fn.get("arguments")),
                    }
                )
            out.append({"role": "assistant", "content": content})
            continue
        out.append({"role": role, "content": message.get("content") or ""})
    return out


def _json_or_raw(value: Any) -> Any:
    if isinstance(value, (dict, list)):
        return value
    if isinstance(value, str) and value:
        try:
            return json.loads(value)
        except ValueError:
            return {}
    return {}


def openai_chat_request(
    spec: ModelConfig,
    messages: list[dict[str, Any]],
    *,
    temperature: float | None,
    tools: list[dict[str, Any]] | None,
    response_format: dict[str, Any] | None,
    max_tokens: int | None,
    thinking: str,
    stream: bool,
    tool_choice: Any | None,
) -> dict[str, Any]:
    body: dict[str, Any] = {
        "model": spec.model_slug,
        "messages": messages,
        "reasoning_effort": openai_reasoning_effort(thinking),
    }
    if temperature is not None:
        body["temperature"] = temperature
    if tools:
        body["tools"] = tools
        body["tool_choice"] = tool_choice if tool_choice is not None else "auto"
    if response_format:
        body["response_format"] = response_format
    if max_tokens is not None:
        body["max_tokens"] = max_tokens
    if stream:
        body["stream"] = True
        body["stream_options"] = {"include_usage": True}
    return body


def openai_responses_request(
    spec: ModelConfig,
    input_items: list[dict[str, Any]],
    *,
    tools: list[dict[str, Any]] | None,
    max_tokens: int | None,
    thinking: str,
    stream: bool,
    response_format: dict[str, Any] | None,
    tool_choice: Any | None,
) -> dict[str, Any]:
    body: dict[str, Any] = {
        "model": spec.model_slug,
        "input": input_items,
        "store": False,
        "include": ["reasoning.encrypted_content"],
        "reasoning": {"effort": openai_reasoning_effort(thinking)},
    }
    if tools:
        body["tools"] = _flat_tools(tools)
        body["tool_choice"] = tool_choice if tool_choice is not None else "auto"
    if max_tokens is not None:
        body["max_output_tokens"] = max_tokens
    if response_format:
        body["text"] = {"format": response_format}
    if stream:
        body["stream"] = True
    return body


def deepseek_request(
    spec: ModelConfig,
    messages: list[dict[str, Any]],
    *,
    temperature: float | None,
    tools: list[dict[str, Any]] | None,
    response_format: dict[str, Any] | None,
    max_tokens: int | None,
    thinking: str,
    stream: bool,
    tool_choice: Any | None,
) -> dict[str, Any]:
    body: dict[str, Any] = {
        "model": spec.model_slug,
        "messages": messages,
    }
    body.update(deepseek_thinking_body(thinking))
    if temperature is not None:
        body["temperature"] = temperature
    if tools:
        body["tools"] = tools
        body["tool_choice"] = tool_choice if tool_choice is not None else "auto"
    if response_format:
        body["response_format"] = response_format
    if max_tokens is not None:
        body["max_tokens"] = max_tokens
    if stream:
        body["stream"] = True
        body["stream_options"] = {"include_usage": True}
    return body


def zai_request(
    spec: ModelConfig,
    messages: list[dict[str, Any]],
    *,
    temperature: float | None,
    tools: list[dict[str, Any]] | None,
    response_format: dict[str, Any] | None,
    max_tokens: int | None,
    thinking: str,
    stream: bool,
    tool_choice: Any | None,
) -> dict[str, Any]:
    body: dict[str, Any] = {
        "model": transport_model_slug(spec),
        "messages": messages,
    }
    body.update(zai_thinking_body(thinking))
    if temperature is not None:
        body["temperature"] = temperature
    if tools:
        body["tools"] = tools
        body["tool_choice"] = tool_choice if tool_choice is not None else "auto"
    if response_format:
        body["response_format"] = response_format
    if max_tokens is not None:
        body["max_tokens"] = max_tokens
    if stream:
        body["stream"] = True
        body["stream_options"] = {"include_usage": True}
    return body


def _flat_tools(schemas: list[dict[str, Any]] | None) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for schema in schemas or []:
        fn = schema.get("function") or schema
        if schema.get("type") == "function" and "name" in schema:
            out.append(schema)
            continue
        out.append(
            {
                "type": "function",
                "name": fn.get("name"),
                "description": fn.get("description") or "",
                "parameters": fn.get("parameters")
                or {"type": "object", "properties": {}},
            }
        )
    return out


def context_components(
    spec: ModelConfig,
    messages: list[dict[str, Any]],
    *,
    tools: list[dict[str, Any]] | None = None,
    response_format: dict[str, Any] | None = None,
    reasoning: bool | None = None,
    input_items: list[dict[str, Any]] | None = None,
) -> tuple[Any, Any, Any]:
    """Return provider-shaped content split for context accounting."""
    thinking = _thinking_for_call(spec, reasoning)
    if _uses_responses(spec, thinking, bool(tools)):
        items = list(input_items or [])
        system = [item for item in items if item.get("role") == "system"]
        conversation = [item for item in items if item.get("role") != "system"]
        schemas: list[Any] = list(_flat_tools(tools))
        if response_format:
            schemas.append({"text": {"format": response_format}})
        return system, conversation, schemas
    if spec.provider_slug == "anthropic":
        body = anthropic_request(
            spec,
            messages,
            temperature=None,
            tools=tools,
            max_tokens=None,
            thinking=thinking,
        )
        schemas = list(body.get("tools") or [])
        return body.get("system") or "", body.get("messages") or [], schemas

    system = [message for message in messages if message.get("role") == "system"]
    conversation = [message for message in messages if message.get("role") != "system"]
    schemas = list(tools or [])
    if response_format:
        schemas.append(response_format)
    return system, conversation, schemas


def _interactive() -> bool:
    from ..retrieval import accounting

    state = accounting.current()
    return state is None or state.settlement_mode != "ingest"


def _call_timeout() -> float:
    """Whole-call bound for a non-streaming request; idle bound for a stream."""
    if _interactive():
        return cfg.interactive_provider_timeout_s
    return cfg.ingest_provider_timeout_s


def _stream_backstop() -> float:
    if _interactive():
        return cfg.interactive_stream_max_s
    return cfg.ingest_provider_timeout_s


# One client per event loop: keep-alive connections are reused across calls
# instead of paying a TLS handshake per request. The per-model gate bounds
# concurrency, so the pool itself is unbounded.
_clients: dict[int, tuple[asyncio.AbstractEventLoop, httpx.AsyncClient]] = {}


def _client() -> httpx.AsyncClient:
    loop = asyncio.get_running_loop()
    entry = _clients.get(id(loop))
    if entry is not None and entry[0] is loop and not loop.is_closed():
        return entry[1]
    for key, (old, _client_for_old) in list(_clients.items()):
        if old.is_closed():
            _clients.pop(key, None)
    client = httpx.AsyncClient(
        limits=httpx.Limits(max_connections=None, max_keepalive_connections=32)
    )
    _clients[id(loop)] = (loop, client)
    return client


def jsonable(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, dict):
        return {str(key): jsonable(child) for key, child in value.items()}
    if isinstance(value, list):
        return [jsonable(item) for item in value]
    dump = getattr(value, "model_dump", None)
    if callable(dump):
        return jsonable(dump())
    if hasattr(value, "__dict__"):
        return jsonable(vars(value))
    return value


async def _post_json(
    url: str,
    headers: dict[str, str],
    body: dict[str, Any],
) -> dict[str, Any]:
    timeout = _call_timeout()
    async with asyncio.timeout(timeout):
        response = await _client().post(
            url, headers=headers, json=jsonable(body), timeout=httpx.Timeout(timeout)
        )
    if response.status_code >= 400:
        raise _error_from_response(
            response.status_code, response.text, response.headers
        )
    return response.json()


async def _stream_sse(
    url: str,
    headers: dict[str, str],
    body: dict[str, Any],
) -> AsyncIterator[dict[str, Any]]:
    """Yield ``data:`` payloads. Each provider read gets the idle bound.

    Only the awaits on the provider are timed, so a consumer may take as long
    as it likes between chunks without that counting as provider silence.
    Comment-only keep-alives (``: keep-alive``) do not count as activity, so a
    provider that parks the request in a queue times out like a silent one.
    The backstop bounds the whole stream and is what the receipt window is
    derived from. httpx's own read timeout is off so this timer decides.
    """
    idle = _call_timeout()
    loop = asyncio.get_running_loop()
    backstop_at = loop.time() + _stream_backstop()
    # Provider-wait time since the last data payload. Keep-alive comments and
    # blank lines add to it like no bytes at all; time the consumer spends
    # between chunks does not, because only the reads below are measured.
    silence = 0.0

    async def bounded(awaitable: Any) -> Any:
        nonlocal silence
        remaining = min(idle - silence, backstop_at - loop.time())
        if remaining <= 0:
            raise TimeoutError("provider stream went silent or exceeded its backstop")
        started = loop.time()
        try:
            async with asyncio.timeout(remaining):
                return await awaitable
        finally:
            silence += loop.time() - started

    stream = _client().stream(
        "POST",
        url,
        headers=headers,
        json=jsonable(body),
        timeout=httpx.Timeout(idle, read=None),
    )
    response = await bounded(stream.__aenter__())
    try:
        if response.status_code >= 400:
            text = await bounded(response.aread())
            raise _error_from_response(
                response.status_code, text.decode(), response.headers
            )
        lines = response.aiter_lines()
        while True:
            try:
                line = await bounded(anext(lines))
            except StopAsyncIteration:
                return
            if not line.startswith("data:"):
                continue
            payload = line[5:].strip()
            if payload == "[DONE]":
                return
            if not payload:
                continue
            silence = 0.0
            yield json.loads(payload)
    finally:
        await stream.__aexit__(None, None, None)


def _bearer(key: str) -> dict[str, str]:
    return {
        "authorization": f"Bearer {key}",
        "content-type": "application/json",
    }


async def complete(
    spec: ModelConfig,
    messages: list[dict[str, Any]],
    *,
    temperature: float | None = None,
    tools: list[dict[str, Any]] | None = None,
    response_format: dict[str, Any] | None = None,
    max_tokens: int | None = None,
    reasoning: bool | None = None,
    input_items: list[dict[str, Any]] | None = None,
    tool_choice: Any | None = None,
) -> Any:
    thinking = _thinking_for_call(spec, reasoning)
    if temperature is None:
        temperature = spec.temperature()
    if spec.provider_slug == "anthropic":
        url, headers = anthropic_endpoint(spec)
        body = anthropic_request(
            spec,
            messages,
            temperature=temperature,
            tools=tools,
            max_tokens=max_tokens,
            thinking=thinking,
        )
        raw = await _post_json(url, headers, body)
        return _anthropic_as_chat(raw)
    key = resolve_api_key(spec)
    if _uses_responses(spec, thinking, bool(tools)):
        body = openai_responses_request(
            spec,
            input_items or messages,
            tools=tools,
            max_tokens=max_tokens,
            thinking=thinking,
            stream=False,
            response_format=response_format,
            tool_choice=tool_choice,
        )
        raw = await _post_json(OPENAI_RESPONSES_URL, _bearer(key), body)
        return _as_obj(raw)
    if spec.provider_slug == "openai":
        body = openai_chat_request(
            spec,
            messages,
            temperature=temperature,
            tools=tools,
            response_format=response_format,
            max_tokens=max_tokens,
            thinking=thinking,
            stream=False,
            tool_choice=tool_choice,
        )
        return _as_obj(await _post_json(OPENAI_CHAT_URL, _bearer(key), body))
    if spec.provider_slug == "deepseek":
        body = deepseek_request(
            spec,
            messages,
            temperature=temperature,
            tools=tools,
            response_format=response_format,
            max_tokens=max_tokens,
            thinking=thinking,
            stream=False,
            tool_choice=tool_choice,
        )
        return _as_obj(await _post_json(DEEPSEEK_CHAT_URL, _bearer(key), body))
    if _is_routed_zai_glm(spec):
        body = zai_request(
            spec,
            messages,
            temperature=temperature,
            tools=tools,
            response_format=response_format,
            max_tokens=max_tokens,
            thinking=thinking,
            stream=False,
            tool_choice=tool_choice,
        )
        return _as_obj(await _post_json(DEEPINFRA_CHAT_URL, _bearer(key), body))
    raise RegistryError(f"elitellm has no chat route for {spec.provider_slug}")


async def stream(
    spec: ModelConfig,
    messages: list[dict[str, Any]],
    *,
    temperature: float | None = None,
    tools: list[dict[str, Any]] | None = None,
    max_tokens: int | None = None,
    reasoning: bool | None = None,
    input_items: list[dict[str, Any]] | None = None,
    tool_choice: Any | None = None,
    response_format: dict[str, Any] | None = None,
) -> AsyncIterator[Any]:
    thinking = _thinking_for_call(spec, reasoning)
    if temperature is None:
        temperature = spec.temperature()
    if spec.provider_slug == "anthropic":
        url, headers = anthropic_endpoint(spec)
        body = anthropic_request(
            spec,
            messages,
            temperature=temperature,
            tools=tools,
            max_tokens=max_tokens,
            thinking=thinking,
        )
        body["stream"] = True
        converter = _AnthropicStreamConverter()
        async for event in _stream_sse(url, headers, body):
            chunk = converter.push(event)
            if chunk is not None:
                yield chunk
        return
    key = resolve_api_key(spec)
    if _uses_responses(spec, thinking, bool(tools)):
        body = openai_responses_request(
            spec,
            input_items or messages,
            tools=tools,
            max_tokens=max_tokens,
            thinking=thinking,
            stream=True,
            tool_choice=tool_choice,
            response_format=response_format,
        )
        async for event in _stream_sse(OPENAI_RESPONSES_URL, _bearer(key), body):
            yield _as_obj(event)
        return
    if spec.provider_slug == "openai":
        body = openai_chat_request(
            spec,
            messages,
            temperature=temperature,
            tools=tools,
            response_format=response_format,
            max_tokens=max_tokens,
            thinking=thinking,
            stream=True,
            tool_choice=tool_choice,
        )
        async for event in _stream_sse(OPENAI_CHAT_URL, _bearer(key), body):
            yield _as_obj(event)
        return
    if spec.provider_slug == "deepseek":
        body = deepseek_request(
            spec,
            messages,
            temperature=temperature,
            tools=tools,
            response_format=response_format,
            max_tokens=max_tokens,
            thinking=thinking,
            stream=True,
            tool_choice=tool_choice,
        )
        async for event in _stream_sse(DEEPSEEK_CHAT_URL, _bearer(key), body):
            yield _as_obj(event)
        return
    if _is_routed_zai_glm(spec):
        body = zai_request(
            spec,
            messages,
            temperature=temperature,
            tools=tools,
            response_format=response_format,
            max_tokens=max_tokens,
            thinking=thinking,
            stream=True,
            tool_choice=tool_choice,
        )
        async for event in _stream_sse(DEEPINFRA_CHAT_URL, _bearer(key), body):
            yield _as_obj(event)
        return
    raise RegistryError(f"elitellm has no stream route for {spec.provider_slug}")


async def embed_batch(
    spec: ModelConfig,
    texts: list[str],
    *,
    dimensions: int,
) -> Any:
    if (
        spec.provider_slug != "deepinfra"
        or spec.model_slug != DEEPINFRA_QWEN_EMBED_MODEL
    ):
        raise RegistryError(f"elitellm has no embedding route for {spec.provider_slug}")
    key = platform_api_key("deepinfra")
    if not key:
        raise RegistryError("missing DEEPINFRA_API_KEY")
    raw = await _post_json(
        DEEPINFRA_EMBED_URL,
        _bearer(key),
        {
            "model": spec.model_slug,
            "input": texts,
            "dimensions": dimensions,
            "encoding_format": "float",
        },
    )
    return _as_obj(raw)


def _thinking_for_call(spec: ModelConfig, reasoning: bool | None) -> str:
    if reasoning is False:
        if _is_routed_zai_glm(spec):
            return "low"
        return ""
    return spec.resolve_thinking(_request_thinking())


def _anthropic_as_chat(raw: dict[str, Any]) -> Any:
    text_parts: list[str] = []
    tool_calls: list[dict[str, Any]] = []
    thinking_blocks: list[Any] = []
    for block in raw.get("content") or []:
        kind = block.get("type")
        if kind == "text":
            text_parts.append(str(block.get("text") or ""))
        elif kind == "tool_use":
            tool_calls.append(
                {
                    "id": block.get("id"),
                    "type": "function",
                    "function": {
                        "name": block.get("name"),
                        "arguments": json.dumps(block.get("input") or {}),
                    },
                }
            )
        elif kind in ("thinking", "redacted_thinking"):
            thinking_blocks.append(block)
    usage = raw.get("usage") or {}
    message = {
        "role": "assistant",
        "content": "".join(text_parts),
        "tool_calls": tool_calls or None,
    }
    if thinking_blocks:
        message["thinking_blocks"] = thinking_blocks
    return _as_obj(
        {
            "choices": [{"message": message}],
            "usage": {
                "prompt_tokens": usage.get("input_tokens") or 0,
                "completion_tokens": usage.get("output_tokens") or 0,
                "cache_read_input_tokens": usage.get("cache_read_input_tokens") or 0,
                "cache_creation_input_tokens": usage.get("cache_creation_input_tokens")
                or 0,
            },
        }
    )


class _AnthropicStreamConverter:
    """Convert one Anthropic Messages stream into chat-completion deltas."""

    def __init__(self) -> None:
        self._blocks: dict[int, dict[str, Any]] = {}
        self._usage: dict[str, int] = {
            "prompt_tokens": 0,
            "completion_tokens": 0,
            "cache_read_input_tokens": 0,
            "cache_creation_input_tokens": 0,
        }

    def push(self, event: dict[str, Any]) -> Any | None:
        kind = str(event.get("type") or "")
        if kind == "error":
            error = event.get("error") or {}
            message = str(
                error.get("message") or error.get("type") or "Anthropic stream error"
            )
            raise ProviderError(message)
        if kind == "message_start":
            self._update_usage((event.get("message") or {}).get("usage") or {})
            return self._chunk(usage=True)
        if kind == "content_block_start":
            return self._start_block(event)
        if kind == "content_block_delta":
            return self._block_delta(event)
        if kind == "content_block_stop":
            return self._stop_block(event)
        if kind == "message_delta":
            self._update_usage(event.get("usage") or {})
            stop_reason = str((event.get("delta") or {}).get("stop_reason") or "")
            finish_reason = {
                "end_turn": "stop",
                "stop_sequence": "stop",
                "tool_use": "tool_calls",
                "max_tokens": "length",
            }.get(stop_reason, stop_reason or None)
            return self._chunk(finish_reason=finish_reason, usage=True)
        return None

    def _start_block(self, event: dict[str, Any]) -> Any | None:
        index = int(event.get("index") or 0)
        block = dict(event.get("content_block") or {})
        kind = str(block.get("type") or "")
        self._blocks[index] = block
        if kind == "tool_use":
            raw_input = block.get("input")
            arguments = ""
            if raw_input not in (None, {}):
                arguments = json.dumps(raw_input, separators=(",", ":"))
            return self._chunk(
                delta={
                    "tool_calls": [
                        {
                            "index": index,
                            "id": block.get("id"),
                            "type": "function",
                            "function": {
                                "name": block.get("name"),
                                "arguments": arguments,
                            },
                        }
                    ]
                }
            )
        if kind == "text" and block.get("text"):
            return self._chunk(delta={"content": str(block["text"])})
        return None

    def _block_delta(self, event: dict[str, Any]) -> Any | None:
        index = int(event.get("index") or 0)
        delta = event.get("delta") or {}
        kind = str(delta.get("type") or "")
        if kind == "text_delta":
            return self._chunk(delta={"content": str(delta.get("text") or "")})
        if kind == "input_json_delta":
            return self._chunk(
                delta={
                    "tool_calls": [
                        {
                            "index": index,
                            "function": {
                                "arguments": str(delta.get("partial_json") or "")
                            },
                        }
                    ]
                }
            )
        block = self._blocks.get(index)
        if block is None:
            return None
        if kind == "thinking_delta":
            block["thinking"] = str(block.get("thinking") or "") + str(
                delta.get("thinking") or ""
            )
        elif kind == "signature_delta":
            block["signature"] = str(block.get("signature") or "") + str(
                delta.get("signature") or ""
            )
        return None

    def _stop_block(self, event: dict[str, Any]) -> Any | None:
        index = int(event.get("index") or 0)
        block = self._blocks.pop(index, None)
        if block and block.get("type") in ("thinking", "redacted_thinking"):
            return self._chunk(delta={"thinking_blocks": [block]})
        return None

    def _update_usage(self, usage: dict[str, Any]) -> None:
        fields = {
            "input_tokens": "prompt_tokens",
            "output_tokens": "completion_tokens",
            "cache_read_input_tokens": "cache_read_input_tokens",
            "cache_creation_input_tokens": "cache_creation_input_tokens",
        }
        for source, target in fields.items():
            value = usage.get(source)
            if value is not None:
                self._usage[target] = max(0, int(value or 0))

    def _chunk(
        self,
        *,
        delta: dict[str, Any] | None = None,
        finish_reason: str | None = None,
        usage: bool = False,
    ) -> Any:
        choice: dict[str, Any] = {"delta": delta or {}}
        if finish_reason is not None:
            choice["finish_reason"] = finish_reason
        payload: dict[str, Any] = {"choices": [choice]}
        if usage:
            payload["usage"] = dict(self._usage)
        return _as_obj(payload)


def chat_response(
    message: dict[str, Any], *, finish_reason: str, usage: Any = None
) -> Any:
    """Shape one assembled stream like a non-streaming chat completion."""
    return _as_obj(
        {
            "choices": [{"message": dict(message), "finish_reason": finish_reason}],
            "usage": usage,
        }
    )


def message_from_response(resp: Any) -> Any:
    choices = getattr(resp, "choices", None)
    if choices:
        return choices[0].message
    output = getattr(resp, "output", None) or []
    text_parts: list[str] = []
    tool_calls: list[Any] = []
    extra: dict[str, Any] = {}
    for item in output:
        kind = _get(item, "type")
        if kind in ("message", "output_text"):
            content = _get(item, "content")
            if isinstance(content, str):
                text_parts.append(content)
            elif isinstance(content, list):
                for part in content:
                    text = _get(part, "text")
                    if text:
                        text_parts.append(str(text))
        elif kind == "function_call":
            tool_calls.append(item)
        for key in CONTINUITY_KEYS:
            value = _get(item, key)
            if value is not None:
                extra[key] = value
    return SimpleMessage(
        content="".join(text_parts),
        tool_calls=tool_calls or None,
        **extra,
    )


def assistant_message_from_obj(message: Any) -> dict[str, Any]:
    if isinstance(message, dict):
        out = dict(message)
    else:
        out = {}
        dump = getattr(message, "model_dump", None)
        if callable(dump):
            raw = dump()
            if isinstance(raw, dict):
                out = raw
        if not out:
            for key in ("role", "content", "tool_calls", *CONTINUITY_KEYS):
                if hasattr(message, key):
                    value = getattr(message, key)
                    if value is not None:
                        out[key] = value
    out.setdefault("role", "assistant")
    return {k: v for k, v in jsonable(out).items() if v is not None}


def _get(obj: Any, name: str, default: Any = None) -> Any:
    if obj is None:
        return default
    if isinstance(obj, dict):
        return obj.get(name, default)
    return getattr(obj, name, default)


def _as_obj(raw: Any) -> Any:
    if isinstance(raw, dict):
        return SimpleNamespace(**{key: _as_obj(value) for key, value in raw.items()})
    if isinstance(raw, list):
        return [_as_obj(item) for item in raw]
    return raw


class SimpleNamespace:
    def __init__(self, **values: Any) -> None:
        for key, value in values.items():
            setattr(self, key, value)

    def model_dump(self) -> dict[str, Any]:
        return {key: getattr(self, key) for key in vars(self)}

    def get(self, name: str, default: Any = None) -> Any:
        return getattr(self, name, default)


class SimpleMessage:
    def __init__(
        self,
        content: str = "",
        tool_calls: Any = None,
        **extra: Any,
    ) -> None:
        self.role = "assistant"
        self.content = content
        self.tool_calls = tool_calls
        for key, value in extra.items():
            setattr(self, key, value)

    def model_dump(self) -> dict[str, Any]:
        out = {"role": self.role, "content": self.content}
        if self.tool_calls is not None:
            out["tool_calls"] = self.tool_calls
        for key in CONTINUITY_KEYS:
            if hasattr(self, key):
                value = getattr(self, key)
                if value is not None:
                    out[key] = value
        return out
