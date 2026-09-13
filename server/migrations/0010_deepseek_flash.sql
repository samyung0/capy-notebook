-- DeepSeek V4.1 Flash uses the canonical deepseek-flash identifier for text
-- and vision. Keep historical rows and credit rates; supplier USD prices do
-- not set the product's credit multipliers. Move only Flash Vision pins and
-- defaults, preserving the GLM chat default and other model selections.
DO $$
DECLARE
  previous model_configs%ROWTYPE;
BEGIN
  PERFORM version FROM model_registry_state WHERE id = true FOR UPDATE;
  IF EXISTS (SELECT 1 FROM model_configs
             WHERE provider_slug = 'deepseek' AND model_slug = 'deepseek-flash') THEN
    IF EXISTS (SELECT 1 FROM model_configs
               WHERE provider_slug = 'deepseek'
                 AND model_slug = 'deepseek-v4-flash-vision-exp' AND enabled) THEN
      RAISE EXCEPTION 'deepseek-flash already exists alongside active Flash Vision; reconcile the catalog before migrating';
    END IF;
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM model_configs
                 WHERE provider_slug = 'deepseek' AND model_slug = 'deepseek-v4-flash-vision-exp') THEN
    RAISE EXCEPTION 'Flash Vision source catalog is missing; configure deepseek-flash before migrating';
  END IF;

  FOR previous IN SELECT * FROM model_configs
    WHERE provider_slug = 'deepseek' AND model_slug = 'deepseek-v4-flash-vision-exp'
    ORDER BY version
  LOOP
    UPDATE model_configs SET enabled = false, is_default_for = '{}',
      updated_at = now(), updated_by = 'migration:0010'
    WHERE provider_slug = previous.provider_slug AND model_slug = previous.model_slug
      AND version = previous.version;
    previous.model_slug := 'deepseek-flash';
    previous.model_name := 'Flash 4.1';
    previous.created_at := now();
    previous.updated_at := now();
    previous.created_by := 'migration:0010';
    previous.updated_by := 'migration:0010';
    INSERT INTO model_configs SELECT previous.*;
  END LOOP;

  -- Carry this environment's existing limit forward, if configured. Missing
  -- limits remain explicit; deploy/model-capacities.sql populates them.
  INSERT INTO model_capacities (provider, model, concurrency_total, interactive_reserve)
  SELECT provider, 'deepseek-flash', concurrency_total, interactive_reserve
  FROM model_capacities
  WHERE provider = 'deepseek' AND model = 'deepseek-v4-flash-vision-exp'
  ON CONFLICT (provider, model) DO NOTHING;

  UPDATE users SET chat_model_slug = 'deepseek-flash', updated_at = now()
  WHERE chat_model_provider_slug = 'deepseek' AND chat_model_slug = 'deepseek-v4-flash-vision-exp';
  UPDATE users SET generate_model_slug = 'deepseek-flash', updated_at = now()
  WHERE generate_model_provider_slug = 'deepseek' AND generate_model_slug = 'deepseek-v4-flash-vision-exp';
  UPDATE users SET editor_model_slug = 'deepseek-flash', updated_at = now()
  WHERE editor_model_provider_slug = 'deepseek' AND editor_model_slug = 'deepseek-v4-flash-vision-exp';
  UPDATE users SET quiz_model_slug = 'deepseek-flash', updated_at = now()
  WHERE quiz_model_provider_slug = 'deepseek' AND quiz_model_slug = 'deepseek-v4-flash-vision-exp';

  UPDATE model_registry_state SET version = version + 1, updated_at = now();
END $$;

ALTER TABLE users
  ALTER COLUMN generate_model_slug SET DEFAULT 'deepseek-flash',
  ALTER COLUMN editor_model_slug SET DEFAULT 'deepseek-flash',
  ALTER COLUMN quiz_model_slug SET DEFAULT 'deepseek-flash';
