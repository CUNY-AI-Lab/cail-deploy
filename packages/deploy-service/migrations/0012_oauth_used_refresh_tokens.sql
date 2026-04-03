CREATE TABLE IF NOT EXISTS oauth_used_refresh_tokens (
  jti TEXT PRIMARY KEY,
  used_at TEXT NOT NULL
);
