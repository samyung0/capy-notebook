from __future__ import annotations

import pytest

from pipeline import plan_limits
from pipeline.ingest import worker
from pipeline.registry import (
    JobPins,
    ModelConfig,
    RegistryError,
    Slot,
    credits_for_tokens,
    embedding_spec,
    registry,
    resolve_pinned,
    set_job_pins,
)
from pipeline.retrieval import models as retrieval_models
from pipeline.store import db


def _spec(**overrides) -> ModelConfig:
    base = {
        "version": 1,
        "provider_name": "DeepSeek",
        "model_name": "Flash",
        "provider_slug": "deepseek",
        "model_slug": "flash",
        "slots": ("chat", "generate", "editor", "quiz", "ingest"),
        "micros_per_input_token": 250,
        "micros_per_output_token": 1000,
    }
    base.update(overrides)
    return ModelConfig(**base)


def test_credits_for_tokens_keeps_zeros():
    spec = _spec(micros_per_input_token=0, micros_per_output_token=0)
    assert credits_for_tokens(spec, "llm", 1000, 1000) == 0
    embed = _spec(
        provider_slug="deepinfra",
        model_slug="Qwen/Qwen3-Embedding-4B",
        slots=("retrieval",),
        micros_per_input_token=0,
        micros_per_output_token=0,
    )
    assert credits_for_tokens(embed, "embedding", 1000, 0) == 0


def test_embedding_credits_ignore_cached_rate():
    embed = _spec(
        provider_slug="deepinfra",
        model_slug="Qwen/Qwen3-Embedding-4B",
        slots=("retrieval",),
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
        model_slug="pro",
        micros_per_input_token=775,
        micros_per_output_token=3100,
    )
    assert credits_for_tokens(pro, "llm", 1000, 1000) > credits_for_tokens(
        flash, "llm", 1000, 1000
    )


def test_get_never_falls_back_to_default(monkeypatch):
    def boom(_provider_slug, _model_slug, _version):
        raise RegistryError("missing")

    monkeypatch.setattr(registry, "_load", boom)
    with registry._lock:
        registry._by_pin.clear()
    with pytest.raises(RegistryError, match="missing"):
        registry.get("deepseek", "flash", 99)


def test_chat_pin_does_not_fall_back(monkeypatch):
    monkeypatch.setattr(
        "pipeline.registry.registry.default",
        lambda _slot: (_ for _ in ()).throw(AssertionError("default used")),
    )
    with pytest.raises(RegistryError, match="missing pin"):
        resolve_pinned(None, None, None, Slot.CHAT)


def test_model_string_does_not_create_a_bootstrap_config():
    with pytest.raises(RegistryError, match="pinned ModelConfig"):
        retrieval_models._as_spec("deepseek-v4-flash")  # type: ignore[arg-type]


@pytest.mark.parametrize("slot", [Slot.INGEST, Slot.RETRIEVAL, Slot.CAPTIONING])
def test_no_slot_resolves_its_own_default(monkeypatch, slot):
    """Ingest, retrieval and captioning used to fall back to the live default
    when handed no pin, which is how an ingest job could run on a model nobody
    had priced and write vectors into a space nobody had chosen. Strictness here
    is what forces the choice back onto the caller that pays for it."""
    monkeypatch.setattr(
        "pipeline.registry.registry.default",
        lambda _slot: (_ for _ in ()).throw(AssertionError("default used")),
    )
    with pytest.raises(RegistryError, match="missing pin"):
        resolve_pinned(None, None, None, slot)


def test_job_pins_keep_embedding_after_default_would_move():
    pinned = _spec(
        provider_slug="deepinfra",
        slots=("retrieval",),
        model_slug="old-embed-id",
    )
    set_job_pins(JobPins(embedding=pinned))
    try:
        got = embedding_spec()
        assert got.provider_slug == "deepinfra"
        assert got.litellm_model_id == "old-embed-id"
    finally:
        set_job_pins(None)


class _Conn:
    def execute(self, query, params):
        assert query.startswith("UPDATE files SET ever_parsed_successfully=true")

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def cursor(self):
        return self

    def commit(self):
        return None


