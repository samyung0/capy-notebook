"""Redis publisher for live upload progress.

The worker PUBLISHes small JSON events to ``ingest:{workspaceId}``; the Go
gateway SUBSCRIBEs and fans them out to the browser over SSE. A standalone
file (no workspace) publishes the same event, typed ``ingest`` and without a
workspace, on its owner's ``notif:{userId}`` channel, which the gateway relays
as a ``notification`` event. Publishing is best-effort and fire-and-forget — a
Redis hiccup must never fail an ingest job.
"""

from __future__ import annotations

import json
import logging

import redis

from .config import cfg
from .store.db import Scope

log = logging.getLogger("capy.progress")

_client: redis.Redis | None = None


def _redis() -> redis.Redis:
    global _client
    if _client is None:
        _client = redis.Redis.from_url(
            cfg.redis_url, socket_timeout=2, socket_connect_timeout=2
        )
    return _client


def channel(scope: Scope) -> str:
    if scope.workspace_id:
        return f"ingest:{scope.workspace_id}"
    return f"notif:{scope.owner_id}"


def publish(
    scope: Scope,
    file_id: str,
    stage: str,
    pct: int,
    status: str = "processing",
    message: str = "",
    indexed: bool | None = None,
) -> None:
    """Emit a progress event. ``status`` is one of pending|processing|ready|failed."""
    event: dict[str, object] = {"fileId": file_id}
    if scope.workspace_id:
        event["workspaceId"] = scope.workspace_id
    else:
        event["type"] = "ingest"
    event.update(
        stage=stage,
        pct=max(0, min(100, int(pct))),
        status=status,
        message=message,
    )
    if indexed is not None:
        event["indexed"] = indexed
    try:
        _redis().publish(channel(scope), json.dumps(event))
    except Exception:
        log.warning(
            "redis publish failed for %s/%s", channel(scope), file_id, exc_info=True
        )
