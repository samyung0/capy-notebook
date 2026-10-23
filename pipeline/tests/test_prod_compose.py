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


APP_IMAGES = {
    "migrate": "CAPY_SERVER_IMAGE",
    "server": "CAPY_SERVER_IMAGE",
    "reconcile": "CAPY_SERVER_IMAGE",
    "collaboration": "CAPY_COLLABORATION_IMAGE",
    "retrieval": "CAPY_PIPELINE_IMAGE",
}


def test_app_services_run_the_ci_images_of_the_release() -> None:
    """The host never builds (Coolify removal, Epo 2026-10-23): every app
    service runs the image the deploy job names by digest in stack.env (the
    host checks it is CI's, labelled with RELEASE_SHA; review M2), and
    Postgres and Redis are pinned by digest."""
    text = COMPOSE.read_text(encoding="utf-8")
    services = yaml.safe_load(text)["services"]

    for name, variable in APP_IMAGES.items():
        assert services[name]["image"] == f"${{{variable}:?set {variable}}}", name
    assert not [name for name, service in services.items() if "build" in service]
    assert "SOURCE_COMMIT" not in text
    for name in ("db", "capy-redis"):
        assert "@sha256:" in services[name]["image"], name


def test_only_loopback_and_the_wireguard_address_are_published() -> None:
    """Security regression (Coolify removal): cloudflared reaches the gateway,
    collaboration and Ops on 127.0.0.1; the ingest host reaches Postgres,
    Redis and the gateway on the required WireGuard address; nothing binds
    every interface."""
    wireguard = "${CAPY_PRIVATE_BIND_ADDRESS:?set CAPY_PRIVATE_BIND_ADDRESS}"
    published = {
        name: service.get("ports", [])
        for path in (COMPOSE, COMPOSE.with_name("docker-compose.ops.yml"))
        for name, service in yaml.safe_load(path.read_text(encoding="utf-8"))[
            "services"
        ].items()
    }

    assert published == {
        "db": [f"{wireguard}:5432:5432"],
        "capy-redis": [f"{wireguard}:6379:6379"],
        "migrate": [],
        "server": ["127.0.0.1:8080:8080", f"{wireguard}:8080:8080"],
        "collaboration": ["127.0.0.1:1234:1234"],
        "retrieval": [],
        "reconcile": [],
        "ops": ["127.0.0.1:8082:8082"],
    }
