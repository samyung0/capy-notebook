from __future__ import annotations

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
