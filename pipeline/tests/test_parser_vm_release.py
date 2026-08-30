from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

PREVIOUS = "1" * 40
CANDIDATE = "2" * 40
REPO_ROOT = Path(__file__).resolve().parents[2]
REMOTE_SCRIPT = REPO_ROOT / "scripts/deploy/parser-vm-remote-release.sh"


def _write_executable(path: Path, body: str) -> None:
    path.write_text(body)
    path.chmod(0o755)


def _release_harness(tmp_path: Path) -> tuple[dict[str, str], Path, Path, Path]:
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    repo = tmp_path / "repo"
    repo.mkdir()
    state_path = tmp_path / "docker-state.json"
    state_path.write_text(
        json.dumps(
            {
                "events": [],
                "images": {},
                "services": {
                    service: {"revision": PREVIOUS, "running": True}
                    for service in ("parser", "worker", "host-sampler")
                },
            }
        )
    )
    git_head = tmp_path / "git-head"
    git_head.write_text(PREVIOUS)
    release_env = tmp_path / "release.env"
    release_env.write_text(f"RELEASE_SHA={PREVIOUS}\n")
    pending = tmp_path / "release.pending"
    secret_env = tmp_path / "parser.env"
    secret_env.write_text("PARSER_BIND_ADDRESS=127.0.0.1\n")

    _write_executable(
        fake_bin / "git",
        """#!/usr/bin/env python3
import os
import pathlib
import sys

head = pathlib.Path(os.environ["FAKE_GIT_HEAD"])
args = sys.argv[1:]
if args[:2] == ["status", "--porcelain"]:
    raise SystemExit(0)
if args[:3] == ["fetch", "--prune", "origin"]:
    raise SystemExit(0)
if args[:2] == ["cat-file", "-e"]:
    raise SystemExit(0)
if args[:2] == ["checkout", "--detach"]:
    head.write_text(args[2])
    raise SystemExit(0)
if args[:2] == ["rev-parse", "HEAD"]:
    print(head.read_text().strip())
    raise SystemExit(0)
print(f"unsupported fake git command: {args}", file=sys.stderr)
raise SystemExit(2)
""",
    )
    _write_executable(
        fake_bin / "docker",
        """#!/usr/bin/env python3
import json
import os
import pathlib
import re
import sys

state_path = pathlib.Path(os.environ["FAKE_DOCKER_STATE"])
state = json.loads(state_path.read_text())
args = sys.argv[1:]
state["events"].append(" ".join(args))

def save():
    state_path.write_text(json.dumps(state))

def service_names(values):
    return [value for value in values if not value.startswith("-")]

if args and args[0] == "compose":
    index = 1
    while index < len(args) and args[index] in {"-p", "--env-file", "-f"}:
        index += 2
    command = args[index]
    rest = args[index + 1:]
    sha = os.environ["RELEASE_SHA"]
    if command == "config":
        save()
        raise SystemExit(0)
    if command == "ps":
        service = rest[-1]
        current = state["services"][service]
        if current["running"]:
            print(f"ctr-{service}")
        save()
        raise SystemExit(0)
    if command == "build":
        if os.environ.get("FAKE_FAIL_BUILD") == "1":
            save()
            raise SystemExit(1)
        state["images"][f"evo-parser-parser:{sha}"] = sha
        state["images"][f"evo-parser-pipeline:{sha}"] = sha
        save()
        raise SystemExit(0)
    if command == "stop":
        for service in service_names(rest):
            state["services"][service]["running"] = False
        save()
        raise SystemExit(0)
    if command == "up":
        for service in service_names(rest):
            state["services"][service] = {"revision": sha, "running": True}
        save()
        raise SystemExit(0)
    if command == "exec":
        save()
        if (
            os.environ.get("FAKE_FAIL_CANDIDATE_HEALTH") == "1"
            and sha == os.environ["FAKE_CANDIDATE_SHA"]
        ):
            raise SystemExit(1)
        raise SystemExit(0)

if args[:1] == ["inspect"]:
    formatting = args[2]
    service = args[3].removeprefix("ctr-")
    revision = state["services"][service]["revision"]
    save()
    if ".Image" in formatting:
        print(f"image-{service}-{revision}")
    else:
        print(revision)
    raise SystemExit(0)

if args[:2] == ["image", "tag"]:
    match = re.search(r"([0-9a-f]{40})$", args[2])
    if match is None:
        save()
        raise SystemExit(1)
    state["images"][args[3]] = match.group(1)
    save()
    raise SystemExit(0)

if args[:2] == ["image", "inspect"]:
    image = args[4]
    revision = state["images"].get(image)
    save()
    if revision is None:
        raise SystemExit(1)
    print(revision)
    raise SystemExit(0)

save()
print(f"unsupported fake docker command: {args}", file=sys.stderr)
raise SystemExit(2)
""",
    )

    env = {
        **os.environ,
        "EVO_PARSER_COMPOSE": "deploy/docker-compose.parser-vm.yml",
        "EVO_PARSER_HEALTH_ATTEMPTS": "1",
        "EVO_PARSER_HEALTH_INTERVAL": "0",
        "EVO_PARSER_PENDING_STATE": str(pending),
        "EVO_PARSER_RELEASE_ENV": str(release_env),
        "EVO_PARSER_REPO": str(repo),
        "EVO_PARSER_SECRET_ENV": str(secret_env),
        "FAKE_CANDIDATE_SHA": CANDIDATE,
        "FAKE_DOCKER_STATE": str(state_path),
        "FAKE_GIT_HEAD": str(git_head),
        "PATH": f"{fake_bin}{os.pathsep}{os.environ['PATH']}",
    }
    return env, state_path, release_env, pending


