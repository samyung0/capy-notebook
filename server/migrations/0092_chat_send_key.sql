-- The chat's Send key setting: whether Enter or Shift+Enter sends a message;
-- the other key adds a new line.
ALTER TABLE users ADD COLUMN IF NOT EXISTS chat_send_key text NOT NULL DEFAULT 'enter'
  CHECK (chat_send_key IN ('enter','shift_enter'));
