-- Populate missing capacity rows in ONE explicitly selected environment,
-- after migrations. Run with psql -v ON_ERROR_STOP=1 -f deploy/model-capacities.sql.
-- Existing operator settings win; this is an opt-in bootstrap, not a migration.
-- If environments share a provider account, divide that account's capacity
-- between their databases before applying. Separate keys do not add capacity.
--
-- Official limits checked 2026-09-13:
-- DeepSeek Flash: 2500 concurrent requests per account.
-- https://api-docs.deepseek.com/quick_start/rate_limit/
-- DeepInfra: 200 concurrent requests per account/model.
-- https://docs.deepinfra.com/account/rate-limits
-- Tencent exposes account/model TPM and RPM, not a fixed concurrency limit.
-- https://cloud.tencent.com/document/api/1823/136110
-- User-confirmed quota (2026-09-13): 1,000,000 TPM / 60 RPM per model.
-- User-selected GLM capacity: 30 concurrent calls / 24 interactive reserve.
-- At an assumed 30 seconds and 10k tokens/call, 30 calls in flight imply
-- ~60 RPM and ~600k TPM, reaching the RPM limit under those assumptions.
-- RPM binds below ~16.7k tokens/request.
-- These are steady-state estimates. Bursts, shorter calls or larger prompts
-- can still receive 429s; concurrency does not enforce the per-minute quotas.
-- Interactive reserves: 80% Tencent GLM / 60% DeepSeek / 40% embedding.

WITH capacities(provider, model, concurrency_total, interactive_reserve) AS (
  VALUES
    ('deepseek', 'deepseek-flash', 2500, 2200),
    ('tencent', 'glm-5.3-flash', 30, 24),
    ('deepinfra', 'Qwen/Qwen3-Embedding-4B', 200, 80)
)
INSERT INTO model_capacities (provider, model, concurrency_total, interactive_reserve)
SELECT provider, model, concurrency_total, interactive_reserve FROM capacities c
WHERE EXISTS (
  SELECT 1 FROM model_configs m WHERE m.enabled AND m.platform_enabled
    AND m.model_slug = c.model
    AND m.provider_slug = CASE WHEN c.provider = 'tencent' THEN 'zai' ELSE c.provider END
)
ON CONFLICT (provider, model) DO NOTHING;

SELECT provider, model, concurrency_total, interactive_reserve,
  concurrency_total - interactive_reserve AS ingest_limit
FROM model_capacities ORDER BY provider, model;
