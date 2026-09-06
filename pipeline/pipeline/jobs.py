"""Job-queue policy and error taxonomy.

Retry knobs live here, not on the ``jobs`` row: they vary by type, and a
column would freeze a policy you can no longer change by deploying. The row
carries only state (``attempts``, ``not_before``, ``lease_expires_at``).

Retryability is a property of the error. A provider 503 should retry; "model
pins could not be resolved" never should. Unknown exceptions default to
retryable because the attempt budget bounds them.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from .config import cfg


class RetryableError(Exception):
    """The worker should re-pend this job against its attempt budget."""


class TerminalError(Exception):
    """Do not retry. The job is failed and, for ingest, the file is failed."""


class CapacityWait(Exception):
    """Parser slots are full. The job returns to pending.

    The file stays pending. Do not spend an attempt or mark the file failed.
    """


# A provider that stays busy past the in-call retry budget re-pends the ingest
# job without spending an attempt, at most this many times per job. The wait
# follows the provider's Retry-After, else this base doubling per re-pend.
PROVIDER_WAITS_MAX = 5
PROVIDER_WAIT_BACKOFF_S = 30


def provider_wait_backoff_s(retry_after: float | None, waits: int) -> int:
    """``waits`` is the number of busy re-pends this job already had."""
    if retry_after is not None and retry_after > 0:
        return max(1, math.ceil(retry_after))
    return PROVIDER_WAIT_BACKOFF_S * (2 ** max(waits, 0))


@dataclass(frozen=True)
class JobPolicy:
    max_attempts: int
    backoff_base_s: int
    timeout_s: int
    lease_s: int


POLICIES: dict[str, JobPolicy] = {
    "import": JobPolicy(
        # Provider 429/5xx and B2 hiccups are cheap to retry; every attempt asks
        # the gateway for a fresh download grant. Exhausting the budget fails
        # the import and releases its reservation.
        max_attempts=4,
        backoff_base_s=30,
        timeout_s=cfg.import_job_timeout,
        lease_s=180,
    ),
    "parse": JobPolicy(
        # One initial attempt and one retry. Confirmed hard parser resource
        # failures are TerminalError and do not spend the second attempt.
        max_attempts=2,
        backoff_base_s=30,
        timeout_s=cfg.parse_job_timeout,
        lease_s=180,
    ),
    "ingest": JobPolicy(
        # Post-parse resource failures always receive this one retry. They never
        # quarantine the source fingerprint because MinerU already completed.
        max_attempts=2,
        backoff_base_s=30,
        timeout_s=cfg.ingest_timeout,
        lease_s=180,
    ),
}

# After this long a waiter starts trying to steal a processing rag_contents
# claim. The job wall-clock timeout is the hard bound; this is only the
# steal-attempt threshold. A SIGKILLed creator never runs abandon_content.
CONTENT_CLAIM_WAIT_S = 120
# Floor on steal, not the death signal. Steal also requires the owning job to
# no longer be running with a live lease — otherwise a missed heartbeat write
# would yank a creator that is still embedding. Must exceed the heartbeat
# interval so a live creator whose lease is about to be renewed is not stolen
# on a race with the first poll.
CONTENT_CLAIM_STALE_S = 90


def policy_for(job_type: str) -> JobPolicy:
    if not job_type:
        raise TerminalError("missing job type")
    try:
        return POLICIES[job_type]
    except KeyError:
        raise TerminalError(f"unknown job type {job_type!r}") from None


def backoff_s(policy: JobPolicy, attempts: int) -> int:
    """attempts is the value after claim (1-based). First failure waits base."""
    exponent = max(attempts - 1, 0)
    return policy.backoff_base_s * (2**exponent)


def is_retryable(exc: BaseException) -> bool:
    if isinstance(exc, (TerminalError, CapacityWait)):
        return False
    if isinstance(exc, RetryableError):
        return True
    # KeyboardInterrupt/SystemExit must not be retried; everything else is
    # bounded by the attempt budget.
    return not isinstance(exc, (KeyboardInterrupt, SystemExit))
