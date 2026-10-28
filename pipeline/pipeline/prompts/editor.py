"""Editor-slot prompt: note ghost text (Epo 2026-10-28).

The model sees the note title and the text around a caret marker and replies
with only what goes at the caret. No language field: the model follows the
note's language and script on its own.
"""

from __future__ import annotations

CARET = "<CARET>"
GHOST_MAX_TOKENS = 40
GHOST_TEMPERATURE = 0.2

GHOST_SYSTEM = (
    f"You complete the user's note at {CARET}. Reply with only the text that goes at "
    "the caret: at most one sentence, in the note's language, no Markdown, no "
    "repetition of the text before or after it. Reply with nothing if no "
    "continuation fits."
)


def ghost_text_messages(title: str, before: str, after: str) -> list[dict[str, str]]:
    return [
        {"role": "system", "content": GHOST_SYSTEM},
        {"role": "user", "content": f"Title: {title}\n\n{before}{CARET}{after}"},
    ]