def _run_release(env: dict[str, str], mode: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["bash", str(REMOTE_SCRIPT), mode, CANDIDATE],
        check=False,
        capture_output=True,
        env=env,
        text=True,
        timeout=10,
    )


def _state(path: Path) -> dict:
    return json.loads(path.read_text())


def _assert_running_revision(state_path: Path, revision: str) -> None:
    services = _state(state_path)["services"]
    assert services == {
        service: {"revision": revision, "running": True}
        for service in ("parser", "worker", "host-sampler")
    }


def test_candidate_build_failure_does_not_pause_ingest(tmp_path: Path) -> None:
    env, state_path, release_env, pending = _release_harness(tmp_path)
    env["FAKE_FAIL_BUILD"] = "1"

    result = _run_release(env, "prepare")

    assert result.returncode != 0
    _assert_running_revision(state_path, PREVIOUS)
    assert not pending.exists()
    assert release_env.read_text() == f"RELEASE_SHA={PREVIOUS}\n"
    assert not any(" stop " in f" {event} " for event in _state(state_path)["events"])


def test_parser_health_failure_restores_previous_release(tmp_path: Path) -> None:
    env, state_path, release_env, pending = _release_harness(tmp_path)
    env["FAKE_FAIL_CANDIDATE_HEALTH"] = "1"

    result = _run_release(env, "prepare")

    assert result.returncode != 0
    _assert_running_revision(state_path, PREVIOUS)
    assert not pending.exists()
    assert release_env.read_text() == f"RELEASE_SHA={PREVIOUS}\n"


def test_cleanup_restores_previous_release_after_prepare(tmp_path: Path) -> None:
    env, state_path, release_env, pending = _release_harness(tmp_path)
    prepared = _run_release(env, "prepare")

    assert prepared.returncode == 0, prepared.stderr
    services = _state(state_path)["services"]
    assert services["parser"] == {"revision": CANDIDATE, "running": True}
    assert services["worker"]["running"] is False
    assert services["host-sampler"]["running"] is False
    assert pending.exists()

    rolled_back = _run_release(env, "rollback-if-pending")

    assert rolled_back.returncode == 0, rolled_back.stderr
    _assert_running_revision(state_path, PREVIOUS)
    assert not pending.exists()
    assert release_env.read_text() == f"RELEASE_SHA={PREVIOUS}\n"


def test_activation_commits_candidate_and_cleanup_becomes_noop(tmp_path: Path) -> None:
    env, state_path, release_env, pending = _release_harness(tmp_path)
    prepared = _run_release(env, "prepare")
    assert prepared.returncode == 0, prepared.stderr

    activated = _run_release(env, "activate")

    assert activated.returncode == 0, activated.stderr
    _assert_running_revision(state_path, CANDIDATE)
    assert not pending.exists()
    assert release_env.read_text() == f"RELEASE_SHA={CANDIDATE}\n"

    cleanup = _run_release(env, "rollback-if-pending")
    assert cleanup.returncode == 0, cleanup.stderr
    _assert_running_revision(state_path, CANDIDATE)
