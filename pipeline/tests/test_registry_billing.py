from __future__ import annotations

from types import SimpleNamespace

import pytest

from pipeline.ingest import worker
from pipeline.registry import (
    SURFACE_CHAT,
    SURFACE_EMBEDDING,
    SURFACE_INGEST,
    SURFACE_VISION,
    JobPins,
    ModelConfig,
    RegistryError,
    credits_for_tokens,
    embedding_spec,
    registry,
    resolve_pinned,
    set_job_pins,
)
from pipeline.store import db


def _spec(**overrides) -> ModelConfig:
    base = {
        "model_key": "deepseek-flash",
        "version": 1,
        "display_name": "Flash",
        "provider_slug": "deepseek",
        "base_url": "https://example.test",
        "provider_model_id": "flash",
        "surfaces": ("chat", "generate", "editor", "quiz", "ingest"),
        "micros_per_input_token": 250,
        "micros_per_output_token": 1000,
    }
    base.update(overrides)
    return ModelConfig(**base)


def test_credits_for_tokens_keeps_zeros():
    spec = _spec(micros_per_input_token=0, micros_per_output_token=0)
    assert credits_for_tokens(spec, "llm", 1000, 1000) == 0
    embed = _spec(
        model_key="qwen-embed",
        surfaces=("embedding",),
        micros_per_input_token=0,
        micros_per_output_token=0,
    )
    assert credits_for_tokens(embed, "embedding", 1000, 0) == 0


def test_embedding_credits_ignore_cached_rate():
    embed = _spec(
        model_key="qwen-embed",
        surfaces=("embedding",),
        micros_per_input_token=10,
        micros_per_cached_input_token=1,
    )
    assert credits_for_tokens(embed, "embedding", 1000, 0, 400) == 1000 * 10


def test_credits_discount_only_valid_cache_reads():
    flash = _spec(micros_per_cached_input_token=25)
    full = credits_for_tokens(flash, "llm", 1000, 100)
    discounted = credits_for_tokens(flash, "llm", 1000, 100, 200)
    assert discounted == 800 * 250 + 200 * 25 + 100 * 1000
    assert discounted < full
    assert credits_for_tokens(flash, "llm", 1000, 0, 5000) == 1000 * 250


def test_credits_differ_by_model():
    flash = _spec()
    pro = _spec(
        model_key="deepseek-pro",
        provider_model_id="pro",
        micros_per_input_token=775,
        micros_per_output_token=3100,
    )
    assert credits_for_tokens(pro, "llm", 1000, 1000) > credits_for_tokens(
        flash, "llm", 1000, 1000
    )


def test_get_never_falls_back_to_default(monkeypatch):
    def boom(_key, _version):
        raise RegistryError("missing")

    monkeypatch.setattr(registry, "_load", boom)
    with registry._lock:
        registry._by_pin.clear()
    with pytest.raises(RegistryError, match="missing"):
        registry.get("deepseek-flash", 99)


def test_chat_pin_does_not_fall_back(monkeypatch):
    monkeypatch.setattr(
        "pipeline.registry.registry.default",
        lambda _surface: (_ for _ in ()).throw(AssertionError("default used")),
    )
    with pytest.raises(RegistryError, match="missing pin"):
        resolve_pinned(None, None, SURFACE_CHAT)


@pytest.mark.parametrize("surface", [SURFACE_INGEST, SURFACE_EMBEDDING, SURFACE_VISION])
def test_no_surface_resolves_its_own_default(monkeypatch, surface):
    """Ingest, embedding and vision used to fall back to the live default
    when handed no pin, which is how an ingest job could run on a model nobody
    had priced and write vectors into a space nobody had chosen. Strictness here
    is what forces the choice back onto the caller that pays for it."""
    monkeypatch.setattr(
        "pipeline.registry.registry.default",
        lambda _surface: (_ for _ in ()).throw(AssertionError("default used")),
    )
    with pytest.raises(RegistryError, match="missing pin"):
        resolve_pinned(None, None, surface)


