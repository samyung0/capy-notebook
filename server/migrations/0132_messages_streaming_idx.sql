-- A conversation's running mark in the chat list (Epo 2026-10-27, T19) asks
-- whether any of its rows is still streaming; few rows ever are.
CREATE INDEX IF NOT EXISTS messages_streaming_idx ON messages (conversation_id) WHERE status = 'streaming';
