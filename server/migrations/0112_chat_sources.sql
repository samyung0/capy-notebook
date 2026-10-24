-- A search_web call that returns results is charged per search (decision
-- 2026-10-24). DeepSeek's web search costs $0.75 per 1,000 searches with
-- results; the learner pays 1.8 credits for each. An empty or failed search
-- is free.
INSERT INTO resource_credit_rates
  (resource_key, version, unit, credit_micros_per_unit, active)
VALUES
  ('web_search', 1, 'search', 1800000, true)
ON CONFLICT (resource_key, version) DO NOTHING;
