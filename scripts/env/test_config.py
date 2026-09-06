#!/usr/bin/env python3
import contextlib
import importlib.util
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "config", Path(__file__).with_name("config.py")
)
config = importlib.util.module_from_spec(spec)
spec.loader.exec_module(config)


class ConfigTest(unittest.TestCase):
    def test_literal_parser_classification_and_duplicate_rejection(self):
        value = "$(do-not-run) `${HOME}` #still-secret"
        parsed = config.parse_dotenv(
            "POSTGRES_PASSWORD='" + value + "'\nVITE_POSTHOG_KEY=public # comment\n"
        )
        self.assertEqual(parsed["POSTGRES_PASSWORD"], value)
        self.assertEqual(
            config.classify(parsed),
            {"POSTGRES_PASSWORD": "secret", "VITE_POSTHOG_KEY": "variable"},
        )
        with self.assertRaisesRegex(ValueError, "duplicate"):
            config.parse_dotenv("POSTGRES_PASSWORD=a\nPOSTGRES_PASSWORD=b")
        with self.assertRaisesRegex(ValueError, "unknown"):
            config.classify({"UNCLASSIFIED_SECRET": "never printed"})

    def test_github_requires_known_keys_and_correct_namespace(self):
        with patch.dict(
            config.os.environ,
            {
                "CAPY_GITHUB_VARS": json.dumps(
                    {"DEPLOYMENT_OPS_URL": "https://uat-ops.example.com"}
                ),
                "CAPY_GITHUB_SECRETS": "{}",
            },
        ):
            self.assertEqual(
                config.github_values(),
                {"DEPLOYMENT_OPS_URL": "https://uat-ops.example.com"},
            )
        with (
            patch.dict(
                config.os.environ,
                {
                    "CAPY_GITHUB_VARS": json.dumps({"POSTGRES_PASSWORD": "private"}),
                    "CAPY_GITHUB_SECRETS": "{}",
                },
            ),
            self.assertRaisesRegex(ValueError, "wrong GitHub namespace"),
        ):
            config.github_values()
        with (
            patch.dict(
                config.os.environ,
                {
                    "CAPY_GITHUB_VARS": "{}",
                    "CAPY_GITHUB_SECRETS": json.dumps(
                        {"NEW_UNCLASSIFIED_SECRET": "private"}
                    ),
                },
            ),
            self.assertRaisesRegex(ValueError, "unknown GitHub configuration keys"),
        ):
            config.github_values()

    def test_render_clears_optional_values_and_encodes_credentials(self):
        values = {
            key: "explicit"
            for key, rule in config.MANIFEST.items()
            if rule.get("required_for")
        }
        values.update(
            POSTGRES_PASSWORD="a@/:?$#% b",
            CAPY_PRIVATE_BIND_ADDRESS="10.77.0.3",
            CLERK_PUBLISHABLE_KEY="pk_public",
            DEPLOYMENT_APP_URL="https://uat.example.com",
        )
        with tempfile.TemporaryDirectory() as temp:
            with contextlib.redirect_stdout(io.StringIO()):
                config.render(values, "uat", temp, "a" * 40)
            queue = config.parse_dotenv(Path(temp, "uat.queue.env").read_text())
            self.assertEqual(
                queue["DATABASE_URL"],
                "postgres://capy:a%40%2F%3A%3F%24%23%25%20b@10.77.0.3:5432/capy?sslmode=disable",
            )
            self.assertEqual(queue["GATEWAY_URL"], "http://10.77.0.3:8080")
            self.assertNotIn(
                "DATABASE_URL",
                config.parse_dotenv(Path(temp, "nonprod.env").read_text()),
            )
            self.assertEqual(
                json.loads(Path(temp, "coolify.json").read_text())["OPENAI_API_KEY"], ""
            )
            self.assertEqual(Path(temp, "uat.queue.env").stat().st_mode & 0o777, 0o600)

    def test_coolify_payload_and_redacted_readback(self):
        secret = "never-disclose-this-value"
        values = {"POSTGRES_PASSWORD": secret, "OPENAI_API_KEY": ""}
        payload = config.coolify_payload(values)
        rows = payload["data"]
        for row in rows:
            self.assertIs(row["is_literal"], True)
            self.assertIs(row["is_preview"], False)
            self.assertIs(row["is_shown_once"], False)
        returned = [dict(row) for row in rows]
        returned[0]["value"] = None  # empty API values normalize to null
        with patch.object(config, "coolify_request", side_effect=[[], returned]) as api:
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                config.apply_coolify(values)
            self.assertNotIn(secret, output.getvalue())
            self.assertEqual(
                api.call_args_list[0].args, ("PATCH", "/envs/bulk", payload)
            )

    def test_ops_render_needs_only_ops_config_and_excludes_app_secrets(self):
        values = {
            key: "configured"
            for key, rule in config.MANIFEST.items()
            if "ops" in rule.get("required_for", [])
        }
        values.update(
            OPS_INGEST_PRIMARY_ENVIRONMENT="uat",
            POSTGRES_PASSWORD="app-owner-secret",
            STRIPE_SECRET_KEY="billing-secret",
            OPS_AUTH_DISABLED="true",
        )
        with tempfile.TemporaryDirectory() as temp:
            with contextlib.redirect_stdout(io.StringIO()) as output:
                config.render_ops(values, "uat", temp, "a" * 40)
            self.assertEqual(list(Path(temp).iterdir()), [Path(temp, "ops.json")])
            rendered = json.loads(Path(temp, "ops.json").read_text())
            self.assertEqual(rendered["VITE_CLERK_PUBLISHABLE_KEY"], "configured")
            self.assertEqual(rendered["RELEASE_SHA"], "a" * 40)
            self.assertEqual(rendered["SENTRY_ENVIRONMENT"], "uat")
            self.assertEqual(rendered["OPS_INGEST_LOCAL_DATABASE_URL"], "")
            self.assertNotIn("CLERK_PUBLISHABLE_KEY", rendered)
            self.assertNotIn("POSTGRES_PASSWORD", rendered)
            self.assertNotIn("STRIPE_SECRET_KEY", rendered)
            self.assertNotIn("OPS_AUTH_DISABLED", rendered)
            self.assertEqual(Path(temp, "ops.json").stat().st_mode & 0o777, 0o600)
            self.assertNotIn("configured", output.getvalue())
            self.assertNotIn("coolify", config.MANIFEST["OPS_DATABASE_URL"]["targets"])

    def test_ops_render_rejects_missing_required_config_and_wrong_environment(self):
        values = {
            key: "configured"
            for key, rule in config.MANIFEST.items()
            if "ops" in rule.get("required_for", [])
        }
        with tempfile.TemporaryDirectory() as temp:
            with self.assertRaisesRegex(ValueError, "must match"):
                config.render_ops(values, "uat", temp, "a" * 40)
            values["OPS_INGEST_PRIMARY_ENVIRONMENT"] = "uat"
            values["OPS_DATABASE_URL"] = ""
            with self.assertRaisesRegex(ValueError, "OPS_DATABASE_URL is required"):
                config.render_ops(values, "uat", temp, "a" * 40)
            self.assertFalse(Path(temp, "ops.json").exists())

    def test_ops_target_refuses_main_stack_or_wrong_compose(self):
        with (
            patch.dict(
                config.os.environ,
                {
                    "COOLIFY_RESOURCE_UUID": "main",
                    "COOLIFY_MAIN_RESOURCE_UUID": "main",
                },
            ),
            patch.object(config, "coolify_request") as api,
        ):
            with self.assertRaisesRegex(ValueError, "separate"):
                config.verify_ops_target()
            api.assert_not_called()
            config.os.environ["COOLIFY_RESOURCE_UUID"] = "ops"
            api.return_value = {
                "docker_compose_location": "/deploy/docker-compose.prod.yml"
            }
            with self.assertRaisesRegex(ValueError, "docker-compose.ops.yml"):
                config.verify_ops_target()
            api.return_value = {
                "docker_compose_location": "/deploy/docker-compose.ops.yml",
                "settings": {"connect_to_docker_network": True},
                "destination_id": 0,
                "destination_type": "App\\Models\\StandaloneDocker",
            }
            with contextlib.redirect_stdout(io.StringIO()):
                config.verify_ops_target()
            self.assertTrue(all(call.args[0] == "GET" for call in api.call_args_list))
            ops = api.return_value
            api.side_effect = [
                ops,
                {**ops, "settings": {"connect_to_docker_network": False}},
            ]
            with self.assertRaisesRegex(ValueError, "Predefined Network"):
                config.verify_ops_target()
            api.side_effect = [ops, {**ops, "destination_id": 1}]
            with self.assertRaisesRegex(ValueError, "share a Coolify destination"):
                config.verify_ops_target()

    def test_coolify_removes_replaced_and_retired_keys_after_verification(
        self,
    ):
        values = {"CAPY_PRIVATE_BIND_ADDRESS": "10.77.0.3"}
        current = config.coolify_payload(values)["data"]
        retired = [
            {"key": key, "uuid": f"retired-{index}", "is_preview": False}
            for index, key in enumerate(
                (
                    "EVO_PRIVATE_BIND_ADDRESS",
                    "EVO_QUERY_MODEL",
                    "IMPORT_RELAY_ENQUEUE_URL",
                    "IMPORT_RELAY_SECRET",
                )
            )
        ]
        preserved = [
            {"key": "EVO_UNRELATED", "uuid": "unrelated"},
            {"key": "OPERATOR_SETTING", "uuid": "operator"},
        ]
        with (
            patch.object(
                config,
                "coolify_request",
                side_effect=[
                    [],
                    current + retired + preserved,
                    {},
                    {},
                    {},
                    {},
                    current + preserved,
                ],
            ) as api,
            contextlib.redirect_stdout(io.StringIO()),
        ):
            config.apply_coolify(values)
        self.assertEqual(
            [call.args[:2] for call in api.call_args_list],
            [
                ("PATCH", "/envs/bulk"),
                ("GET", "/envs"),
                ("DELETE", "/envs/retired-0"),
                ("DELETE", "/envs/retired-1"),
                ("DELETE", "/envs/retired-2"),
                ("DELETE", "/envs/retired-3"),
                ("GET", "/envs"),
            ],
        )

    def test_coolify_verification_failure_never_deletes_previous_or_preview_values(
        self,
    ):
        values = {"CAPY_PRIVATE_BIND_ADDRESS": "10.77.0.3"}
        actual = config.coolify_payload(values)["data"]
        actual[0]["value"] = "mismatch"
        actual.extend(
            [
                {"key": "EVO_PRIVATE_BIND_ADDRESS", "uuid": "previous"},
                {
                    "key": "CAPY_PRIVATE_BIND_ADDRESS",
                    "is_preview": True,
                    "uuid": "preview",
                },
            ]
        )
        with (
            patch.object(config, "coolify_request", side_effect=[[], actual]) as api,
            self.assertRaisesRegex(ValueError, "readback mismatch"),
        ):
            config.apply_coolify(values)
        self.assertFalse(any(call.args[0] == "DELETE" for call in api.call_args_list))

    def test_coolify_cleanup_requires_absence_readback(self):
        values = {"CAPY_PRIVATE_BIND_ADDRESS": "10.77.0.3"}
        actual = config.coolify_payload(values)["data"] + [
            {"key": "IMPORT_RELAY_SECRET", "uuid": "relay"}
        ]
        with (
            patch.object(
                config, "coolify_request", side_effect=[[], actual, {}, actual]
            ),
            self.assertRaisesRegex(ValueError, "remain after cleanup"),
        ):
            config.apply_coolify(values)

    def test_recovery_requires_a_terminal_provider_job(self):
        for status in ("queued", "in_progress", "building", "unknown"):
            with (
                patch.object(
                    config, "coolify_request", return_value={"status": status}
                ),
                self.assertRaisesRegex(ValueError, "not terminal"),
            ):
                config.verify_coolify_terminal("job-id")
        with self.assertRaisesRegex(ValueError, "UUID unavailable"):
            config.verify_coolify_terminal("")
        with (
            patch.object(config, "coolify_request", return_value={"status": "failed"}),
            contextlib.redirect_stdout(io.StringIO()),
        ):
            config.verify_coolify_terminal("job-id")

    def test_secret_upload_uses_stdin_and_redacts_errors(self):
        secret = "private-value"
        with patch.object(config.subprocess, "run") as run:
            run.return_value.returncode = 0
            run.return_value.stdout = ""
            with contextlib.redirect_stdout(io.StringIO()) as output:
                config.push({"POSTGRES_PASSWORD": secret}, "uat", "owner/repo")
            self.assertEqual(run.call_args.kwargs["input"], secret)
            self.assertNotIn(secret, " ".join(run.call_args.args[0]))
            self.assertNotIn(secret, output.getvalue())
            run.return_value.returncode = 1
            run.return_value.stderr = secret
            with self.assertRaisesRegex(ValueError, "response redacted"):
                config.push({"POSTGRES_PASSWORD": secret}, "uat", "owner/repo")


if __name__ == "__main__":
    unittest.main()
