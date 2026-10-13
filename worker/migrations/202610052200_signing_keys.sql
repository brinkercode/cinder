-- Per-repo Ed25519 key the merge job signs merge commits with (DESIGN INV §1.1). private_key is OpenSSH PEM and only
-- ever leaves the Worker in a merge claim; public_key is served at GET /api/repos/:name/signing-key.
CREATE TABLE IF NOT EXISTS signing_keys (
  repo_id TEXT PRIMARY KEY REFERENCES repos(id),
  public_key TEXT NOT NULL,
  private_key TEXT NOT NULL
);
