-- Open quiz parts are graded by Jev, which the API calls directly
-- (anonymous-study-plan.md, 2026-10-02), so the quiz model slot goes away.
DO $$
DECLARE
  orphan text;
BEGIN
  PERFORM version FROM model_registry_state WHERE id = true FOR UPDATE;
  -- A row serving only quiz has no slot left; an operator must reassign it.
  SELECT provider_slug || '/' || model_slug || ' v' || version INTO orphan
  FROM model_configs WHERE slots = ARRAY['quiz']::text[] LIMIT 1;
  IF orphan IS NOT NULL THEN
    RAISE EXCEPTION 'model_configs row % serves only the quiz slot', orphan;
  END IF;
  UPDATE model_configs SET
    slots = array_remove(slots, 'quiz'),
    is_default_for = array_remove(is_default_for, 'quiz'),
    updated_at = now(), updated_by = 'migration:0050'
  WHERE 'quiz' = ANY(slots) OR 'quiz' = ANY(is_default_for);
  UPDATE model_registry_state SET version = version + 1, updated_at = now();
END $$;

ALTER TABLE model_configs DROP CONSTRAINT model_configs_slots_check;
ALTER TABLE model_configs ADD CONSTRAINT model_configs_slots_check CHECK (
  slots <@ ARRAY['chat','editor','ingest','retrieval','captioning','rerank']::text[]
  AND slots <> '{}'
);
ALTER TABLE model_configs DROP CONSTRAINT model_configs_default_for_check;
ALTER TABLE model_configs ADD CONSTRAINT model_configs_default_for_check CHECK (
  is_default_for <@ ARRAY['chat','editor','ingest','retrieval','captioning','rerank']::text[]
);
