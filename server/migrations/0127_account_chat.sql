-- Account chat (Epo 2026-10-27, todo-account-chat.md): a conversation with no
-- workspace is its user's chat across their own files, owned by user_id alone.
-- A conversation keeps its scope for life. rag_search_events.workspace_id is
-- nullable already, so an account search records none.
ALTER TABLE conversations ALTER COLUMN workspace_id DROP NOT NULL;
CREATE INDEX conversations_account_idx ON conversations (user_id, updated_at DESC)
  WHERE workspace_id IS NULL;
