-- A person's own key is a Secrets Store secret (scope ai_gateway) that their provider config names; secret_id is that
-- secret, so a replace or a removal deletes it with the config.
ALTER TABLE model_providers ADD COLUMN secret_id TEXT;
