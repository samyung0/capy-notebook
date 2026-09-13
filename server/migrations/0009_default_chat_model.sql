-- New accounts start on zai/glm-5.3-flash (served from Tencent TokenHub): it is
-- the catalog model that reads scanned tables correctly through capture_page.
-- Existing rows keep the pin they have. The catalog's chat slot default moves
-- with it (a pin reset lands on the same model): clear `chat` from every other
-- row first, because the one-default-per-slot trigger refuses a second holder,
-- then mark the newest enabled GLM row and bump the registry version so every
-- replica reloads. One file is one transaction, and the block refuses to run
-- when no enabled GLM row exists, so the slot is never left without a default.
ALTER TABLE users
  ALTER COLUMN chat_model_provider_slug SET DEFAULT 'zai',
  ALTER COLUMN chat_model_slug SET DEFAULT 'glm-5.3-flash';

DO $$
DECLARE
  marked integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM model_configs
    WHERE provider_slug = 'zai' AND model_slug = 'glm-5.3-flash' AND enabled
  ) THEN
    RAISE EXCEPTION 'zai/glm-5.3-flash has no enabled catalog row; enable it before moving the chat slot default';
  END IF;
  UPDATE model_configs SET is_default_for = array_remove(is_default_for, 'chat')
  WHERE 'chat' = ANY(is_default_for)
    AND NOT (provider_slug = 'zai' AND model_slug = 'glm-5.3-flash');
  UPDATE model_configs SET is_default_for = array_append(is_default_for, 'chat')
  WHERE provider_slug = 'zai' AND model_slug = 'glm-5.3-flash' AND enabled
    AND NOT ('chat' = ANY(is_default_for))
    AND version = (SELECT max(version) FROM model_configs
                   WHERE provider_slug = 'zai' AND model_slug = 'glm-5.3-flash' AND enabled);
  GET DIAGNOSTICS marked = ROW_COUNT;
  IF marked <> 1 AND NOT EXISTS (
    SELECT 1 FROM model_configs
    WHERE provider_slug = 'zai' AND model_slug = 'glm-5.3-flash' AND 'chat' = ANY(is_default_for)
  ) THEN
    RAISE EXCEPTION 'chat slot default could not be moved to zai/glm-5.3-flash';
  END IF;
  UPDATE model_registry_state SET version = version + 1, updated_at = now();
END $$;
