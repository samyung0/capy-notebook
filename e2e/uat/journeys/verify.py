"""UAT PostgreSQL and bucket verification using the existing Python runtime.

Read-only, except the credits journey's one raise of used credits.
"""

import base64
import hashlib
import json
import os
import sys
from datetime import date, datetime
from decimal import Decimal
from urllib.parse import urlparse

import boto3
import psycopg
from botocore.config import Config
from botocore.exceptions import ClientError
from psycopg.rows import dict_row


def encode(value):
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    if isinstance(value, Decimal):
        return str(value)
    raise TypeError("Query must explicitly encode binary columns")


def connect():
    return psycopg.connect(
        os.environ["UAT_DATABASE_URL"],
        connect_timeout=10,
        options="-c default_transaction_read_only=on -c statement_timeout=10000",
        row_factory=dict_row,
    )


def check_identity(connection):
    identity = connection.execute(
        "SELECT current_database() AS name, current_user AS role, "
        "current_setting('capy.environment',true) AS environment"
    ).fetchone()
    if (
        identity["name"] != os.environ["UAT_DATABASE_NAME"]
        or identity["role"] != "capy_uat_verifier"
        or identity["environment"] != "uat"
    ):
        raise ValueError("Database identity is not the configured UAT verifier")


def database_query(sql, params):
    with connect() as connection:
        check_identity(connection)
        # Every invocation opens a new read-only transaction, including cleanup.
        return connection.execute(sql, params).fetchall()


def raise_credits_used(user_id, used_micros):
    """The verifier's one write: scripts/uat/journey-credits.sql (Q496)."""
    with connect() as connection:
        check_identity(connection)
        # The identity read opened the session's read-only transaction; READ
        # WRITE must be the first statement of the next one.
        connection.commit()
        connection.execute("SET TRANSACTION READ WRITE")
        connection.execute(
            "SELECT public.uat_journey_raise_credits_used(%s::text, %s::bigint)",
            [user_id, used_micros],
        )


def storage():
    endpoint = urlparse(os.environ["B2_ENDPOINT"])
    bucket = os.environ["B2_BUCKET"]
    # The B2_* settings name the R2 bucket after the move (Q474, Q487); B2
    # stays accepted until the B2 UAT bucket is gone.
    if endpoint.scheme != "https" or not (endpoint.hostname or "").endswith(
        (".backblazeb2.com", ".r2.cloudflarestorage.com")
    ):
        raise ValueError("Invalid bucket endpoint")
    if "uat" not in bucket.replace("_", "-").split("-"):
        raise ValueError("A dedicated UAT bucket is required")
    return boto3.client(
        "s3",
        endpoint_url=os.environ["B2_ENDPOINT"],
        region_name=os.environ["B2_REGION"],
        aws_access_key_id=os.environ["B2_KEY_ID"],
        aws_secret_access_key=os.environ["B2_APP_KEY"],
        config=Config(
            signature_version="s3v4",
            retries={"total_max_attempts": 1},
            connect_timeout=10,
            read_timeout=30,
        ),
    ), bucket


def main(request):
    if request["operation"] == "query":
        return database_query(request["sql"], request.get("params", []))
    if request["operation"] == "raise-credits-used":
        return raise_credits_used(request["userId"], request["usedMicros"])
    client, bucket = storage()
    if request["operation"] == "storage-identity":
        client.head_bucket(Bucket=bucket)
        return {"bucket": bucket}
    key = request["key"]
    if request["operation"] == "blob":
        response = client.get_object(Bucket=bucket, Key=key)
        with response["Body"] as stream:
            data = stream.read(64 * 1024 * 1024 + 1)
        if len(data) > 64 * 1024 * 1024:
            raise ValueError("Fixture blob exceeds the verifier's 64 MiB limit")
        return {
            "sha256": hashlib.sha256(data).hexdigest(),
            "size": len(data),
            "contentType": response.get("ContentType", ""),
            "bodyBase64": base64.b64encode(data).decode(),
        }
    if request["operation"] == "exists":
        # R2 has no object versions (ListObjectVersions answers 501), so a key
        # is live or gone; on B2 a hidden key heads as 404 too.
        try:
            head = client.head_object(Bucket=bucket, Key=key)
        except ClientError as error:
            if error.response["ResponseMetadata"]["HTTPStatusCode"] == 404:
                return {"live": False}
            raise
        return {"live": True, "size": head["ContentLength"]}
    raise ValueError("Unknown verifier operation")


if __name__ == "__main__":
    try:
        print(json.dumps(main(json.load(sys.stdin)), default=encode))
    except Exception as error:  # noqa: BLE001 - never emit credential-bearing SDK errors
        # SDK exceptions can contain signed URLs, DSNs and request credentials.
        print(
            f"UAT verifier failed ({type(error).__name__}); check configured access and scoped resource IDs",
            file=sys.stderr,
        )
        sys.exit(1)
