"""The layout service with a stand-in model: its token, the depth limit answering
429, its caps on bytes and pixels, and what /healthz counts (layout/app.py). The
real model runs in bench/extraction/scripts/layout_trial.py."""

from __future__ import annotations

import importlib.util
import io
import os
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
from PIL import Image
from starlette.testclient import TestClient

TOKEN = "layout-token-of-at-least-thirty-two-chars"
# The compose file sets them; the module refuses to load without them.
os.environ.update(
    CAPY_LAYOUT_TOKEN=TOKEN,
    LAYOUT_MODEL_PATH="unused",
    LAYOUT_THREADS="1",
    LAYOUT_WORKERS="1",
    LAYOUT_QUEUE_DEPTH="2",
    LAYOUT_MAX_BYTES="20000",
    LAYOUT_MAX_PIXELS="10000",
)
spec = importlib.util.spec_from_file_location(
    "layout_app", Path(__file__).resolve().parents[2] / "layout" / "app.py"
)
assert spec is not None and spec.loader is not None
service = importlib.util.module_from_spec(spec)
spec.loader.exec_module(service)

AUTH = {"Authorization": f"Bearer {TOKEN}"}
REGIONS = [{"label": "image", "score": 0.9, "box": [1.0, 2.0, 3.0, 4.0]}]


def _jpeg(width: int = 100, height: int = 100) -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", (width, height), "white").save(buffer, "JPEG")
    return buffer.getvalue()


@pytest.fixture
def client(monkeypatch):
    """No lifespan: the stand-in takes the model's place."""
    pool = ThreadPoolExecutor(1)
    monkeypatch.setattr(service, "model", lambda image: REGIONS)
    monkeypatch.setattr(service, "pool", pool)
    monkeypatch.setattr(service, "counts", service.Counter())
    monkeypatch.setattr(service, "in_service", 0)
    yield TestClient(service.app)
    pool.shutdown()


def test_the_token_leaves_the_environment():
    assert "CAPY_LAYOUT_TOKEN" not in os.environ


def test_a_jpeg_comes_back_as_regions(client):
    response = client.post("/regions", content=_jpeg(), headers=AUTH)
    assert response.status_code == 200
    assert response.json() == {"regions": REGIONS}
    assert client.get("/healthz").json() == {"ok": True, "inService": 0, "served": 1}


def test_a_request_needs_the_token(client):
    assert client.post("/regions", content=_jpeg()).status_code == 401
    wrong = {"Authorization": "Bearer nope"}
    assert client.post("/regions", content=_jpeg(), headers=wrong).status_code == 401


def test_past_the_depth_limit_a_request_is_answered_429(client, monkeypatch):
    monkeypatch.setattr(service, "in_service", service.DEPTH)
    response = client.post("/regions", content=_jpeg(), headers=AUTH)
    assert response.status_code == 429
    assert client.get("/healthz").json()["busy"] == 1


def test_what_is_too_big_or_no_jpeg_is_refused(client):
    too_long = client.post("/regions", content=b"x" * 20001, headers=AUTH)
    assert (too_long.status_code, too_long.json()) == (
        413,
        {"error": "too_many_bytes"},
    )
    too_wide = client.post("/regions", content=_jpeg(200, 100), headers=AUTH)
    assert (too_wide.status_code, too_wide.json()) == (
        413,
        {"error": "too_many_pixels"},
    )
    buffer = io.BytesIO()
    Image.new("RGB", (10, 10)).save(buffer, "PNG")
    other = client.post("/regions", content=buffer.getvalue(), headers=AUTH)
    assert (other.status_code, other.json()) == (400, {"error": "not_a_jpeg"})
    assert service.in_service == 0
