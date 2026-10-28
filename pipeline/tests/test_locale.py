"""Offline tests for account-locale instructions on user-facing LLM prompts.

Ingest prompts are intentionally not covered: they must stay English.
"""

from __future__ import annotations

from pipeline.prompts.chat import system_prompt
from pipeline.prompts.locale import (
    language_name,
    normalize_locale,
    response_language_rule,
)


def test_normalize_locale_maps_zh_prefixes_and_defaults_to_en():
    assert normalize_locale("zh") == "zh"
    assert normalize_locale("zh-CN") == "zh"
    assert normalize_locale("ZH") == "zh"
    assert normalize_locale("en") == "en"
    assert normalize_locale(None) == "en"
    assert normalize_locale("fr") == "en"


def test_response_rule_names_the_user_language_and_keeps_structure():
    zh = response_language_rule("zh")
    assert "Simplified Chinese" in zh
    assert "JSON keys" in zh
    assert language_name("en") == "English"
    assert "English" in response_language_rule(None)


def test_chat_system_prompt_appends_locale_rule():
    prompt = system_prompt("zh")
    assert "study assistant" in prompt
    assert "Simplified Chinese" in prompt
