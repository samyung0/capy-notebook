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
-- GLM-5.3-Flash is served by Z.AI itself (2026-10-20), whose limits are set per
-- account and were not measured. Its gate keeps the 100 concurrent calls / 80
-- interactive reserve sized for Relace, which served it before: Z.AI's 429s
-- show under Ops Health "Busy models", the signal to revisit the limit. The
-- gate stays as a runaway bound.
-- OpenRouter DeepSeek V4 Flash 0731 (held on Relace) serves only the ingest
-- descriptor, so it has no interactive reserve. Measured 2026-10-15: no 429 at
-- up to 96 calls in flight; 32 in flight held ~600 requests/min (p95 5.5 s),
-- while 96 queued (p95 25 s), so the gate stops at 32.
-- OpenRouter DeepSeek V4.1 Flash 1017 (held on DeepInfra) reads pages and
-- images for captioning, so it has no interactive reserve either. It copies the
-- 0731 gate unmeasured. Page reads lease the fixed vlm_page gate of 20 instead
-- of this row, so it gates standalone image captions only.
-- Interactive reserves: 80% GLM / 60% DeepSeek / 40% embedding.
-- The reranker is a separate DeepInfra model on the same account, with its own
-- 200-request limit. Only interactive search calls it, so its reserve never
-- binds; it copies the embedding's 80.

WITH capacities(provider, model, concurrency_total, interactive_reserve) AS (
  VALUES
    ('deepseek', 'deepseek-flash', 2500, 2200),
    ('zai', 'glm-5.3-flash', 100, 80),
    ('openrouter', 'deepseek/deepseek-v4-flash-0731', 32, 0),
    ('openrouter', 'deepseek/deepseek-v4.1-flash-1017', 32, 0),
    ('deepinfra', 'Qwen/Qwen3-Embedding-4B', 200, 80),
    ('deepinfra', 'Qwen/Qwen3-Reranker-4B', 200, 80)
)
INSERT INTO model_capacities (provider, model, concurrency_total, interactive_reserve)
SELECT provider, model, concurrency_total, interactive_reserve FROM capacities c
WHERE EXISTS (
  SELECT 1 FROM model_configs m WHERE m.enabled AND m.platform_enabled
    AND m.model_slug = c.model
    AND m.provider_slug = c.provider
)
ON CONFLICT (provider, model) DO NOTHING;

SELECT provider, model, concurrency_total, interactive_reserve,
  concurrency_total - interactive_reserve AS ingest_limit
FROM model_capacities ORDER BY provider, model;
