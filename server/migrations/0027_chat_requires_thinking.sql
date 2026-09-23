-- Selectable levels belong to the catalog. The editor keeps its fixed off policy.
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
  has_llm := slots && ARRAY['chat','generate','editor','quiz','ingest']::text[];
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

DO $$
DECLARE
  current_config model_configs%ROWTYPE;
BEGIN
  PERFORM version FROM model_registry_state WHERE id = true FOR UPDATE;
  FOR current_config IN SELECT * FROM model_configs
    WHERE enabled AND 'chat' = ANY(slots) AND 'instant' = ANY(thinking_levels)
  LOOP
    UPDATE model_configs SET enabled = false, is_default_for = '{}',
      updated_at = now(), updated_by = 'migration:0027'
    WHERE provider_slug = current_config.provider_slug
      AND model_slug = current_config.model_slug AND version = current_config.version;
    SELECT max(version) + 1 INTO current_config.version FROM model_configs
    WHERE provider_slug = current_config.provider_slug AND model_slug = current_config.model_slug;
    current_config.thinking_levels := array_remove(current_config.thinking_levels, 'instant');
    IF current_config.default_thinking = 'instant' THEN
      current_config.default_thinking := 'high';
    END IF;
    current_config.created_at := now();
    current_config.updated_at := now();
    current_config.created_by := 'migration:0027';
    current_config.updated_by := 'migration:0027';
    INSERT INTO model_configs SELECT current_config.*;
  END LOOP;
  UPDATE model_registry_state SET version = version + 1, updated_at = now();
END $$;

ALTER TABLE model_configs ADD CONSTRAINT model_configs_chat_thinking_check
  CHECK (NOT enabled OR NOT ('chat' = ANY(slots)) OR NOT ('instant' = ANY(thinking_levels)));
ALTER TABLE user_model_reasoning ADD CONSTRAINT user_model_reasoning_chat_thinking_check
  CHECK (slot <> 'chat' OR thinking <> 'instant');
