-- No production data depends on Pro. Remove its configuration directly;
-- historical migration files stay unchanged so their checksums remain valid.
DELETE FROM model_configs
WHERE provider_slug = 'deepseek' AND model_slug = 'deepseek-v4-pro';
DELETE FROM model_capacities
WHERE provider = 'deepseek' AND model = 'deepseek-v4-pro';
DELETE FROM user_model_reasoning
WHERE provider_slug = 'deepseek' AND model_slug = 'deepseek-v4-pro';
UPDATE model_registry_state SET version = version + 1, updated_at = now();
