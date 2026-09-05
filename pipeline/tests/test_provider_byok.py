from __future__ import annotations

import os

import pytest

from pipeline.elitellm.client import deepseek_thinking_body
from pipeline.registry import (
    ModelConfig,
    RegistryError,
    bind_request_llm,
    input_budget,
    provider_api_key_for,
)
from pipeline.retrieval import models as retrieval_models


def _spec(**overrides) -> ModelConfig:
    base = {
        "version": 1,
        "provider_name": "DeepSeek",
        "model_name": "Flash",
        "provider_slug": "deepseek",
        "model_slug": "deepseek-v4-flash",
        "platform_enabled": True,
        "byok_enabled": True,
        "thinking_levels": ("instant", "low", "mid", "high", "max"),
        "default_thinking": "instant",
        "context_window_tokens": 1_000_000,
    }
    base.update(overrides)
    return ModelConfig(**base)


def test_unknown_slug_is_rejected():
    bind_request_llm()
    with pytest.raises(RegistryError, match="unknown elitellm provider"):
        provider_api_key_for(
            _spec(
                provider_slug="mystery",
                model_slug="mystery",
            )
        )


def test_user_key_required_without_request_secret():
    bind_request_llm()
    with pytest.raises(RegistryError, match="user key required"):
        provider_api_key_for(
            _spec(
                provider_slug="openai",
                platform_enabled=False,
                byok_enabled=True,
            )
        )


def test_user_paid_without_key_does_not_use_platform():
    bind_request_llm(user_id="u_1", paid_by="user")
    with pytest.raises(RegistryError, match="user key required"):
        provider_api_key_for(
            _spec(
                provider_slug="deepseek",
                platform_enabled=True,
                byok_enabled=True,
            )
        )


def test_user_key_used_when_bound():
    bind_request_llm(user_api_key="sk-user")
    key = provider_api_key_for(
        _spec(
            provider_slug="openai",
            platform_enabled=False,
            byok_enabled=True,
        )
    )
    assert key == "sk-user"


def test_platform_row_ignores_bound_user_key(monkeypatch):
    bind_request_llm(user_api_key="sk-user")
    monkeypatch.setenv("DEEPINFRA_API_KEY", "sk-platform-deepinfra")
    key = provider_api_key_for(
        _spec(
            provider_slug="deepinfra",
            platform_enabled=True,
            byok_enabled=False,
            slots=("retrieval",),
        )
    )
    assert key == "sk-platform-deepinfra"


def test_embedding_uses_provider_env(monkeypatch):
    bind_request_llm(user_api_key="sk-user")
    monkeypatch.setenv("DEEPINFRA_API_KEY", "sk-deepinfra")
    key = provider_api_key_for(
        _spec(
            provider_slug="deepinfra",
            platform_enabled=True,
            byok_enabled=False,
            slots=("retrieval",),
        )
    )
    assert key == "sk-deepinfra"


def test_user_key_is_not_copied_into_process_env(monkeypatch):
    bind_request_llm(user_api_key="sk-user-secret")
    provider_api_key_for(
        _spec(provider_slug="openai", platform_enabled=False, byok_enabled=True)
    )
    assert os.environ.get("OPENAI_API_KEY") != "sk-user-secret"


def test_input_budget_uses_catalog_window():
    assert input_budget(_spec(context_window_tokens=1_000_000)) == 1_000_000 - 8192
    assert input_budget(_spec(context_window_tokens=20_000)) == 20_000 - 8192
    assert input_budget(_spec(context_window_tokens=5000)) == 4000


def test_input_budget_rejects_missing_catalog_window():
    with pytest.raises(RegistryError, match="positive context window"):
        input_budget(_spec(context_window_tokens=0))


def test_deepseek_thinking_maps_product_levels():
    bind_request_llm(thinking="high")
    assert deepseek_thinking_body("high") == {
        "thinking": {"type": "enabled"},
        "reasoning_effort": "high",
    }
    assert deepseek_thinking_body("instant") == {"thinking": {"type": "disabled"}}


def test_quiz_grade_tokens_stay_small():
    bind_request_llm(thinking="high")
    assert retrieval_models.quiz_grade_max_tokens(_spec()) == 80


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
