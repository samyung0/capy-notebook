-- Quiz grading now resolves the operator's slot default per request.
ALTER TABLE users
  DROP CONSTRAINT users_model_refs_nonempty,
  DROP COLUMN quiz_model_provider_slug,
  DROP COLUMN quiz_model_slug,
  ADD CONSTRAINT users_model_refs_nonempty CHECK (
    chat_model_provider_slug <> '' AND chat_model_slug <> ''
    AND generate_model_provider_slug <> '' AND generate_model_slug <> ''
    AND editor_model_provider_slug <> '' AND editor_model_slug <> ''
  );
DELETE FROM user_model_reasoning WHERE slot = 'quiz';
