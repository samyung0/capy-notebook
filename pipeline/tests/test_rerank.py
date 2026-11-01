"""Search reranking: the first 20 fused candidates follow the rerank slot's
model, the rest keep fused order, and any failure keeps the fused order.

Calls run the real models and elitellm path against a mock Alibaba
transport. Accounting is unbound, so no ledger row is written, except in the
background-settlement test, which fakes the gateway.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging

import httpx
import pytest

from pipeline import registry
from pipeline.registry import ModelConfig
from pipeline.retrieval import accounting, models, search
from pipeline.retrieval.search import _rerank_spec as registry_rerank_spec

SPEC = ModelConfig(
    version=1,
    provider_name="Alibaba",
    model_name="Qwen3 Rerank",
    provider_slug="alibaba",
    model_slug="qwen3-rerank",
    slots=(registry.Slot.RERANK,),
)
ROWS = [{"id": f"c{i}", "indexed_text": f"Section\n\nchunk {i}"} for i in range(25)]
REVERSED = [f"c{i}" for i in range(19, -1, -1)] + [f"c{i}" for i in range(20, 25)]


def _scores(request: httpx.Request) -> httpx.Response:
    """Scores that reverse the first 20 rows."""
    results = [{"index": i, "relevance_score": i} for i in range(20)]
    return httpx.Response(
        200, json={"results": results, "usage": {"total_tokens": 300}}
    )


@pytest.fixture
async def provider(monkeypatch):
    """Install a rerank default and route Alibaba to ``serve(handler)``."""
    clients: list[httpx.AsyncClient] = []
    seen: list[dict] = []

    def serve(handler):
        async def recording(request: httpx.Request):
            seen.append(json.loads(request.content))
            response = handler(request)
            return await response if asyncio.iscoroutine(response) else response

        client = httpx.AsyncClient(transport=httpx.MockTransport(recording))
        clients.append(client)
        monkeypatch.setattr("pipeline.elitellm.client._client", lambda: client)
        return seen

    monkeypatch.setenv("ALIBABA_MODELSTUDIO_KEY", "sk-alibaba")
    monkeypatch.setenv(
        "ALIBABA_MODELSTUDIO_URL",
        "https://ws.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
    )
    monkeypatch.setattr(search, "_rerank_spec", lambda: SPEC)
    yield serve
    for client in clients:
        await client.aclose()


async def test_first_twenty_are_reranked_and_the_tail_keeps_fused_order(provider):
    seen = provider(_scores)

    ranked, reranked = await search.rerank("what is chunk 7", ROWS)

    assert seen == [
        {
            "model": "qwen3-rerank",
            "query": "what is chunk 7",
            "documents": [row["indexed_text"] for row in ROWS[:20]],
            "top_n": 20,
        }
    ]
    assert reranked and [row["id"] for row in ranked] == REVERSED


async def test_a_provider_error_keeps_fused_order(provider, caplog):
    provider(lambda request: httpx.Response(500, text="down"))

    with caplog.at_level(logging.WARNING, logger="capy.search"):
        assert await search.rerank("q", ROWS) == (ROWS, False)
    assert "keeping fused order" in caplog.text


async def test_reranks_answering_past_the_bound_keep_fused_order_and_settle(
    provider, monkeypatch, caplog
):
    """Parallel searches whose reranks answer after the bound: each search
    keeps fused order at the bound, and every opened call still posts its
    receipt with the provider's usage instead of being cut off unsettled."""
    answer = asyncio.Event()

    async def late(request):
        await answer.wait()
        return _scores(request)

    provider(late)
    monkeypatch.setattr(models, "RERANK_TIMEOUT_S", 0.05)
    monkeypatch.setattr(accounting.cfg, "gateway_url", "http://gateway")
    monkeypatch.setattr(accounting.cfg, "pipeline_secret", "secret")
    opened: list[str] = []
    settled: list[tuple[str, int]] = []
    all_settled = asyncio.Event()

    async def open_call(call_id, **_kwargs):
        opened.append(call_id)

    async def no_lease(_call_id):
        return None

    async def post_settlement(payload, **_kwargs):
        settled.append((payload["callId"], payload["inputTokens"]))
        if len(settled) == 4:
            all_settled.set()
        return {}

    monkeypatch.setattr(accounting, "open_call", open_call)
    monkeypatch.setattr(accounting, "release_call", no_lease)
    monkeypatch.setattr(accounting, "_post_settlement", post_settlement)
    token = accounting.bind("cr_search")
    try:
        with caplog.at_level(logging.WARNING, logger="capy.search"):
            searches = [search.rerank("q", ROWS) for _ in range(4)]
            assert await asyncio.gather(*searches) == [(ROWS, False)] * 4
        assert "keeping fused order" in caplog.text
        answer.set()
        await asyncio.wait_for(all_settled.wait(), 5)
    finally:
        accounting.reset(token)
    assert len(opened) == 4
    assert sorted(settled) == sorted((call_id, 300) for call_id in opened)


