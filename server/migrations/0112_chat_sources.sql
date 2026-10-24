-- A search_web call that returns results is charged per search (decision
-- 2026-10-24). DeepSeek's web search costs $0.75 per 1,000 searches with
-- results; the learner pays 1.8 credits for each. An empty or failed search
-- is free.
INSERT INTO resource_credit_rates
  (resource_key, version, unit, credit_micros_per_unit, active)
VALUES
  ('web_search', 1, 'search', 1800000, true)
ON CONFLICT (resource_key, version) DO NOTHING;

-- MiniMax 3.1 Flash joins the chat choices (decision 2026-10-24, Q224),
-- certified for the agentic loop (agentic_loop_certs.json). It goes through
-- OpenRouter, pinned to Together with fallbacks off in elitellm, at
-- temperature 0.2, and reads images there (2026-10-24 probe), as the chat
-- slot requires. Its credit rates follow Together's list price ($0.15 input,
-- $0.015 cached input, $0.60 output per million tokens) at 2,000 micros per
-- dollar per million: 300 / 30 / 1200 micros per token. Its capacity row is
-- environment data (deploy/model-capacities.sql).
INSERT INTO model_configs (
  version, provider_name, model_name, provider_slug, model_slug,
  platform_enabled, byok_enabled, context_window_tokens,
  thinking_levels, default_thinking, params, slots, capabilities,
  micros_per_input_token, micros_per_output_token, micros_per_cached_input_token,
  enabled, is_default_for, created_by, updated_by
) VALUES (
  1, 'MiniMax', 'MiniMax 3.1 Flash', 'openrouter', 'minimax/minimax-m3.1-flash',
  true, false, 1000000,
  ARRAY['low','mid','high'], 'high', '{"temperature": 0.2}'::jsonb,
  ARRAY['chat'], ARRAY['vision'],
  300, 1200, 30,
  true, ARRAY[]::text[], 'migration:0112', 'migration:0112'
) ON CONFLICT (provider_slug, model_slug, version) DO NOTHING;

UPDATE model_registry_state SET version = version + 1, updated_at = now();
