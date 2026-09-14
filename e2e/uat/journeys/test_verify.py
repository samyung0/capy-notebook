"""Offline checks for the journey verifier's database and object boundaries."""

import importlib.util
import os
import unittest
from datetime import datetime, timezone
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


class ObjectVersionTests(unittest.TestCase):
    def test_all_pages_include_only_exact_object_versions_and_delete_markers(self):
        key = "files/uat-run/source"
        modified = datetime(2026, 9, 14, tzinfo=timezone.utc)

        def item(object_key, version, latest=False, size=None):
            record = {
                "Key": object_key,
                "VersionId": version,
                "IsLatest": latest,
                "LastModified": modified,
            }
            if size is not None:
                record["Size"] = size
            return record

        client = Mock(spec=["get_paginator"])
        paginator = client.get_paginator.return_value
        paginator.paginate.return_value = [
            {
                "Versions": [
                    item(key, "current", True, 42),
                    item(key + ".neighbor", "unrelated", True, 100),
                ],
                "DeleteMarkers": [item(key + "/child", "unrelated-marker", True)],
            },
            {
                "Versions": [item(key, "older", size=40)],
                "DeleteMarkers": [item(key, "deleted")],
            },
            {},
        ]
        with patch.object(verify, "storage", return_value=(client, "capy-uat")):
            result = verify.main({"operation": "versions", "key": key})

        self.assertEqual(
            result,
            [
                {
                    "id": version,
                    "latest": latest,
                    "deleteMarker": marker,
                    "size": size,
                    "modified": modified.isoformat(),
                }
                for version, latest, marker, size in (
                    ("current", True, False, 42),
                    ("older", False, False, 40),
                    ("deleted", False, True, 0),
                )
            ],
        )
        client.get_paginator.assert_called_once_with("list_object_versions")
        paginator.paginate.assert_called_once_with(Bucket="capy-uat", Prefix=key)


if __name__ == "__main__":
    unittest.main()
