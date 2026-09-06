#!/usr/bin/env python3
"""Manifest-backed GitHub config upload and deployment rendering. Never prints values."""

import argparse
import ipaddress
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import quote

ROOT = Path(__file__).resolve().parents[2]
MANIFEST = json.loads((ROOT / "deploy/env-manifest.json").read_text())["keys"]


class ConfigError(ValueError):
    pass


def fail(message):
    raise ConfigError(message)


def parse_dotenv(text):
    """Literal dotenv subset: no evaluation, interpolation, or multiline values."""
    result = {}
    for number, line in enumerate(text.splitlines(), 1):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        match = re.fullmatch(r"(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*)", line)
        if not match:
            fail(f"invalid dotenv syntax at line {number}")
        key, value = match.groups()
        if key in result:
            fail(f"duplicate key {key}")
        if value[:1] in ('"', "'"):
            quote = value[0]
            if len(value) < 2 or value[-1] != quote:
                fail(f"unclosed quote for {key}")
            value = value[1:-1]
            if quote == '"':
                # Explicit escapes permit SSH keys without evaluating shell syntax.
                value = re.sub(
                    r'\\([nrt"\\])',
                    lambda m: {"n": "\n", "r": "\r", "t": "\t", '"': '"', "\\": "\\"}[
                        m[1]
                    ],
                    value,
                )
            else:
                value = value.replace("\\'", "'")
        else:
            value = re.split(r"\s+#", value, maxsplit=1)[0].rstrip()
        if "\x00" in value:
            fail(f"NUL is forbidden for {key}")
        result[key] = value
    return result


def classify(values):
    unknown = sorted(values.keys() - MANIFEST.keys())
    if unknown:
        fail("unknown configuration keys: " + ", ".join(unknown))
    return {key: MANIFEST[key]["kind"] for key in values}


def github_values():
    variables = json.loads(os.environ["CAPY_GITHUB_VARS"])
    secrets = json.loads(os.environ["CAPY_GITHUB_SECRETS"])
    unknown = (variables.keys() | secrets.keys()) - MANIFEST.keys() - {"GITHUB_TOKEN"}
    if unknown:
        fail("unknown GitHub configuration keys: " + ", ".join(sorted(unknown)))
    result = {}
    for key, spec in MANIFEST.items():
        if spec["targets"] == ["local"]:
            continue
        source, other = (
            (secrets, variables) if spec["kind"] == "secret" else (variables, secrets)
        )
        if key in other:
            fail(
                f"{key} is stored in the wrong GitHub namespace; expected {spec['kind']}"
            )
        if key in source:
            result[key] = source[key]
    return result


def target_values(values, target):
    result = {}
    for key, spec in MANIFEST.items():
        if target not in spec["targets"]:
            continue
        value = values.get(key, "")
        if target in spec.get("required_for", []) and not value:
            fail(f"{key} is required for {target}")
        result[key] = value
    return result


def private_write(path, text):
    path = Path(path)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    os.fchmod(fd, 0o600)
    with os.fdopen(fd, "w") as stream:
        stream.write(text)


def dotenv(values):
    # Compose single quotes suppress $ interpolation, including passwords.
    if any("\n" in value or "\r" in value for value in values.values()):
        fail("multiline values cannot be rendered as container dotenv")
    return "".join(
        f"{key}='" + value.replace("'", "\\'") + "'\n"
        for key, value in sorted(values.items())
    )


