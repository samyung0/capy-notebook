-- Make a quiz gets a model slot of its own, `extraction` (Epo 2026-11-03). It
-- read page images on the chat slot's direct DeepSeek pin, which costs too
-- much; it now runs on OpenRouter's DeepSeek V4.1 Flash 1017, held on Wafer's
-- US endpoint, then InferenceNet, then Cloudflare with fallbacks off in
-- elitellm (Epo 2026-11-04), the pin that
-- already reads pages and captions images and writes ghost text, so one image
-- model serves both (bench/extraction/reports/2026-11-03-keys-in-one-prompt.md:
-- same labels, questions and keys as direct Flash at about half the credits).
-- The slot is a text slot (a context window and thinking levels) that needs
-- vision; its page windows run at mid.

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
  has_llm := slots && ARRAY['chat','generate','editor','quiz','ingest','extraction']::text[];
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
  slots <@ ARRAY['chat','editor','ingest','extraction','retrieval','captioning','rerank']::text[]
  AND slots <> '{}'
);
ALTER TABLE model_configs DROP CONSTRAINT model_configs_default_for_check;
ALTER TABLE model_configs ADD CONSTRAINT model_configs_default_for_check CHECK (
  is_default_for <@ ARRAY['chat','editor','ingest','extraction','retrieval','captioning','rerank']::text[]
);
ALTER TABLE model_configs DROP CONSTRAINT model_configs_llm_window_check;
ALTER TABLE model_configs ADD CONSTRAINT model_configs_llm_window_check CHECK (
  NOT (slots && ARRAY['chat','generate','editor','quiz','ingest','extraction']::text[])
  OR context_window_tokens > 0
);

-- The pin. Where operators keep a 1017 row (UAT), a new version of its newest
-- enabled row also serves and defaults extraction, with low and mid among its
-- levels, as an ops save that changes a row's slots publishes one, and the old
-- version is disabled; its other slots and defaults move with it. A database
-- built from migrations has no 1017 row, so one is added for extraction alone
-- at InferenceNet's list price on 2026-11-03 ($0.08 / $0.008 / $0.55 per
-- million input / cached / output tokens, 2,000 micros per dollar per
-- million). Which provider's price the 1017 row should carry now that Wafer
-- serves first is Epo's to decide.
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
      updated_at = now(), updated_by = 'migration:0138'
    WHERE provider_slug = current_config.provider_slug
      AND model_slug = current_config.model_slug AND version = current_config.version;
    SELECT max(version) + 1 INTO current_config.version FROM model_configs
    WHERE provider_slug = current_config.provider_slug AND model_slug = current_config.model_slug;
    current_config.slots := array_append(current_config.slots, 'extraction');
    current_config.is_default_for := array_append(current_config.is_default_for, 'extraction');
    current_config.thinking_levels := ARRAY(
      SELECT level FROM unnest(ARRAY['instant','low','mid','high','max']) AS level
      WHERE level = ANY(current_config.thinking_levels) OR level IN ('low', 'mid')
    );
    -- A row that served only captioning carried no levels or window.
    IF current_config.default_thinking = '' THEN
      current_config.default_thinking := 'mid';
    END IF;
    IF current_config.context_window_tokens = 0 THEN
      current_config.context_window_tokens := 1000000;
    END IF;
    current_config.created_at := now();
    current_config.updated_at := now();
    current_config.created_by := 'migration:0138';
    current_config.updated_by := 'migration:0138';
    INSERT INTO model_configs SELECT current_config.*;
  ELSE
    INSERT INTO model_configs (
      version, provider_name, model_name, provider_slug, model_slug,
      platform_enabled, byok_enabled, context_window_tokens,
      thinking_levels, default_thinking, params, slots, capabilities,
      micros_per_input_token, micros_per_output_token, micros_per_cached_input_token,
      enabled, is_default_for, created_by, updated_by
    ) VALUES (
      (SELECT COALESCE(max(version), 0) + 1 FROM model_configs
        WHERE provider_slug = 'openrouter' AND model_slug = 'deepseek/deepseek-v4.1-flash-1017'),
      'DeepSeek', 'DeepSeek V4.1 Flash 1017', 'openrouter', 'deepseek/deepseek-v4.1-flash-1017',
      true, false, 1000000,
      ARRAY['low','mid'], 'mid', '{}'::jsonb, ARRAY['extraction'], ARRAY['vision'],
      160, 1100, 16,
      true, ARRAY['extraction'], 'migration:0138', 'migration:0138'
    );
  END IF;
  UPDATE model_registry_state SET version = version + 1, updated_at = now();
END $$;
