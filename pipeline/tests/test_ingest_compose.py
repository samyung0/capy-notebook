"""The ingest-host compose files: the parser reads untrusted documents, so it
runs with no capabilities, no privilege gain and a read-only root (small tmpfs
mounts, a disk-backed work volume), and the deploy can supply every variable
the files require."""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest
import yaml

DEPLOY = Path(__file__).resolve().parents[2] / "deploy"
# Each file and the env-manifest target its deploy renders it from.
COMPOSE = {
    "docker-compose.ingest-host.yml": "ingest-production",
    "docker-compose.ingest-host.nonprod.yml": "ingest-shared",
}
# Values scripts/env/config.py render derives instead of reading the manifest.
RENDERED = {"RELEASE_SHA", "DATABASE_URL", "REDIS_URL", "GATEWAY_URL"}
WORK = "parser_work:/run/capy-parser/work"


@pytest.mark.parametrize("name", COMPOSE)
def test_parser_runs_unprivileged_on_a_read_only_root(name: str) -> None:
    services = yaml.safe_load((DEPLOY / name).read_text())["services"]
    parser = services["parser"]

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
    # The init service hands the work volume to the parser's uid.
    init = services["parse-spool-init"]
    assert WORK in init["volumes"]
    assert "chown 10001:10001 /run/capy-parser/work" in init["command"][-1]
    for service in services.values():
        assert not any(
            "unconfined" in option for option in service.get("security_opt", [])
        )


@pytest.mark.parametrize(("name", "target"), COMPOSE.items())
def test_every_required_variable_is_required_by_the_manifest(
    name: str, target: str
) -> None:
    manifest = json.loads((DEPLOY / "env-manifest.json").read_text())["keys"]
    required = set(re.findall(r"\$\{([A-Z0-9_]+):\?", (DEPLOY / name).read_text()))

    missing = {
        key
        for key in required - RENDERED
        if target not in manifest.get(key, {}).get("required_for", [])
    }
    assert missing == set()
