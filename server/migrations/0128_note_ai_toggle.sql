-- Editor AI is ghost text only, on the editor slot's default pin (Epo
-- 2026-10-28): the per-user editor model goes, and each user turns note AI on
-- in Settings → LLM, off by default.
ALTER TABLE users
  DROP CONSTRAINT users_model_refs_nonempty,
  DROP COLUMN editor_model_provider_slug,
  DROP COLUMN editor_model_slug,
  ADD COLUMN note_ai_enabled boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT users_model_refs_nonempty CHECK (
    chat_model_provider_slug <> '' AND chat_model_slug <> ''
  );
