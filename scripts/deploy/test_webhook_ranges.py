#!/usr/bin/env python3
"""The webhook range check's comparison against fixture lists (review M-5)."""

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import webhook_ranges

# The lists as published on 2026-10-24.
STRIPE = {
    "WEBHOOKS": [
        "3.18.12.63",
        "3.69.109.8",
        "3.120.168.93",
        "3.130.192.231",
        "13.235.14.237",
        "13.235.122.149",
        "18.211.135.69",
        "35.154.171.200",
        "35.157.207.129",
        "52.15.183.38",
        "54.88.130.119",
        "54.88.130.237",
        "54.187.174.169",
        "54.187.205.235",
        "54.187.216.72",
    ]
}
SVIX = {
    "us": [
        "44.228.126.217",
        "50.112.21.217",
        "52.24.126.164",
        "54.148.139.208",
        "2600:1f24:64:8000::/56",
    ],
    "us-east": ["54.164.207.221", "54.90.7.123", "2600:1f28:37:4000::/56"],
    "eu": ["52.215.16.239", "54.216.8.72", "63.33.109.123", "2a05:d028:17:8000::/56"],
    "au": ["13.239.204.236", "54.66.246.217", "54.252.65.96", "2406:da2c:13:4000::/56"],
    "ca": ["52.60.44.49", "3.98.68.230", "3.96.105.27", "2600:1f21:1c:4000::/56"],
}
CONFIG = json.loads(webhook_ranges.RULES.read_text())


class WebhookRangesTest(unittest.TestCase):
    """Security regression: rate-limit audit M5, review M-5."""

    def test_the_rule_holds_both_published_lists(self):
        rule = webhook_ranges.rule_sources(CONFIG)
        self.assertEqual(
            webhook_ranges.drift(rule, webhook_ranges.published(STRIPE, SVIX)), []
        )

    def test_a_new_provider_address_is_reported_missing(self):
        rule = webhook_ranges.rule_sources(CONFIG)
        svix = SVIX | {"ap": ["203.0.113.7"]}
        stripe = {"WEBHOOKS": STRIPE["WEBHOOKS"] + ["198.51.100.9"]}
        self.assertEqual(
            webhook_ranges.drift(rule, webhook_ranges.published(stripe, svix)),
            [
                "  + 198.51.100.9 (published, not in the rule)",
                "  + 203.0.113.7 (published, not in the rule)",
            ],
        )

    def test_a_retired_address_is_reported_extra(self):
        rule = webhook_ranges.rule_sources(CONFIG)
        stripe = {"WEBHOOKS": STRIPE["WEBHOOKS"][1:]}
        self.assertEqual(
            webhook_ranges.drift(rule, webhook_ranges.published(stripe, SVIX)),
            ["  - 3.18.12.63 (in the rule, no longer published)"],
        )


if __name__ == "__main__":
    unittest.main()
