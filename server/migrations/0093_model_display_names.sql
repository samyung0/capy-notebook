-- The chat and pickers show the model name alone, so catalog model names carry
-- their brand instead of relying on the provider name as a prefix.
UPDATE model_configs SET model_name = 'DeepSeek Flash', updated_at = now(), updated_by = 'migration:0093'
 WHERE provider_slug = 'deepseek' AND model_slug = 'deepseek-flash';
UPDATE model_configs SET model_name = 'GLM 5.3 Flash', updated_at = now(), updated_by = 'migration:0093'
 WHERE provider_slug = 'zai' AND model_slug = 'glm-5.3-flash';
UPDATE model_configs SET model_name = 'Qwen3 Embedding 4B', updated_at = now(), updated_by = 'migration:0093'
 WHERE provider_slug = 'deepinfra' AND model_slug = 'Qwen/Qwen3-Embedding-4B';
UPDATE model_configs SET model_name = 'Qwen3 Reranker 4B', updated_at = now(), updated_by = 'migration:0093'
 WHERE provider_slug = 'deepinfra' AND model_slug = 'Qwen/Qwen3-Reranker-4B';
UPDATE model_registry_state SET version = version + 1, updated_at = now();
