#!/usr/bin/env python3
"""Applies deploy/cloudflare/rules.json to the zone, or with --check reports drift.

The file owns every phase it lists: each phase's entry point ruleset must hold
exactly the file's rules, in order, and nothing else. Rules match by `ref`.
Phases the file does not list are never read or written.

    CLOUDFLARE_API_TOKEN=... python3 scripts/deploy/cloudflare_rules.py --check
    CLOUDFLARE_API_TOKEN=... python3 scripts/deploy/cloudflare_rules.py

--check exits 1 on drift and writes nothing. An apply replaces each drifted
phase's rules with the file's, then reads them back. It refuses to remove a
live rule the file does not list unless given --prune. The token is sent only
in the Authorization header and never printed.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Protocol, TextIO

API = "https://api.cloudflare.com/client/v4"
RULES = Path(__file__).resolve().parents[2] / "deploy" / "cloudflare" / "rules.json"
# The rule fields the file sets; the API's own (id, version, last_updated) are ignored.
KEYS = (
    "ref",
    "description",
    "expression",
    "action",
    "action_parameters",
    "ratelimit",
    "logging",
    "enabled",
)


class ApiError(Exception):
    pass


class Api(Protocol):
    def get(self, path: str) -> dict | None: ...

    def put(self, path: str, body: dict) -> dict: ...


class CloudflareApi:
    def __init__(self, token: str) -> None:
        self._token = token

    def _call(self, method: str, path: str, body: dict | None = None) -> dict | None:
        request = urllib.request.Request(
            API + path,
            method=method,
            data=None if body is None else json.dumps(body).encode(),
            headers={
                "Authorization": f"Bearer {self._token}",
                "Content-Type": "application/json",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            if method == "GET" and error.code == 404:
                return None
            try:
                errors = json.load(error).get("errors", [])
            except ValueError:
                errors = []
            messages = "; ".join(f"{e.get('code')}: {e.get('message')}" for e in errors)
            raise ApiError(f"{method} {path}: HTTP {error.code} {messages}") from None
        except urllib.error.URLError as error:
            raise ApiError(f"{method} {path}: {error.reason}") from None

    def get(self, path: str) -> dict | None:
        return self._call("GET", path)

    def put(self, path: str, body: dict) -> dict:
        return self._call("PUT", path, body) or {}


def zone_id(api: Api, name: str) -> str:
    found = (api.get("/zones?" + urllib.parse.urlencode({"name": name})) or {}).get(
        "result", []
    )
    if len(found) != 1:
        raise ApiError(f"zone {name}: expected one zone, found {len(found)}")
    return found[0]["id"]


def live_rules(api: Api, zone: str, phase: str) -> list[dict]:
    """The phase entry point's rules; a phase without an entry point has none."""
    found = api.get(f"/zones/{zone}/rulesets/phases/{phase}/entrypoint")
    return ((found or {}).get("result") or {}).get("rules") or []


def managed(rule: dict) -> dict:
    return {"enabled": True} | {key: rule[key] for key in KEYS if key in rule}


def drift(want: list[dict], have: list[dict]) -> list[str]:
    """Lines describing how the live rules differ from the file's; none when in sync."""
    want = [managed(rule) for rule in want]
    have = [managed(rule) for rule in have]
    if want == have:
        return []
    live = {rule.get("ref"): rule for rule in have}
    wanted = {rule["ref"] for rule in want}
    lines = []
    for rule in want:
        if rule["ref"] not in live:
            lines.append(f"  + {rule['ref']}: {rule.get('description', '')}")
        elif live[rule["ref"]] != rule:
            lines.append(f"  ~ {rule['ref']}: {rule.get('description', '')}")
            lines.append(f"      file: {json.dumps(rule, sort_keys=True)}")
            lines.append(f"      live: {json.dumps(live[rule['ref']], sort_keys=True)}")
    for rule in have:
        if rule.get("ref") not in wanted:
            lines.append(
                f"  - {rule.get('ref')}: {rule.get('description', '')} (live only)"
            )
    return lines or ["  order differs"]


def run(config: dict, api: Api, *, check: bool, prune: bool, out: TextIO) -> int:
    phases = config["phases"]
    for phase, rules in phases.items():
        refs = [rule.get("ref") for rule in rules]
        if None in refs or len(set(refs)) != len(refs):
            raise ApiError(f"{phase}: every rule in the file needs its own ref")
    zone = zone_id(api, config["zone"])
    changes = {}
    for phase, rules in phases.items():
        lines = drift(rules, live_rules(api, zone, phase))
        print(f"{phase}: {'drift' if lines else 'in sync'}", file=out)
        for line in lines:
            print(line, file=out)
        if lines:
            changes[phase] = lines
    if check or not changes:
        return 1 if changes else 0
    removals = [
        phase
        for phase, lines in changes.items()
        if any(line.startswith("  - ") for line in lines)
    ]
    if removals and not prune:
        print(
            f"refusing to remove live-only rules in {', '.join(removals)}: add them to "
            "the file, or rerun with --prune to delete them",
            file=out,
        )
        return 2
    for phase in changes:
        api.put(
            f"/zones/{zone}/rulesets/phases/{phase}/entrypoint",
            {"rules": phases[phase]},
        )
        print(f"{phase}: applied", file=out)
    stale = [p for p in changes if drift(phases[p], live_rules(api, zone, p))]
    for phase in stale:
        print(
            f"{phase}: still differs after the apply; align the file with the API",
            file=out,
        )
    return 1 if stale else 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--check",
        action="store_true",
        help="report drift, exit 1 on any, write nothing",
    )
    parser.add_argument(
        "--prune", action="store_true", help="let the apply delete live-only rules"
    )
    parser.add_argument(
        "--rules", type=Path, default=RULES, help="rules file (default: %(default)s)"
    )
    args = parser.parse_args(argv)
    token = os.environ.get("CLOUDFLARE_API_TOKEN", "")
    if not token:
        print("CLOUDFLARE_API_TOKEN is not set", file=sys.stderr)
        return 2
    config = json.loads(args.rules.read_text())
    try:
        return run(
            config,
            CloudflareApi(token),
            check=args.check,
            prune=args.prune,
            out=sys.stdout,
        )
    except ApiError as error:
        print(error, file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
