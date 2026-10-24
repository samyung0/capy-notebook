#!/usr/bin/env python3
"""The Cloudflare rules file and its apply/--check script against a fake API."""

import contextlib
import copy
import io
import ipaddress
import json
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))

import cloudflare_rules

CONFIG = json.loads(cloudflare_rules.RULES.read_text())
ZONE = "zone123"
TOKEN = "cf-test-token-not-real"


def recorded(rules: list[dict]) -> list[dict]:
    """Rules as the API returns them: with its own id, version and timestamp."""
    return [
        {"id": f"id{n}", "version": "1", "last_updated": "2026-10-19T00:00:00Z"} | rule
        for n, rule in enumerate(copy.deepcopy(rules))
    ]


class FakeApi:
    """The zone lookup and phase entry points; a phase missing from `phases` 404s."""

    def __init__(self, phases: dict[str, list[dict]]) -> None:
        self.phases = phases
        self.puts: list[tuple[str, dict]] = []

    def get(self, path: str) -> dict | None:
        if path == "/zones?name=capynotebook.com":
            return {"result": [{"id": ZONE, "name": "capynotebook.com"}]}
        phase = path.removeprefix(f"/zones/{ZONE}/rulesets/phases/").removesuffix(
            "/entrypoint"
        )
        if phase not in self.phases:
            return None
        return {"result": {"phase": phase, "rules": self.phases[phase]}}

    def put(self, path: str, body: dict) -> dict:
        self.puts.append((path, body))
        phase = path.removeprefix(f"/zones/{ZONE}/rulesets/phases/").removesuffix(
            "/entrypoint"
        )
        self.phases[phase] = recorded(body["rules"])
        return {"result": {"rules": self.phases[phase]}}


def in_sync() -> dict[str, list[dict]]:
    return {phase: recorded(rules) for phase, rules in CONFIG["phases"].items()}


def run(api: FakeApi, **flags) -> tuple[int, str]:
    out = io.StringIO()
    code = cloudflare_rules.run(
        CONFIG,
        api,
        check=flags.get("check", False),
        prune=flags.get("prune", False),
        out=out,
    )
    return code, out.getvalue()


def rule(phases: dict, phase: str, ref: str) -> dict:
    return next(r for r in phases[phase] if r["ref"] == ref)


class CheckTest(unittest.TestCase):
    def test_check_passes_when_the_zone_matches_the_file(self):
        api = FakeApi(in_sync())
        code, out = run(api, check=True)
        self.assertEqual(code, 0)
        self.assertEqual(out.count("in sync"), len(CONFIG["phases"]))

    def test_check_reports_each_kind_of_drift_and_writes_nothing(self):
        phases = in_sync()
        rule(phases, "http_request_cache_settings", "capy_app_api_bypass_cache")[
            "enabled"
        ] = False
        phases["http_request_firewall_custom"].append(
            {
                "id": "hand",
                "ref": "hand",
                "description": "added by hand",
                "expression": "true",
                "action": "skip",
                "action_parameters": {"ruleset": "current"},
                "enabled": True,
            }
        )
        del phases["http_response_headers_transform"]
        api = FakeApi(phases)

        code, out = run(api, check=True)

        self.assertEqual(code, 1)
        self.assertEqual(api.puts, [])
        self.assertIn("  ~ capy_app_api_bypass_cache:", out)
        self.assertIn('"enabled": false', out)
        self.assertIn("  - hand: added by hand (live only)", out)
        self.assertIn("  + capy_ops_no_store_noindex:", out)
        self.assertIn("http_request_firewall_custom: drift", out)

    def test_check_reports_a_reordered_phase(self):
        phases = in_sync()
        phases["http_request_cache_settings"].reverse()
        code, out = run(FakeApi(phases), check=True)
        self.assertEqual(code, 1)
        self.assertIn("  order differs", out)


