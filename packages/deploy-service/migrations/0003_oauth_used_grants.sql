CREATE TABLE IF NOT EXISTS oauth_used_grants (
  jti TEXT PRIMARY KEY,
  grant_kind TEXT NOT NULL CHECK(grant_kind IN ('authorization_code')),
  used_at TEXT NOT NULL
);
