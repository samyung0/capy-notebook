#!/usr/bin/env python3
"""Manifest-backed GitHub config upload and deployment rendering. Never prints values."""

import argparse
import ipaddress
import json
import os
import re
import subprocess
import sys
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


def read_file(path):
    if not path:
        fail("--file is required")
    path = Path(path)
    if not path.is_file():
        fail(f"{path}: no such file")
    return path.read_text()


def github_values():
    """Variables come from the whole `vars` context; each secret comes from its
    own `CAPY_SECRET_<KEY>` step variable. The render steps name exactly the
    secrets their render reads (test_config.py checks the wiring): a step given
    `toJSON(secrets)` makes GitHub hold the run for approval."""
    if "CAPY_GITHUB_VARS" not in os.environ:
        fail(
            "CAPY_GITHUB_VARS unset; outside the deploy workflows pass --file with a local env file"
        )
    variables = json.loads(os.environ["CAPY_GITHUB_VARS"])
    # The vars context also holds unrelated repository and organization settings.
    result = {}
    for key, spec in MANIFEST.items():
        if spec["targets"] == ["local"]:
            continue
        if spec["kind"] == "variable":
            if key in variables:
                result[key] = variables[key]
            continue
        if key in variables:
            fail(f"{key} is stored in the wrong GitHub namespace; expected secret")
        # GitHub expands an unset secret to blank; both stay absent.
        if os.environ.get("CAPY_SECRET_" + key):
            result[key] = os.environ["CAPY_SECRET_" + key]
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
    # Compose single quotes suppress $ interpolation, including passwords. A
    # quote inside, or a backslash before the closing quote, lets Compose read
    # another assignment out of the line, so the app host refuses such lines
    # (review R1) and they are refused here rather than escaped.
    if any("\n" in value or "\r" in value for value in values.values()):
        fail("multiline values cannot be rendered as container dotenv")
    for key, value in values.items():
        if "'" in value or value.endswith("\\"):
            fail(f"{key} may not hold a single quote or end in a backslash")
    return "".join(f"{key}='{value}'\n" for key, value in sorted(values.items()))


def refuse_other_environments(values, environment):
    """Keys scoped to other environments (the UAT switches) stay blank."""
    for key, value in values.items():
        if value and environment not in MANIFEST[key].get(
            "environments", [environment]
        ):
            fail(f"{key} is not allowed in {environment}")


def private_output(output, revision):
    if not re.fullmatch("[0-9a-f]{40}", revision):
        fail("revision must be a lowercase full Git SHA")
    output = Path(output)
    output.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(output, 0o700)
    return output


def build_values(values, environment, revision):
    build = target_values(values, "build")
    build.update(
        VITE_APP_ENV=environment,
        VITE_APP_URL=values.get("DEPLOYMENT_APP_URL", ""),
        VITE_CLERK_PUBLISHABLE_KEY=values.get("CLERK_PUBLISHABLE_KEY", ""),
        # Copied bank questions keep linking their figures here.
        VITE_BANK_ASSETS_URL=values.get("BANK_ASSETS_URL", ""),
        VITE_RELEASE_SHA=revision,
        VITE_E2E_EDITOR_SEED="false",
        VITE_LOAD_TEST_SEED="false",
        VITE_USE_MSW="false",
    )
    if not build["VITE_APP_URL"] or not build["VITE_CLERK_PUBLISHABLE_KEY"]:
        fail("DEPLOYMENT_APP_URL and CLERK_PUBLISHABLE_KEY are required")
    return build


def render_build(values, environment, output, revision):
    """Only the SPA build's values: the build job runs third-party build code,
    so the deploy job renders the app host and ingest configuration itself."""
    output = private_output(output, revision)
    build = build_values(values, environment, revision)
    private_write(output / "build.json", json.dumps(build))
    print(f"rendered {environment} build configuration; values redacted")


