-- forks = 1: the secret also reaches untrusted flow runs (a change's fork, a manual run of an unprotected ref, no trigger).
ALTER TABLE keystore_secrets ADD COLUMN forks INTEGER NOT NULL DEFAULT 0;
