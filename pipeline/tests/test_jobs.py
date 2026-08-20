"""Job queue policy and Postgres claim/retry behaviour."""

from __future__ import annotations

from pipeline.jobs import (
    CapacityWait,
    RetryableError,
    TerminalError,
    backoff_s,
    is_retryable,
    policy_for,
)


def test_unknown_errors_are_retryable():
    assert is_retryable(RuntimeError("provider 503"))
    assert is_retryable(RetryableError("chapter failed"))
    assert not is_retryable(TerminalError("file gone"))
    assert not is_retryable(CapacityWait("fast"))
    assert not is_retryable(KeyboardInterrupt())


def test_backoff_grows_with_attempts():
    policy = policy_for("ingest")
    assert backoff_s(policy, 1) == policy.backoff_base_s
    assert backoff_s(policy, 2) == policy.backoff_base_s * 2
    assert backoff_s(policy, 3) == policy.backoff_base_s * 4


def test_unknown_job_types_use_the_ingest_policy():
    assert policy_for("no_such_job").max_attempts == policy_for("ingest").max_attempts
