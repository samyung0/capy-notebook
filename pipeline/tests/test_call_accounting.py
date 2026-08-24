from __future__ import annotations

from pipeline.registry import AUTH_PLATFORM_OR_USER, ModelConfig
from pipeline.retrieval import accounting
from pipeline.retrieval.usage_extract import NormalizedUsage


def _spec() -> ModelConfig:
    return ModelConfig(
        model_key="deepseek-flash",
        version=1,
        display_name="Flash",
        provider_slug="deepseek",
        base_url="https://api.deepseek.com",
        provider_model_id="deepseek-v4-flash",
        auth_mode=AUTH_PLATFORM_OR_USER,
        context_window_tokens=100_000,
    )


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
    assert sent[0]["cachedReadTokens"] == 3
    assert state is not None
    assert state.credits_exhausted
    assert state.terminal_call_allowed


async def test_settlement_is_a_noop_outside_chat():
    state = await accounting.settle(
        call_id="pc_1",
        kind=accounting.KIND_LLM,
        purpose=accounting.PURPOSE_AGENT,
        spec=_spec(),
        usage=NormalizedUsage(input_tokens=1),
    )
    assert state is None
