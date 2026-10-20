"""The collaboration service in the UAT and production compose file (and, for
its sandbox flags, the local and e2e ones)."""

from __future__ import annotations

from pathlib import Path

import pytest
import yaml

COMPOSE = Path(__file__).resolve().parents[2] / "deploy" / "docker-compose.prod.yml"
MALLOC = {
    "MALLOC_ARENA_MAX": "2",
    "MALLOC_TRIM_THRESHOLD_": "131072",
    "MALLOC_MMAP_THRESHOLD_": "131072",
}


def test_collaboration_returns_freed_memory_to_the_system() -> None:
    """Two glibc arenas and fixed 128 KiB trim and mmap thresholds give back
    room memory after peers leave (Epo 2026-10-17); the engines inherit them."""
    services = yaml.safe_load(COMPOSE.read_text(encoding="utf-8"))["services"]
    environment = services["collaboration"]["environment"]

    assert {key: environment.get(key) for key in MALLOC} == MALLOC


def test_collaboration_keeps_source_files_on_a_disk_volume() -> None:
    """The source disk store's folder is a named volume at the image's folder,
    never tmpfs, and its cap comes from each environment (Epo 2026-10-17)."""
    compose = yaml.safe_load(COMPOSE.read_text(encoding="utf-8"))
    service = compose["services"]["collaboration"]
    dockerfile = COMPOSE.parents[1] / "collaboration-rs" / "Dockerfile"

    assert "ENV COLLABORATION_SOURCE_DISK_DIR=/var/lib/capy/sources" in (
        dockerfile.read_text(encoding="utf-8")
    )
    assert service["volumes"] == ["capy_collaboration_sources:/var/lib/capy/sources"]
    assert "tmpfs" not in service
    assert "capy_collaboration_sources" in compose["volumes"]
    assert service["environment"]["COLLABORATION_SOURCE_DISK_BYTES"] == (
        "${COLLABORATION_SOURCE_DISK_BYTES:?set COLLABORATION_SOURCE_DISK_BYTES}"
    )


@pytest.mark.parametrize(
    "compose",
    ["docker-compose.prod.yml", "docker-compose.yml", "docker-compose.e2e.yml"],
)
def test_collaboration_runs_without_capabilities_or_privilege_gain(
    compose: str,
) -> None:
    """Its Office engine children read uploaded files (Epo 2026-10-20): no
    capabilities and no privilege gain, deployed, local and in CI's e2e stack
    (security regression: the Office engine sandbox)."""
    path = COMPOSE.parent / compose
    service = yaml.safe_load(path.read_text(encoding="utf-8"))["services"][
        "collaboration"
    ]

    assert service["cap_drop"] == ["ALL"]
    assert "no-new-privileges:true" in service["security_opt"]
