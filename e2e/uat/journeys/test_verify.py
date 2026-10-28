"""Offline checks for the journey verifier's database and object boundaries."""

import importlib.util
import os
import unittest
from pathlib import Path
from unittest.mock import Mock, call, patch

spec = importlib.util.spec_from_file_location(
    "journey_verify", Path(__file__).with_name("verify.py")
)
verify = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verify)


class DatabaseVerificationTests(unittest.TestCase):
    def setUp(self):
        self.environment = patch.dict(
            os.environ,
            {
                "UAT_DATABASE_URL": "postgresql://capy_uat_verifier@invalid/capy_uat",
                "UAT_DATABASE_NAME": "capy_uat",
            },
        )
        self.environment.start()
        self.addCleanup(self.environment.stop)
        self.connect_patch = patch.object(verify.psycopg, "connect")
        self.connect = self.connect_patch.start()
        self.addCleanup(self.connect_patch.stop)
        self.connection = self.connect.return_value.__enter__.return_value
        self.identity = {
            "name": "capy_uat",
            "role": "capy_uat_verifier",
            "environment": "uat",
        }

    def test_connection_is_read_only_and_checks_identity_before_bound_query(self):
        identity_cursor = Mock()
        identity_cursor.fetchone.return_value = self.identity
        rows = [{"id": "user_fixture"}]
        query_cursor = Mock()
        query_cursor.fetchall.return_value = rows
        self.connection.execute.side_effect = [identity_cursor, query_cursor]
        sql, params = "SELECT id FROM users WHERE id=%s", ["user_fixture"]

        self.assertEqual(verify.database_query(sql, params), rows)

        self.connect.assert_called_once_with(
            os.environ["UAT_DATABASE_URL"],
            connect_timeout=10,
            options="-c default_transaction_read_only=on -c statement_timeout=10000",
            row_factory=verify.dict_row,
        )
        self.assertEqual(
            self.connection.execute.call_args_list,
            [
                call(
                    "SELECT current_database() AS name, current_user AS role, "
                    "current_setting('capy.environment',true) AS environment"
                ),
                call(sql, params),
            ],
        )

    def test_identity_mismatch_never_executes_requested_query(self):
        for field, value in (
            ("name", "capy_prod"),
            ("role", "capy"),
            ("environment", "production"),
            ("environment", None),
        ):
            with self.subTest(field=field, value=value):
                self.connection.execute.reset_mock()
                self.connection.execute.return_value.fetchone.return_value = {
                    **self.identity,
                    field: value,
                }

                with self.assertRaisesRegex(ValueError, "Database identity"):
                    verify.database_query("SELECT id FROM users", [])

                self.connection.execute.assert_called_once()
                self.assertIn(
                    "current_database()", self.connection.execute.call_args.args[0]
                )


class StorageEndpointTests(unittest.TestCase):
    def test_only_b2_and_r2_https_endpoints_reach_the_client(self):
        for endpoint, accepted in (
            ("https://s3.eu-central-003.backblazeb2.com", True),
            ("https://0123456789abcdef.eu.r2.cloudflarestorage.com", True),
            ("https://0123456789abcdef.r2.cloudflarestorage.com", True),
            ("http://0123456789abcdef.eu.r2.cloudflarestorage.com", False),
            ("https://evil-r2.cloudflarestorage.com", False),
            ("https://s3.amazonaws.com", False),
        ):
            with (
                self.subTest(endpoint=endpoint),
                patch.dict(
                    os.environ,
                    {
                        "B2_ENDPOINT": endpoint,
                        "B2_BUCKET": "capy-notebook-uat",
                        "B2_REGION": "auto",
                        "B2_KEY_ID": "fixture",
                        "B2_APP_KEY": "fixture",
                    },
                ),
                patch.object(verify.boto3, "client") as client,
            ):
                if accepted:
                    self.assertEqual(verify.storage()[1], "capy-notebook-uat")
                    client.assert_called_once()
                else:
                    with self.assertRaisesRegex(ValueError, "Invalid bucket endpoint"):
                        verify.storage()
                    client.assert_not_called()


class ObjectExistsTests(unittest.TestCase):
    def exists(self, head):
        client = Mock(spec=["head_object"])
        client.head_object.side_effect = head
        with patch.object(verify, "storage", return_value=(client, "capy-uat")):
            result = verify.main({"operation": "exists", "key": "sources/blob_1"})
        client.head_object.assert_called_once_with(
            Bucket="capy-uat", Key="sources/blob_1"
        )
        return result

    @staticmethod
    def error(status):
        return verify.ClientError(
            {
                "Error": {"Code": str(status)},
                "ResponseMetadata": {"HTTPStatusCode": status},
            },
            "HeadObject",
        )

    def test_a_head_answers_live_with_the_size_and_a_404_answers_gone(self):
        self.assertEqual(
            self.exists(lambda **_: {"ContentLength": 42}), {"live": True, "size": 42}
        )
        self.assertEqual(self.exists(self.error(404)), {"live": False})

    def test_any_other_refusal_fails_the_check(self):
        with self.assertRaises(verify.ClientError):
            self.exists(self.error(403))


if __name__ == "__main__":
    unittest.main()
