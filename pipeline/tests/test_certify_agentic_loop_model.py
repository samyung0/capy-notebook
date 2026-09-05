from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest
from prompt_toolkit import PromptSession
from prompt_toolkit.layout.containers import FloatContainer
from prompt_toolkit.layout.menus import CompletionsMenu

from pipeline.model_replay_cert import ModelListAuthError

SCRIPT = (
    Path(__file__).resolve().parents[1] / "scripts" / "certify_agentic_loop_model.py"
)


def load_certify_cli():
    spec = importlib.util.spec_from_file_location("certify_agentic_loop_model", SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def certify_cli():
    return load_certify_cli()


def test_align_model_catalog_menu_left_aligns_and_adds_check(certify_cli):
    session: PromptSession[str] = PromptSession()
    certify_cli.align_model_catalog_menu(session)

    menus = {}
    for node in session.layout.walk():
        if not isinstance(node, FloatContainer):
            continue
        for floating in node.floats:
            if isinstance(floating.content, CompletionsMenu):
                menus[id(floating)] = floating
    assert menus
    for floating in menus.values():
        assert floating.xcursor is False
        assert floating.left == 0
        checks = [
            margin
            for margin in floating.content.content.left_margins
            if isinstance(margin, certify_cli.SelectedCheckMargin)
        ]
        assert len(checks) == 1


def test_main_exits_when_api_key_is_rejected(certify_cli, monkeypatch):
    monkeypatch.setattr(certify_cli, "choose_provider", lambda _requested: "openai")
    monkeypatch.setattr(certify_cli, "print_certified_models", lambda _provider: None)
    monkeypatch.setattr(certify_cli, "certified_model_slugs", lambda _provider: [])
    monkeypatch.setattr(certify_cli, "read_api_key", lambda _provider: "bad-key")

    def reject(_provider: str, _api_key: str):
        raise ModelListAuthError("OPENAI_API_KEY was rejected by openai (401)")

    monkeypatch.setattr(certify_cli, "fetch_available_model_slugs", reject)

    with pytest.raises(
        SystemExit, match="OPENAI_API_KEY was rejected by openai \\(401\\)"
    ):
        certify_cli.main([])
