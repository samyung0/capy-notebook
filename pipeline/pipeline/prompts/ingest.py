"""Ingest-slot prompts: the descriptor written for each file and each note
of 200 tokens or more.

The prompt stays English whatever the uploader's locale; the descriptor itself
is written in the source's language, because it describes the content and is
stored on canonical content, copied to every later workspace that uploads the
same bytes. Rewording these prompts leaves stored descriptors in place: only
the reuse gate in ``retrieval/indexing.py`` regenerates one.
"""

from __future__ import annotations

from .sources import SOURCE_RULE, source_block

DESCRIPTOR_WORDS = 50

SUMMARY_SYSTEM = (
    "You describe study material for another assistant. Reply with one dense "
    f"sentence of about {DESCRIPTOR_WORDS} words naming the specific topics, "
    "terms and results covered, as plain text: no JSON, no preamble. Start with "
    "the subject itself; never refer to the text, document, article, outline or "
    "source. Write in the language the source is written in; for mixed-language "
    f"material, use its main language. {SOURCE_RULE}"
)


def summary_messages(body: str) -> list[dict[str, str]]:
    """The descriptor of a document (or its excerpt), as one plain-text reply."""
    return [
        {"role": "system", "content": SUMMARY_SYSTEM},
        {
            "role": "user",
            "content": (
                f"Write a descriptor of about {DESCRIPTOR_WORDS} words.\n\n"
                f"Content:\n{source_block(body)}"
            ),
        },
    ]
