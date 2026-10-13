-- Merge-signing keys are derived in the Worker from the MERGE_SIGNING_KEY Secrets Store secret (src/signing.js); D1 holds none.
DROP TABLE IF EXISTS signing_keys;
