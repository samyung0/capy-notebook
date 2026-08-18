"""Evo Notes retrieval pipeline.

Two runtime roles share this package (compose picks the command):
- ``pipeline.ingest.worker``    — claims jobs, parses on Modal or MinerU lite,
  chunks and embeds into the retrieval index, publishes progress to Redis.
- ``pipeline.retrieve.service`` — FastAPI chat/generate over that index.

Supporting packages: ``parse`` (document parsers), ``retrieval`` (chunking,
embedding, search, tools, agent), ``store`` (Postgres queue + B2 blobs).
"""

from __future__ import annotations

import asyncio
import sys


def use_compatible_event_loop() -> None:
    """Select an event loop psycopg's async driver can use.

    Python defaults to the Proactor loop on Windows and psycopg refuses to run
    on it, so every database call fails with a pool timeout instead of an error
    that names the cause. Deployment is Linux-only, but the worker and the
    service are both run locally during development. Call before the loop is
    created; a no-op everywhere else.
    """
    if sys.platform == "win32":
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
