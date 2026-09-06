"""Offline tests for account-locale instructions on user-facing LLM prompts.

Ingest prompts are intentionally not covered: they must stay English.
"""

from __future__ import annotations

from pipeline.prompts.chat import system_prompt
from pipeline.prompts.locale import (
    language_name,
    normalize_locale,
    response_language_rule,
    rewrite_language_rule,
)
from pipeline.retrieve.ai_adapter import (
    PlateCommandReq,
    PlateContext,
    UIMessage,
    UIMessagePart,
    build_comment_prompt,
    build_edit_prompt,
    build_generate_prompt,
)


def _message(text: str) -> UIMessage:
    return UIMessage(role="user", parts=[UIMessagePart(type="text", text=text)])


def _command(
    *, locale: str | None, instruction: str = "Summarize this"
) -> PlateCommandReq:
    return PlateCommandReq(
        workspaceId="ws_1",
        thinking="instant",
        locale=locale,
        messages=[_message(instruction)],
        ctx=PlateContext(
            children=[{"id": "b1", "type": "p", "children": [{"text": "Hello"}]}],
            selection=None,
        ),
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


def test_rewrite_rule_keeps_selection_language():
    rule = rewrite_language_rule("zh")
    assert "简体中文" in rule
    assert "keep the selection's language" in rule


def test_chat_system_prompt_appends_locale_rule():
    prompt = system_prompt("zh")
    assert "study assistant" in prompt
    assert "Simplified Chinese" in prompt


def test_generate_and_comment_prompts_use_response_language():
    req = _command(locale="zh")
    generate = build_generate_prompt(req)
    comment = build_comment_prompt(req)

    assert "<language>" in generate
    assert "Write all user-visible prose in Simplified Chinese" in generate
    assert "Write all user-visible prose in Simplified Chinese" in comment
    assert "keep the selection's language" not in generate


def test_edit_prompt_keeps_selection_language():
    prompt = build_edit_prompt(_command(locale="zh", instruction="Make this shorter"))
    assert "keep the selection's language" in prompt
    assert "Write all user-visible prose" not in prompt
