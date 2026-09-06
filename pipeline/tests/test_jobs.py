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


def test_model_concurrency_rejects_a_reserve_that_starves_ingest():
    from pipeline.config import parse_model_concurrency

    assert parse_model_concurrency("deepinfra:m=200/120") == {
        ("deepinfra", "m"): (200, 120)
    }
    # Inner whitespace would otherwise build a key no transport slug matches.
    assert parse_model_concurrency(" deepinfra : m = 200 / 120 ") == {
        ("deepinfra", "m"): (200, 120)
    }
    for raw in ("deepinfra:m=200/200", "deepinfra:m=0/0", "m=1/0", "deepinfra:m"):
        with pytest.raises(ValueError):
            parse_model_concurrency(raw)


def test_provider_wait_backoff_follows_retry_after_then_doubles():
    from pipeline.jobs import PROVIDER_WAIT_BACKOFF_S, provider_wait_backoff_s

    assert provider_wait_backoff_s(7.2, 0) == 8
    assert provider_wait_backoff_s(None, 0) == PROVIDER_WAIT_BACKOFF_S
    assert provider_wait_backoff_s(0, 3) == PROVIDER_WAIT_BACKOFF_S * 8


def test_unknown_errors_are_retryable():
    assert is_retryable(RuntimeError("provider 503"))
    assert is_retryable(RetryableError("chapter failed"))
    assert not is_retryable(TerminalError("file gone"))
    assert not is_retryable(CapacityWait("fast"))
    assert not is_retryable(KeyboardInterrupt())


def test_backoff_grows_with_attempts():
    assert policy_for("import").max_attempts == 4
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
