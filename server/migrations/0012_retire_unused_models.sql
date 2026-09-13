-- No production data depends on these models. Keep provider support in code.
DELETE FROM model_configs
WHERE (provider_slug, model_slug) IN (
  ('deepseek', 'deepseek-v4-flash-vision-exp'),
  ('openai', 'gpt-5.6-sol'),
  ('openai', 'gpt-5.6-terra'),
  ('openai', 'gpt-5.6-luna')
);
DELETE FROM model_capacities
WHERE (provider, model) IN (
  ('deepseek', 'deepseek-v4-flash-vision-exp'),
  ('openai', 'gpt-5.6-sol'),
  ('openai', 'gpt-5.6-terra'),
  ('openai', 'gpt-5.6-luna')
);
DELETE FROM user_model_reasoning
WHERE (provider_slug, model_slug) IN (
  ('deepseek', 'deepseek-v4-flash-vision-exp'),
  ('openai', 'gpt-5.6-sol'),
  ('openai', 'gpt-5.6-terra'),
  ('openai', 'gpt-5.6-luna')
);
UPDATE model_registry_state SET version = version + 1, updated_at = now();
