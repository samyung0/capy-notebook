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
