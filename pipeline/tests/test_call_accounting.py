from __future__ import annotations

from pipeline.registry import ModelConfig
from pipeline.retrieval import accounting, models
from pipeline.retrieval.usage_extract import NormalizedUsage


def _spec(**overrides) -> ModelConfig:
    values = {
        "version": 1,
        "provider_name": "DeepSeek",
        "model_name": "Flash",
        "provider_slug": "deepseek",
        "model_slug": "deepseek-v4-flash",
        "platform_enabled": True,
        "byok_enabled": True,
        "thinking_levels": ("instant", "low", "high"),
        "default_thinking": "instant",
        "context_window_tokens": 100_000,
    }
    values.update(overrides)
    return ModelConfig(**values)


async def test_settlement_retry_reuses_call_id_and_returns_exhaustion(monkeypatch):
    monkeypatch.setattr(accounting.cfg, "gateway_url", "http://gateway")
    monkeypatch.setattr(accounting.cfg, "pipeline_secret", "secret")
    sent = []

    class Response:
        status_code = 200
        text = ""

        @staticmethod
        def json():
            return {
                "creditsExhausted": True,
                "terminalCallAllowed": True,
                "duplicate": False,
            }

    def post(_url, **kwargs):
        sent.append(kwargs["json"])
        if len(sent) == 1:
            raise accounting.requests.Timeout("lost response")
        return Response()

    async def no_sleep(*_args):
        return None

    monkeypatch.setattr(accounting.requests, "post", post)
    monkeypatch.setattr(accounting.asyncio, "sleep", no_sleep)
    token = accounting.bind("cr_1")
    try:
        state = await accounting.settle(
            call_id="pc_1",
            kind=accounting.KIND_LLM,
            purpose=accounting.PURPOSE_AGENT,
            thinking="high",
            spec=_spec(),
            usage=NormalizedUsage(
                input_tokens=10,
                output_tokens=4,
                cached_read_tokens=3,
            ),
        )
    finally:
        accounting.reset(token)

    assert len(sent) == 2
    assert sent[0] == sent[1]
    assert sent[0]["callId"] == "pc_1"
    assert sent[0]["thinking"] == "high"
    assert sent[0]["cachedReadTokens"] == 3
    assert state is not None
    assert state.credits_exhausted
    assert state.terminal_call_allowed


async def test_settlement_is_a_noop_outside_chat():
    state = await accounting.settle(
        call_id="pc_1",
        kind=accounting.KIND_LLM,
        purpose=accounting.PURPOSE_AGENT,
        thinking="instant",
        spec=_spec(),
        usage=NormalizedUsage(input_tokens=1),
    )
    assert state is None


async def test_open_and_abandon_are_noop_when_unbound():
    await accounting.open_call("pc_1", kind=accounting.KIND_LLM, purpose="agent")
    await accounting.abandon_call("pc_1")


def test_measure_context_separates_system_tools_and_conversation():
    measured = accounting.measure_context(
        [
            {"role": "system", "content": "Follow the workspace rules."},
            {"role": "user", "content": "Summarize my notes."},
            {
                "role": "assistant",
                "content": "Earlier compacted conversation summary",
                "_kind": "summary",
            },
        ],
        tools=[
            {
                "type": "function",
                "function": {"name": "search_notes", "parameters": {}},
            }
        ],
        window_tokens=100_000,
    )

    assert measured.system_tokens > 0
    assert measured.tool_tokens > 0
    assert measured.conversation_tokens > 0
    assert measured.total_tokens == (
        measured.system_tokens + measured.tool_tokens + measured.conversation_tokens
    )
    assert measured.window_tokens == 100_000
    assert measured.counting_method == accounting.CONTEXT_COUNTING_METHOD
    assert measured.counting_version == accounting.CONTEXT_COUNTING_VERSION


def test_provider_shaped_measurement_keeps_reasoning_and_full_tool_payloads():
    spec = _spec()
    short = models.measure_request_context(
        [
            {"role": "system", "content": "system"},
            {"role": "user", "content": "question"},
            {
                "role": "assistant",
                "content": "",
                "reasoning_content": "reasoning " * 100,
                "tool_calls": [
                    {
                        "id": "call_1",
                        "type": "function",
                        "function": {
                            "name": "search_workspace",
                            "arguments": "x" * 100,
                        },
                    }
                ],
            },
            {"role": "tool", "tool_call_id": "call_1", "content": "result"},
        ],
        model=spec,
        tools=[
            {
                "type": "function",
                "function": {"name": "search_workspace", "parameters": {}},
            }
        ],
    )
    long = models.measure_request_context(
        [
            {"role": "system", "content": "system"},
            {"role": "user", "content": "question"},
            {
                "role": "assistant",
                "content": "",
                "reasoning_content": "reasoning " * 100,
                "tool_calls": [
                    {
                        "id": "call_1",
                        "type": "function",
                        "function": {
                            "name": "search_workspace",
                            "arguments": "x" * 10_000,
                        },
                    }
                ],
            },
            {"role": "tool", "tool_call_id": "call_1", "content": "result"},
        ],
        model=spec,
        tools=[
            {
                "type": "function",
                "function": {"name": "search_workspace", "parameters": {}},
            }
        ],
    )

    assert long.conversation_tokens > short.conversation_tokens + 3000
    assert long.system_tokens == short.system_tokens
    assert long.tool_tokens == short.tool_tokens


