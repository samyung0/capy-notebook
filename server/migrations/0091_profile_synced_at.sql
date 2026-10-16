-- The API reads a signed-in user's Clerk profile on the account's first request
-- and then at most once an hour (Epo 2026-10-17). profile_synced_at is when a
-- request last claimed that read; a new row (request-time provisioning or the
-- user.created webhook, both from Clerk's profile) counts as just read.
ALTER TABLE users ADD COLUMN profile_synced_at timestamptz NOT NULL DEFAULT now();
