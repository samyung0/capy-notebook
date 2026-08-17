"""Job queue policy and Postgres claim/retry behaviour."""

from __future__ import annotations

from pipeline.jobs import (
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
    assert not is_retryable(KeyboardInterrupt())


def test_backoff_grows_with_attempts():
    policy = policy_for("ingest")
    assert backoff_s(policy, 1) == policy.backoff_base_s
    assert backoff_s(policy, 2) == policy.backoff_base_s * 2
    assert backoff_s(policy, 3) == policy.backoff_base_s * 4


def test_rollup_budget_is_three_attempts():
    assert policy_for("summaries_rollup").max_attempts == 3
