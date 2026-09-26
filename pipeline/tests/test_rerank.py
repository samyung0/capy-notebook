"""Search reranking: the first 20 fused candidates follow the rerank slot's
model, the rest keep fused order, and any failure keeps the fused order.

Calls run the real models and elitellm path against a mock DeepInfra
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
    provider_name="Qwen",
    model_name="Reranker 4B",
    provider_slug="deepinfra",
    model_slug="Qwen/Qwen3-Reranker-4B",
    slots=(registry.Slot.RERANK,),
)
ROWS = [{"id": f"c{i}", "indexed_text": f"Section\n\nchunk {i}"} for i in range(25)]
REVERSED = [f"c{i}" for i in range(19, -1, -1)] + [f"c{i}" for i in range(20, 25)]


def _scores(request: httpx.Request) -> httpx.Response:
    """Scores that reverse the first 20 rows."""
    return httpx.Response(200, json={"scores": list(range(20)), "input_tokens": 300})


@pytest.fixture
async def deepinfra(monkeypatch):
    """Install a rerank default and route DeepInfra to ``serve(handler)``."""
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

    monkeypatch.setenv("DEEPINFRA_API_KEY", "sk-deepinfra")
    monkeypatch.setattr(search, "_rerank_spec", lambda: SPEC)
    yield serve
    for client in clients:
        await client.aclose()


async def test_first_twenty_are_reranked_and_the_tail_keeps_fused_order(deepinfra):
    seen = deepinfra(_scores)

    ranked, reranked = await search.rerank("what is chunk 7", ROWS)

    assert seen == [
        {
            "queries": ["what is chunk 7"] * 20,
            "documents": [row["indexed_text"] for row in ROWS[:20]],
        }
    ]
    assert reranked and [row["id"] for row in ranked] == REVERSED


async def test_a_provider_error_keeps_fused_order(deepinfra, caplog):
    deepinfra(lambda request: httpx.Response(500, text="down"))

    with caplog.at_level(logging.WARNING, logger="capy.search"):
        assert await search.rerank("q", ROWS) == (ROWS, False)
    assert "keeping fused order" in caplog.text


async def test_a_call_past_the_bound_keeps_fused_order(deepinfra, monkeypatch, caplog):
    async def slow(request):
        await asyncio.sleep(1)
        return _scores(request)

    deepinfra(slow)
    monkeypatch.setattr(models, "RERANK_TIMEOUT_S", 0.05)

    with caplog.at_level(logging.WARNING, logger="capy.search"):
        assert await search.rerank("q", ROWS) == (ROWS, False)
    assert "keeping fused order" in caplog.text


async def test_scores_return_before_the_settlement_finishes(deepinfra, monkeypatch):
    """A slow gateway delays the zero-credit receipt, never the search."""
    deepinfra(_scores)
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


async def test_an_unassigned_rerank_slot_skips_reranking(deepinfra, monkeypatch):
    seen = deepinfra(lambda request: httpx.Response(500))
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
                (1, "Qwen", "Reranker 4B", "deepinfra", "Qwen/Qwen3-Reranker-4B",
                 True, False, {}, ["rerank"], [], "", 63, 63, True,
                 catalog["default_for"], 0, 63)
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
    assert fresh.default(registry.Slot.RERANK).model_name == "Reranker 4B"

    catalog.update(rev=2, default_for=[])
    fresh.refresh()
    with pytest.raises(registry.RegistryError):
        fresh.default(registry.Slot.RERANK)
