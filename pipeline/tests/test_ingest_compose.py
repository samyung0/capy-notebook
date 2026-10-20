"""The ingest-host compose files: the parser reads untrusted documents, so it
runs with no capabilities, no privilege gain and a read-only root (small tmpfs
mounts, a disk-backed work volume), the Parser budget runs the image the same
way, the pipeline services run non-root with no capabilities, the deploy can
supply every variable the files require, the image's own execute-only init is
PID 1, and the host lets a process trace only its own descendants."""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]
DEPLOY = ROOT / "deploy"
# Each file and the env-manifest targets its deploy renders it from: the
# production env also carries the ingest-queue values.
COMPOSE = {
    "docker-compose.ingest-host.yml": {"ingest-production", "ingest-queue"},
    "docker-compose.ingest-host.nonprod.yml": {"ingest-shared"},
}
# Values scripts/env/config.py render derives instead of reading the manifest;
# keep in sync with config.py render.
RENDERED = {"RELEASE_SHA", "DATABASE_URL", "REDIS_URL", "GATEWAY_URL"}
WORK = "parser_work:/run/capy-parser/work"


def _parser(name: str) -> tuple[dict, dict]:
    services = yaml.safe_load((DEPLOY / name).read_text())["services"]
    return services, services["parser"]


@pytest.mark.parametrize("name", COMPOSE)
def test_parser_runs_unprivileged_on_a_read_only_root(name: str) -> None:
    services, parser = _parser(name)

    assert parser["cap_drop"] == ["ALL"]
    assert "cap_add" not in parser and not parser.get("privileged")
    assert parser["security_opt"] == ["no-new-privileges:true"]
    assert parser["read_only"] is True
    tmpfs = dict(entry.split(":", 1) for entry in parser["tmpfs"])
    assert set(tmpfs) == {"/run/capy-parser/home", "/tmp"}
    for options in tmpfs.values():
        assert {"noexec", "nosuid", "nodev"} <= set(options.split(","))
        assert re.search(r"(^|,)size=\d+[km]($|,)", options)
    assert WORK in parser["volumes"]
    # The init service, run on every release, hands the work volume to the
    # parser's uid.
    init = services["parse-spool-init"]
    assert WORK in init["volumes"]
    assert "chown 10001:10001 /run/capy-parser/work" in init["command"][-1]
    for service in services.values():
        assert not any(
            "unconfined" in option for option in service.get("security_opt", [])
        )


@pytest.mark.parametrize("name", COMPOSE)
def test_the_parsers_pid_1_is_the_images_execute_only_init(name: str) -> None:
    """The parser user cannot read PID 1's environment: tini is installed
    execute-only and is the entrypoint, with no Docker init in front of it."""
    _, parser = _parser(name)
    dockerfile = (ROOT / "parser/Dockerfile").read_text()
    budget = (ROOT / ".github/workflows/parser-budget.yml").read_text()

    assert not parser.get("init") and "entrypoint" not in parser
    assert "install -y --no-install-recommends tini" in dockerfile
    assert "chmod 0711 /usr/bin/tini" in dockerfile
    assert 'ENTRYPOINT ["/usr/bin/tini", "--"]' in dockerfile
    assert "--init" not in budget.split("docker run -d --name capy-parser-budget")[1]


@pytest.mark.parametrize("name", COMPOSE)
def test_the_parser_budget_runs_the_image_with_the_same_flags(name: str) -> None:
    budget = (ROOT / ".github/workflows/parser-budget.yml").read_text()
    _, parser = _parser(name)

    for flag in (
        "--cap-drop ALL",
        "--security-opt no-new-privileges:true",
        "--read-only",
        *(f"--tmpfs {entry} " for entry in parser["tmpfs"]),
        f"-e MALLOC_ARENA_MAX={parser['environment']['MALLOC_ARENA_MAX']} ",
    ):
        assert flag in budget


@pytest.mark.parametrize("name", COMPOSE)
def test_the_parser_runs_with_two_malloc_arenas(name: str) -> None:
    """LibreOffice and the JVM then fit the parse child's address space."""
    _, parser = _parser(name)

    assert parser["environment"]["MALLOC_ARENA_MAX"] == "2"


@pytest.mark.parametrize("name", COMPOSE)
def test_the_pipeline_services_run_unprivileged_in_the_spool_group(name: str) -> None:
    """(security regression: S2 ingest containers) The worker, import worker,
    parse coordinator and host sampler run as the image's capy-ingest user in
    the spool's group (the parser's gid), with no capabilities and no
    privilege gain; the image's sources are readable by that user."""
    services = yaml.safe_load((DEPLOY / name).read_text())["services"]
    pipeline = {
        key: service
        for key, service in services.items()
        if "pipeline:" in service.get("image", "")
    }
    dockerfile = (ROOT / "pipeline/Dockerfile").read_text(encoding="utf-8")

    roles = {key.removesuffix("-local").removesuffix("-uat") for key in pipeline}
    assert roles == {"parse-coordinator", "import-worker", "worker", "host-sampler"}
    for service in pipeline.values():
        assert service["user"] == "10002:10001"
        assert service["cap_drop"] == ["ALL"]
        assert service["security_opt"] == ["no-new-privileges:true"]
        assert "cap_add" not in service and not service.get("privileged")
    assert "useradd --uid 10002 --gid 10001" in dockerfile
    assert "chmod -R a+rX /app/pipeline /app/server" in dockerfile
    init = services["parse-spool-init"]["command"][-1]
    assert "chown -R 10001:10001 /var/lib/capy-parse" in init
    assert "chmod 2770 /var/lib/capy-parse " in init


@pytest.mark.parametrize(("name", "targets"), COMPOSE.items())
def test_every_required_variable_is_required_by_the_manifest(
    name: str, targets: set[str]
) -> None:
    manifest = json.loads((DEPLOY / "env-manifest.json").read_text())["keys"]
    required = set(re.findall(r"\$\{([A-Z0-9_]+):\?", (DEPLOY / name).read_text()))

    missing = {
        key
        for key in required - RENDERED
        if not targets & set(manifest.get(key, {}).get("required_for", []))
    }
    assert missing == set()


def test_the_ingest_host_lets_a_process_trace_only_its_descendants() -> None:
    """The parser's children run as the same user as its API process."""
    playbook = yaml.safe_load(
        (DEPLOY / "ansible" / "ingest-host" / "playbook.yml").read_text()
    )
    settings = {
        task["ansible.posix.sysctl"]["name"]: task["ansible.posix.sysctl"]
        for play in playbook
        for task in play["tasks"]
        if "ansible.posix.sysctl" in task
    }
    assert settings["kernel.yama.ptrace_scope"]["value"] == "1"
    assert settings["kernel.yama.ptrace_scope"]["state"] == "present"
