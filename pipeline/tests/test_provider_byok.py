from __future__ import annotations

import pytest

from pipeline.config import ProviderCfg
from pipeline.registry import (
    AUTH_PLATFORM,
    AUTH_PLATFORM_OR_USER,
    AUTH_USER_KEY,
    ModelConfig,
    RegistryError,
    bind_request_llm,
    extra_headers_for,
    input_budget,
    provider_cfg_for,
)
from pipeline.retrieval import models as retrieval_models


def _spec(**overrides) -> ModelConfig:
    base = {
        "model_key": "deepseek-flash",
        "version": 1,
        "display_name": "Flash",
        "provider_slug": "deepseek",
        "base_url": "https://api.deepseek.com",
        "provider_model_id": "deepseek-v4-flash",
        "auth_mode": AUTH_PLATFORM_OR_USER,
        "context_window_tokens": 1_000_000,
    }
    base.update(overrides)
    return ModelConfig(**base)


def test_unknown_slug_does_not_use_deepseek_env():
    bind_request_llm()
    with pytest.raises(RegistryError, match="unknown platform provider"):
        provider_cfg_for(
            _spec(
                model_key="mystery",
                provider_slug="mystery",
                auth_mode=AUTH_PLATFORM,
                base_url="https://example.test",
            )
        )


def test_user_key_required_without_request_secret():
    bind_request_llm()
    with pytest.raises(RegistryError, match="user key required"):
        provider_cfg_for(
            _spec(
                model_key="gpt-5.6-sol",
                provider_slug="openai",
                auth_mode=AUTH_USER_KEY,
                base_url="https://api.openai.com/v1",
            )
        )


def test_user_paid_without_key_does_not_use_platform():
    bind_request_llm(user_id="u_1", paid_by="user")
    with pytest.raises(RegistryError, match="user key required"):
        provider_cfg_for(
            _spec(
                model_key="deepseek-flash",
                provider_slug="deepseek",
                auth_mode=AUTH_PLATFORM_OR_USER,
            )
        )


def test_user_key_used_when_bound():
    bind_request_llm(user_api_key="sk-user")
    cfg = provider_cfg_for(
        _spec(
            model_key="gpt-5.6-sol",
            provider_slug="openai",
            auth_mode=AUTH_USER_KEY,
            base_url="https://api.openai.com/v1",
        )
    )
    assert cfg.api_key == "sk-user"
    assert cfg.base_url == "https://api.openai.com/v1"


def test_platform_row_ignores_bound_user_key():
    bind_request_llm(user_api_key="sk-user")
    cfg = provider_cfg_for(
        _spec(
            provider_slug="openrouter",
            auth_mode=AUTH_PLATFORM,
            base_url="https://openrouter.ai/api/v1",
            surfaces=("embedding",),
        )
    )
    assert cfg.api_key != "sk-user"
    assert cfg.base_url == "https://openrouter.ai/api/v1"


def test_embedding_uses_embedding_env_regardless_of_slug():
    bind_request_llm(user_api_key="sk-user")
    from pipeline.config import cfg as pipeline_cfg

    got = provider_cfg_for(
        _spec(
            model_key="self-host-embed",
            provider_slug="local",
            auth_mode=AUTH_PLATFORM,
            base_url="http://embed.internal/v1",
            surfaces=("embedding",),
        )
    )
    assert got.api_key == pipeline_cfg.embedding.api_key
    assert got.api_key != "sk-user"
    assert got.base_url == "http://embed.internal/v1"


def test_client_cache_uses_full_key():
    retrieval_models._clients.clear()
    first = retrieval_models.client(
        ProviderCfg("sk-aaaaaa-user-one", "https://api.openai.com/v1")
    )
    second = retrieval_models.client(
        ProviderCfg("sk-aaaaaa-user-two", "https://api.openai.com/v1")
    )
    again = retrieval_models.client(
        ProviderCfg("sk-aaaaaa-user-one", "https://api.openai.com/v1")
    )
    assert first is not second
    assert first is again
    retrieval_models._clients.clear()


def test_provider_client_disables_hidden_retries():
    retrieval_models._clients.clear()
    provider = retrieval_models.client(
        ProviderCfg("sk-accounted-call", "https://api.openai.com/v1")
    )
    assert provider.max_retries == 0
    retrieval_models._clients.clear()


def test_anthropic_headers():
    spec = _spec(provider_slug="anthropic")
    assert extra_headers_for(spec)["anthropic-version"] == "2023-06-01"


def test_input_budget_uses_catalog_window():
    assert input_budget(_spec(context_window_tokens=1_000_000)) == 1_000_000 - 8192
    assert input_budget(_spec(context_window_tokens=20_000)) == 20_000 - 8192
    assert input_budget(_spec(context_window_tokens=5000)) == 4000


def test_openai_reasoning_kwargs():
    bind_request_llm(reasoning_mode="on", reasoning_effort="high")
    spec = _spec(
        provider_slug="openai",
        params={
            "reasoning": {
                "canDisable": True,
                "efforts": ["low", "medium", "high"],
                "defaultMode": "on",
                "defaultEffort": "medium",
            }
        },
    )
    kwargs: dict = {"temperature": 0.3}
    retrieval_models._apply_reasoning(spec, kwargs)
    assert kwargs["reasoning_effort"] == "high"
    assert "temperature" not in kwargs


