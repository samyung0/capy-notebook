-- Account chat (Epo 2026-10-27, todo-account-chat.md): a conversation with no
-- workspace is its user's chat across their own files, owned by user_id alone.
-- A conversation keeps its scope for life. rag_search_events.workspace_id is
-- nullable already, so an account search records none.
ALTER TABLE conversations ALTER COLUMN workspace_id DROP NOT NULL;
CREATE INDEX conversations_account_idx ON conversations (user_id, updated_at DESC)
  WHERE workspace_id IS NULL;

-- Account chat's create_workspace records a receipt (Epo 2026-10-28).
ALTER TABLE agent_operations DROP CONSTRAINT agent_operations_kind_check,
  ADD CONSTRAINT agent_operations_kind_check CHECK (kind IN (
    'create_material','edit_document','undo_edit','trash','restore','purge','create_workspace'));

-- Account chat's summary search (Epo 2026-10-28, option B of
-- bench/rag/reports/2026-10-28-summary-search-scale.md): each summary's
-- search vector, written with it by the pipeline's tokenizer under its
-- language's configuration, as rag_chunks.search is. A search narrows to the
-- caller's items first, so there is no index on it. A summary written before
-- has none and is found by its file's name until it is written again.
ALTER TABLE rag_content_summaries ADD COLUMN lang text NOT NULL DEFAULT 'und',
  ADD COLUMN search tsvector;
