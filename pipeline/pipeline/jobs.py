"""Job-queue policy and error taxonomy.

Retry knobs live here, not on the ``jobs`` row: they vary by type, and a
column would freeze a policy you can no longer change by deploying. The row
carries only state (``attempts``, ``not_before``, ``lease_expires_at``).

Retryability is a property of the error. A provider 503 should retry; "model
pins could not be resolved" never should. Unknown exceptions default to
retryable because the attempt budget bounds them.
"""

from __future__ import annotations

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


@dataclass(frozen=True)
class JobPolicy:
    max_attempts: int
    backoff_base_s: int
    timeout_s: int
    lease_s: int


# The whole job outlives the parser request and its presigned URLs. This leaves
# a ten-minute post-parse budget at the defaults for captions, embeddings, and
# recording the usage receipt.
POLICIES: dict[str, JobPolicy] = {
    "ingest": JobPolicy(
        max_attempts=3,
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
