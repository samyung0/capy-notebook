"""Workspace-keyed LRU cache of ``LightRAG`` instances.

Instances are thin handles over a shared asyncpg pool, so keeping a bounded set
hot avoids re-running ``initialize_storages()`` on every request without holding
a connection per tenant. Eviction finalizes the instance's storages.

The cache MUST live on a single long-lived event loop (the worker's
``asyncio.run(main)`` or FastAPI's loop): asyncpg pools are bound to the loop
that created them.
"""

from __future__ import annotations

import asyncio
import logging
from collections import OrderedDict
from collections.abc import Awaitable, Callable

from lightrag import LightRAG

log = logging.getLogger("evo.rag.cache")


class RagCache:
    def __init__(
        self, builder: Callable[[str], Awaitable[LightRAG]], maxsize: int = 16
    ):
        self._builder = builder
        self._maxsize = max(1, maxsize)
        self._items: OrderedDict[str, LightRAG] = OrderedDict()
        self._lock = asyncio.Lock()

    async def get(self, workspace: str) -> LightRAG:
        async with self._lock:
            rag = self._items.get(workspace)
            if rag is not None:
                self._items.move_to_end(workspace)
                return rag

            rag = await self._builder(workspace)
            self._items[workspace] = rag
            self._items.move_to_end(workspace)
            await self._evict_if_needed()
            return rag

    async def discard(self, workspace: str) -> bool:
        """Drop a cached instance, finalizing its storages.

        Required before tearing a workspace's state down: a cached handle would
        keep pointing at tables and a graph that no longer exist, and the next
        request for that id would resurrect empty state instead of 404ing.
        """
        async with self._lock:
            rag = self._items.pop(workspace, None)
        if rag is None:
            return False
        try:
            await rag.finalize_storages()
        except Exception:
            log.exception("error finalizing discarded workspace=%s", workspace)
        return True

    async def _evict_if_needed(self) -> None:
        while len(self._items) > self._maxsize:
            ws, rag = self._items.popitem(last=False)
            log.info("evicting LightRAG for workspace=%s", ws)
            try:
                await rag.finalize_storages()
            except Exception:
                log.exception("error finalizing evicted workspace=%s", ws)

    async def close(self) -> None:
        async with self._lock:
            while self._items:
                _ws, rag = self._items.popitem(last=False)
                try:
                    await rag.finalize_storages()
                except Exception:
                    log.exception("error finalizing workspace during close")
