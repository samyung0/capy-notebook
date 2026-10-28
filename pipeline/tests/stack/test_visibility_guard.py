"""The lane calls no provider: the scripted model answers every completion
(an extra one fails the turn), embeddings are the stub, and any connection
off the loopback is refused and fails the test."""

from __future__ import annotations

import pytest
import requests

pytestmark = pytest.mark.stack


def test_a_connection_off_the_loopback_fails_the_test(no_provider):
    with pytest.raises(requests.ConnectionError):
        requests.get("https://198.51.100.7/v1/embeddings", timeout=5)
    assert no_provider == [("198.51.100.7", 443)]
    no_provider.clear()  # this test's own attempt
