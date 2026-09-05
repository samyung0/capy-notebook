#!/usr/bin/env python3
"""Small offline checks for UAT targeting, identity reuse and SSH quoting."""

import importlib.util
import shlex
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock

spec = importlib.util.spec_from_file_location(
    "uat_seed", Path(__file__).with_name("seed.py")
)
seed = importlib.util.module_from_spec(spec)
spec.loader.exec_module(seed)


class SeedTest(unittest.TestCase):
    def user(self):
        return {
            "id": "user_fixture1",
            "banned": False,
            "locked": False,
            "primary_email_address_id": "email_1",
            "email_addresses": [
                {
                    "id": "email_1",
                    "email_address": "capy-uat-owner+clerk_test@stablestudio.org",
                    "verification": {"status": "verified"},
                }
            ],
        }

    def test_target_is_explicitly_uat(self):
        values = {
            "DEPLOYMENT_APP_URL": seed.APP_URL,
            "CLERK_SECRET_KEY": "sk_test_synthetic",
        }
        seed.validate_config(values)
        for changed in (
            {"DEPLOYMENT_APP_URL": "https://capynotebook.com"},
            {"DEPLOYMENT_API_URL": "https://api.capynotebook.com"},
        ):
            with self.assertRaises(seed.SeedError):
                seed.validate_config({**values, **changed})

    def test_clerk_key_must_match_primary_uat_domain(self):
        primary = {
            "name": "uat.capynotebook.com",
            "is_satellite": False,
            "frontend_api_url": "https://clerk.uat.capynotebook.com",
        }
        client = Mock()
        client.request.return_value = {"data": [primary]}
        seed.verify_instance(client)
        client.request.assert_called_once_with("GET", "/domains")
        for domains in (
            [],
            [{**primary, "is_satellite": True}],
            [{**primary, "name": "capynotebook.com"}],
            [{**primary, "frontend_api_url": "https://clerk.capynotebook.com"}],
            [primary, {**primary, "name": "other.example.com"}],
        ):
            client.request.return_value = {"data": domains}
            with self.assertRaises(seed.SeedError):
                seed.verify_instance(client)

    def test_existing_actor_is_read_back_without_mutation(self):
        client = Mock()
        client.request.side_effect = [[self.user()], self.user()]
        actor = seed.ensure_actor(client, "owner")
        self.assertEqual(actor["id"], "user_fixture1")
        self.assertTrue(
            all(call.args[0] == "GET" for call in client.request.call_args_list)
        )

    def test_creation_uses_verified_email_without_password_or_invitation(self):
        client = Mock()
        client.request.side_effect = [[], self.user(), self.user()]
        seed.ensure_actor(client, "owner")
        self.assertEqual(
            client.request.call_args_list[1].args,
            (
                "POST",
                "/users",
                {
                    "email_address": ["capy-uat-owner+clerk_test@stablestudio.org"],
                    "first_name": "Capy UAT Owner",
                    "skip_password_requirement": True,
                },
            ),
        )

    def test_unavailable_or_unverified_identity_is_preserved(self):
        for field in ("banned", "locked"):
            user = self.user()
            user[field] = True
            client = Mock()
            client.request.return_value = [user]
            with self.assertRaises(seed.SeedError):
                seed.ensure_actor(client, "owner")
            self.assertEqual(client.request.call_count, 1)
        user = self.user()
        user["email_addresses"][0]["verification"]["status"] = "unverified"
        with self.assertRaises(seed.SeedError):
            seed.verify_user(user, user["email_addresses"][0]["email_address"])

    def test_remote_json_is_one_quoted_argument(self):
        with tempfile.NamedTemporaryFile() as key:
            payload = {"actors": [{"name": "a' $(touch NEVER) `false`"}]}
            command = seed.remote_command(key.name, "postgres-uat", payload)
            remote = shlex.split(command[-1])
            self.assertIn("root@159.195.250.206", command)
            self.assertIn("StrictHostKeyChecking=yes", command)
            self.assertEqual(remote[-2], "-v")
            self.assertTrue(remote[-1].startswith("seed={"))
            self.assertIn("$(touch NEVER)", remote[-1])
            with self.assertRaises(seed.SeedError):
                seed.remote_command(key.name, "postgres; false", payload)


if __name__ == "__main__":
    unittest.main()
