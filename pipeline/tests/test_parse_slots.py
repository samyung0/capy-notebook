"""Offline tests for the Modal parse-slot gate (no Redis)."""

from __future__ import annotations

from pipeline.parse import slots


def test_a_dead_redis_lets_the_parse_through(monkeypatch):
    def _boom():
        raise RuntimeError("redis down")

    monkeypatch.setattr(slots, "_redis", _boom)
    assert slots.try_acquire("fast", "job_1") is True


def test_slot_caps_match_the_modal_boxes():
    assert slots.cap_for("fast") == 72
