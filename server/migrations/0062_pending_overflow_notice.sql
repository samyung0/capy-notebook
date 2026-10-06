-- The indexed checkpoint at which the owner was last told this file's pending
-- edits no longer fit the AI context. Processing advances indexed_checkpoint,
-- so the next overflow notifies again.
ALTER TABLE source_documents ADD COLUMN overflow_notified_checkpoint bigint;