def render(values, environment, output, revision):
    output = private_output(output, revision)
    # app.env: the env file the app host's Compose stack interpolates.
    app = target_values(values, "app")
    refuse_other_environments(app, environment)
    password = values.get("POSTGRES_PASSWORD", "")
    if not password:
        fail("POSTGRES_PASSWORD is required")
    app["DATABASE_URL"] = (
        f"postgres://capy:{quote(password, safe='')}@db:5432/capy?sslmode=disable"
    )
    # Tags the images and is checked by the host's deploy command.
    app["RELEASE_SHA"] = revision
    # Production pins the collaboration service to cores 2-3 of its 4 vCPU
    # (cpuset in docker-compose.prod.yml), mainly so the Office engine worker
    # has its own core; UAT's 2 vCPU stay unpinned. Runbook §1.1.
    app["COLLABORATION_CPUSET"] = "2,3" if environment == "production" else ""
    # Office engine child processes (save lane, background lane) and each
    # one's memory cap: production 2 + 1 at 4 GiB (the box has swap), UAT 1 + 1
    # at 3 GiB (Epo 2026-10-07).
    production = environment == "production"
    app["COLLABORATION_ENGINE_SAVE_PROCESSES"] = "2" if production else "1"
    app["COLLABORATION_ENGINE_BACKGROUND_PROCESSES"] = "1"
    app["COLLABORATION_ENGINE_MEMORY_LIMIT_BYTES"] = str((4 if production else 3) << 30)
    # The source rooms' disk store cap: production 10 GiB, UAT 5 GiB
    # (Epo 2026-10-17).
    app["COLLABORATION_SOURCE_DISK_BYTES"] = str((10 if production else 5) << 30)
    private_write(output / "app.env", dotenv(app))
    build = build_values(values, environment, revision)
    private_write(output / "build.json", json.dumps(build))
    queue = target_values(values, "ingest-queue")
    refuse_other_environments(queue, environment)
    address = values.get("CAPY_PRIVATE_BIND_ADDRESS", "")
    password = values.get("POSTGRES_PASSWORD", "")
    try:
        parsed = ipaddress.IPv4Address(address)
    except ipaddress.AddressValueError:
        fail("CAPY_PRIVATE_BIND_ADDRESS must be a valid IPv4 address")
    # Compose publishes Postgres, Redis and the gateway on it: 0.0.0.0 binds
    # every interface, and loopback leaves the ingest host without them.
    if parsed.is_unspecified or parsed.is_loopback:
        fail(
            "CAPY_PRIVATE_BIND_ADDRESS must be the WireGuard address, not unspecified or loopback"
        )
    address = str(parsed)
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


def render_ops(values, environment, output, revision):
    output = private_output(output, revision)
    ops = target_values(values, "ops")
    if ops["OPS_INGEST_PRIMARY_ENVIRONMENT"] != environment:
        fail("OPS_INGEST_PRIMARY_ENVIRONMENT must match the deployment environment")
    # Both name the image (capy-ops:<sha>-<environment>); the image job takes
    # the public build values from the GitHub variables itself.
    ops["SENTRY_ENVIRONMENT"] = environment
    ops["RELEASE_SHA"] = revision
    private_write(output / "ops.env", dotenv(ops))
    print(f"rendered {environment} Ops configuration; values redacted")


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
    common = ["--env", environment, "--repo", repo]
    # Deploys read only the secrets their render steps name, so they cannot see
    # a manifest variable stored as a secret; refuse before changing anything.
    stored = json.loads(run_gh(["secret", "list", *common, "--json", "name"]))
    misplaced = sorted(
        row["name"]
        for row in stored
        if MANIFEST.get(row["name"], {}).get("kind") == "variable"
    )
    if misplaced:
        fail(
            f"manifest variables stored as GitHub secrets in {environment}: "
            + ", ".join(misplaced)
            + "; delete those secrets first"
        )
    # Empty optional values delete GitHub entries; rendering always supplies blank.
    for key, value in values.items():
        spec = MANIFEST[key]
        if spec["targets"] == ["local"] or (
            "environments" in spec and environment not in spec["environments"]
        ):
            continue
        kind = "secret" if spec["kind"] == "secret" else "variable"
        if value:
            run_gh([kind, "set", key, *common], value)
        else:
            names = json.loads(run_gh([kind, "list", *common, "--json", "name"]))
            if any(row["name"] == key for row in names):
                run_gh([kind, "delete", key, *common])
        print(f"{key}: {kind} {'set' if value else 'cleared'} (value redacted)")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "command",
        choices=[
            "check",
            "push",
            "render",
            "render-ops",
            "render-build",
            "build",
        ],
    )
    parser.add_argument("--environment", choices=["uat", "production"])
    parser.add_argument("--file")
    parser.add_argument("--repo")
    parser.add_argument("--output")
    parser.add_argument("--revision")
    args = parser.parse_args()
    if args.command == "build":
        values = json.loads(read_file(args.file))
        result = subprocess.run(
            ["pnpm", "build"], env={**os.environ, **values}, check=False
        )
        sys.exit(result.returncode)
    values = parse_dotenv(read_file(args.file)) if args.file else github_values()
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
        renderer = {
            "render": render,
            "render-ops": render_ops,
            "render-build": render_build,
        }[args.command]
        renderer(values, args.environment, args.output, args.revision)


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
