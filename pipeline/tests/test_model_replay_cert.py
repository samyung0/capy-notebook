from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest

from pipeline.elitellm import observed_continuity
from pipeline.model_replay_cert import (
    ModelListAuthError,
    ModelListError,
    cassette_relpath,
    certification_entry,
    certified_model_slugs,
    certify_model,
    chat_provider_entries,
    delete_manifest_key,
    fetch_available_model_slugs,
    load_manifest,
    replay_certified_models,
    require_chat_provider,
    selectable_model_slugs,
    sync_go_agentic_loop_certs,
    two_turn_cassette_ok,
    upsert_manifest_key,
    write_manifest,
)

STREAM_TAPE = """interactions:
- request:
    body: '{"stream":true}'
  response:
    body:
      string: 'data: {}'
    headers:
      content-type: [text/event-stream]
    status:
      code: 200
- request:
    body: '{"stream":true}'
  response:
    body:
      string: 'data: {}'
    headers:
      content-type: [text/event-stream]
    status:
      code: 200
"""


def test_two_turn_cassette_requires_streaming_requests_and_sse(tmp_path: Path):
    streaming = tmp_path / "streaming.yaml"
    streaming.write_text(STREAM_TAPE)
    assert two_turn_cassette_ok(streaming)

    legacy = tmp_path / "legacy.yaml"
    legacy.write_text("- request:\n  code: 200\n- request:\n  code: 200\n")
    assert not two_turn_cassette_ok(legacy)


def test_chat_provider_entries_only_include_providers_with_a_model_list():
    catalog = {
        "providers": {
            "openai": {
                "name": "OpenAI",
                "platformEnv": "OPENAI_API_KEY",
            },
            "anthropic": {
                "name": "Anthropic",
                "platformEnv": "ANTHROPIC_API_KEY",
            },
            "deepinfra": {
                "name": "DeepInfra",
                "platformEnv": "DEEPINFRA_API_KEY",
            },
        }
    }
    assert chat_provider_entries(catalog) == [
        {
            "name": "Anthropic",
            "platformEnv": "ANTHROPIC_API_KEY",
            "slug": "anthropic",
        },
        {
            "name": "OpenAI",
            "platformEnv": "OPENAI_API_KEY",
            "slug": "openai",
        },
    ]


def test_require_chat_provider_rejects_non_chat_provider():
    assert require_chat_provider(" openai ") == "openai"
    assert require_chat_provider("zai") == "zai"
    with pytest.raises(ValueError, match="not a supported chat provider"):
        require_chat_provider("deepinfra")


def test_certified_model_slugs_are_sorted_and_provider_scoped(tmp_path: Path):
    path = tmp_path / "certs.json"
    write_manifest(
        {
            "anthropic": {"claude-z": {}, "claude-a": {}},
            "openai": {"gpt-only": {}},
        },
        path,
    )

    assert certified_model_slugs("anthropic", path) == ["claude-a", "claude-z"]
    assert certified_model_slugs("deepseek", path) == []


@pytest.mark.parametrize(
    ("provider_slug", "expected_url", "expected_header", "expected_params"),
    [
        (
            "anthropic",
            "https://api.anthropic.com/v1/models",
            "x-api-key",
            {"limit": 1000},
        ),
        (
            "deepseek",
            "https://api.deepseek.com/models",
            "authorization",
            {},
        ),
        (
            "openai",
            "https://api.openai.com/v1/models",
            "authorization",
            {},
        ),
    ],
)
def test_fetch_available_model_slugs_uses_provider_endpoint(
    provider_slug: str,
    expected_url: str,
    expected_header: str,
    expected_params: dict[str, int],
):
    captured = {}

    def get(url: str, **kwargs):
        captured["url"] = url
        captured.update(kwargs)
        return httpx.Response(
            200,
            request=httpx.Request("GET", url),
            json={"data": [{"id": "model-z"}, {"id": "model-a"}, {"id": "model-z"}]},
        )

    assert fetch_available_model_slugs(provider_slug, "sk-test", get=get) == [
        "model-a",
        "model-z",
    ]
    assert captured["url"] == expected_url
    assert expected_header in captured["headers"]
    assert captured["params"] == expected_params
    assert captured["timeout"] == 30.0


