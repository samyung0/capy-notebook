-- Study's Continue (Epo 2026-11-13) offers what the user left partway; Remove
-- from Continue stops offering it on every device. It stays in History, which
-- still continues it.
ALTER TABLE review_sessions ADD COLUMN continue_hidden_at timestamptz;
ALTER TABLE attempts ADD COLUMN continue_hidden_at timestamptz;