class ApplyTest(unittest.TestCase):
    def test_apply_writes_the_files_rules_to_drifted_phases_only(self):
        phases = in_sync()
        rule(phases, "http_request_cache_settings", "capy_app_api_bypass_cache")[
            "expression"
        ] = "true"
        api = FakeApi(phases)

        code, out = run(api)

        self.assertEqual(code, 0)
        self.assertEqual(
            api.puts,
            [
                (
                    f"/zones/{ZONE}/rulesets/phases/http_request_cache_settings/entrypoint",
                    {"rules": CONFIG["phases"]["http_request_cache_settings"]},
                )
            ],
        )
        self.assertIn("http_request_cache_settings: applied", out)
        self.assertEqual(run(api, check=True)[0], 0)

    def test_apply_refuses_to_remove_live_only_rules_without_prune(self):
        phases = in_sync()
        phases["http_request_cache_settings"].append(
            {"ref": "hand", "description": "by hand", "action": "set_cache_settings"}
        )
        api = FakeApi(phases)

        code, out = run(api)
        self.assertEqual(code, 2)
        self.assertEqual(api.puts, [])
        self.assertIn(
            "refusing to remove live-only rules in http_request_cache_settings", out
        )

        self.assertEqual(run(api, prune=True)[0], 0)
        self.assertEqual(len(api.puts), 1)

    def test_apply_fails_when_the_api_does_not_echo_the_file(self):
        class Normalizing(FakeApi):
            def put(self, path, body):
                result = super().put(path, body)
                for stored in self.phases["http_request_cache_settings"]:
                    stored["action_parameters"]["origin_error_page_passthru"] = False
                return result

        phases = in_sync()
        del phases["http_request_cache_settings"]
        code, out = run(Normalizing(phases))
        self.assertEqual(code, 1)
        self.assertIn("http_request_cache_settings: still differs after the apply", out)


class TokenTest(unittest.TestCase):
    def test_the_token_goes_only_in_the_authorization_header(self):
        responses = {
            "/zones?name=capynotebook.com": {"result": [{"id": ZONE}]},
            **{
                f"/zones/{ZONE}/rulesets/phases/{phase}/entrypoint": {
                    "result": {"rules": rules}
                }
                for phase, rules in in_sync().items()
            },
        }
        requests = []

        def urlopen(request, timeout):
            requests.append(request)
            body = responses[request.full_url.removeprefix(cloudflare_rules.API)]
            return contextlib.nullcontext(io.BytesIO(json.dumps(body).encode()))

        stdout, stderr = io.StringIO(), io.StringIO()
        with (
            patch.dict(os.environ, {"CLOUDFLARE_API_TOKEN": TOKEN}),
            patch("urllib.request.urlopen", urlopen),
            contextlib.redirect_stdout(stdout),
            contextlib.redirect_stderr(stderr),
        ):
            code = cloudflare_rules.main(["--check"])

        self.assertEqual(code, 0)
        self.assertTrue(requests)
        for request in requests:
            self.assertEqual(request.get_header("Authorization"), f"Bearer {TOKEN}")
            self.assertNotIn(TOKEN, request.full_url)
        self.assertNotIn(TOKEN, stdout.getvalue() + stderr.getvalue())