def render(values, environment, output, revision):
    if not re.fullmatch("[0-9a-f]{40}", revision):
        fail("revision must be a lowercase full Git SHA")
    output = Path(output)
    output.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(output, 0o700)
    coolify = target_values(values, "coolify")
    password = values.get("POSTGRES_PASSWORD", "")
    if not password:
        fail("POSTGRES_PASSWORD is required")
    coolify["DATABASE_URL"] = (
        f"postgres://capy:{quote(password, safe='')}@db:5432/capy?sslmode=disable"
    )
    coolify["VITE_CLERK_PUBLISHABLE_KEY"] = values.get("CLERK_PUBLISHABLE_KEY", "")
    coolify["RELEASE_SHA"] = revision
    private_write(output / "coolify.json", json.dumps(coolify))
    build = target_values(values, "build")
    build.update(
        VITE_APP_ENV=environment,
        VITE_APP_URL=values.get("DEPLOYMENT_APP_URL", ""),
        VITE_CLERK_PUBLISHABLE_KEY=values.get("CLERK_PUBLISHABLE_KEY", ""),
        VITE_RELEASE_SHA=revision,
        VITE_E2E_EDITOR_SEED="false",
        VITE_LOAD_TEST_SEED="false",
        VITE_USE_MSW="false",
    )
    if not build["VITE_APP_URL"] or not build["VITE_CLERK_PUBLISHABLE_KEY"]:
        fail("DEPLOYMENT_APP_URL and CLERK_PUBLISHABLE_KEY are required")
    private_write(output / "build.json", json.dumps(build))
    queue = target_values(values, "ingest-queue")
    address = values.get("CAPY_PRIVATE_BIND_ADDRESS", "")
    password = values.get("POSTGRES_PASSWORD", "")
    try:
        address = str(ipaddress.IPv4Address(address))
    except ipaddress.AddressValueError:
        fail("CAPY_PRIVATE_BIND_ADDRESS must be a valid IPv4 address")
    if not password:
        fail("POSTGRES_PASSWORD is required for ingest")
    queue.update(
        DATABASE_URL=f"postgres://capy:{quote(password, safe='')}@{address}:5432/capy?sslmode=disable",
        REDIS_URL=f"redis://{address}:6379/0",
        GATEWAY_URL=f"http://{address}:8080",
    )
    queue["SENTRY_DSN"] = queue.pop("SENTRY_DSN_WORKER")
    private_write(output / f"{environment}.queue.env", dotenv(queue))
    target = "ingest-shared" if environment == "uat" else "ingest-production"
    shared = target_values(values, target)
    # Queue addresses always come from the explicitly selected environment.
    if environment == "production":
        shared.update(queue)
    shared["RELEASE_SHA"] = revision
    private_write(
        output / ("nonprod.env" if environment == "uat" else "prod.env"), dotenv(shared)
    )
    print(f"rendered {environment} configuration; values redacted")


def run_gh(args, value=None):
    result = subprocess.run(
        ["gh", *args],
        input=value,
        text=True,
        capture_output=True,
        check=False,
    )
    if result.returncode:
        fail("GitHub configuration operation failed (response redacted)")
    return result.stdout


def push(values, environment, repo):
    classify(values)
    # Empty optional values delete GitHub entries; rendering always supplies blank.
    for key, value in values.items():
        spec = MANIFEST[key]
        if spec["targets"] == ["local"] or (
            "environments" in spec and environment not in spec["environments"]
        ):
            continue
        kind = "secret" if spec["kind"] == "secret" else "variable"
        common = ["--env", environment, "--repo", repo]
        if value:
            run_gh([kind, "set", key, *common], value)
        else:
            names = json.loads(run_gh([kind, "list", *common, "--json", "name"]))
            if any(row["name"] == key for row in names):
                run_gh([kind, "delete", key, *common])
        print(f"{key}: {kind} {'set' if value else 'cleared'} (value redacted)")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def coolify_request(method, route, payload=None, *, application=True):
    base = os.environ["COOLIFY_API_URL"].rstrip("/")
    uuid = os.environ["COOLIFY_RESOURCE_UUID"]
    if not base.startswith("https://") or not re.fullmatch("[A-Za-z0-9_-]+", uuid):
        fail("invalid Coolify target")
    request = urllib.request.Request(
        base + ("/applications/" + uuid if application else "") + route,
        data=json.dumps(payload).encode() if payload is not None else None,
        method=method,
        headers={
            "Authorization": "Bearer " + os.environ["COOLIFY_API_TOKEN"],
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": "Capy Notebook deployment",
        },
    )
    try:
        with urllib.request.build_opener(NoRedirect).open(
            request, timeout=45
        ) as response:
            return json.load(response)
    except (urllib.error.URLError, json.JSONDecodeError):
        fail("Coolify configuration request failed (response redacted)")


def verify_coolify_terminal(deployment_uuid):
    if not re.fullmatch(r"[A-Za-z0-9_-]+", deployment_uuid or ""):
        fail("Coolify deployment UUID unavailable; pending ingest must remain paused")
    deployment = coolify_request(
        "GET", "/deployments/" + deployment_uuid, application=False
    )
    terminal = {
        "finished",
        "completed",
        "success",
        "successful",
        "failed",
        "error",
        "cancelled",
        "cancelled-by-user",
        "cancelled-by-system",
    }
    if deployment.get("status") not in terminal:
        fail("Coolify deployment is not terminal; pending ingest must remain paused")
    print("Coolify deployment is terminal; safe to inspect the backend revision")


