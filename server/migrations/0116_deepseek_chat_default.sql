-- New accounts start on deepseek/deepseek-flash at its default high thinking
-- (decision 2026-10-25), and the catalog's chat slot default moves with it, as
-- 0009 moved it to GLM: clear `chat` from every other row first, because the
-- one-default-per-slot trigger refuses a second holder, then mark the newest
-- enabled DeepSeek row and bump the registry version so every replica
-- reloads. Existing rows keep the pin they have. The block refuses to run when
-- that row cannot take the chat slot at high thinking, so the slot is never
-- left without a default.
ALTER TABLE users
  ALTER COLUMN chat_model_provider_slug SET DEFAULT 'deepseek',
  ALTER COLUMN chat_model_slug SET DEFAULT 'deepseek-flash';

DO $$
DECLARE
  target model_configs%ROWTYPE;
BEGIN
  PERFORM version FROM model_registry_state WHERE id = true FOR UPDATE;
  SELECT * INTO target FROM model_configs
  WHERE provider_slug = 'deepseek' AND model_slug = 'deepseek-flash' AND enabled
  ORDER BY version DESC LIMIT 1;
  IF NOT FOUND OR NOT ('chat' = ANY(target.slots)) OR target.default_thinking <> 'high' THEN
    RAISE EXCEPTION 'deepseek/deepseek-flash has no enabled chat row at high thinking; fix the catalog before moving the chat slot default';
  END IF;
  UPDATE model_configs SET is_default_for = array_remove(is_default_for, 'chat'),
    updated_at = now(), updated_by = 'migration:0116'
  WHERE 'chat' = ANY(is_default_for)
    AND NOT (provider_slug = 'deepseek' AND model_slug = 'deepseek-flash' AND version = target.version);
  UPDATE model_configs SET is_default_for = array_append(is_default_for, 'chat'),
    updated_at = now(), updated_by = 'migration:0116'
  WHERE provider_slug = 'deepseek' AND model_slug = 'deepseek-flash' AND version = target.version
    AND NOT ('chat' = ANY(is_default_for));
  UPDATE model_registry_state SET version = version + 1, updated_at = now();
END $$;