@pytest.mark.parametrize("status", [401, 403])
def test_fetch_available_model_slugs_rejects_unauthorized_key(status: int):
    def get(url: str, **_kwargs):
        return httpx.Response(status, request=httpx.Request("GET", url))

    with pytest.raises(
        ModelListAuthError,
        match=rf"OPENAI_API_KEY was rejected by openai \({status}\)",
    ):
        fetch_available_model_slugs("openai", "bad-key", get=get)


def test_fetch_available_model_slugs_names_deepinfra_key_when_zai_rejects():
    def get(url: str, **_kwargs):
        return httpx.Response(401, request=httpx.Request("GET", url))

    with pytest.raises(
        ModelListAuthError,
        match=r"DEEPINFRA_API_KEY was rejected by zai \(401\)",
    ):
        fetch_available_model_slugs("zai", "bad-key", get=get)


def test_fetch_available_model_slugs_rejects_provider_error():
    def get(url: str, **_kwargs):
        return httpx.Response(500, request=httpx.Request("GET", url))

    with pytest.raises(ModelListError, match="500") as error:
        fetch_available_model_slugs("openai", "sk-test", get=get)
    assert not isinstance(error.value, ModelListAuthError)


def test_zai_model_list_maps_deepinfra_wire_slug_to_catalog_slug():
    captured = {}

    def get(url: str, **_kwargs):
        captured["url"] = url
        return httpx.Response(
            200,
            request=httpx.Request("GET", url),
            json={"data": [{"id": "zai-org/GLM-5.3-Flash"}]},
        )

    assert fetch_available_model_slugs("zai", "sk-test", get=get) == ["glm-5.3-flash"]
    assert captured["url"] == "https://api.deepinfra.com/v1/models"


def test_selectable_models_retain_certified_slugs_missing_from_provider():
    assert selectable_model_slugs(
        ["available-model", "shared-model"],
        ["certified-model", "shared-model"],
    ) == ["available-model", "certified-model", "shared-model"]


def test_certify_rejects_invalid_identity_before_running(tmp_path: Path):
    def should_not_run(*_args, **_kwargs):
        raise AssertionError("pytest must not run")

    with pytest.raises(ValueError, match="not a supported chat provider"):
        certify_model(
            "deepinfra",
            "Qwen/Qwen3-Embedding-4B",
            "sk-test",
            repo=tmp_path,
            manifest_path=tmp_path / "certs.json",
            run_pytest=should_not_run,
        )
    with pytest.raises(ValueError, match="API key is required"):
        certify_model(
            "openai",
            "gpt-5.6-sol",
            " ",
            repo=tmp_path,
            manifest_path=tmp_path / "certs.json",
            run_pytest=should_not_run,
        )


def test_replay_command_forces_replay_mode(monkeypatch, tmp_path: Path):
    monkeypatch.setenv("EVO_TEST_RECORD", "once")
    captured = {}

    def run_process(command, **kwargs):
        captured["command"] = command
        captured.update(kwargs)
        return SimpleNamespace(returncode=7)

    assert replay_certified_models(repo=tmp_path, run_process=run_process) == 7
    assert captured["command"][3].endswith("test_certified_two_turn_replay")
    assert "EVO_TEST_RECORD" not in captured["env"]
    assert captured["cwd"] == tmp_path
    assert captured["check"] is False


def test_cassette_relpath_matches_existing_tapes():
    assert (
        cassette_relpath("deepseek", "deepseek-v4-flash")
        == "pipeline/tests/cassettes/replay/deepseek__deepseek_v4_flash.yaml"
    )
    assert (
        cassette_relpath("anthropic", "claude-haiku-4-5")
        == "pipeline/tests/cassettes/replay/anthropic__claude_haiku_4_5.yaml"
    )
    assert (
        cassette_relpath("openai", "gpt-5.6-sol")
        == "pipeline/tests/cassettes/replay/openai__gpt_5_6_sol.yaml"
    )