def test_openai_responses_and_anthropic_thinking_blocks_are_counted():
    tools = [
        {
            "type": "function",
            "function": {"name": "search_workspace", "parameters": {}},
        }
    ]
    openai = _spec(
        provider_slug="openai",
        model_slug="gpt-5",
        default_thinking="low",
    )
    openai_messages = [
        {"role": "system", "content": "system"},
        {"role": "user", "content": "question"},
        {
            "role": "assistant",
            "content": "",
            "output_items": [
                {
                    "type": "reasoning",
                    "id": "rs_1",
                    "encrypted_content": "encrypted " * 1000,
                }
            ],
        },
    ]
    anthropic = _spec(provider_slug="anthropic", model_slug="claude-sonnet")
    anthropic_messages = [
        {"role": "system", "content": "system"},
        {"role": "user", "content": "question"},
        {
            "role": "assistant",
            "content": "",
            "thinking_blocks": [{"type": "thinking", "thinking": "private " * 1000}],
            "tool_calls": [
                {
                    "id": "call_1",
                    "type": "function",
                    "function": {"name": "search_workspace", "arguments": "{}"},
                }
            ],
        },
    ]

    openai_count = models.measure_request_context(
        openai_messages, model=openai, tools=tools
    )
    anthropic_count = models.measure_request_context(
        anthropic_messages, model=anthropic, tools=tools
    )

    assert openai_count.conversation_tokens > 3000
    assert anthropic_count.conversation_tokens > 2000


async def test_open_call_forwards_numeric_context_before_provider_call(monkeypatch):
    monkeypatch.setattr(accounting.cfg, "gateway_url", "http://gateway")
    monkeypatch.setattr(accounting.cfg, "pipeline_secret", "secret")
    monkeypatch.setattr(accounting.cfg, "dsn", "postgres://unused")
    forwarded = []

    async def capture_to_thread(function, *args):
        forwarded.append((function, args))

    monkeypatch.setattr(accounting.asyncio, "to_thread", capture_to_thread)
    context = accounting.ContextComposition(
        system_tokens=11,
        tool_tokens=7,
        conversation_tokens=23,
        window_tokens=128_000,
    )
    token = accounting.bind("cr_1")
    try:
        await accounting.open_call(
            "pc_1",
            kind=accounting.KIND_LLM,
            purpose=accounting.PURPOSE_AGENT,
            thinking="high",
            context=context,
        )
    finally:
        accounting.reset(token)

    assert forwarded == [
        (
            accounting._open_call_sync,
            (
                "cr_1",
                "pc_1",
                accounting.KIND_LLM,
                accounting.PURPOSE_AGENT,
                "high",
                context,
            ),
        )
    ]


async def test_ingest_settlement_stays_per_call_and_local(monkeypatch):
    monkeypatch.setattr(accounting.cfg, "dsn", "postgres://unused")
    forwarded = []

    async def capture_to_thread(function, *args):
        forwarded.append((function, args))

    monkeypatch.setattr(accounting.asyncio, "to_thread", capture_to_thread)
    usage = NormalizedUsage(input_tokens=13, output_tokens=5)
    token = accounting.bind_ingest(
        "cr_ingest",
        {"figure_caption_call": {"creditMicrosPerUnit": 2_000_000}},
    )
    try:
        state = await accounting.settle(
            call_id="pc_ingest",
            kind=accounting.KIND_LLM,
            purpose="ingest_summary",
            thinking="instant",
            spec=_spec(),
            usage=usage,
        )
    finally:
        accounting.reset(token)

    assert state is not None
    assert state.settled_calls == 1
    assert forwarded == [
        (
            accounting._settle_ingest_call_sync,
            (
                "cr_ingest",
                "pc_ingest",
                accounting.KIND_LLM,
                "ingest_summary",
                "instant",
                _spec(),
                usage,
                {"figure_caption_call": {"creditMicrosPerUnit": 2_000_000}},
            ),
        )
    ]
