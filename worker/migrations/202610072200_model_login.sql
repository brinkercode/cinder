-- A subscription login is a Workers-scoped Secrets Store secret read through cinder-secrets (keystore.js addToStore),
-- not a gateway provider key: login_id is its keystore-style id, which names its secret and its binding.
ALTER TABLE model_providers ADD COLUMN login_id TEXT;
