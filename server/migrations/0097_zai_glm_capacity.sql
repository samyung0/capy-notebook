-- GLM-5.3-Flash moved from Relace to Z.AI itself (decision 2026-10-20) and
-- capacity rows key on the catalog pair, so this environment's GLM limit moves
-- from relace/glm-5.3-flash to zai/glm-5.3-flash. Z.AI holds about 50 calls in
-- flight per key (past that, connections hang and fail), so the copy is capped
-- at 48 in flight with 40 kept for interactive calls (decision 2026-10-20).
-- Missing limits stay explicit; deploy/model-capacities.sql populates them.
-- The tencent row is history and stays.
WITH zai_cap(concurrency_total, interactive_reserve) AS (VALUES (48, 40))
INSERT INTO model_capacities (provider, model, concurrency_total, interactive_reserve)
SELECT 'zai', 'glm-5.3-flash',
  LEAST(relace.concurrency_total, zai_cap.concurrency_total),
  LEAST(relace.interactive_reserve, zai_cap.interactive_reserve)
FROM model_capacities relace, zai_cap
WHERE relace.provider = 'relace' AND relace.model = 'glm-5.3-flash'
ON CONFLICT (provider, model) DO NOTHING;

DELETE FROM model_capacities WHERE provider = 'relace' AND model = 'glm-5.3-flash';
