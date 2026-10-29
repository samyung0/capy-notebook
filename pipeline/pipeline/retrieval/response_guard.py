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
# Checked on prose answers only, once the response ends: an answer program
# streams, and the browser drops a statement it cannot parse.
_ARG_MARKUP = ("<arg_key", "</arg_value")
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

    def __init__(self) -> None:
        self.pending = ""
        self.flagged = False

    def push(self, text: str) -> str:
        if self.flagged:
            return ""
        text = self.pending + text
        self.pending = ""
        if contains_tool_protocol(text):
            self.flagged = True
            return ""
        lower = text.lower()
        hold = 0
        for marker in (*_OPENERS, *_JSON_KEYS):
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