def test_openai_tools_force_reasoning_none():
    bind_request_llm(reasoning_mode="on", reasoning_effort="high")
    spec = _spec(
        provider_slug="openai",
        params={
            "reasoning": {
                "canDisable": True,
                "efforts": ["low", "medium", "high"],
                "defaultMode": "on",
                "defaultEffort": "medium",
            }
        },
    )
    kwargs: dict = {
        "temperature": 0.3,
        "tools": [{"type": "function", "function": {"name": "search_workspace"}}],
    }
    retrieval_models._apply_reasoning(spec, kwargs)
    assert kwargs["reasoning_effort"] == "none"


def test_quiz_grade_tokens_stay_small():
    bind_request_llm(reasoning_mode="on", reasoning_effort="high")
    assert retrieval_models.quiz_grade_max_tokens(_spec()) == 80


def test_reasoning_false_disables_even_when_catalog_cannot():
    bind_request_llm(reasoning_mode="on", reasoning_effort="high")
    spec = _spec(
        provider_slug="anthropic",
        params={
            "reasoning": {
                "canDisable": False,
                "efforts": ["low", "medium", "high"],
                "defaultMode": "on",
                "defaultEffort": "high",
                "style": "adaptive",
            }
        },
    )
    kwargs: dict = {"temperature": 0.1}
    retrieval_models._apply_reasoning(spec, kwargs, reasoning=False)
    assert kwargs["extra_body"]["thinking"] == {"type": "disabled"}
    assert "output_config" not in kwargs["extra_body"]


def test_openai_reasoning_uses_catalog_default_effort():
    bind_request_llm(reasoning_mode="on")
    spec = _spec(
        provider_slug="openai",
        params={
            "reasoning": {
                "canDisable": True,
                "efforts": ["low", "medium", "high"],
                "defaultMode": "on",
                "defaultEffort": "medium",
            }
        },
    )
    kwargs: dict = {"temperature": 0.3}
    retrieval_models._apply_reasoning(spec, kwargs)
    assert kwargs["reasoning_effort"] == "medium"


def test_openai_reasoning_empty_catalog_efforts_fails():
    bind_request_llm(reasoning_mode="on", reasoning_effort="high")
    spec = _spec(
        model_key="gpt-broken",
        provider_slug="openai",
        params={"reasoning": {"canDisable": True, "defaultMode": "on"}},
    )
    with pytest.raises(RegistryError, match="no usable effort"):
        retrieval_models._apply_reasoning(spec, {"temperature": 0.3})


def test_anthropic_budget_fail_closes_without_effort():
    bind_request_llm(reasoning_mode="on")
    spec = _spec(
        model_key="claude-haiku-4-5",
        provider_slug="anthropic",
        params={
            "reasoning": {
                "canDisable": True,
                "efforts": ["low", "medium", "high"],
                "defaultMode": "off",
                "defaultEffort": "",
                "style": "budget",
            }
        },
    )
    with pytest.raises(RegistryError, match="no usable effort"):
        retrieval_models._apply_reasoning(spec, {"temperature": 0.3})


def test_anthropic_budget_maps_xhigh_and_max():
    bind_request_llm(reasoning_mode="on", reasoning_effort="xhigh")
    spec = _spec(
        provider_slug="anthropic",
        params={
            "reasoning": {
                "canDisable": True,
                "efforts": ["low", "medium", "high", "xhigh", "max"],
                "defaultMode": "off",
                "defaultEffort": "medium",
                "style": "budget",
            }
        },
    )
    kwargs: dict = {}
    retrieval_models._apply_reasoning(spec, kwargs)
    assert kwargs["extra_body"]["thinking"] == {
        "type": "enabled",
        "budget_tokens": 32768,
    }
    bind_request_llm(reasoning_mode="on", reasoning_effort="max")
    kwargs = {}
    retrieval_models._apply_reasoning(spec, kwargs)
    assert kwargs["extra_body"]["thinking"]["budget_tokens"] == 65536


def test_anthropic_budget_unknown_effort_fails():
    bind_request_llm(reasoning_mode="on", reasoning_effort="ultra")
    spec = _spec(
        model_key="claude-broken",
        provider_slug="anthropic",
        params={
            "reasoning": {
                "canDisable": True,
                "efforts": ["ultra"],
                "defaultMode": "on",
                "defaultEffort": "ultra",
                "style": "budget",
            }
        },
    )
    with pytest.raises(RegistryError, match="no thinking budget"):
        retrieval_models._apply_reasoning(spec, {"temperature": 0.3})


def test_openai_reasoning_false_sets_effort_none():
    bind_request_llm(reasoning_mode="on", reasoning_effort="high")
    spec = _spec(
        provider_slug="openai",
        params={
            "reasoning": {
                "canDisable": True,
                "efforts": ["low", "medium", "high"],
                "defaultMode": "on",
                "defaultEffort": "medium",
            }
        },
    )
    kwargs: dict = {"temperature": 0.1}
    retrieval_models._apply_reasoning(spec, kwargs, reasoning=False)
    assert kwargs["reasoning_effort"] == "none"


class _StatusError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status_code = status


def test_classify_user_key_401():
    bind_request_llm(paid_by="user")
    err = retrieval_models.classify_user_key_error(_StatusError(401, "nope"))
    assert err is not None
    assert err.code == retrieval_models.INVALID_KEY


def test_classify_user_key_unclear():
    bind_request_llm(paid_by="user")
    err = retrieval_models.classify_user_key_error(RuntimeError("provider timeout"))
    assert err is not None
    assert err.code == retrieval_models.KEY_FAILED


def test_classify_user_key_skips_platform():
    bind_request_llm(paid_by="platform")
    assert retrieval_models.classify_user_key_error(_StatusError(401, "nope")) is None