def coolify_payload(values):
    # Verified against coollabsio/coolify v4.3.14 ApplicationsController::create_bulk_envs.
    return {
        "data": [
            {
                "key": key,
                "value": value,
                "is_literal": True,
                "is_preview": False,
                "is_shown_once": False,
                "is_multiline": False,
                "is_runtime": True,
                "is_buildtime": True,
            }
            for key, value in sorted(values.items())
        ]
    }


def apply_coolify(values):
    payload = coolify_payload(values)
    coolify_request("PATCH", "/envs/bulk", payload)
    actual = coolify_request("GET", "/envs")
    for wanted in payload["data"]:
        rows = [
            row
            for row in actual
            if row.get("key") == wanted["key"] and not row.get("is_preview")
        ]
        if len(rows) != 1:
            fail(wanted["key"] + ": Coolify readback missing or duplicate")
        row = rows[0]
        for name, value in wanted.items():
            # Laravel converts empty input strings to null; both clear the value.
            observed = row.get(name)
            if name == "value" and observed is None:
                observed = ""
            if observed != value:
                fail(wanted["key"] + ": Coolify readback mismatch (values redacted)")
    obsolete_keys = {
        "EVO_" + key.removeprefix("CAPY_")
        for key in values
        if key.startswith("CAPY_")
        and key in MANIFEST
        and "coolify" in MANIFEST[key]["targets"]
    } | {"EVO_QUERY_MODEL", "IMPORT_RELAY_ENQUEUE_URL", "IMPORT_RELAY_SECRET"}
    obsolete = [
        row
        for row in actual
        if row.get("is_preview") or row.get("key") in obsolete_keys
    ]
    # Keep the previous names until every replacement has passed readback.
    for row in obsolete:
        uuid = row.get("uuid", "")
        if not re.fullmatch("[A-Za-z0-9_-]+", uuid):
            fail("invalid Coolify environment UUID")
        coolify_request("DELETE", "/envs/" + uuid)
    if obsolete:
        remaining = coolify_request("GET", "/envs")
        if any(
            row.get("is_preview") or row.get("key") in obsolete_keys
            for row in remaining
        ):
            fail("obsolete or preview Coolify variables remain after cleanup")
    print(
        f"Coolify: {len(values)} managed keys verified; preview disabled; values redacted"
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "command",
        choices=[
            "check",
            "push",
            "render",
            "apply-coolify",
            "build",
            "verify-coolify-terminal",
        ],
    )
    parser.add_argument("--environment", choices=["uat", "production"])
    parser.add_argument("--file")
    parser.add_argument("--repo")
    parser.add_argument("--output")
    parser.add_argument("--revision")
    parser.add_argument("--deployment-uuid")
    args = parser.parse_args()
    if args.command == "verify-coolify-terminal":
        verify_coolify_terminal(args.deployment_uuid)
        return
    if args.command in ("apply-coolify", "build"):
        values = json.loads(Path(args.file).read_text())
        if args.command == "apply-coolify":
            apply_coolify(values)
        else:
            result = subprocess.run(
                ["pnpm", "build"], env={**os.environ, **values}, check=False
            )
            sys.exit(result.returncode)
        return
    values = parse_dotenv(Path(args.file).read_text()) if args.file else github_values()
    classify(values)
    if args.command == "check":
        print(f"{len(values)} known keys validated; values redacted")
    elif args.command == "push":
        if not args.environment or not args.repo or not args.file:
            fail("push requires --environment, --repo, and --file")
        push(values, args.environment, args.repo)
    else:
        if not args.environment or not args.output or not args.revision:
            fail("render requires --environment, --output, and --revision")
        render(values, args.environment, args.output, args.revision)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, OSError) as error:
        # Never stringify arbitrary exceptions: remote responses may contain secrets.
        message = (
            str(error)
            if isinstance(error, ValueError)
            and not isinstance(error, json.JSONDecodeError)
            else "configuration input unavailable or invalid"
        )
        print("config: " + message, file=sys.stderr)
        sys.exit(1)