def test_observed_continuity_reads_whatever_the_provider_returned():
    assert observed_continuity({"reasoning_content": "think", "content": "hi"}) == [
        "reasoning_content"
    ]
    assert observed_continuity({"output_items": [{"encrypted_content": "enc"}]}) == [
        "encrypted_content"
    ]
    assert observed_continuity(
        {"thinking_blocks": [{"type": "thinking"}], "reasoning": "why"}
    ) == ["thinking_blocks", "reasoning"]
    assert observed_continuity({"content": "hi"}) == []


def test_upsert_writes_only_replay_metadata(tmp_path: Path):
    path = tmp_path / "certs.json"
    write_manifest(
        {
            "openai": {
                "gpt-5.6-sol": {
                    "cassette": "old.yaml",
                    "legacyMetadata": True,
                    "test": "old",
                }
            }
        },
        path,
    )
    existed = upsert_manifest_key(
        "openai",
        "gpt-5.6-sol",
        path,
    )
    assert existed is True
    entry = load_manifest(path)["openai"]["gpt-5.6-sol"]
    assert set(entry) == {"cassette", "test"}
    assert entry["test"].endswith("[openai/gpt-5.6-sol]")


def test_certification_entry_has_replay_metadata_only():
    entry = certification_entry(
        "anthropic",
        "claude-opus-4-7",
    )
    assert set(entry) == {"cassette", "test"}
    assert entry["cassette"].endswith("anthropic__claude_opus_4_7.yaml")


def test_certify_keeps_key_only_after_successful_replay(tmp_path: Path):
    path = tmp_path / "certs.json"
    write_manifest({}, path)
    calls: list[bool] = []

    def run_pytest(
        _provider: str, _model_id: str, record: bool, _env: dict[str, str]
    ) -> int:
        calls.append(record)
        return 0

    result = certify_model(
        "deepseek",
        "deepseek-v4-flash",
        "sk-test",
        repo=tmp_path,
        manifest_path=path,
        run_pytest=run_pytest,
    )
    assert result.kept is True
    assert result.existed is False
    assert calls == [True, False]
    entry = load_manifest(path)["deepseek"]["deepseek-v4-flash"]
    assert set(entry) == {"cassette", "test"}


def test_certify_deletes_existing_key_when_replay_fails(tmp_path: Path):
    path = tmp_path / "certs.json"
    upsert_manifest_key(
        "deepseek",
        "deepseek-v4-flash",
        path,
    )

    def run_pytest(
        _provider: str, _model_id: str, record: bool, _env: dict[str, str]
    ) -> int:
        return 0 if record else 1

    result = certify_model(
        "deepseek",
        "deepseek-v4-flash",
        "sk-test",
        repo=tmp_path,
        manifest_path=path,
        run_pytest=run_pytest,
    )
    assert result.existed is True
    assert result.recorded is True
    assert result.replayed is False
    assert result.kept is False
    assert "deepseek" not in load_manifest(path)


def test_certify_does_not_keep_mistyped_model_when_record_fails(tmp_path: Path):
    path = tmp_path / "certs.json"
    write_manifest({}, path)
    calls: list[bool] = []

    def run_pytest(
        _provider: str, _model_id: str, record: bool, _env: dict[str, str]
    ) -> int:
        calls.append(record)
        return 1 if record else 0

    result = certify_model(
        "anthropic",
        "claude-opus-4-7-typo",
        "sk-test",
        repo=tmp_path,
        manifest_path=path,
        run_pytest=run_pytest,
    )
    assert result.kept is False
    assert result.recorded is False
    assert result.replayed is False
    assert calls == [True]
    assert "anthropic" not in load_manifest(path)


