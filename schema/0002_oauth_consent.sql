CREATE TABLE oauth_consent_nonces (
  nonce TEXT PRIMARY KEY,
  owner_subject TEXT NOT NULL,
  client_id TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);

CREATE INDEX oauth_consent_nonces_expiry
  ON oauth_consent_nonces(expires_at);
