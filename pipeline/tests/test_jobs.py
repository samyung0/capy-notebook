"""Job queue policy and Postgres claim/retry behaviour."""

from __future__ import annotations

import pytest

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
    assert policy.max_attempts == 2
    assert backoff_s(policy, 1) == policy.backoff_base_s
    assert backoff_s(policy, 2) == policy.backoff_base_s * 2


def test_parse_and_post_parse_each_have_one_retry():
    assert policy_for("parse").max_attempts == 2
    assert policy_for("ingest").max_attempts == 2


def test_unknown_job_types_are_terminal():
    with pytest.raises(TerminalError, match="unknown job type"):
        policy_for("no_such_job")


def test_missing_job_type_is_terminal():
    with pytest.raises(TerminalError, match="missing job type"):
        policy_for("")
