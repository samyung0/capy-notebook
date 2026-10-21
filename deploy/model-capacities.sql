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
-- GLM-5.3-Flash keeps its zai catalog pair, which the gate keys on, and is
-- served through OpenRouter on DigitalOcean, then Z.AI (2026-10-21). DigitalOcean
-- held 150 calls in flight for 66 s with no error (first token p95 2.2 s) and
-- answered 250 at once, but half of those waited past the 15 s first-event
-- bound, so the gate is 150 in flight with 125 kept for interactive calls
-- (decision 2026-10-21). The OpenRouter account is shared and sized for
-- production; local development keeps 8 total / 4 interactive.
-- OpenRouter DeepSeek V4 Flash 0731 (Reka, then DigitalOcean, then StreamLake
-- since 2026-10-20) serves only the ingest descriptor, so it has no interactive
-- reserve. Measured on Relace 2026-10-15: no 429 at up to 96 calls in flight;
-- 32 in flight held ~600 requests/min (p95 5.5 s), while 96 queued (p95 25 s),
-- so the gate stops at 32. Each current provider held 32 in flight without a
-- 429 on 2026-10-20.
-- OpenRouter DeepSeek V4.1 Flash 1017 (InferenceNet, then Cloudflare, since
-- 2026-10-21) reads pages and images for captioning, so it has no interactive
-- reserve either. InferenceNet answered 128 page reads at once (p95 8.6 s) and
-- Cloudflare 64 (p95 10.1 s), so this row's gate is 64 (decision 2026-10-21).
-- Page reads lease the vlm_page gate instead of this row (CAPY_VLM_PAGE_CAPACITY:
-- 64 in production, 20 in UAT and local), so it gates standalone image
-- captions only. The two gates add up: production can hold 128 calls in flight
-- on this route, which InferenceNet held, but Cloudflare, the fallback, was
-- measured only at 64, so an InferenceNet outage during a burst may leave
-- reads slow or busy on Cloudflare.
-- Interactive reserves: 83% GLM / 60% DeepSeek / 40% embedding.
-- The reranker is a separate DeepInfra model on the same account, with its own
-- 200-request limit. Only interactive search calls it, so its reserve never
-- binds; it copies the embedding's 80.

WITH capacities(provider, model, concurrency_total, interactive_reserve) AS (
  VALUES
    ('deepseek', 'deepseek-flash', 2500, 2200),
    ('zai', 'glm-5.3-flash', 150, 125),
    ('openrouter', 'deepseek/deepseek-v4-flash-0731', 32, 0),
    ('openrouter', 'deepseek/deepseek-v4.1-flash-1017', 64, 0),
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
