"""Hand-rolled provider HTTP. Callers pass a resolved snapshot."""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
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
GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models"
OPENROUTER_EMBED_URL = "https://openrouter.ai/api/v1/embeddings"

CONTINUITY_KEYS = (
    "thinking_blocks",
    "reasoning_content",
    "encrypted_content",
    "reasoning",
    "thought_signature",
    "thought_signatures",
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


class ProviderError(RuntimeError):
    def __init__(self, message: str, *, status_code: int | None = None) -> None:
        super().__init__(message)
        self.status_code = status_code


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


def deepseek_thinking_body(thinking: str) -> dict[str, Any]:
    if thinking in ("", "instant"):
        return {"thinking": {"type": "disabled"}}
    effort = "high" if thinking in ("high", "max") else thinking
    if effort == "mid":
        effort = "medium"
    return {"thinking": {"type": "enabled"}, "reasoning_effort": effort}


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
    tokens = max_tokens or 8192
    budget = thinking_body.get("budget_tokens")
    if isinstance(budget, int) and tokens <= budget:
        tokens = budget + 4096
    body: dict[str, Any] = {
        "model": spec.model_slug,
        "messages": _anthropic_messages(rest),
        "max_tokens": tokens,
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

    if spec.provider_slug == "gemini":
        system = ""
        conversation: list[dict[str, Any]] = []
        for message in messages:
            role = message.get("role")
            if role == "system":
                system = str(message.get("content") or "")
                continue
            conversation.append(
                {
                    "role": "user" if role == "user" else "model",
                    "parts": _gemini_parts(message.get("content")),
                }
            )
        return system, conversation, []

    system = [message for message in messages if message.get("role") == "system"]
    conversation = [message for message in messages if message.get("role") != "system"]
    schemas = list(tools or [])
    if response_format:
        schemas.append(response_format)
    return system, conversation, schemas


def _timeout() -> float:
    return cfg.provider_timeout_s


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
    async with httpx.AsyncClient(timeout=_timeout()) as client:
        response = await client.post(url, headers=headers, json=jsonable(body))
    if response.status_code >= 400:
        raise ProviderError(
            response.text or f"provider HTTP {response.status_code}",
            status_code=response.status_code,
        )
    return response.json()


async def _stream_sse(
    url: str,
    headers: dict[str, str],
    body: dict[str, Any],
) -> AsyncIterator[dict[str, Any]]:
    async with (
        httpx.AsyncClient(timeout=_timeout()) as client,
        client.stream("POST", url, headers=headers, json=jsonable(body)) as response,
    ):
        if response.status_code >= 400:
            text = await response.aread()
            raise ProviderError(
                text.decode() if text else f"provider HTTP {response.status_code}",
                status_code=response.status_code,
            )
        async for line in response.aiter_lines():
            if not line.startswith("data:"):
                continue
            payload = line[5:].strip()
            if payload == "[DONE]":
                return
            if not payload:
                continue
            yield json.loads(payload)


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
    if spec.provider_slug == "gemini":
        return _as_obj(await _gemini_complete(spec, messages, thinking, max_tokens))
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
            response_format=None,
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
            response_format=None,
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
            response_format=None,
            max_tokens=max_tokens,
            thinking=thinking,
            stream=True,
            tool_choice=tool_choice,
        )
        async for event in _stream_sse(DEEPSEEK_CHAT_URL, _bearer(key), body):
            yield _as_obj(event)
        return
    raise RegistryError(f"elitellm has no stream route for {spec.provider_slug}")


async def embed_batch(
    spec: ModelConfig,
    texts: list[str],
    *,
    dimensions: int,
) -> Any:
    if spec.provider_slug != "openrouter":
        raise RegistryError(f"elitellm has no embedding route for {spec.provider_slug}")
    key = platform_api_key("openrouter")
    if not key:
        raise RegistryError("missing OPENROUTER_API_KEY")
    raw = await _post_json(
        OPENROUTER_EMBED_URL,
        _bearer(key),
        {"model": spec.model_slug, "input": texts, "dimensions": dimensions},
    )
    return _as_obj(raw)


def _thinking_for_call(spec: ModelConfig, reasoning: bool | None) -> str:
    if reasoning is False:
        requested = (
            "instant" if "instant" in spec.thinking_levels else spec.default_thinking
        )
        return spec.resolve_thinking(requested)
    return spec.resolve_thinking(_request_thinking())


def _gemini_parts(content: Any) -> list[dict[str, Any]]:
    if isinstance(content, str):
        return [{"text": content}] if content else []
    if not isinstance(content, list):
        return [{"text": str(content or "")}]
    parts: list[dict[str, Any]] = []
    for item in content:
        if not isinstance(item, dict):
            continue
        kind = item.get("type")
        if kind == "text":
            parts.append({"text": str(item.get("text") or "")})
            continue
        if kind == "image_url":
            url = str((item.get("image_url") or {}).get("url") or "")
            if url.startswith("data:"):
                header, _, payload = url.partition(",")
                mime = "image/png"
                if header.startswith("data:") and ";base64" in header:
                    mime = header[5:].split(";", 1)[0] or mime
                parts.append({"inline_data": {"mime_type": mime, "data": payload}})
            elif url:
                parts.append({"file_data": {"file_uri": url}})
    return parts or [{"text": ""}]


async def _gemini_complete(
    spec: ModelConfig,
    messages: list[dict[str, Any]],
    thinking: str,
    max_tokens: int | None,
) -> dict[str, Any]:
    key = resolve_api_key(spec)
    url = f"{GEMINI_BASE}/{spec.model_slug}:generateContent"
    contents = []
    system = ""
    for message in messages:
        role = message.get("role")
        if role == "system":
            system = str(message.get("content") or "")
            continue
        contents.append(
            {
                "role": "user" if role == "user" else "model",
                "parts": _gemini_parts(message.get("content")),
            }
        )
    body: dict[str, Any] = {"contents": contents}
    if system:
        body["systemInstruction"] = {"parts": [{"text": system}]}
    config: dict[str, Any] = {}
    if max_tokens is not None:
        config["maxOutputTokens"] = max_tokens
    if thinking and thinking != "instant":
        config["thinkingConfig"] = {
            "thinkingLevel": thinking if thinking != "mid" else "medium"
        }
    if config:
        body["generationConfig"] = config
    async with httpx.AsyncClient(timeout=_timeout()) as client:
        response = await client.post(url, params={"key": key}, json=body)
    if response.status_code >= 400:
        raise ProviderError(response.text, status_code=response.status_code)
    raw = response.json()
    text = ""
    for candidate in raw.get("candidates") or []:
        for part in (candidate.get("content") or {}).get("parts") or []:
            if part.get("text"):
                text += part["text"]
    usage = raw.get("usageMetadata") or {}
    return {
        "choices": [{"message": {"role": "assistant", "content": text}}],
        "usage": {
            "prompt_tokens": usage.get("promptTokenCount") or 0,
            "completion_tokens": usage.get("candidatesTokenCount") or 0,
        },
    }


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
