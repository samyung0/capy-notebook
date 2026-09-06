"""Retrieval-slot prompt: the instruct prefix a Qwen3 embedding query needs.

Only the query side is prefixed. Passages are embedded bare, and any other
pinned embedding model takes the raw query — ``models.format_query`` owns that
branch because it is the one that holds the workspace's pin.
"""

from __future__ import annotations

QWEN3_QUERY_TASK = (
    "Given a question about the user's notes and uploaded materials, "
    "retrieve relevant passages that answer the question"
)


def qwen3_query(query: str) -> str:
    return f"Instruct: {QWEN3_QUERY_TASK}\nQuery:{query}"
