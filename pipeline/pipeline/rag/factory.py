"""Build per-workspace ``LightRAG`` instances over the shared Postgres + AGE +
pgvector backends.

Each call creates a ``LightRAG(workspace=workspaceId, ...)`` so the four PG
storages (KV / vector / graph / doc-status) are isolated per tenant: the PG
storages add a ``workspace`` column, and ``PGGraphStorage`` derives a
per-workspace AGE graph name from it automatically.

The worker and retrieval service build different *kinds* of instance (ingest
uses the fixed flash model + the Gemini vlm role for multimodal analysis;
query uses the pro/flash dispatcher), but both share the SAME embedding
function/dimension — that is mandatory because they read and write the same
vector store.

Importing this module registers the custom ``modal`` parser engine so the
ingest pipeline can route pending_parse documents to the Modal GPU MineRU
service (see ``modal_parser.py``).
"""

from __future__ import annotations

import logging
from collections.abc import Callable

from lightrag import LightRAG
from lightrag.kg.shared_storage import initialize_pipeline_status
from lightrag.llm_roles import RoleLLMConfig

from ..config import cfg
from .modal_parser import register_modal_parser
from .models import (
    make_embedding_func,
    make_llm_func,
    make_query_llm_func,
    make_vlm_func,
)

log = logging.getLogger("evo.rag.factory")

# Embedding func/dim must be identical across every instance in the process.
_embedding_func = make_embedding_func()

register_modal_parser()


async def _build(
    workspace: str,
    llm_func: Callable,
    model_name: str,
    *,
    enable_llm_cache: bool,
    for_ingest: bool,
) -> LightRAG:
    extra: dict = {}
    if for_ingest:
        # i/t/e multimodal analysis needs the vlm role; Gemini handles images,
        # DeepSeek (the base llm) is text-only.
        extra["vlm_process_enable"] = True
        extra["role_llm_configs"] = {"vlm": RoleLLMConfig(func=make_vlm_func())}

    rag = LightRAG(
        working_dir=cfg.working_dir,
        workspace=workspace,
        llm_model_func=llm_func,
        llm_model_name=model_name,
        embedding_func=_embedding_func,
        kv_storage="PGKVStorage",
        vector_storage="PGVectorStorage",
        graph_storage="PGGraphStorage",
        doc_status_storage="PGDocStatusStorage",
        enable_llm_cache=enable_llm_cache,
        **extra,
    )
    await rag.initialize_storages()
    await initialize_pipeline_status(workspace)
    log.info(
        "built LightRAG for workspace=%s (model=%s, llm_cache=%s, ingest=%s)",
        workspace,
        model_name,
        enable_llm_cache,
        for_ingest,
    )
    return rag


async def build_ingest_rag(workspace: str) -> LightRAG:
    """Ingest-side instance: fixed cheap extraction model, LLM cache on.

    The cache is disabled when ``EVO_INGEST_LLM_CACHE=false`` (test recording).
    """
    return await _build(
        workspace,
        make_llm_func(cfg.ingest_model),
        cfg.ingest_model,
        enable_llm_cache=cfg.ingest_llm_cache,
        for_ingest=True,
    )


async def build_query_rag(workspace: str) -> LightRAG:
    """Query-side instance: model chosen per request (pro default / flash alt).

    LLM cache is disabled so a flash-vs-pro switch can't serve a cached answer
    produced by the other model.
    """
    return await _build(
        workspace,
        make_query_llm_func(),
        cfg.query_model,
        enable_llm_cache=False,
        for_ingest=False,
    )
