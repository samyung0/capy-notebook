"""Cap concurrent Modal parse calls so we never open more boxes than we pay for.

Fast: 12 containers × 6 in-flight = 72 (OCR-heavy jobs still share a lane of 2
inside each box).

The ingest worker takes a slot only for the Modal HTTP call. When every slot
is taken, the job goes back to ``pending`` and the file stays ``pending`` so
the user sees a wait, not a stuck parse. Redis is the scoreboard; if Redis is
down we let the call through and Modal's ``max_containers`` is the backstop.
"""

from __future__ import annotations

import logging
import time

import redis

from ..config import cfg

log = logging.getLogger("evo.parse.slots")

HOLD_TTL_S = 1800
YIELD_BACKOFF_S = 2

_LUA_ACQUIRE = """
local key = KEYS[1]
local job = ARGV[1]
local cap = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local ttl = tonumber(ARGV[4])
redis.call('ZREMRANGEBYSCORE', key, '-inf', now)
if redis.call('ZSCORE', key, job) then
  redis.call('ZADD', key, now + ttl, job)
  return 1
end
if redis.call('ZCARD', key) >= cap then
  return 0
end
redis.call('ZADD', key, now + ttl, job)
return 1
"""

_client: redis.Redis | None = None


def _redis() -> redis.Redis:
    global _client
    if _client is None:
        _client = redis.Redis.from_url(
            cfg.redis_url, socket_timeout=2, socket_connect_timeout=2
        )
    return _client


def cap_for(route: str) -> int:
    return cfg.parse_fast_slots


def _key(route: str) -> str:
    return f"evo:parse:slots:{route}"


def try_acquire(route: str, job_id: str) -> bool:
    """True if this job may call Modal now. Fail-open if Redis is unreachable."""
    try:
        allowed = _redis().eval(
            _LUA_ACQUIRE,
            1,
            _key(route),
            job_id,
            cap_for(route),
            time.time(),
            HOLD_TTL_S,
        )
        return bool(int(allowed))
    except Exception:
        log.warning(
            "parse-slot acquire failed; letting the call through route=%s job=%s",
            route,
            job_id,
            exc_info=True,
        )
        return True


def release(route: str, job_id: str) -> None:
    try:
        _redis().zrem(_key(route), job_id)
    except Exception:
        log.warning(
            "parse-slot release failed route=%s job=%s",
            route,
            job_id,
            exc_info=True,
        )
