"""Source-reviewed annotations for library retrieval, separate from full notes."""

from typing import TypedDict


class RetrievalMetadata(TypedDict):
    summary: str
    scope: str
    context_excerpt_ids: list[str]


def validate_metadata(
    value: object, excerpt_id: str, book_excerpt_ids: set[str]
) -> None:
    """Validate a reviewed annotation against the exact book being imported."""
    if not isinstance(value, dict) or set(value) != {
        "summary",
        "scope",
        "context_excerpt_ids",
    }:
        raise ValueError(f"invalid retrieval metadata for {excerpt_id}")
    for key, limit in (("summary", 400), ("scope", 600)):
        text = value[key]
        if not isinstance(text, str) or not text.strip() or len(text) > limit:
            raise ValueError(
                f"retrieval {key} must contain 1-{limit} characters: {excerpt_id}"
            )
    links = value["context_excerpt_ids"]
    if (
        not isinstance(links, list)
        or any(not isinstance(link, str) for link in links)
        or len(links) > 8
        or len(set(links)) != len(links)
        or excerpt_id in links
        or not set(links) <= book_excerpt_ids
    ):
        raise ValueError(f"invalid context excerpt links for {excerpt_id}")


def indexed_text(text: str, metadata: RetrievalMetadata | None) -> str:
    """Index reviewed teaching scope without changing the quoted source passage."""
    if metadata is None:
        return text
    return (
        f"{text}\n\nReviewed description: {metadata['summary']}"
        f"\nApplicability: {metadata['scope']}"
    )
