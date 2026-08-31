"""Write two-turn replay certifications only after a successful replay."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx

from pipeline.config import env_name_for_provider
from pipeline.elitellm.client import (
    DEEPINFRA_GLM_FLASH_MODEL,
    ZAI_GLM_FLASH_MODEL,
)
from pipeline.elitellm.providers import load_providers

REPO = Path(__file__).resolve().parents[2]
MANIFEST = REPO / "pipeline" / "tests" / "model_replay_certifications.json"
REPLAY_NODE = "pipeline/tests/test_model_replay.py::test_certified_two_turn_replay"
CASSETTE_DIR = Path("pipeline/tests/cassettes/replay")
MODEL_LIST_ENDPOINTS = {
    "anthropic": "https://api.anthropic.com/v1/models",
    "deepseek": "https://api.deepseek.com/models",
    "openai": "https://api.openai.com/v1/models",
    "zai": "https://api.deepinfra.com/v1/models",
}


def two_turn_cassette_ok(path: Path) -> bool:
    """True when the YAML is two successful recorded streaming HTTP turns."""
    if not path.is_file():
        return False
    text = path.read_text()
    if text.count("- request:") < 2:
        return False
    if text.count("code: 200") < 2:
        return False
    compact = "".join(text.split())
    if compact.count('"stream":true') < 2:
        return False
    if text.lower().count("text/event-stream") < 2 or text.count("data:") < 2:
        return False
    return "authentication_error" not in text and "invalid_api_key" not in text


def chat_provider_entries(
    catalog: dict[str, Any] | None = None,
) -> list[dict[str, str]]:
    raw = catalog if catalog is not None else load_providers()
    providers = raw.get("providers") or {}
    if not isinstance(providers, dict):
        return []
    entries: list[dict[str, str]] = []
    for slug, spec in providers.items():
        if not isinstance(spec, dict) or "chat" not in (spec.get("modes") or []):
            continue
        entries.append(
            {
                "name": str(spec.get("name") or slug),
                "platformEnv": str(spec.get("platformEnv") or ""),
                "slug": str(slug),
            }
        )
    return sorted(entries, key=lambda entry: entry["slug"])


def require_chat_provider(provider_slug: str) -> str:
    slug = provider_slug.strip()
    if not any(entry["slug"] == slug for entry in chat_provider_entries()):
        raise ValueError(f"{provider_slug!r} is not a supported chat provider")
    return slug


def cassette_relpath(provider_slug: str, model_id: str) -> str:
    slug = model_id.rsplit("/", 1)[-1].replace(".", "_").replace("-", "_")
    return str(CASSETTE_DIR / f"{provider_slug}__{slug}.yaml")


def load_manifest(path: Path = MANIFEST) -> dict[str, Any]:
    if not path.is_file():
        return {}
    raw = json.loads(path.read_text())
    if not isinstance(raw, dict):
        raise TypeError("model_replay_certifications.json must be an object")
    return raw


def certified_model_slugs(provider_slug: str, path: Path = MANIFEST) -> list[str]:
    """Return the exact certified model slugs for one provider."""
    provider_models = load_manifest(path).get(provider_slug)
    if not isinstance(provider_models, dict):
        return []
    return sorted(str(model_id) for model_id in provider_models)


class ModelListError(RuntimeError):
    pass


GetFn = Callable[..., httpx.Response]


def fetch_available_model_slugs(
    provider_slug: str,
    api_key: str,
    *,
    get: GetFn = httpx.get,
) -> list[str]:
    """List model slugs currently available to the provider API key."""
    provider_slug = require_chat_provider(provider_slug)
    endpoint = MODEL_LIST_ENDPOINTS.get(provider_slug)
    if endpoint is None:
        raise ModelListError(f"{provider_slug} does not have a model-list endpoint")
    api_key = api_key.strip()
    if not api_key:
        raise ValueError("provider API key is required")

    headers = {"authorization": f"Bearer {api_key}"}
    params: dict[str, str | int] = {}
    if provider_slug == "anthropic":
        headers = {
            "anthropic-version": "2023-06-01",
            "x-api-key": api_key,
        }
        params["limit"] = 1000

    try:
        response = get(endpoint, headers=headers, params=params, timeout=30.0)
        response.raise_for_status()
        payload = response.json()
    except (httpx.HTTPError, ValueError) as error:
        raise ModelListError(
            f"could not list models from {provider_slug}: {error}"
        ) from None

    data = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(data, list):
        raise ModelListError(
            f"could not list models from {provider_slug}: response has no data list"
        )
    model_ids = {
        str(item["id"]).strip()
        for item in data
        if isinstance(item, dict) and str(item.get("id") or "").strip()
    }
    if not model_ids:
        raise ModelListError(f"{provider_slug} returned no available model slugs")
    if provider_slug == "zai":
        if DEEPINFRA_GLM_FLASH_MODEL not in model_ids:
            raise ModelListError(
                f"zai routed model {DEEPINFRA_GLM_FLASH_MODEL} is unavailable"
            )
        return [ZAI_GLM_FLASH_MODEL]
    return sorted(model_ids)


def selectable_model_slugs(available: list[str], certified: list[str]) -> list[str]:
    """Keep certified slugs selectable even if the provider no longer lists them."""
    return sorted(set(available) | set(certified))


def write_manifest(manifest: dict[str, Any], path: Path = MANIFEST) -> None:
    path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")


def replay_node(provider_slug: str, model_id: str) -> str:
    return f"{REPLAY_NODE}[{provider_slug}/{model_id}]"


def certification_entry(
    provider_slug: str,
    model_id: str,
) -> dict[str, Any]:
    return {
        "cassette": cassette_relpath(provider_slug, model_id),
        "test": replay_node(provider_slug, model_id),
    }


def upsert_manifest_key(
    provider_slug: str,
    model_id: str,
    path: Path = MANIFEST,
) -> bool:
    manifest = load_manifest(path)
    provider_models = manifest.setdefault(provider_slug, {})
    if not isinstance(provider_models, dict):
        raise TypeError(f"certification provider {provider_slug!r} must be an object")
    existed = model_id in provider_models
    provider_models[model_id] = certification_entry(provider_slug, model_id)
    write_manifest(manifest, path)
    return existed


def delete_manifest_key(
    provider_slug: str, model_id: str, path: Path = MANIFEST
) -> bool:
    manifest = load_manifest(path)
    provider_models = manifest.get(provider_slug)
    if not isinstance(provider_models, dict) or model_id not in provider_models:
        return False
    del provider_models[model_id]
    if not provider_models:
        del manifest[provider_slug]
    write_manifest(manifest, path)
    return True


@dataclass(frozen=True)
class CertifyResult:
    model_id: str
    existed: bool
    recorded: bool
    replayed: bool
    kept: bool


RunFn = Callable[[str, str, bool, dict[str, str]], int]
RunProcessFn = Callable[..., subprocess.CompletedProcess[Any]]


def run_replay_pytest(
    provider_slug: str, model_id: str, record: bool, extra_env: dict[str, str]
) -> int:
    env = os.environ.copy()
    env.update(extra_env)
    if record:
        env["EVO_TEST_RECORD"] = "once"
    else:
        env.pop("EVO_TEST_RECORD", None)
    proc = subprocess.run(
        [
            sys.executable,
            "-m",
            "pytest",
            replay_node(provider_slug, model_id),
            "-q",
            "--tb=short",
        ],
        cwd=REPO,
        env=env,
        check=False,
    )
    return proc.returncode


def replay_certified_models(
    *,
    repo: Path = REPO,
    run_process: RunProcessFn = subprocess.run,
) -> int:
    """Replay every certified two-turn cassette without permitting recording."""
    env = os.environ.copy()
    env.pop("EVO_TEST_RECORD", None)
    proc = run_process(
        [
            sys.executable,
            "-m",
            "pytest",
            REPLAY_NODE,
            "-q",
            "--tb=short",
        ],
        cwd=repo,
        env=env,
        check=False,
    )
    return proc.returncode


def sync_go_agentic_loop_certs(
    repo: Path = REPO, manifest_path: Path = MANIFEST
) -> None:
    dest = repo / "server" / "internal" / "models" / "agentic_loop_certs.json"
    dest.parent.mkdir(parents=True, exist_ok=True)
    certified: dict[str, dict[str, bool]] = {}
    for provider_slug, provider_models in load_manifest(manifest_path).items():
        if not isinstance(provider_models, dict):
            continue
        for model_id, entry in provider_models.items():
            if isinstance(entry, dict) and two_turn_cassette_ok(
                repo / (entry.get("cassette") or "")
            ):
                certified.setdefault(provider_slug, {})[model_id] = True
    dest.write_text(
        json.dumps(
            {"schemaVersion": 1, "certified": certified}, indent=2, sort_keys=True
        )
        + "\n"
    )


@dataclass(frozen=True)
class FileSnapshot:
    path: Path
    content: bytes | None


def snapshot_file(path: Path) -> FileSnapshot:
    return FileSnapshot(
        path=path, content=path.read_bytes() if path.is_file() else None
    )


def restore_file(snapshot: FileSnapshot) -> None:
    if snapshot.content is None:
        snapshot.path.unlink(missing_ok=True)
        return
    snapshot.path.parent.mkdir(parents=True, exist_ok=True)
    snapshot.path.write_bytes(snapshot.content)


def certify_model(
    provider_slug: str,
    model_id: str,
    api_key: str,
    *,
    repo: Path = REPO,
    manifest_path: Path = MANIFEST,
    run_pytest: RunFn = run_replay_pytest,
) -> CertifyResult:
    provider_slug = require_chat_provider(provider_slug)
    model_id = model_id.strip()
    if not model_id:
        raise ValueError("model slug is required")
    api_key = api_key.strip()
    if not api_key:
        raise ValueError("provider API key is required")
    env_name = env_name_for_provider(provider_slug)
    extra_env = {env_name: api_key}
    cassette = repo / cassette_relpath(provider_slug, model_id)
    go_certs = repo / "server" / "internal" / "models" / "agentic_loop_certs.json"
    snapshots = (
        snapshot_file(manifest_path),
        snapshot_file(cassette),
        snapshot_file(go_certs),
    )
    before = load_manifest(manifest_path)
    provider_models = before.get(provider_slug) or {}
    existed = model_id in provider_models
    recorded = False
    replayed = False
    kept = False
    try:
        if cassette.is_file():
            cassette.unlink()
        upsert_manifest_key(provider_slug, model_id, manifest_path)
        recorded = run_pytest(provider_slug, model_id, True, extra_env) == 0
        replayed = (
            recorded and run_pytest(provider_slug, model_id, False, extra_env) == 0
        )
        kept = recorded and replayed
        if not kept and not recorded:
            for snapshot in snapshots:
                restore_file(snapshot)
        elif not kept:
            if cassette.is_file():
                cassette.unlink()
            delete_manifest_key(provider_slug, model_id, manifest_path)
            sync_go_agentic_loop_certs(repo, manifest_path)
        else:
            sync_go_agentic_loop_certs(repo, manifest_path)
        return CertifyResult(
            model_id=model_id,
            existed=existed,
            recorded=recorded,
            replayed=replayed,
            kept=kept,
        )
    except BaseException:
        for snapshot in snapshots:
            restore_file(snapshot)
        raise
