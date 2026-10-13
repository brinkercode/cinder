-- Access service tokens allowed to act as a person (Settings › Access & people): a JWT whose common_name is client_id
-- signs in as <name>@service-token.
CREATE TABLE IF NOT EXISTS service_tokens (
  client_id TEXT PRIMARY KEY,
  name TEXT NOT NULL
);
