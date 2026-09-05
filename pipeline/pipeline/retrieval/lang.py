"""Per-chunk language detection and the text-search configuration it selects.

The lexical index stems and drops stopwords per language, so every chunk
carries a language tag and its tsvector is built with that language's Postgres
configuration. A query is parsed once per language present in the search scope
and matched against the chunks of that language (see ``store.hybrid_search``),
so nothing has to guess the language of a three-word query.

Detection is deliberately small: script counts decide between the CJK
languages, and a function-word tally decides between the Latin ones. Both
signals are strong on a 400-token chunk and free. A chunk that shows neither
(tables, formulas, a language outside the list) is ``und`` and is indexed with
the ``simple`` configuration: exact tokens, no stemming, no stopwords.
"""

from __future__ import annotations

import re

UND = "und"

# Postgres configuration per language. CJK is bigrammed by the application
# and needs no stemmer; ``simple`` keeps every bigram and any embedded Latin
# word as written.
TS_CONFIG = {
    "en": "english",
    "fr": "french",
    "de": "german",
    "es": "spanish",
    "zh": "simple",
    "ja": "simple",
    "ko": "simple",
    UND: "simple",
}

_KANA = (0x3040, 0x30FF)
_HANGUL = (0xAC00, 0xD7AF)
_CJK_RANGES = (
    _KANA,
    (0x3400, 0x4DBF),  # CJK ext A
    (0x4E00, 0x9FFF),  # CJK unified
    (0xF900, 0xFAFF),  # compatibility ideographs
    _HANGUL,
)
CJK_CLASS = "[" + "".join(f"{chr(lo)}-{chr(hi)}" for lo, hi in _CJK_RANGES) + "]"
CJK_RUN_RE = re.compile(CJK_CLASS + "+")
_WORD_RE = re.compile(r"[^\W\d_]+")

# The commonest function words of each language. Shared spellings ("de", "la",
# "que") count for every language that has them; the distinctive ones decide.
_STOPWORDS = {
    "en": [
        "the",
        "and",
        "of",
        "to",
        "in",
        "is",
        "that",
        "for",
        "it",
        "with",
        "as",
        "was",
        "on",
        "are",
        "this",
        "by",
        "be",
        "or",
        "an",
        "which",
        "from",
        "at",
        "have",
        "not",
        "they",
        "has",
        "were",
    ],
    "fr": [
        "le",
        "la",
        "les",
        "de",
        "des",
        "du",
        "et",
        "est",
        "une",
        "un",
        "dans",
        "que",
        "qui",
        "pour",
        "pas",
        "sur",
        "au",
        "aux",
        "ce",
        "se",
        "sont",
        "avec",
        "par",
        "plus",
        "ne",
        "nous",
        "vous",
        "leur",
    ],
    "de": [
        "der",
        "die",
        "das",
        "und",
        "ist",
        "nicht",
        "ein",
        "eine",
        "zu",
        "den",
        "von",
        "mit",
        "sich",
        "auf",
        "für",
        "dem",
        "des",
        "im",
        "auch",
        "wird",
        "sind",
        "werden",
        "als",
        "oder",
        "bei",
        "einer",
    ],
    "es": [
        "el",
        "la",
        "los",
        "las",
        "de",
        "del",
        "y",
        "es",
        "en",
        "que",
        "un",
        "una",
        "por",
        "con",
        "para",
        "se",
        "su",
        "al",
        "como",
        "más",
        "pero",
        "son",
        "lo",
        "o",
        "sus",
        "también",
    ],
}
_STOPWORD_LANG: dict[str, list[str]] = {}
for _lang, _words in _STOPWORDS.items():
    for _word in _words:
        _STOPWORD_LANG.setdefault(_word, []).append(_lang)


def is_cjk(ch: str) -> bool:
    code = ord(ch)
    return any(lo <= code <= hi for lo, hi in _CJK_RANGES)


def detect_lang(text: str) -> str:
    """One of ``TS_CONFIG``'s keys."""
    cjk = kana = hangul = 0
    latin_letters = 0
    for ch in text:
        code = ord(ch)
        if _KANA[0] <= code <= _KANA[1]:
            kana += 1
            cjk += 1
        elif _HANGUL[0] <= code <= _HANGUL[1]:
            hangul += 1
            cjk += 1
        elif is_cjk(ch):
            cjk += 1
        elif ch.isalpha():
            latin_letters += 1
    # Same token model as estimate_tokens: a CJK character is a token, four
    # Latin letters are one. The dominant script by tokens names the branch.
    if cjk and cjk > latin_letters / 4:
        if kana >= 0.05 * cjk:
            return "ja"
        if hangul >= 0.5 * cjk:
            return "ko"
        return "zh"

    tally = dict.fromkeys(_STOPWORDS, 0)
    for word in _WORD_RE.findall(text.lower()):
        for lang in _STOPWORD_LANG.get(word, ()):
            tally[lang] += 1
    ranked = sorted(tally.items(), key=lambda item: item[1], reverse=True)
    (best, hits), (_, runner_up) = ranked[0], ranked[1]
    if hits >= 3 and hits > runner_up:
        return best
    return UND
