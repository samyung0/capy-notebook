-- Populate missing capacity rows in ONE explicitly selected environment,
-- after migrations. Run with psql -v ON_ERROR_STOP=1 -f deploy/model-capacities.sql.
-- Existing operator settings win; this is an opt-in bootstrap, not a migration.
-- If environments share a provider account, divide that account's capacity
-- between their databases before applying. Separate keys do not add capacity.
--
-- Official limits checked 2026-09-13:
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
-- 2026-10-21) captions standalone images and, from 2026-10-28, writes note
-- ghost text. From 2026-10-29 the deepseek/deepseek-flash catalog pair (chat's
-- default) runs on the same route under its own row: deepseek-flash 40 with no
-- interactive reserve (chat and Generate take all 40; ingest never runs on
-- it) and 1017 40/20 (ghost text up to 40, ingest captions up to 20), 80 in
-- flight together, up from 76 (Epo 2026-10-29); UAT and local
-- 8/0 and 8/4.
-- InferenceNet answered 128 page reads at once (p95 8.6 s) and Cloudflare 64
-- (p95 10.1 s); a 2026-10-28 ghost-text probe from the ingest host (about 400
-- tokens in, 20 out) held 64 in flight at about 5,000 calls a minute with no
-- 429 (first token p50 0.39 s, total p95 1.0 s). Page reads lease the vlm_page
-- gate instead of this row (CAPY_VLM_PAGE_CAPACITY: 40 in production since
-- 2026-10-29, 20 in UAT and local), so the gates add up: production can hold
-- 120 calls in flight on this route, and Cloudflare, the fallback, was measured only at 64, so an
-- InferenceNet outage during a burst may leave calls slow or busy there.
-- OpenRouter MiniMax 3.1 Flash (Together, then Wafer since 2026-10-25; a chat
-- choice since 2026-10-24) serves chat alone, so all but one call is kept for
-- interactive use (the reserve must stay below the total). Together and Wafer
-- each held 16 calls at once in the 2026-10-23 probe (total p95 3.0 s and
-- 3.1 s), so the gate is 16.
-- Interactive reserves: 83% GLM / 0% DeepSeek Flash (chat only) / 50% DeepSeek 1017 / 40% embedding.
-- The reranker is a separate DeepInfra model on the same account, with its own
-- 200-request limit. Only interactive search calls it, so its reserve never
-- binds; it copies the embedding's 80.

WITH capacities(provider, model, concurrency_total, interactive_reserve) AS (
  VALUES
    ('deepseek', 'deepseek-flash', 40, 0),
    ('zai', 'glm-5.3-flash', 150, 125),
    ('openrouter', 'deepseek/deepseek-v4-flash-0731', 32, 0),
    ('openrouter', 'deepseek/deepseek-v4.1-flash-1017', 40, 20),
    ('openrouter', 'minimax/minimax-m3.1-flash', 16, 15),
    ('deepinfra', 'Qwen/Qwen3-Embedding-4B', 200, 80),
    ('deepinfra', 'Qwen/Qwen3-Reranker-4B', 200, 80)
)
INSERT INTO model_capacities (provider, model, concurrency_total, interactive_reserve)
SELECT provider, model, concurrency_total, interactive_reserve FROM capacities c
WHERE EXISTS (
  SELECT 1 FROM model_configs m WHERE m.enabled
    AND m.model_slug = c.model
    AND m.provider_slug = c.provider
)
ON CONFLICT (provider, model) DO NOTHING;

SELECT provider, model, concurrency_total, interactive_reserve,
  concurrency_total - interactive_reserve AS ingest_limit
FROM model_capacities ORDER BY provider, model;
