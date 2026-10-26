-- BYOK is removed (Epo 2026-10-24, Q290): every model session is
-- platform-paid. Stored provider keys go, `enabled` becomes a catalog row's
-- only switch, and a provider session is paid by the platform or, for a
-- maintenance republish, the system.
DROP TABLE user_llm_credentials;

-- A row only a user's key could serve has no path left.
DELETE FROM model_configs WHERE NOT platform_enabled;

ALTER TABLE model_configs
  DROP CONSTRAINT model_configs_enabled_path_check,
  DROP CONSTRAINT model_configs_byok_only_no_default,
  DROP CONSTRAINT model_configs_credit_rates_check,
  DROP CONSTRAINT model_configs_deepinfra_check,
  DROP COLUMN platform_enabled,
  DROP COLUMN byok_enabled;

-- Every row carries credit rates. Retrieval needs input > 0 (output may be
-- 0); every other slot needs all three above zero.
ALTER TABLE model_configs ADD CONSTRAINT model_configs_credit_rates_check CHECK (
  (
    'retrieval' = ANY(slots)
    AND micros_per_input_token > 0
    AND micros_per_cached_input_token >= 0
    AND micros_per_output_token >= 0
  )
  OR (
    NOT ('retrieval' = ANY(slots))
    AND micros_per_input_token > 0
    AND micros_per_cached_input_token > 0
    AND micros_per_output_token > 0
  )
);

-- DeepInfra rows are only the seeded qwen-embed hop in the retrieval slot and
-- the Qwen3 reranker in the rerank slot. No other router rows.
ALTER TABLE model_configs ADD CONSTRAINT model_configs_deepinfra_check CHECK (
  provider_slug <> 'deepinfra'
  OR (model_slug = 'Qwen/Qwen3-Embedding-4B' AND slots = ARRAY['retrieval']::text[])
  OR (model_slug = 'Qwen/Qwen3-Reranker-4B' AND slots = ARRAY['rerank']::text[])
);

DELETE FROM provider_sessions WHERE paid_by = 'user';
ALTER TABLE provider_sessions DROP CONSTRAINT provider_sessions_paid_by_check;
ALTER TABLE provider_sessions ADD CONSTRAINT provider_sessions_paid_by_check
  CHECK (paid_by IN ('platform', 'system'));

UPDATE model_registry_state SET version = version + 1, updated_at = now();
