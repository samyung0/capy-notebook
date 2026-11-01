"""Keep recognizable tool-call envelopes out of assistant answer text."""

from __future__ import annotations

import re

FLAGGED_CODE = "response_flagged"
FLAGGED_MESSAGE = "Response flagged due to safety concern"

# ponytail: recognize protocol envelopes, not arbitrary code or obfuscation.
# Add a marker here when another provider's wire format leaks into text.
_OPENERS = (
    "<｜dsml｜",
    "<｜｜dsml｜｜",
    "<|dsml|",
    "<||dsml||",
    "<tool_call",
    "<function_call",
    "<function=",
    "<invoke ",
    "[tool_calls]",
    # MiniMax's own markup, which it once wrote as a whole answer after
    # 30,771 reasoning tokens, closing tags only (2026-10-30 loop trace, T5).
    "]<]minimax[>[",
    "</invoke>",
    "</tool_call>",
)
# GLM's argument markup (AskUser<arg_key>question</arg_key><arg_value>...).
# Checked once the response ends: it can stream before it reads as markup.
_ARG_MARKUP = ("<arg_key", "</arg_value")
_ASK = "AskUser"
_JSON_KEYS = ('"tool_calls"', '"function_call"')
_JSON_CALL = re.compile(r'"(?:tool_calls|function_call)"\s*:', re.IGNORECASE)


def contains_tool_protocol(text: str) -> bool:
    lower = text.lower()
    return any(marker in lower for marker in _OPENERS) or bool(_JSON_CALL.search(text))


def contains_arg_markup(text: str) -> bool:
    lower = text.lower()
    return any(marker in lower for marker in _ARG_MARKUP)


class ResponseGuard:
    """Hold incomplete markers so splitting one across deltas cannot leak it."""

    def __init__(self, *, ask_markup: bool = False) -> None:
        """``ask_markup``: hold everything from a written AskUser on, for
        agent.text_ask_user to read back when the response ends."""
        self.pending = ""
        self.flagged = False
        self.ask_markup = ask_markup

    def push(self, text: str) -> str:
        if self.flagged:
            return ""
        text = self.pending + text
        self.pending = ""
        if contains_tool_protocol(text):
            self.flagged = True
            return ""
        if self.ask_markup and (at := text.find(_ASK)) >= 0:
            self.pending = text[at:]
            return text[:at]
        lower = text.lower()
        hold = 0
        markers = (
            *_OPENERS,
            *_JSON_KEYS,
            *((_ASK.lower(),) if self.ask_markup else ()),
        )
        for marker in markers:
            for size in range(1, len(marker) + 1):
                if lower.endswith(marker[:size]):
                    hold = max(hold, size)
        for key in _JSON_KEYS:
            if lower.rstrip().endswith(key):
                hold = max(hold, len(text) - len(text.rstrip()) + len(key))
        if hold:
            self.pending = text[-hold:]
            return text[:-hold]
        return text

    def finish(self) -> str:
        text, self.pending = self.pending, ""
        return "" if self.flagged else text
