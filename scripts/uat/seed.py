#!/usr/bin/env python3
"""Create approved Clerk UAT actors and initialize their isolated SQL fixture."""

import argparse
import json
import re
import shlex
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "env"))
from config import parse_dotenv

ROLES = ("owner", "editor", "commenter", "viewer", "other")
APP_URL = "https://uat.capynotebook.com"
API_URL = "https://uat-api.capynotebook.com"


class SeedError(Exception):
    pass


def validate_config(values):
    if values.get("DEPLOYMENT_APP_URL") != APP_URL:
        raise SeedError("DEPLOYMENT_APP_URL must select the approved UAT hostname")
    if values.get("DEPLOYMENT_API_URL") not in (None, "", API_URL):
        raise SeedError("DEPLOYMENT_API_URL must select the approved UAT API hostname")
    if not re.fullmatch(
        r"sk_(test|live)_[A-Za-z0-9]+", values.get("CLERK_SECRET_KEY", "")
    ):
        raise SeedError("CLERK_SECRET_KEY is missing or invalid")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


class Clerk:
    def __init__(self, key):
        self.key = key

    def request(self, method, path, body=None):
        request = urllib.request.Request(
            "https://api.clerk.com/v1" + path,
            data=json.dumps(body).encode() if body is not None else None,
            method=method,
            headers={
                "Authorization": "Bearer " + self.key,
                "Content-Type": "application/json",
                "Accept": "application/json",
                "User-Agent": "Capy Notebook UAT initialization",
            },
        )
        try:
            with urllib.request.build_opener(NoRedirect).open(
                request, timeout=30
            ) as response:
                return json.load(response)
        except (urllib.error.URLError, OSError, ValueError):
            raise SeedError(
                "Clerk request failed; response withheld. Rerun to reuse any created accounts."
            ) from None


def verify_instance(clerk):
    response = clerk.request("GET", "/domains")
    domains = response.get("data") if isinstance(response, dict) else None
    if not isinstance(domains, list) or any(
        not isinstance(domain, dict) for domain in domains
    ):
        raise SeedError("Clerk domain readback is invalid; no accounts were changed")
    primary = [domain for domain in domains if domain.get("is_satellite") is not True]
    if (
        len(primary) != 1
        or primary[0].get("is_satellite") is not False
        or primary[0].get("name") != "uat.capynotebook.com"
        or primary[0].get("frontend_api_url") != "https://clerk.uat.capynotebook.com"
    ):
        raise SeedError(
            "Clerk key does not identify the approved primary UAT instance; no accounts were changed"
        )


def verify_user(user, email):
    if (
        not isinstance(user, dict)
        or not isinstance(user.get("id"), str)
        or not re.fullmatch(r"user_[A-Za-z0-9]+", user["id"])
    ):
        raise SeedError("Clerk returned an invalid user identity")
    if (
        user.get("banned") is not False
        or user.get("locked") is not False
        or user.get("deleted")
    ):
        raise SeedError(
            "Existing UAT actor is unavailable; no lifecycle state was changed"
        )
    addresses = user.get("email_addresses")
    if not isinstance(addresses, list) or len(addresses) != 1:
        raise SeedError("UAT actor must have exactly one approved email address")
    address = addresses[0]
    if (
        not isinstance(address, dict)
        or address.get("email_address") != email
        or address.get("id") != user.get("primary_email_address_id")
        or (address.get("verification") or {}).get("status") != "verified"
    ):
        raise SeedError(
            "UAT actor primary verified email does not match; account preserved"
        )
    return user["id"]


