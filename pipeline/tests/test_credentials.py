from __future__ import annotations

import os
import subprocess
import sys

import pytest
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from pipeline import credentials
from pipeline.retrieve import service


def test_parse_credential_key_hex_and_base64():
    hex_key = "01" * 32
    assert len(credentials.parse_credential_key(hex_key)) == 32
    b64 = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE="
    assert len(credentials.parse_credential_key(b64)) == 32


def test_parse_credential_key_rejects_raw_ascii():
    with pytest.raises(ValueError, match="hex or base64"):
        credentials.parse_credential_key("x" * 32)


def test_decrypt_secret_round_trip():
    key = credentials.parse_credential_key("01" * 32)
    nonce = b"\x00" * 12
    ciphertext = AESGCM(key).encrypt(nonce, b"sk-test-secret", None)
    assert credentials.decrypt_secret(key, nonce, ciphertext) == "sk-test-secret"


def test_pipeline_secret_compare(monkeypatch):
    monkeypatch.setattr(service.cfg, "pipeline_secret", "abc")
    assert service.pipeline_secret_ok("abc")
    assert not service.pipeline_secret_ok("ab")
    assert not service.pipeline_secret_ok("abcd")
    monkeypatch.setattr(service.cfg, "pipeline_secret", "")
    assert not service.pipeline_secret_ok("")
    assert not service.pipeline_secret_ok("abc")


def test_chat_stop_needs_the_pipeline_secret(monkeypatch):
    from fastapi.testclient import TestClient

    monkeypatch.setattr(service.cfg, "pipeline_secret", "abc")
    http = TestClient(service.app)  # no lifespan: no database
    body = {"assistantMessageId": "m_1"}
    assert http.post("/chat/stop", json=body).status_code == 401
    wrong = http.post("/chat/stop", json=body, headers={"X-Pipeline-Secret": "abd"})
    assert wrong.status_code == 401
    right = http.post("/chat/stop", json=body, headers={"X-Pipeline-Secret": "abc"})
    assert right.status_code == 404  # no such running turn


def _boot(key: str, value: str, app_env: str | None) -> int:
    """Exit code of a pipeline process loading its configuration."""
    env = {
        k: v
        for k, v in os.environ.items()
        if k not in {"APP_ENV", "PIPELINE_SECRET", "PARSER_TOKEN"}
    }
    env[key] = value
    if app_env is not None:
        env["APP_ENV"] = app_env
    return subprocess.run(
        [sys.executable, "-c", "import pipeline.config"],
        env=env,
        capture_output=True,
        check=False,
    ).returncode


@pytest.mark.parametrize("key", ["PIPELINE_SECRET", "PARSER_TOKEN"])
def test_a_short_shared_secret_refuses_to_boot_outside_development(key):
    """(security regression: rate-limit audit M4) A set secret under 32
    characters stops the process unless APP_ENV is development or e2e; a
    missing APP_ENV is checked."""
    short = "s" * 31
    assert _boot(key, short, "production") != 0
    assert _boot(key, short, None) != 0
    assert _boot(key, "s" * 32, "production") == 0
    assert _boot(key, short, "development") == 0
    assert _boot(key, short, "e2e") == 0
