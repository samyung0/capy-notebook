"""Client for the free MinerU "Agent lightweight" parse API (mineru.net).

No auth token — the API is IP rate-limited (HTTP 429 when throttled). Flow:

1. ``POST {base}/parse/file`` with the file name + options → ``task_id`` and a
   signed OSS upload URL (``file_url``)
2. ``PUT`` the raw bytes to ``file_url``
3. Poll ``GET {base}/parse/{task_id}`` until ``done`` / ``failed``
4. Download the markdown from ``data.markdown_url``

Upstream limits (the Go gateway pre-validates size/type at upload time):
≤ 10 MB, ≤ 20 pages; PDF, images (png/jpg/jpeg/jp2/webp/gif/bmp), docx,
pptx, xlsx. OCR language packs are limited — the default ``ch`` pack covers
Chinese + English only.

Synchronous (requests); the worker calls it via ``asyncio.to_thread``.
"""

from __future__ import annotations

import logging
import time
from collections.abc import Callable

import requests

from ..config import cfg

log = logging.getLogger("evo.rag.mineru_lite")

_POLL_INTERVAL = 3.0
_MAX_BYTES = 10 << 20


class MineruLiteError(RuntimeError):
    pass


def _check(resp: requests.Response) -> dict:
    if resp.status_code == 429:
        raise MineruLiteError("MinerU lightweight API rate limit hit; retry later")
    resp.raise_for_status()
    body = resp.json()
    if body.get("code") != 0:
        raise MineruLiteError(
            f"MinerU lite API error {body.get('code')}: {body.get('msg')}"
        )
    return body.get("data") or {}


def _create_task(file_name: str) -> tuple[str, str]:
    base = cfg.mineru_lite_base.rstrip("/")
    data = _check(
        requests.post(
            f"{base}/parse/file",
            json={
                "file_name": file_name,
                "language": cfg.mineru_lite_language,
                "enable_table": True,
                "is_ocr": True,
                "enable_formula": True,
            },
            timeout=30,
        )
    )
    return data["task_id"], data["file_url"]


def _poll_result(
    task_id: str, on_progress: Callable[[int], None] | None = None
) -> str:
    base = cfg.mineru_lite_base.rstrip("/")
    deadline = time.monotonic() + cfg.mineru_lite_timeout
    pct = 25
    while time.monotonic() < deadline:
        time.sleep(_POLL_INTERVAL)
        data = _check(requests.get(f"{base}/parse/{task_id}", timeout=30))
        state = data.get("state")
        if state == "done":
            md = requests.get(data["markdown_url"], timeout=120)
            md.raise_for_status()
            md.encoding = "utf-8"
            text = md.text
            if not text.strip():
                raise MineruLiteError("parse produced empty markdown")
            if on_progress:
                on_progress(55)
            return text
        if state == "failed":
            raise MineruLiteError(
                f"lightweight parse failed ({data.get('err_code')}): "
                f"{data.get('err_msg') or 'unknown error'}"
            )
        pct = min(50, pct + 2)
        if on_progress:
            on_progress(pct)
    raise MineruLiteError(
        f"lightweight parse timed out after {cfg.mineru_lite_timeout}s (task {task_id})"
    )


def parse_file(
    local_path: str,
    file_name: str,
    on_progress: Callable[[int], None] | None = None,
) -> str:
    """Parse a document with the MinerU lightweight API and return markdown.

    ``on_progress`` receives coarse percentages (25–55) suitable for the SSE
    parsing band; it is invoked from the calling (worker) thread.
    """
    task_id, file_url = _create_task(file_name)
    log.info("mineru lite task %s created for %s", task_id, file_name)

    # 2. Upload the bytes (per MinerU docs: plain PUT, no Content-Type needed).
    with open(local_path, "rb") as fh:
        put = requests.put(file_url, data=fh, timeout=120)
    if put.status_code not in (200, 201):
        raise MineruLiteError(f"file upload failed: HTTP {put.status_code}")
    if on_progress:
        on_progress(25)

    return _poll_result(task_id, on_progress)


def parse_blob(
    blob_path: str,
    file_name: str,
    on_progress: Callable[[int], None] | None = None,
) -> str:
    """Parse a B2 object, relaying its bytes through Cloudflare when enabled."""
    from ..store import blobstore

    if not cfg.mineru_relay_url:
        local_path, cleanup = blobstore.fetch_local(blob_path)
        try:
            return parse_file(local_path, file_name, on_progress)
        finally:
            cleanup()

    task_id, destination_url = _create_task(file_name)
    source_url = blobstore.presign_get(blob_path, cfg.mineru_relay_timeout + 60)
    headers = {"Content-Type": "application/json"}
    if cfg.mineru_relay_token:
        headers["Authorization"] = f"Bearer {cfg.mineru_relay_token}"
    relay = None
    for attempt in range(2):
        try:
            relay = requests.post(
                cfg.mineru_relay_url,
                headers=headers,
                json={
                    "sourceUrl": source_url,
                    "destinationUrl": destination_url,
                    "maxBytes": _MAX_BYTES,
                },
                timeout=cfg.mineru_relay_timeout,
            )
            if relay.status_code < 300:
                break
        except requests.RequestException:
            relay = None
        if attempt == 0:
            time.sleep(1)
    if relay is None or relay.status_code >= 300:
        detail = (
            "network error"
            if relay is None
            else f"{relay.status_code}: {relay.text[:300]}"
        )
        raise MineruLiteError(f"MinerU relay failed ({detail})")
    if on_progress:
        on_progress(25)
    return _poll_result(task_id, on_progress)
