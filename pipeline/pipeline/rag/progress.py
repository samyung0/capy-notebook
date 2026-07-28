"""Redis progress publisher for live upload progress.

The worker PUBLISHes small JSON events to ``ingest:{workspaceId}``; the Go
gateway SUBSCRIBEs and fans them out to the browser over SSE. Publishing is
best-effort and fire-and-forget — a Redis hiccup must never fail an ingest job.
"""

from __future__ import annotations

import json
import logging

import redis

from ..config import cfg

log = logging.getLogger("evo.rag.progress")

_client: redis.Redis | None = None


def _redis() -> redis.Redis:
    global _client
    if _client is None:
        _client = redis.Redis.from_url(
            cfg.redis_url, socket_timeout=2, socket_connect_timeout=2
        )
    return _client


def channel(workspace_id: str) -> str:
    return f"ingest:{workspace_id}"


def publish(
    workspace_id: str,
    file_id: str,
    stage: str,
    pct: int,
    status: str = "processing",
    message: str = "",
) -> None:
    """Emit a progress event. ``status`` is one of processing|ready|failed."""
    event = {
        "fileId": file_id,
        "workspaceId": workspace_id,
        "stage": stage,
        "pct": max(0, min(100, int(pct))),
        "status": status,
        "message": message,
    }
    try:
        _redis().publish(channel(workspace_id), json.dumps(event))
    except Exception:
        log.warning(
            "redis publish failed for %s/%s", workspace_id, file_id, exc_info=True
        )
