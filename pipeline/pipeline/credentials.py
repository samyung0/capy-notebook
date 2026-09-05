"""Decrypt per-user provider keys. The Go gateway writes the rows.

Plaintext never crosses the gateway hop. Retrieval reads the same
``user_llm_credentials`` table under the same ``LLM_CREDENTIALS_KEY``.
"""

from __future__ import annotations

import base64
import logging

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from .config import cfg
from .store import db

log = logging.getLogger("capy.credentials")

_INVALID_KEY = "LLM_CREDENTIALS_KEY must be 32-byte hex or base64"


def parse_credential_key(raw: str) -> bytes:
    raw = (raw or "").strip()
    if not raw:
        raise ValueError(_INVALID_KEY)
    try:
        decoded = bytes.fromhex(raw)
        if len(decoded) == 32:
            return decoded
    except ValueError:
        pass
    try:
        decoded = base64.b64decode(raw, validate=True)
        if len(decoded) == 32:
            return decoded
    except (ValueError, TypeError):
        pass
    raise ValueError(_INVALID_KEY)


def decrypt_secret(key: bytes, nonce: bytes, ciphertext: bytes) -> str:
    return AESGCM(key).decrypt(nonce, ciphertext, None).decode()


def decrypt_user_provider_key(user_id: str, provider_slug: str) -> str:
    if not user_id or not provider_slug:
        return ""
    try:
        key = parse_credential_key(cfg.llm_credentials_key)
    except ValueError:
        log.warning("LLM_CREDENTIALS_KEY missing or invalid")
        return ""
    with db.connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT key_nonce, key_ciphertext
              FROM user_llm_credentials
             WHERE user_id=%s AND provider_slug=%s
            """,
            (user_id, provider_slug),
        )
        row = cur.fetchone()
    if not row:
        return ""
    nonce, ciphertext = bytes(row[0]), bytes(row[1])
    try:
        return decrypt_secret(key, nonce, ciphertext)
    except Exception:  # noqa: BLE001 - decrypt failures are invalid ciphertext
        log.warning("failed to decrypt %s key for %s", provider_slug, user_id)
        return ""
