#!/usr/bin/env python3
"""Checks the webhook skip rule's sources against Stripe's and Svix's published lists.

`capy_webhooks_skip_security` in deploy/cloudflare/rules.json lets webhooks
skip the zone's security rules only from the providers' webhook addresses
(Clerk sends through Svix). Run at each deploy, before applying the rules:

    python3 scripts/deploy/webhook_ranges.py

Exit 0 when the rule's set equals the union of both published lists, 1 when
they differ (each missing or extra address is printed), 2 when a list cannot
be read. On a difference, put the printed union in the rule (runbook §2).
"""

from __future__ import annotations

import json
import re
import sys
import urllib.request
from pathlib import Path

RULES = Path(__file__).resolve().parents[2] / "deploy" / "cloudflare" / "rules.json"
RULE_REF = "capy_webhooks_skip_security"
STRIPE_URL = "https://stripe.com/files/ips/ips_webhooks.json"
SVIX_URL = "https://docs.svix.com/webhook-ips.json"


def rule_sources(config: dict) -> set[str]:
    """The addresses in the skip rule's `ip.src in {...}` set."""
    rules = config["phases"]["http_request_firewall_custom"]
    expression = next(rule for rule in rules if rule["ref"] == RULE_REF)["expression"]
    found = re.search(r"ip\.src in \{([^}]*)\}", expression)
    if not found:
        raise ValueError(f"{RULE_REF} has no ip.src set")
    return set(found.group(1).split())


def published(stripe: dict, svix: dict) -> set[str]:
    """Stripe's webhook addresses and every Svix region's."""
    return set(stripe["WEBHOOKS"]) | {ip for region in svix.values() for ip in region}


def drift(rule: set[str], wanted: set[str]) -> list[str]:
    """Lines naming each published address the rule lacks and each it has extra."""
    return [
        f"  + {ip} (published, not in the rule)" for ip in sorted(wanted - rule)
    ] + [f"  - {ip} (in the rule, no longer published)" for ip in sorted(rule - wanted)]


def fetch(url: str) -> dict:
    with urllib.request.urlopen(url, timeout=30) as response:
        return json.load(response)


def main() -> int:
    try:
        wanted = published(fetch(STRIPE_URL), fetch(SVIX_URL))
    except (OSError, ValueError) as error:
        print(f"cannot read the published lists: {error}", file=sys.stderr)
        return 2
    lines = drift(rule_sources(json.loads(RULES.read_text())), wanted)
    if not lines:
        print(f"{RULE_REF}: in sync with Stripe and Svix ({len(wanted)} sources)")
        return 0
    print(f"{RULE_REF}: differs from the published lists")
    for line in lines:
        print(line)
    print("published union: " + " ".join(sorted(wanted)))
    return 1


if __name__ == "__main__":
    sys.exit(main())