def ensure_actor(clerk, role):
    email = f"capy-uat-{role}+clerk_test@stablestudio.org"
    name = "Capy UAT " + role.title()
    query = urllib.parse.urlencode({"email_address": email, "limit": 2})
    users = clerk.request("GET", "/users?" + query)
    if not isinstance(users, list) or len(users) > 1:
        raise SeedError("Clerk lookup did not resolve a unique UAT actor")
    if users:
        user_id = verify_user(users[0], email)
    else:
        # Clerk's create-user API verifies supplied email addresses without sending invitations.
        user = clerk.request(
            "POST",
            "/users",
            {
                "email_address": [email],
                "first_name": name,
                "skip_password_requirement": True,
            },
        )
        user_id = verify_user(user, email)
    verified_id = verify_user(clerk.request("GET", "/users/" + user_id), email)
    if verified_id != user_id:
        raise SeedError("Clerk user readback identity changed")
    return {"role": role, "id": user_id, "email": email, "name": name}


def remote_command(key, container, seed=None):
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*", container or ""):
        raise SeedError(
            "--db-container must explicitly name the UAT Postgres container"
        )
    key = Path(key).expanduser().resolve()
    if not key.is_file():
        raise SeedError("--ssh-key must name an existing key file")
    remote = [
        "docker",
        "exec",
        "-i",
        container,
        "psql",
        "-X",
        "-U",
        "capy",
        "-d",
        "capy",
        "-v",
        "ON_ERROR_STOP=1",
    ]
    if seed is not None:
        remote += ["-v", "seed=" + json.dumps(seed, separators=(",", ":"))]
    return [
        "ssh",
        "-i",
        str(key),
        "-o",
        "IdentitiesOnly=yes",
        "-o",
        "StrictHostKeyChecking=yes",
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=15",
        "root@159.195.250.206",
        shlex.join(remote),
    ]


def run_sql(command, sql):
    try:
        result = subprocess.run(
            command, input=sql, text=True, capture_output=True, timeout=90, check=False
        )
    except (OSError, subprocess.TimeoutExpired):
        raise SeedError(
            "UAT database connection failed or timed out; remote details withheld"
        ) from None
    if result.returncode:
        raise SeedError(
            "UAT SQL failed or fixture drift was detected; no reset attempted, remote details withheld"
        )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--file", required=True, type=Path)
    parser.add_argument("--accounts-only", action="store_true")
    parser.add_argument("--ssh-key")
    parser.add_argument("--db-container")
    args = parser.parse_args()
    try:
        values = parse_dotenv(args.file.read_text())
    except (OSError, ValueError):
        raise SeedError("Cannot read a valid literal environment file") from None
    validate_config(values)
    if not args.accounts_only:
        if not args.ssh_key or not args.db_container:
            raise SeedError(
                "Database initialization requires --ssh-key and --db-container"
            )
        command = remote_command(args.ssh_key, args.db_container)
        # Actual column reads fail before Clerk mutations when normal migrations are absent.
        run_sql(
            command,
            "BEGIN READ ONLY;\nSELECT filename, checksum FROM schema_migrations LIMIT 0;\n"
            "SELECT id, email, deleted_at FROM users LIMIT 0;\n"
            "SELECT id, description FROM workspaces LIMIT 0;\n"
            "SELECT owner_user_id, node_count, revision FROM materials LIMIT 0;\n"
            "SELECT version_date FROM material_revisions LIMIT 0;\n"
            "SELECT role FROM workspace_members LIMIT 0;\nCOMMIT;\n",
        )
    clerk = Clerk(values["CLERK_SECRET_KEY"])
    verify_instance(clerk)
    actors = [ensure_actor(clerk, role) for role in ROLES]
    if len({actor["id"] for actor in actors}) != len(ROLES):
        raise SeedError("Approved UAT actors unexpectedly share a Clerk identity")
    if not args.accounts_only:
        run_sql(
            remote_command(args.ssh_key, args.db_container, {"actors": actors}),
            Path(__file__).with_name("seed.sql").read_text(),
        )
    for actor in actors:
        print(f"{actor['role']}: {actor['id']} {actor['email']}")
    print(
        "UAT accounts verified."
        if args.accounts_only
        else "UAT accounts and authorization fixture initialized."
    )


if __name__ == "__main__":
    try:
        main()
    except SeedError as error:
        print("uat-seed: " + str(error), file=sys.stderr)
        sys.exit(1)
