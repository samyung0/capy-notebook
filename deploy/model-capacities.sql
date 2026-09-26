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
-- Relace limits requests per key over a rolling minute, not concurrency.
-- https://docs.relace.ai/api-reference/introduction
-- Measured on the subscribed key (2026-09-26): roughly 700-800 RPM
-- (bench/rag/reports/2026-09-26-glm-relace-tencent.md).
-- GLM capacity: 100 concurrent calls / 80 interactive reserve, deliberately
-- above the key's budget. At the ~4 s median chat-agent turn in that report,
-- a full gate is ~1,500 RPM, so Relace's RPM limit binds first and its 429s
-- show under Ops Health "Busy models": that is the signal to ask Relace for a
-- higher limit. The gate stays as a runaway bound.
-- Interactive reserves: 80% Relace GLM / 60% DeepSeek / 40% embedding.
-- The reranker is a separate DeepInfra model on the same account, with its own
-- 200-request limit. Only interactive search calls it, so its reserve never
-- binds; it copies the embedding's 80.

WITH capacities(provider, model, concurrency_total, interactive_reserve) AS (
  VALUES
    ('deepseek', 'deepseek-flash', 2500, 2200),
    ('relace', 'glm-5.3-flash', 100, 80),
    ('deepinfra', 'Qwen/Qwen3-Embedding-4B', 200, 80),
    ('deepinfra', 'Qwen/Qwen3-Reranker-4B', 200, 80)
)
INSERT INTO model_capacities (provider, model, concurrency_total, interactive_reserve)
SELECT provider, model, concurrency_total, interactive_reserve FROM capacities c
WHERE EXISTS (
  SELECT 1 FROM model_configs m WHERE m.enabled AND m.platform_enabled
    AND m.model_slug = c.model
    AND m.provider_slug = CASE WHEN c.provider = 'relace' THEN 'zai' ELSE c.provider END
)
ON CONFLICT (provider, model) DO NOTHING;

SELECT provider, model, concurrency_total, interactive_reserve,
  concurrency_total - interactive_reserve AS ingest_limit
FROM model_capacities ORDER BY provider, model;