class RulesFileTest(unittest.TestCase):
    """The edge rules cover production and UAT (security regression)."""

    def expression(self, phase, ref):
        return rule(CONFIG["phases"], phase, ref)["expression"]

    def test_the_uat_app_hosts_are_kept_out_of_search_indexes(self):
        noindex = rule(
            CONFIG["phases"], "http_response_headers_transform", "capy_uat_app_noindex"
        )
        for host in ("uat-app", "app.uat", "uat"):
            self.assertIn(f'"{host}.capynotebook.com"', noindex["expression"])
        self.assertEqual(
            noindex["action_parameters"]["headers"]["X-Robots-Tag"]["value"],
            "noindex, nofollow",
        )

    def test_webhooks_skip_the_security_rules_only_from_the_providers(self):
        """Security regression: rate-limit audit M5."""
        skip = rule(
            CONFIG["phases"],
            "http_request_firewall_custom",
            "capy_webhooks_skip_security",
        )
        # Human decisions: only the API hosts' webhooks (Epo 2026-10-20), and
        # only from the providers' published ranges (Epo 2026-10-24).
        prefix = (
            'http.host in {"api.capynotebook.com" "uat-api.capynotebook.com"}'
            ' and starts_with(http.request.uri.path, "/webhooks/")'
            " and ip.src in {"
        )
        self.assertTrue(skip["expression"].startswith(prefix))
        self.assertTrue(skip["expression"].endswith("}"))
        sources = skip["expression"][len(prefix) : -1].split()
        for source in sources:
            ipaddress.ip_network(source)
        # One address of each provider's list (runbook §2: refreshing them).
        self.assertIn("3.18.12.63", sources)  # Stripe
        self.assertIn("44.228.126.217", sources)  # Svix, Clerk's sender
        self.assertIn("http_ratelimit", skip["action_parameters"]["phases"])

    def test_internal_paths_are_blocked_on_every_public_host(self):
        """Security regression: rate-limit audit M4."""
        block = rule(
            CONFIG["phases"],
            "http_request_firewall_custom",
            "capy_block_internal_paths",
        )
        self.assertEqual(block["action"], "block")
        for host in (
            "api",
            "uat-api",
            "app",
            "app.uat",
            "uat-app",
            "uat",
            "collab",
            "uat-collab",
        ):
            self.assertIn(f'"{host}.capynotebook.com"', block["expression"])
        for path in ("/api/internal/", "/internal/"):
            self.assertIn(
                f'starts_with(http.request.uri.path, "{path}")', block["expression"]
            )

    def test_signed_out_api_reads_have_the_edge_rate_limit(self):
        """Security regression: rate-limit audit H1."""
        limit = rule(CONFIG["phases"], "http_ratelimit", "capy_public_api_rate_limit")
        self.assertEqual(
            limit["expression"], 'starts_with(http.request.uri.path, "/api/public/")'
        )
        self.assertEqual(limit["action"], "block")
        self.assertEqual(
            limit["ratelimit"],
            {
                "characteristics": ["ip.src", "cf.colo.id"],
                "period": 10,
                "requests_per_period": 100,
                "mitigation_timeout": 10,
            },
        )

    def test_shared_pages_are_challenged_past_600_a_minute(self):
        """Security regression: rate-limit audit Q324 (the zone on Pro)."""
        share = rule(CONFIG["phases"], "http_ratelimit", "capy_share_pages_rate_limit")
        for host in ("app", "uat-app", "app.uat", "uat"):
            self.assertIn(f'"{host}.capynotebook.com"', share["expression"])
        for path in ("/share/", "/w/"):
            self.assertIn(
                f'starts_with(http.request.uri.path, "{path}")', share["expression"]
            )
        # /p/ serves images and audio, which a challenge answer would break.
        self.assertNotIn("/p/", share["expression"])
        self.assertEqual(share["action"], "managed_challenge")
        self.assertEqual(
            share["ratelimit"],
            {
                "characteristics": ["ip.src", "cf.colo.id"],
                "period": 60,
                "requests_per_period": 600,
                "mitigation_timeout": 0,
            },
        )

    def test_the_rate_limit_phase_holds_at_most_two_rules(self):
        """Cloudflare Pro allows two rate limiting rules (Q324)."""
        self.assertLessEqual(len(CONFIG["phases"]["http_ratelimit"]), 2)

    def test_ops_and_backend_hosts_are_never_cached_in_either_environment(self):
        ops = rule(
            CONFIG["phases"],
            "http_response_headers_transform",
            "capy_ops_no_store_noindex",
        )
        headers = ops["action_parameters"]["headers"]
        self.assertEqual(
            headers["Cache-Control"], {"operation": "set", "value": "private, no-store"}
        )
        self.assertEqual(
            headers["X-Robots-Tag"]["value"], "noindex, nofollow, noarchive"
        )
        bypass = self.expression(
            "http_request_cache_settings", "capy_backend_hosts_bypass_cache"
        )
        for host in ("ops", "uat-ops"):
            self.assertIn(f'"{host}.capynotebook.com"', ops["expression"])
        for host in ("api", "collab", "ops", "uat-api", "uat-collab", "uat-ops"):
            self.assertIn(f'"{host}.capynotebook.com"', bypass)


if __name__ == "__main__":
    unittest.main()
