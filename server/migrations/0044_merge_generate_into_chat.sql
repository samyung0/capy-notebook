-- Generate workflows run on the user's chat model and chat thinking, so the
-- generate slot, its per-user model columns and its thinking rows go away.
ALTER TABLE users
  DROP CONSTRAINT users_model_refs_nonempty,
  DROP COLUMN generate_model_provider_slug,
  DROP COLUMN generate_model_slug,
  ADD CONSTRAINT users_model_refs_nonempty CHECK (
    chat_model_provider_slug <> '' AND chat_model_slug <> ''
    AND editor_model_provider_slug <> '' AND editor_model_slug <> ''
  );

DELETE FROM user_model_reasoning WHERE slot <> 'chat';
ALTER TABLE user_model_reasoning DROP CONSTRAINT user_model_reasoning_slot_check;
ALTER TABLE user_model_reasoning ADD CONSTRAINT user_model_reasoning_slot_check
  CHECK (slot = 'chat');

DO $$
DECLARE
  orphan text;
BEGIN
  PERFORM version FROM model_registry_state WHERE id = true FOR UPDATE;
  -- A row serving only generate has no slot left; an operator must reassign it.
  SELECT provider_slug || '/' || model_slug || ' v' || version INTO orphan
  FROM model_configs WHERE slots = ARRAY['generate']::text[] LIMIT 1;
  IF orphan IS NOT NULL THEN
    RAISE EXCEPTION 'model_configs row % serves only the generate slot', orphan;
  END IF;
  UPDATE model_configs SET
    slots = array_remove(slots, 'generate'),
    is_default_for = array_remove(is_default_for, 'generate'),
    updated_at = now(), updated_by = 'migration:0044'
  WHERE 'generate' = ANY(slots) OR 'generate' = ANY(is_default_for);
  UPDATE model_registry_state SET version = version + 1, updated_at = now();
END $$;

ALTER TABLE model_configs DROP CONSTRAINT model_configs_slots_check;
ALTER TABLE model_configs ADD CONSTRAINT model_configs_slots_check CHECK (
  slots <@ ARRAY['chat','editor','quiz','ingest','retrieval','captioning','rerank']::text[]
  AND slots <> '{}'
);
ALTER TABLE model_configs DROP CONSTRAINT model_configs_default_for_check;
ALTER TABLE model_configs ADD CONSTRAINT model_configs_default_for_check CHECK (
  is_default_for <@ ARRAY['chat','editor','quiz','ingest','retrieval','captioning','rerank']::text[]
);
