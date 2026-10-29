-- The rerank slot moves from DeepInfra Qwen3-Reranker-4B to Alibaba Model
-- Studio qwen3-rerank in the Singapore workspace (Epo 2026-10-30).
-- bench/rag/providers measured it level with the 4B on library search (MRR@10
-- 0.938 vs 0.940) at more than ten times the 4B's throughput from the ingest
-- host. The DeepInfra row and its capacity go, so DeepInfra is again only the
-- seeded qwen-embed hop.
DELETE FROM model_configs
WHERE provider_slug = 'deepinfra' AND model_slug = 'Qwen/Qwen3-Reranker-4B';
DELETE FROM model_capacities
WHERE provider = 'deepinfra' AND model = 'Qwen/Qwen3-Reranker-4B';

ALTER TABLE model_configs DROP CONSTRAINT model_configs_deepinfra_check;
ALTER TABLE model_configs ADD CONSTRAINT model_configs_deepinfra_check CHECK (
  provider_slug <> 'deepinfra'
  OR (model_slug = 'Qwen/Qwen3-Embedding-4B' AND slots = ARRAY['retrieval']::text[])
);

-- qwen3-rerank lists at $0.10 per 1M input tokens: 200 micros per token at
-- 2,000 micros per dollar-per-million (one credit is $0.0005, 2026-10-15).
-- Output and cached input mirror input as on the 4B row; interactive reranks
-- settle at zero credits, and the rates label the row.
INSERT INTO model_configs (
  version, provider_name, model_name, provider_slug, model_slug,
  context_window_tokens, thinking_levels, default_thinking, params, slots, capabilities,
  micros_per_input_token, micros_per_output_token, micros_per_cached_input_token,
  enabled, is_default_for, created_by, updated_by
) VALUES (
  1, 'Alibaba', 'Qwen3 Rerank', 'alibaba', 'qwen3-rerank',
  0, ARRAY[]::text[], '', '{}'::jsonb, ARRAY['rerank'], ARRAY['rerank'],
  200, 200, 200,
  true, ARRAY['rerank'], 'migration:0134', 'migration:0134'
) ON CONFLICT (provider_slug, model_slug, version) DO NOTHING;

-- 64 requests in flight answered without an error in the ramp (2026-10-30).
-- Only interactive search reranks, so the reserve never binds.
INSERT INTO model_capacities (provider, model, concurrency_total, interactive_reserve)
VALUES ('alibaba', 'qwen3-rerank', 64, 32)
ON CONFLICT (provider, model) DO NOTHING;

UPDATE model_registry_state SET version = version + 1, updated_at = now();
