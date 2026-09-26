-- The rerank slot: search_workspace and search_knowledge rerank their first 20
-- fused candidates with this slot's default. Leaving the slot without a default
-- turns reranking off (search keeps fused order), so Ops may clear it.
ALTER TABLE model_configs DROP CONSTRAINT IF EXISTS model_configs_slots_check;
ALTER TABLE model_configs ADD CONSTRAINT model_configs_slots_check CHECK (
  slots <@ ARRAY['chat','generate','editor','quiz','ingest','retrieval','captioning','rerank']::text[]
  AND slots <> '{}'
);
ALTER TABLE model_configs DROP CONSTRAINT IF EXISTS model_configs_capabilities_check;
ALTER TABLE model_configs ADD CONSTRAINT model_configs_capabilities_check CHECK (
  capabilities <@ ARRAY['vision','pdf','embedding','rerank']::text[]
);
ALTER TABLE model_configs DROP CONSTRAINT IF EXISTS model_configs_default_for_check;
ALTER TABLE model_configs ADD CONSTRAINT model_configs_default_for_check CHECK (
  is_default_for <@ ARRAY['chat','generate','editor','quiz','ingest','retrieval','captioning','rerank']::text[]
);

-- DeepInfra rows are only the seeded qwen-embed hop in the retrieval slot and
-- the Qwen3 reranker in the rerank slot, never BYOK. No other router rows.
ALTER TABLE model_configs DROP CONSTRAINT IF EXISTS model_configs_deepinfra_embed_check;
ALTER TABLE model_configs DROP CONSTRAINT IF EXISTS model_configs_deepinfra_check;
ALTER TABLE model_configs ADD CONSTRAINT model_configs_deepinfra_check CHECK (
  provider_slug <> 'deepinfra'
  OR (
    NOT byok_enabled
    AND (
      (model_slug = 'Qwen/Qwen3-Embedding-4B' AND slots = ARRAY['retrieval']::text[])
      OR (model_slug = 'Qwen/Qwen3-Reranker-4B' AND slots = ARRAY['rerank']::text[])
    )
  )
);

-- Credit rates follow the embedding row. Qwen3-Embedding-4B lists at $0.02 per
-- 1M input tokens and carries 50 micros per token, i.e. 2,500 micros per
-- dollar-per-million. Qwen3-Reranker-4B lists at $0.025 per 1M input tokens:
-- 62.5, rounded up to 63 because rates are whole micros. Output mirrors input
-- as on the embedding row (the route reports none). The cached-input rate is
-- the input rate: DeepInfra reports no cache split here, and a platform row
-- outside retrieval needs all three rates above zero. Interactive reranks are
-- recorded at zero credits like query embeddings; the rates label the row.
INSERT INTO model_configs (
  version, provider_name, model_name, provider_slug, model_slug,
  platform_enabled, byok_enabled, context_window_tokens,
  thinking_levels, default_thinking, params, slots, capabilities,
  micros_per_input_token, micros_per_output_token, micros_per_cached_input_token,
  enabled, is_default_for, created_by, updated_by
) VALUES (
  1, 'Qwen', 'Reranker 4B', 'deepinfra', 'Qwen/Qwen3-Reranker-4B',
  true, false, 0,
  ARRAY[]::text[], '', '{}'::jsonb, ARRAY['rerank'], ARRAY['rerank'],
  63, 63, 63,
  true, ARRAY['rerank'], 'migration:0030', 'migration:0030'
) ON CONFLICT (provider_slug, model_slug, version) DO NOTHING;

-- The reranker shares this environment's DeepInfra account with the embedding
-- model, and DeepInfra limits concurrency per account and model, so it takes
-- the embedding row's environment-local limit when one is configured. Missing
-- limits stay explicit; deploy/model-capacities.sql populates them.
INSERT INTO model_capacities (provider, model, concurrency_total, interactive_reserve)
SELECT provider, 'Qwen/Qwen3-Reranker-4B', concurrency_total, interactive_reserve
FROM model_capacities
WHERE provider = 'deepinfra' AND model = 'Qwen/Qwen3-Embedding-4B'
ON CONFLICT (provider, model) DO NOTHING;

UPDATE model_registry_state SET version = version + 1, updated_at = now();
