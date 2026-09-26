-- A file summary is the short descriptor only. change_share is the net text
-- change since the descriptor was last regenerated, as a share of the
-- document; a refresh reuses the descriptor while it stays under 2%.
ALTER TABLE rag_content_summaries DROP COLUMN summary;
ALTER TABLE rag_content_summaries ADD COLUMN change_share double precision NOT NULL DEFAULT 0 CHECK (change_share >= 0);

-- paid_by 'system' is the maintenance republish: platform keys at zero credits,
-- no credit check and no lease on its actor's ingest slots.
ALTER TABLE provider_sessions DROP CONSTRAINT provider_sessions_paid_by_check;
ALTER TABLE provider_sessions ADD CONSTRAINT provider_sessions_paid_by_check
  CHECK (paid_by IN ('platform', 'user', 'system'));