async def test_scores_return_before_the_settlement_finishes(provider, monkeypatch):
    """A slow gateway delays the zero-credit receipt, never the search."""
    provider(_scores)
    monkeypatch.setattr(accounting.cfg, "gateway_url", "http://gateway")
    monkeypatch.setattr(accounting.cfg, "pipeline_secret", "secret")

    async def no_row(*_args, **_kwargs):
        return None

    monkeypatch.setattr(accounting, "open_call", no_row)
    monkeypatch.setattr(accounting, "release_call", no_row)
    gateway = asyncio.Event()
    settled: list[dict] = []

    async def post_settlement(payload):
        await gateway.wait()
        settled.append(payload)
        return {}

    monkeypatch.setattr(accounting, "_post_settlement", post_settlement)
    token = accounting.bind("cr_search")
    try:
        ranked, reranked = await search.rerank("q", ROWS)
        pending = [task for task in accounting._background if not task.done()]
        assert reranked and [row["id"] for row in ranked] == REVERSED
        assert settled == [] and len(pending) == 1
        gateway.set()
        await asyncio.gather(*pending)
    finally:
        accounting.reset(token)
    assert (settled[0]["kind"], settled[0]["modelVersion"]) == ("rerank", 1)


async def test_an_unassigned_rerank_slot_skips_reranking(provider, monkeypatch):
    seen = provider(lambda request: httpx.Response(500))
    monkeypatch.setattr(search, "_rerank_spec", registry_rerank_spec)
    monkeypatch.setattr(registry.registry, "_current", {})

    assert await search.rerank("q", ROWS) == (ROWS, False)
    assert seen == []


def test_a_refresh_drops_a_cleared_rerank_default(monkeypatch):
    """The off switch reaches running processes: a default Ops cleared is gone
    after the next poll, not kept from the previous one."""
    catalog = {"rev": 1, "default_for": ["rerank"]}

    class Cursor:
        def execute(self, sql, params=None):
            self.sql = sql

        def fetchone(self):
            return (catalog["rev"],)

        def fetchall(self):
            return [
                (1, "Alibaba", "Qwen3 Rerank", "alibaba", "qwen3-rerank",
                 {}, ["rerank"], [], "", 200, 200, True,
                 catalog["default_for"], 0, 200)
            ]  # fmt: skip

    @contextlib.contextmanager
    def connect():
        conn = type(
            "Conn", (), {"cursor": lambda self: contextlib.nullcontext(Cursor())}
        )()
        yield conn

    monkeypatch.setattr(registry.db, "connect", connect)
    fresh = registry.Registry()
    fresh.refresh()
    assert fresh.default(registry.Slot.RERANK).model_name == "Qwen3 Rerank"

    catalog.update(rev=2, default_for=[])
    fresh.refresh()
    with pytest.raises(registry.RegistryError):
        fresh.default(registry.Slot.RERANK)