def test_certify_restores_old_tape_when_record_fails(tmp_path: Path):
    path = tmp_path / "certs.json"
    upsert_manifest_key(
        "deepseek",
        "deepseek-v4-flash",
        path,
    )
    cassette = tmp_path / cassette_relpath("deepseek", "deepseek-v4-flash")
    cassette.parent.mkdir(parents=True)
    cassette.write_text("old tape\n")

    def run_pytest(
        _provider: str, _model_id: str, record: bool, _env: dict[str, str]
    ) -> int:
        return 1 if record else 0

    result = certify_model(
        "deepseek",
        "deepseek-v4-flash",
        "sk-test",
        repo=tmp_path,
        manifest_path=path,
        run_pytest=run_pytest,
    )
    assert result.kept is False
    assert result.recorded is False
    assert "deepseek-v4-flash" in load_manifest(path)["deepseek"]
    assert cassette.read_text() == "old tape\n"


def test_certify_restores_every_artifact_when_record_is_interrupted(tmp_path: Path):
    manifest_path = tmp_path / "certs.json"
    write_manifest(
        {"deepseek": {"deepseek-v4-flash": {"cassette": "old.yaml"}}},
        manifest_path,
    )
    cassette = tmp_path / cassette_relpath("deepseek", "deepseek-v4-flash")
    cassette.parent.mkdir(parents=True)
    cassette.write_text("old tape\n")
    go_certs = tmp_path / "server/internal/models/agentic_loop_certs.json"
    go_certs.parent.mkdir(parents=True)
    go_certs.write_text("old go certs\n")
    before_manifest = manifest_path.read_bytes()

    def run_pytest(
        _provider: str, _model_id: str, _record: bool, _env: dict[str, str]
    ) -> int:
        cassette.write_text("partial tape\n")
        go_certs.write_text("partial go certs\n")
        raise KeyboardInterrupt

    with pytest.raises(KeyboardInterrupt):
        certify_model(
            "deepseek",
            "deepseek-v4-flash",
            "sk-test",
            repo=tmp_path,
            manifest_path=manifest_path,
            run_pytest=run_pytest,
        )

    assert manifest_path.read_bytes() == before_manifest
    assert cassette.read_text() == "old tape\n"
    assert go_certs.read_text() == "old go certs\n"


def test_certify_removes_new_artifacts_when_replay_is_interrupted(tmp_path: Path):
    manifest_path = tmp_path / "certs.json"
    go_certs = tmp_path / "server/internal/models/agentic_loop_certs.json"
    calls: list[bool] = []

    def run_pytest(
        _provider: str, model_id: str, record: bool, _env: dict[str, str]
    ) -> int:
        calls.append(record)
        cassette = tmp_path / cassette_relpath("anthropic", model_id)
        cassette.parent.mkdir(parents=True, exist_ok=True)
        cassette.write_text("new tape\n")
        if not record:
            raise KeyboardInterrupt
        return 0

    with pytest.raises(KeyboardInterrupt):
        certify_model(
            "anthropic",
            "claude-new",
            "sk-test",
            repo=tmp_path,
            manifest_path=manifest_path,
            run_pytest=run_pytest,
        )

    assert calls == [True, False]
    assert not manifest_path.exists()
    assert not (tmp_path / cassette_relpath("anthropic", "claude-new")).exists()
    assert not go_certs.exists()


def test_delete_manifest_key_is_idempotent(tmp_path: Path):
    path = tmp_path / "certs.json"
    write_manifest({}, path)
    assert delete_manifest_key("deepseek", "missing", path) is False


def test_sync_keeps_certification_scoped_to_provider(tmp_path: Path):
    manifest_path = tmp_path / "certs.json"
    cassette = "pipeline/tests/cassettes/replay/deepseek__shared.yaml"
    write_manifest(
        {
            "deepseek": {"shared": {"cassette": cassette}},
            "deepinfra": {
                "shared": {
                    "cassette": "pipeline/tests/cassettes/replay/deepinfra__shared.yaml"
                }
            },
        },
        manifest_path,
    )
    tape = tmp_path / cassette
    tape.parent.mkdir(parents=True)
    tape.write_text(STREAM_TAPE)

    sync_go_agentic_loop_certs(tmp_path, manifest_path)

    generated = json.loads(
        (tmp_path / "server/internal/models/agentic_loop_certs.json").read_text()
    )
    assert generated["certified"] == {"deepseek": {"shared": True}}
