-- Quiz grading leaves Jev for a model slot of its own, `grading`, on the same
-- OpenRouter pin as extraction and captions (Epo 2026-11-04,
-- bench/grading/reports/2026-11-03-deepseek-grading-round3.md), on the pin's
-- default route: Wafer's US endpoint, then InferenceNet, then Cloudflare. It needs
-- no vision: parts with working think at low, the rest not at all.

CREATE OR REPLACE FUNCTION model_configs_thinking_ok(
  slots text[],
  thinking_levels text[],
  default_thinking text
)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  item text;
  has_llm boolean;
BEGIN
  has_llm := slots && ARRAY['chat','generate','editor','quiz','ingest','extraction','grading']::text[];
  IF NOT has_llm THEN
    RETURN thinking_levels = '{}' AND default_thinking = '';
  END IF;
  IF thinking_levels = '{}' OR default_thinking IS NULL OR default_thinking = '' THEN
    RETURN FALSE;
  END IF;
  IF NOT (default_thinking = ANY(thinking_levels)) THEN
    RETURN FALSE;
  END IF;
  FOREACH item IN ARRAY thinking_levels
  LOOP
    IF item NOT IN ('instant', 'low', 'mid', 'high', 'max') THEN
      RETURN FALSE;
    END IF;
  END LOOP;
  RETURN TRUE;
END;
$$;

ALTER TABLE model_configs DROP CONSTRAINT model_configs_slots_check;
ALTER TABLE model_configs ADD CONSTRAINT model_configs_slots_check CHECK (
  slots <@ ARRAY['chat','editor','ingest','extraction','grading','retrieval','captioning','rerank']::text[]
  AND slots <> '{}'
);
ALTER TABLE model_configs DROP CONSTRAINT model_configs_default_for_check;
ALTER TABLE model_configs ADD CONSTRAINT model_configs_default_for_check CHECK (
  is_default_for <@ ARRAY['chat','editor','ingest','extraction','grading','retrieval','captioning','rerank']::text[]
);
ALTER TABLE model_configs DROP CONSTRAINT model_configs_llm_window_check;
ALTER TABLE model_configs ADD CONSTRAINT model_configs_llm_window_check CHECK (
  NOT (slots && ARRAY['chat','generate','editor','quiz','ingest','extraction','grading']::text[])
  OR context_window_tokens > 0
);

-- The pin. Where operators keep a 1017 row, a new version of its newest enabled
-- row also serves and defaults grading, as an ops save that changes a row's
-- slots publishes one, and the old version is disabled. Migration 0141 left one
-- in a database built from migrations, so one is always there unless an operator
-- disabled it; then this adds none, and grading stays off until one is assigned.
DO $$
DECLARE
  current_config model_configs%ROWTYPE;
BEGIN
  PERFORM version FROM model_registry_state WHERE id = true FOR UPDATE;
  SELECT * INTO current_config FROM model_configs
  WHERE provider_slug = 'openrouter' AND model_slug = 'deepseek/deepseek-v4.1-flash-1017'
    AND enabled
  ORDER BY version DESC LIMIT 1;
  IF FOUND THEN
    UPDATE model_configs SET enabled = false, is_default_for = '{}',
      updated_at = now(), updated_by = 'migration:0152'
    WHERE provider_slug = current_config.provider_slug
      AND model_slug = current_config.model_slug AND version = current_config.version;
    SELECT max(version) + 1 INTO current_config.version FROM model_configs
    WHERE provider_slug = current_config.provider_slug AND model_slug = current_config.model_slug;
    current_config.slots := array_append(current_config.slots, 'grading');
    current_config.is_default_for := array_append(current_config.is_default_for, 'grading');
    current_config.created_at := now();
    current_config.updated_at := now();
    current_config.created_by := 'migration:0152';
    current_config.updated_by := 'migration:0152';
    INSERT INTO model_configs SELECT current_config.*;
  END IF;
  UPDATE model_registry_state SET version = version + 1, updated_at = now();
END $$;
