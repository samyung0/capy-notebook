"""DeepSeek's web search (POST /v1/tools/search) behind the agent's search_web.

One attempt per search and no retry: a failed search is free and the agent
answers from what it has (Epo 2026-10-24). The request carries the platform
DeepSeek key and the query only; the learner's question and IP
(``ori_question``, ``localization``) are never sent. Results are pages anyone
can publish, so the caller shows them as source data, never instructions.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from urllib.parse import urlsplit

import requests

from ..config import platform_api_key

SEARCH_URL = "https://api.deepseek.com/v1/tools/search"
# Results per search; DeepSeek bills per search whatever the count.
RESULTS = 5
TIMEOUT_S = 20
QUERY_MAX = 128


class SearchFailed(RuntimeError):
    """The search did not answer with results or an empty list."""


@dataclass(frozen=True)
class WebResult:
    title: str
    url: str
    # The short display text (DeepSeek's snippet) and the model-sized excerpt
    # (its summary, about 600-800 characters).
    snippet: str
    summary: str
    site: str
    # The page date as YYYY-MM-DD, or "" when DeepSeek has none.
    date: str


def _text(value: object, limit: int) -> str:
    return " ".join(str(value or "").split())[:limit]


def _result(raw: object) -> WebResult | None:
    """A result with a title and an http(s) link, or None."""
    if not isinstance(raw, dict):
        return None
    url = str(raw.get("url") or "").strip()
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.hostname or len(url) > 2048:
        return None
    title = _text(raw.get("title"), 300)
    summary = _text(raw.get("summary"), 1200) or _text(raw.get("snippet"), 1200)
    if not title or not summary:
        return None
    return WebResult(
        title=title,
        url=url,
        snippet=_text(raw.get("snippet"), 300) or summary[:300],
        summary=summary,
        site=_text(raw.get("site_name"), 120) or parts.hostname,
        date=_text(raw.get("date"), 10),
    )


async def search(query: str) -> list[WebResult]:
    """The results for one query (possibly none). Raises SearchFailed."""
    key = platform_api_key("deepseek")
    if not key:
        raise SearchFailed("the search key is not configured")

    def _post() -> requests.Response:
        return requests.post(
            SEARCH_URL,
            headers={"Authorization": f"Bearer {key}"},
            json={"query": query[:QUERY_MAX], "count": RESULTS},
            timeout=TIMEOUT_S,
        )

    try:
        response = await asyncio.to_thread(_post)
    except requests.RequestException as exc:
        raise SearchFailed(type(exc).__name__) from exc
    if response.status_code >= 300:
        raise SearchFailed(f"HTTP {response.status_code}")
    try:
        body = response.json()
    except ValueError as exc:
        raise SearchFailed("invalid JSON") from exc
    results = body.get("results") if isinstance(body, dict) else None
    if not isinstance(results, list):
        raise SearchFailed("no results list")
    return [r for r in map(_result, results) if r is not None][:RESULTS]
