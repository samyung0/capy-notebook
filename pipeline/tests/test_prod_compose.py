"""The UAT and production compose file's collaboration service."""

from __future__ import annotations

from pathlib import Path

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
