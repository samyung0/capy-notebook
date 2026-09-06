"""Account-locale instructions for user-visible LLM replies.

Ingest and index prompts stay English: they write into a shared retrieval
index, not to a person. Chat, generate, and editor AI that speak *to the
user* append a language rule so replies match Settings → locale.
"""

from __future__ import annotations

_LANGUAGES = {
    "en": "English",
    "zh": "Simplified Chinese (简体中文)",
}


def normalize_locale(locale: str | None) -> str:
    raw = (locale or "").strip().lower()
    if raw.startswith("zh"):
        return "zh"
    return "en"


def language_name(locale: str | None) -> str:
    return _LANGUAGES[normalize_locale(locale)]


def response_language_rule(locale: str | None) -> str:
    lang = language_name(locale)
    return (
        f"Write all user-visible prose in {lang}. JSON keys, Mermaid syntax, "
        "code, formulas, citation markers, and proper nouns stay as specified "
        "or as they appear in the sources. Quoted source passages may remain "
        "in their original language. Do not switch languages unless the user "
        "explicitly asks."
    )


def rewrite_language_rule(locale: str | None) -> str:
    lang = language_name(locale)
    return (
        f"The user's UI language is {lang}. Write comments, explanations, and "
        f"newly generated standalone text in {lang}. When rewriting existing "
        "note content, keep the selection's language unless the instruction "
        "asks to translate."
    )
