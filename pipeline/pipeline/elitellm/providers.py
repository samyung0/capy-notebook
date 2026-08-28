"""Closed elitellm provider list. Must match the Go embed."""

from __future__ import annotations

import json
import os
from functools import lru_cache
from pathlib import Path
from typing import Any

PROVIDERS_PATH = Path(__file__).with_name("providers.json")
GO_PROVIDERS_PATH = (
    Path(__file__).resolve().parents[3]
    / "server"
    / "internal"
    / "models"
    / "elitellm_providers.json"
)


@lru_cache(maxsize=1)
def load_providers() -> dict[str, Any]:
    path = PROVIDERS_PATH
    if GO_PROVIDERS_PATH.is_file():
        path = GO_PROVIDERS_PATH
    return json.loads(path.read_text())


def provider_spec(slug: str) -> dict[str, Any]:
    spec = load_providers().get("providers", {}).get(slug)
    if not spec:
        raise KeyError(f"unknown elitellm provider {slug}")
    return spec


def platform_env_name(slug: str) -> str:
    return str(provider_spec(slug)["platformEnv"])


def platform_api_key(slug: str) -> str:
    return os.environ.get(platform_env_name(slug), "").strip()