def test_job_pins_keep_embedding_after_default_would_move():
    pinned = _spec(
        model_key="old-embed",
        surfaces=("embedding",),
        provider_model_id="old-embed-id",
    )
    set_job_pins(JobPins(embedding=pinned))
    try:
        got = embedding_spec()
        assert got.model_key == "old-embed"
        assert got.provider_model_id == "old-embed-id"
    finally:
        set_job_pins(None)


class _Conn:
    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def cursor(self):
        return self

    def commit(self):
        return None


def test_claim_gating_matrix(monkeypatch):
    state = {"owner_ok": True, "actor_ok": True, "owner": "u_owner"}

    monkeypatch.setattr(db, "connect", lambda: _Conn())
    monkeypatch.setattr(db, "file_owner_user_id", lambda _cur, _fid: state["owner"])
    monkeypatch.setattr(
        db,
        "account_allows_ingest",
        lambda _cur, uid: state["owner_ok"] if uid == "u_owner" else False,
    )
    monkeypatch.setattr(
        db,
        "actor_has_credits",
        lambda _cur, uid: state["actor_ok"] if uid == "u_actor" else False,
    )

    payload = {"actorUserId": "u_actor"}
    assert worker._account_allows_ingest("f_1", payload) is True
    assert worker._account_allows_ingest("f_1", {}) is False

    state["owner_ok"] = False
    assert worker._account_allows_ingest("f_1", payload) is False

    state["owner_ok"] = True
    state["actor_ok"] = False
    assert worker._account_allows_ingest("f_1", payload) is False

    state["actor_ok"] = True
    # Actor lifecycle is not consulted; a deletion_pending actor still proceeds.
    assert worker._account_allows_ingest("f_1", payload) is True


def test_ingest_bills_the_actor(monkeypatch):
    billed = []

    def record(_cur, **kwargs):
        billed.append(kwargs)

    monkeypatch.setattr(db, "connect", lambda: _Conn())
    monkeypatch.setattr(db, "record_usage_event", record)
    monkeypatch.setattr(db, "workspace_owner_user_id", lambda _cur, _ws: "u_owner")

    usage = SimpleNamespace(
        by_model={},
        input_tokens=10,
        output_tokens=4,
        embed_tokens=0,
        model="flash",
        calls=1,
        is_empty=lambda: False,
    )
    monkeypatch.setattr(worker.obs, "current_usage", lambda: usage)
    monkeypatch.setattr(worker.obs, "take_gpu_millis", lambda: 0)
    monkeypatch.setattr(worker.obs, "trace_id", lambda: "t")
    monkeypatch.setattr(
        worker.registry,
        "ingest_spec",
        lambda: _spec(),
    )
    monkeypatch.setattr(
        worker.registry,
        "embedding_spec",
        lambda: _spec(model_key="qwen-embed", surfaces=("embedding",)),
    )
    monkeypatch.setattr(
        worker.registry,
        "vision_spec",
        lambda: _spec(model_key="gemini-flash-lite", surfaces=("vision",)),
    )

    settled: list[str] = []
    monkeypatch.setattr(
        db, "settle_credit_reservation", lambda _cur, rid: settled.append(rid)
    )
    worker._charge_ingest("f_1", "ws_1", "u_actor", "cr_1")
    assert billed and billed[0]["actor_user_id"] == "u_actor"
    assert billed[0]["reservation_id"] == "cr_1"
    assert settled == ["cr_1"]


def test_finish_fail_releases_reservation(monkeypatch):
    released: list[str] = []
    monkeypatch.setattr(db, "connect", lambda: _Conn())
    monkeypatch.setattr(worker, "_lost_claim", lambda *_a, **_k: False)
    monkeypatch.setattr(db, "set_file_status", lambda *_a, **_k: None)
    monkeypatch.setattr(db, "set_file_indexed", lambda *_a, **_k: None)
    monkeypatch.setattr(db, "set_job", lambda *_a, **_k: None)
    monkeypatch.setattr(
        db, "release_credit_reservation", lambda _cur, rid: released.append(rid)
    )
    worker._finish_fail("f_1", "j_1", "boom", 1, "cr_fail")
    assert released == ["cr_fail"]
