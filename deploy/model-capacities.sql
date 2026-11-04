-- Populate missing capacity rows in ONE explicitly selected environment,
-- after migrations. Run with psql -v ON_ERROR_STOP=1 -f deploy/model-capacities.sql.
-- Existing operator settings win; this is an opt-in bootstrap, not a migration.
-- If environments share a provider account, divide that account's capacity
-- between their databases before applying. Separate keys do not add capacity.
--
-- A row is the model's whole capacity, shared by every use with no reserve:
-- every call waits its turn in the model's one line, round-robin by requester
-- (the user, or the ingest job), so one use with more requests gets more
-- (Epo 2026-11-04).
--
-- Official limits checked 2026-09-13:
-- DeepInfra: 200 concurrent requests per account/model.
-- https://docs.deepinfra.com/account/rate-limits
-- GLM-5.3-Flash keeps its zai catalog pair, which the gate keys on, and is
-- served through OpenRouter on DigitalOcean, then Z.AI (2026-10-21). DigitalOcean
-- held 150 calls in flight for 66 s with no error (first token p95 2.2 s) and
-- answered 250 at once, but half of those waited past the 15 s first-event
-- bound, so the gate is 150 in flight (decision 2026-10-21). The OpenRouter
-- account is shared and sized for production; local development keeps 8.
-- OpenRouter DeepSeek V4 Flash 0731 (Reka, then DigitalOcean, then StreamLake
-- since 2026-10-20) serves the ingest descriptor. Measured on Relace
-- 2026-10-15: no 429 at up to 96 calls in flight; 32 in flight held ~600
-- requests/min (p95 5.5 s), while 96 queued (p95 25 s), so the gate stops at
-- 32. Each current provider held 32 in flight without a 429 on 2026-10-20.
-- OpenRouter DeepSeek V4.1 Flash 1017 (InferenceNet, then Cloudflare, since
-- 2026-10-21) captions standalone images and, from 2026-10-28, writes note
-- ghost text: 100 in flight (Epo 2026-11-04, raised from 40 with 20 kept for
-- interactive calls). Wafer took 100 grading calls at once with no error on
-- 2026-11-04 (its latency doubles from about 60 in flight, and InferenceNet
-- takes the overflow past about 100); InferenceNet answered 128 page reads at
-- once (p95 8.6 s) and Cloudflare 64 (p95 10.1 s); a 2026-10-28 ghost-text
-- probe from the ingest host held 64 in flight at about 5,000 calls a minute
-- with no 429. UAT and local keep 8 on the shared account. Page reads lease the
-- vlm_page gate instead of this row (CAPY_VLM_PAGE_CAPACITY: 40 in production
-- since 2026-10-29, 20 in UAT and local), so the gates add up on this route.
-- OpenRouter MiniMax 3.1 Flash (Together, then DigitalOcean since 2026-10-30; a
-- chat choice since 2026-10-24) serves chat alone. Together held 16 calls at
-- once in the 2026-10-23 probe (total p95 3.0 s) and both held 16 in the
-- 2026-10-30 probe (slowest 1.7 s and 2.7 s), so the gate is 16.
-- DeepSeek Flash (chat's default) runs on DeepSeek's own API (2500 concurrent
-- requests per account, https://api-docs.deepseek.com/quick_start/rate_limit/)
-- at Epo's 40 in flight: chat and Generate take all 40 and ingest never runs
-- on it (Epo 2026-10-29).
-- The reranker is Alibaba qwen3-rerank (Singapore): 64 in flight answered
-- without an error in bench/rag/providers' ramp (2026-10-30).

WITH capacities(provider, model, concurrency_total) AS (
  VALUES
    ('deepseek', 'deepseek-flash', 40),
    ('zai', 'glm-5.3-flash', 150),
    ('openrouter', 'deepseek/deepseek-v4-flash-0731', 32),
    ('openrouter', 'deepseek/deepseek-v4.1-flash-1017', 100),
    ('openrouter', 'minimax/minimax-m3.1-flash', 16),
    ('deepinfra', 'Qwen/Qwen3-Embedding-4B', 200),
    ('alibaba', 'qwen3-rerank', 64)
)
INSERT INTO model_capacities (provider, model, concurrency_total)
SELECT provider, model, concurrency_total FROM capacities c
WHERE EXISTS (
  SELECT 1 FROM model_configs m WHERE m.enabled
    AND m.model_slug = c.model
    AND m.provider_slug = c.provider
)
ON CONFLICT (provider, model) DO NOTHING;

SELECT provider, model, concurrency_total
FROM model_capacities ORDER BY provider, model;
