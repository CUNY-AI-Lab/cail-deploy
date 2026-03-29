CREATE TABLE IF NOT EXISTS github_user_auth (
  access_subject TEXT NOT NULL PRIMARY KEY,
  access_email TEXT NOT NULL,
  github_user_id INTEGER NOT NULL,
  github_login TEXT NOT NULL,
  access_token_encrypted TEXT NOT NULL,
  access_token_expires_at TEXT,
  refresh_token_encrypted TEXT,
  refresh_token_expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_github_user_auth_github_user_id
  ON github_user_auth (github_user_id);
