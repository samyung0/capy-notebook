"""Ingest-slot prompts: the descriptor written for each file.

These are read by another model, not by a person, so they stay English whatever
the uploader's locale — the descriptor is stored on canonical content and copied
to every later workspace that uploads the same bytes.

``SUMMARY_VERSION`` lives here so a prose change and its version bump are one
edit apart. It is deliberately not part of the parse fingerprint: rewording a
descriptor must not invalidate a parse. A refresh regenerates a descriptor
whose version differs.
"""

from __future__ import annotations

SUMMARY_VERSION = 2
DESCRIPTOR_WORDS = 50

SUMMARY_SYSTEM = (
    "You describe study material for another assistant. Return ONLY JSON: "
    '{"descriptor": "..."}. descriptor is one dense sentence of about 50 words '
    "naming the specific topics, terms and results covered. No preamble, no "
    "meta-commentary about the document being a document."
)

PARTIAL_SYSTEM = (
    "You summarize one section of a longer study document. Write a dense "
    "factual overview of the requested length covering the specific topics, "
    "terms and results in this section. No preamble."
)


def summary_messages(body: str) -> list[dict[str, str]]:
    """The descriptor of a whole document, as one JSON reply."""
    return [
        {"role": "system", "content": SUMMARY_SYSTEM},
        {
            "role": "user",
            "content": (
                f"Write a descriptor of about {DESCRIPTOR_WORDS} words.\n\n"
                f"Content:\n{body}"
            ),
        },
    ]


def partial_messages(body: str, word_target: int) -> list[dict[str, str]]:
    """One section of a document too large to describe in a single call."""
    return [
        {"role": "system", "content": PARTIAL_SYSTEM},
        {
            "role": "user",
            "content": f"Write about {word_target} words.\n\nContent:\n{body}",
        },
    ]