def test_claim_gating_matrix(monkeypatch):
    state = {
        "owner_ok": True,
        "actor_ok": True,
        "owner": "u_owner",
        "allow_over_quota": False,
    }

    monkeypatch.setattr(db, "connect", lambda: _Conn())
    monkeypatch.setattr(db, "ingest_accounts_active", lambda *_args: True)
    monkeypatch.setattr(db, "file_owner_user_id", lambda _cur, _fid: state["owner"])
    monkeypatch.setattr(
        db,
        "account_allows_ingest",
        lambda _cur, uid, *, allow_over_quota=False: (
            state.update(allow_over_quota=allow_over_quota)
            or (state["owner_ok"] if uid == "u_owner" else False)
        ),
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
    assert worker._account_allows_ingest("f_1", payload) is True

    payload["quotaRecovery"] = True
    assert worker._account_allows_ingest("f_1", payload) is True
    assert state["allow_over_quota"] is True


def test_superseded_worker_closes_exact_attempt_after_job_is_terminal(monkeypatch):
    finished: list[dict] = []
    closed: list[str] = []
    monkeypatch.setattr(db, "connect", lambda: _Conn())
    monkeypatch.setattr(worker, "_lost_claim", lambda *_a, **_k: True)
    monkeypatch.setattr(
        db,
        "finish_job_attempt",
        lambda _cur, **values: finished.append(values),
    )
    monkeypatch.setattr(
        db,
        "close_credit_reservation",
        lambda _cur, reservation_id: closed.append(reservation_id),
    )

    token = worker.telemetry.begin_job(
        {"id": "job_superseded", "attemptId": 42, "attempts": 1}
    )
    try:
        worker._finish_superseded("job_superseded", 1, "cr_superseded")
    finally:
        worker.telemetry.reset_job(token)

    assert finished[0]["attempt_id"] == 42
    assert finished[0]["outcome"] == "superseded"
    assert closed == ["cr_superseded"]


def test_plan_limit_catalog_uses_seeded_product_values():
    catalog = plan_limits._catalog_from_rows(
        [
            ("free", 100_000_000, 1_000_000_000, 10 << 20, 3, None, 100, 20),
            ("pro", 1_000_000_000, 20_000_000_000, 30 << 20, 30, None, 100, 20),
        ]
    )
    assert catalog.free.storage_bytes == 100_000_000
    assert catalog.free.material_revisions == 3
    assert catalog.pro.storage_bytes == 1_000_000_000
    assert catalog.free.owned_workspaces is None


def test_ingest_closes_the_actor_reservation_after_page_billing(monkeypatch):
    billed = []

    def record(_cur, **kwargs):
        billed.append(kwargs)

    monkeypatch.setattr(db, "connect", lambda: _Conn())
    monkeypatch.setattr(db, "record_usage_event", record)
    monkeypatch.setattr(db, "workspace_owner_user_id", lambda _cur, _ws: "u_owner")
    monkeypatch.setattr(worker, "_lost_claim", lambda *_a, **_k: False)
    monkeypatch.setattr(db, "set_file_status", lambda *_a, **_k: None)
    monkeypatch.setattr(db, "set_file_indexed", lambda *_a, **_k: None)
    monkeypatch.setattr(db, "set_job", lambda *_a, **_k: None)
    monkeypatch.setattr(db, "ingest_accounts_active", lambda *_a, **_k: True)
    monkeypatch.setattr(db, "add_notification", lambda *_a, **_k: None)

    worker.obs.start_usage()
    worker.obs.record_parse_usage(
        pages=2,
        ocr_pages=1,
        cpu_milliseconds=1250,
        elapsed_milliseconds=2100,
    )
    monkeypatch.setattr(worker.obs, "trace_id", lambda: "t")
    monkeypatch.setattr(
        worker.registry,
        "ingest_spec",
        lambda: _spec(),
    )
    monkeypatch.setattr(
        worker.registry,
        "embedding_spec",
        lambda: _spec(
            provider_slug="deepinfra",
            model_slug="Qwen/Qwen3-Embedding-4B",
            slots=("retrieval",),
        ),
    )
    monkeypatch.setattr(
        worker.registry,
        "captioning_spec",
        lambda: _spec(
            provider_slug="zai",
            model_slug="glm-5.3-flash",
            slots=("captioning",),
        ),
    )

    settled: list[str] = []
    monkeypatch.setattr(
        db, "settle_credit_reservation", lambda _cur, rid: settled.append(rid)
    )
    token = worker._resource_rates.set(
        {
            worker._RESOURCE_DIGITAL_PAGE: {
                "version": 1,
                "creditMicrosPerUnit": 31_000_000,
            },
            worker._RESOURCE_OCR_PAGE: {
                "version": 1,
                "creditMicrosPerUnit": 52_000_000,
            },
        }
    )
    try:
        worker._finish_ok(
            "f_1",
            "notes.pdf",
            "job_1",
            attempt=1,
            actor_user_id="u_actor",
            workspace_id="ws_1",
            reservation_id="cr_1",
        )
    finally:
        worker._resource_rates.reset(token)
    assert billed and billed[0]["actor_user_id"] == "u_actor"
    assert billed[0]["reservation_id"] == "cr_1"
    assert billed[0]["kind"] == "parse"
    assert billed[0]["unit"] == "pages"
    assert billed[0]["units"] == 2
    assert billed[0]["parse_ocr_pages"] == 1
    assert billed[0]["parse_cpu_milliseconds"] == 1250
    assert billed[0]["credit_micros"] == 83_000_000
    assert billed[0]["idempotency_key"] == "parse:job_1:1"
    assert settled == ["cr_1"]


def test_parser_receipt_uses_fingerprint_idempotency(monkeypatch):
    billed = []
    monkeypatch.setattr(
        db, "record_usage_event", lambda _cur, **kwargs: billed.append(kwargs)
    )
    token = worker._resource_rates.set(
        {
            worker._RESOURCE_DIGITAL_PAGE: {
                "version": 1,
                "creditMicrosPerUnit": 31_000_000,
            },
            worker._RESOURCE_OCR_PAGE: {
                "version": 1,
                "creditMicrosPerUnit": 52_000_000,
            },
        }
    )
    try:
        worker._record_parse_usage_tx(
            None,
            usage=worker.obs.ParseUsage(pages=1, receipt_id="fingerprint-1"),
            file_id="f_1",
            workspace_id="ws_1",
            actor_user_id="u_1",
            reservation_id="cr_1",
            job_id="job_1",
            attempt=2,
            outcome="succeeded",
        )
    finally:
        worker._resource_rates.reset(token)

    assert billed[0]["idempotency_key"] == "parse-receipt:fingerprint-1"
    assert billed[0]["metadata"]["parseReceiptId"] == "fingerprint-1"


def test_finish_fail_closes_reservation_from_recorded_spend(monkeypatch):
    closed: list[str] = []
    previews: list[tuple[str, str | None]] = []
    monkeypatch.setattr(db, "connect", lambda: _Conn())
    monkeypatch.setattr(worker, "_lost_claim", lambda *_a, **_k: False)
    monkeypatch.setattr(db, "set_file_status", lambda *_a, **_k: None)
    monkeypatch.setattr(db, "set_file_indexed", lambda *_a, **_k: None)
    monkeypatch.setattr(
        db,
        "set_file_preview_blob",
        lambda _cur, file_id, path: previews.append((file_id, path)),
    )
    monkeypatch.setattr(db, "set_job", lambda *_a, **_k: None)
    monkeypatch.setattr(
        db, "close_credit_reservation", lambda _cur, rid: closed.append(rid)
    )
    worker._finish_fail("f_1", "j_1", "boom", 1, "cr_fail")
    assert closed == ["cr_fail"]
    assert previews == [("f_1", None)]


def test_parse_page_rates_are_worst_case_and_ocr_replaces_digital_rate():
    rates = {"digital_rate": 31_000_000, "ocr_rate": 52_000_000}
    assert db.credits_for_parse_pages(1, 0, **rates) == 31_000_000
    assert db.credits_for_parse_pages(1, 1, **rates) == 52_000_000
    assert db.credits_for_parse_pages(3, 1, **rates) == 114_000_000
