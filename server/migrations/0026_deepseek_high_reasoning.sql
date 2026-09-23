-- Publish the reasoning default as a new immutable model configuration.
DO $$
DECLARE
  current_config model_configs%ROWTYPE;
BEGIN
  PERFORM version FROM model_registry_state WHERE id = true FOR UPDATE;
  SELECT * INTO STRICT current_config FROM model_configs
  WHERE provider_slug = 'deepseek' AND model_slug = 'deepseek-flash' AND enabled
  ORDER BY version DESC LIMIT 1;
  IF current_config.default_thinking = 'high' THEN
    RETURN;
  END IF;

  UPDATE model_configs SET enabled = false, is_default_for = '{}',
    updated_at = now(), updated_by = 'migration:0026'
  WHERE provider_slug = 'deepseek' AND model_slug = 'deepseek-flash' AND enabled;

  SELECT max(version) + 1 INTO current_config.version FROM model_configs
  WHERE provider_slug = 'deepseek' AND model_slug = 'deepseek-flash';
  current_config.default_thinking := 'high';
  current_config.created_at := now();
  current_config.updated_at := now();
  current_config.created_by := 'migration:0026';
  current_config.updated_by := 'migration:0026';
  INSERT INTO model_configs SELECT current_config.*;
  UPDATE model_registry_state SET version = version + 1, updated_at = now();
END $$;
