"""Ingest-slot prompts: the descriptor and summary written for each file.

These are read by another model, not by a person, so they stay English whatever
the uploader's locale — the summary is stored on canonical content and copied to
every later workspace that uploads the same bytes.

``SUMMARY_VERSION`` lives here so a prose change and its version bump are one
edit apart. It is deliberately not part of the parse fingerprint: rewording a
summary must not invalidate a parse. Donors copy the version, so a later
backfill can tell old summaries from new.
"""

from __future__ import annotations

SUMMARY_VERSION = 1
DESCRIPTOR_WORDS = 50

SUMMARY_SYSTEM = (
    "You summarize study material for another assistant. Return ONLY JSON: "
    '{"descriptor": "...", "summary": "..."}. descriptor is one dense sentence '
    "of about 50 words naming the topics covered. summary is a factual overview "
    "of the requested length. Name specific topics, terms and results. No "
    "preamble, no meta-commentary about the document being a document."
)

PARTIAL_SYSTEM = (
    "You summarize one section of a longer study document. Write a dense "
    "factual overview of the requested length covering the specific topics, "
    "terms and results in this section. No preamble."
)


def summary_messages(body: str, word_target: int) -> list[dict[str, str]]:
    """Descriptor plus summary for a whole document, as one JSON reply."""
    return [
        {"role": "system", "content": SUMMARY_SYSTEM},
        {
            "role": "user",
            "content": (
                f"Write a descriptor of about {DESCRIPTOR_WORDS} words and "
                f"a summary of about {word_target} words.\n\nContent:\n{body}"
            ),
        },
    ]


def partial_messages(body: str, word_target: int) -> list[dict[str, str]]:
    """One section of a document too large to summarize in a single call."""
    return [
        {"role": "system", "content": PARTIAL_SYSTEM},
        {
            "role": "user",
            "content": f"Write about {word_target} words.\n\nContent:\n{body}",
        },
    ]
