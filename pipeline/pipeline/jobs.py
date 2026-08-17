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


class RetryableError(Exception):
    """The worker should re-pend this job against its attempt budget."""


class TerminalError(Exception):
    """Do not retry. The job is failed and, for ingest, the file is failed."""


@dataclass(frozen=True)
class JobPolicy:
    max_attempts: int
    backoff_base_s: int
    timeout_s: int
    lease_s: int


# Ingest timeout sits above MODAL_PARSE_TIMEOUT (900s) plus captioning and
# embed. A timeout that kills a legitimate parse wastes the GPU work already
# in flight — the B2 zip is only recorded after MinerU returns.
POLICIES: dict[str, JobPolicy] = {
    "ingest": JobPolicy(max_attempts=3, backoff_base_s=30, timeout_s=1800, lease_s=180),
    "summaries_rollup": JobPolicy(
        max_attempts=3, backoff_base_s=15, timeout_s=300, lease_s=60
    ),
}

DEFAULT_POLICY = POLICIES["ingest"]

# After this long a waiter starts trying to steal a processing rag_contents
# claim. The job wall-clock timeout is the hard bound; this is only the
# steal-attempt threshold. A SIGKILLed creator never runs abandon_content.
CONTENT_CLAIM_WAIT_S = 120
# Must exceed the heartbeat interval so a live creator is not stolen.
CONTENT_CLAIM_STALE_S = 90


def policy_for(job_type: str) -> JobPolicy:
    return POLICIES.get(job_type, DEFAULT_POLICY)


def backoff_s(policy: JobPolicy, attempts: int) -> int:
    """attempts is the value after claim (1-based). First failure waits base."""
    exponent = max(attempts - 1, 0)
    return policy.backoff_base_s * (2**exponent)


def is_retryable(exc: BaseException) -> bool:
    if isinstance(exc, TerminalError):
        return False
    if isinstance(exc, RetryableError):
        return True
    # KeyboardInterrupt/SystemExit must not be retried; everything else is
    # bounded by the attempt budget.
    return not isinstance(exc, (KeyboardInterrupt, SystemExit))
